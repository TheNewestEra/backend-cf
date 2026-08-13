import {type GameKind, playUrlFor} from "@game-worker/shared/game";
import type {FriendsRpc} from "@game-worker/shared/rpc-types";
import type {D1Response} from "@cloudflare/workers-types";
import {and, desc, eq, inArray, ne, sql} from "drizzle-orm";
import {err, ok, type Result} from "neverthrow";
import {type CatalogEntry, CatalogSort, CatalogStatus, PlayStatus} from "./catalog.schema";
import type {Db} from "./db/client";
import {catalog, ratings} from "./db/schema";

/** `creator` is null for an anonymous host — `createdBy` is left null too,
 * so such entries never match the "created by friends" filter (there's no
 * account to be someone's friend). `creator.name`/`.color` are still
 * recorded either way, as a point-in-time snapshot (same pattern `theme`
 * already uses) rather than a live join back to `users` at read time — an
 * anonymous host has no persisted `users` row to join against, so the
 * snapshot is what makes their chosen name/color displayable at all. */
export const insertCatalogEntry = (
    db: Db,
    id: string,
    kind: GameKind,
    theme: string | null,
    creator: {id: string | null; name: string; color: string},
): Promise<D1Response> =>
    db
        .insert(catalog)
        .values({
            id,
            kind,
            theme,
            status: CatalogStatus.Generating,
            thumbnailKey: null,
            playStatus: PlayStatus.Joinable,
            ratingSum: 0,
            ratingCount: 0,
            createdBy: creator.id,
            creatorName: creator.name,
            creatorColor: creator.color,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        })
        .run();

export const updatePlayStatus = (db: Db, id: string, playStatus: PlayStatus): Promise<D1Response> =>
    db.update(catalog).set({playStatus, updatedAt: Date.now()}).where(eq(catalog.id, id)).run();

export const markCatalogGenerating = (db: Db, id: string): Promise<D1Response> =>
    db
        .update(catalog)
        .set({status: CatalogStatus.Generating, updatedAt: Date.now()})
        .where(eq(catalog.id, id))
        .run();

export const markCatalogReady = (db: Db, id: string, thumbnailKey: string): Promise<D1Response> =>
    db
        .update(catalog)
        .set({status: CatalogStatus.Ready, thumbnailKey, updatedAt: Date.now()})
        .where(eq(catalog.id, id))
        .run();

export const markCatalogError = (db: Db, id: string): Promise<D1Response> =>
    db.update(catalog).set({status: CatalogStatus.Error, updatedAt: Date.now()}).where(eq(catalog.id, id)).run();

export const getThumbnailKey = async (db: Db, id: string): Promise<string | null> => {
    const row = await db.select({thumbnailKey: catalog.thumbnailKey}).from(catalog).where(eq(catalog.id, id)).get();
    return row?.thumbnailKey ?? null;
};

export interface ListCatalogOptions {
    kind: GameKind | null;
    sort: CatalogSort;
    playStatus: PlayStatus | null;
    /** Restricts the list to entries `created_by` a friend of this viewer
     * (never the viewer's own entries — same "friends, not me" semantics as
     * apps/leaderboard's `friendScores`). Null for the unrestricted list. */
    createdByFriendsOf: string | null;
    limit: number;
    offset: number;
}

/** Rating-ratio expression for `CatalogSort.Rating`'s ORDER BY — entries
 * with no ratings yet (`rating_count = 0`) sort as `-1`, i.e. last, exactly
 * matching the raw-SQL `CASE` this replaced. */
const ratingRatio = sql`CASE WHEN ${catalog.ratingCount} > 0 THEN ${catalog.ratingSum} * 1.0 / ${catalog.ratingCount} ELSE -1 END`;

export const listCatalog = async (db: Db, friends: FriendsRpc, opts: ListCatalogOptions, origin: string): Promise<CatalogEntry[]> => {
    const friendIdsList = opts.createdByFriendsOf ? await friends.getFriendIds(opts.createdByFriendsOf) : null;
    // A viewer with no friends yet can't have any "created by friends"
    // matches — skip the query entirely rather than handing `inArray` an
    // empty list.
    if (friendIdsList && friendIdsList.length === 0) return [];

    const conditions = [
        opts.playStatus ? ne(catalog.status, CatalogStatus.Error) : eq(catalog.status, CatalogStatus.Ready),
        opts.playStatus ? eq(catalog.playStatus, opts.playStatus) : undefined,
        opts.kind ? eq(catalog.kind, opts.kind) : undefined,
        friendIdsList ? inArray(catalog.createdBy, friendIdsList) : undefined,
    ].filter((condition) => condition !== undefined);

    const orderBy = opts.sort === CatalogSort.Rating ? [desc(ratingRatio), desc(catalog.createdAt)] : [desc(catalog.createdAt)];

    const rows = await db
        .select()
        .from(catalog)
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(opts.offset);

    return rows.map((row) => toPublic(row, origin));
};

export type RatingResult = {average: number; count: number};

/** `Err("not found")` when `catalogId` doesn't name an existing catalog
 * entry — never crosses a Workers RPC boundary (called directly from
 * catalog.controller.ts within this same Worker), so a live `Result` is
 * fine to hand back as-is; no `toRpcResult()`/`RpcResult` involved. */
export const submitRating = async (db: Db, catalogId: string, stars: number, rater: string | null): Promise<Result<RatingResult, string>> => {
    const existing = await db
        .select({ratingSum: catalog.ratingSum, ratingCount: catalog.ratingCount})
        .from(catalog)
        .where(eq(catalog.id, catalogId))
        .get();
    if (!existing) return err("not found");

    const now = Date.now();
    // Atomic via D1/Drizzle's `.batch()` — same guarantee the original
    // `db.batch([...])` call gave: the new rating row and the running
    // sum/count on `catalog` either both land or neither does.
    await db.batch([
        db.insert(ratings).values({catalogId, rater, stars, createdAt: now}),
        db
            .update(catalog)
            .set({
                ratingSum: sql`${catalog.ratingSum} + ${stars}`,
                ratingCount: sql`${catalog.ratingCount} + 1`,
                updatedAt: now,
            })
            .where(eq(catalog.id, catalogId)),
    ]);

    return ok({
        average: (existing.ratingSum + stars) / (existing.ratingCount + 1),
        count: existing.ratingCount + 1,
    });
};

const toPublic = (row: typeof catalog.$inferSelect, origin: string): CatalogEntry => ({
    id: row.id,
    kind: row.kind,
    theme: row.theme,
    thumbnailUrl: row.thumbnailKey ? new URL(`/api/catalog/${row.id}/thumbnail`, origin) : null,
    playUrl: playUrlFor(row.kind, row.id),
    playStatus: row.playStatus,
    averageRating: row.ratingCount > 0 ? row.ratingSum / row.ratingCount : null,
    ratingCount: row.ratingCount,
    createdAt: row.createdAt,
    // `creatorName` is null only for entries that predate this column
    // (never for a freshly-inserted row — `insertCatalogEntry` always
    // writes it, even for an anonymous host) — see this file's header
    // comment on `insertCatalogEntry` for why it's a snapshot rather than a
    // live join.
    creator: row.creatorName ? {userId: row.createdBy, name: row.creatorName, color: row.creatorColor ?? "#888888"} : null,
});
