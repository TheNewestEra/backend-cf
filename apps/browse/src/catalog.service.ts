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
 * snapshot is what makes their chosen name/color displayable at all.
 *
 * `replayOf`, when given, is the source catalog id a guess/puzzle `/replay`
 * endpoint is creating this entry from. Resolves `rootId` off that source
 * row (its own `rootId`, or its `id` if it's the chain's root itself) in a
 * separate read rather than a single INSERT...SELECT — one extra round
 * trip, but keeps this function's shape a plain `.values()` insert like
 * every other write in this file, and `replayOf` never names a row that
 * doesn't already exist (the caller always creates the source entry first),
 * so `source` is only ever missing for data that predates this column.
 *
 * `themeGenerated` records whether `theme` was picked for this entry rather
 * than typed in — see `updateCatalogTheme` below for the write that backfills
 * the real value once generation resolves one for a themeless entry. */
export const insertCatalogEntry = async (
    db: Db,
    id: string,
    kind: GameKind,
    theme: string | null,
    creator: {id: string | null; name: string; color: string},
    replayOf?: string | null,
    themeGenerated?: boolean,
): Promise<D1Response> => {
    const rootId = replayOf
        ? ((await db.select({rootId: catalog.rootId}).from(catalog).where(eq(catalog.id, replayOf)).get())?.rootId ?? replayOf)
        : id;
    return db
        .insert(catalog)
        .values({
            id,
            kind,
            theme,
            themeGenerated: themeGenerated ? 1 : 0,
            status: CatalogStatus.Generating,
            thumbnailKey: null,
            playStatus: PlayStatus.Joinable,
            ratingSum: 0,
            ratingCount: 0,
            createdBy: creator.id,
            creatorName: creator.name,
            creatorColor: creator.color,
            replayOf: replayOf ?? null,
            rootId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        })
        .run();
};

/** Backfills `theme`/`themeGenerated` once generation actually resolves a
 * theme for an entry that started with none — see CatalogRpc's own doc
 * comment (@game-worker/shared/rpc-types) for the full contract. */
export const updateCatalogTheme = (db: Db, id: string, theme: string, themeGenerated: boolean): Promise<D1Response> =>
    db
        .update(catalog)
        .set({theme, themeGenerated: themeGenerated ? 1 : 0, updatedAt: Date.now()})
        .where(eq(catalog.id, id))
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

/** Groups a possibly-pre-`root_id` row into its replay chain — see
 * db/schema.ts's `rootId` doc comment for why a null falls back to the
 * row's own id rather than a real chain lookup. Shared by every place
 * `listCatalog` needs "which chain is this row part of", so the grouping
 * subquery and the join condition that reads it back can't drift apart. */
const familyId = sql`COALESCE(${catalog.rootId}, ${catalog.id})`;

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

    // Sums ratings across every instance in a replay chain, not just the
    // newest one — a regenerate/replay always starts a fresh `catalog` row
    // at `ratingSum: 0, ratingCount: 0` (see `insertCatalogEntry`'s doc
    // comment), so reading only the newest row would make a chain's earlier
    // ratings vanish from the browse list the moment it's regenerated, even
    // though those `ratings` rows are still sitting in D1.
    const family = db
        .select({
            familyId: familyId.as("family_id"),
            maxCreatedAt: sql<number>`MAX(${catalog.createdAt})`.as("max_created_at"),
            instanceCount: sql<number>`COUNT(*)`.as("instance_count"),
            ratingSum: sql<number>`SUM(${catalog.ratingSum})`.as("total_rating_sum"),
            ratingCount: sql<number>`SUM(${catalog.ratingCount})`.as("total_rating_count"),
        })
        .from(catalog)
        .where(and(...conditions))
        .groupBy(familyId)
        .as("family");

    // Rating-ratio expression for `CatalogSort.Rating`'s ORDER BY, over the
    // chain-wide sums above rather than a single row — entries with no
    // ratings yet anywhere in their chain (`rating_count = 0`) sort as `-1`,
    // i.e. last, same as before this summed across replays.
    const ratingRatio = sql`CASE WHEN ${family.ratingCount} > 0 THEN ${family.ratingSum} * 1.0 / ${family.ratingCount} ELSE -1 END`;
    const orderBy = opts.sort === CatalogSort.Rating ? [desc(ratingRatio), desc(catalog.createdAt)] : [desc(catalog.createdAt)];

    const rows = await db
        .select({
            id: catalog.id,
            kind: catalog.kind,
            theme: catalog.theme,
            themeGenerated: catalog.themeGenerated,
            status: catalog.status,
            thumbnailKey: catalog.thumbnailKey,
            playStatus: catalog.playStatus,
            ratingSum: family.ratingSum,
            ratingCount: family.ratingCount,
            createdBy: catalog.createdBy,
            creatorName: catalog.creatorName,
            creatorColor: catalog.creatorColor,
            replayOf: catalog.replayOf,
            createdAt: catalog.createdAt,
            updatedAt: catalog.updatedAt,
            replayCount: sql<number>`${family.instanceCount} - 1`,
        })
        .from(catalog)
        .innerJoin(family, sql`${familyId} = ${family.familyId} AND ${catalog.createdAt} = ${family.maxCreatedAt}`)
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(opts.offset);

    return rows.map((row) => toPublic(row, origin));
};

/** Ratings are 1-5 whole stars, but an *average* rarely lands on a whole
 * number — rounds it to the nearest half star (e.g. `3.7` -> `3.5`, `3.8`
 * -> `4`) so every display of `averageRating` shows a consistent,
 * half-star-granularity figure rather than a long decimal. Shared by
 * `toPublic` (the chain-wide average `listCatalog` returns) and
 * `submitRating` (the single-entry average it hands back to whoever just
 * rated), so the two can't round differently. */
const roundToNearestHalf = (value: number): number => Math.round(value * 2) / 2;

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
        average: roundToNearestHalf((existing.ratingSum + stars) / (existing.ratingCount + 1)),
        count: existing.ratingCount + 1,
    });
};

/** What `listCatalog`'s row shape actually is: every `catalog` column
 * `CatalogEntry` needs, plus `replayCount` (computed by the `family` join,
 * not a real column — see `listCatalog`). `ratingSum`/`ratingCount` are also
 * `family`-sourced rather than plain `catalog` columns — the chain-wide
 * sums computed there, not just this row's own tally. */
type CatalogRow = Pick<
    typeof catalog.$inferSelect,
    "id" | "kind" | "theme" | "themeGenerated" | "thumbnailKey" | "playStatus" | "createdBy" | "creatorName" | "creatorColor" | "replayOf" | "createdAt"
> & {replayCount: number; ratingSum: number; ratingCount: number};

const toPublic = (row: CatalogRow, origin: string): CatalogEntry => ({
    id: row.id,
    kind: row.kind,
    theme: row.theme,
    themeGenerated: row.themeGenerated === 1,
    thumbnailUrl: row.thumbnailKey ? new URL(`/api/catalog/${row.id}/thumbnail`, origin) : null,
    playUrl: playUrlFor(row.kind, row.id),
    playStatus: row.playStatus,
    averageRating: row.ratingCount > 0 ? roundToNearestHalf(row.ratingSum / row.ratingCount) : null,
    ratingCount: row.ratingCount,
    createdAt: row.createdAt,
    // `creatorName` is null only for entries that predate this column
    // (never for a freshly-inserted row — `insertCatalogEntry` always
    // writes it, even for an anonymous host) — see this file's header
    // comment on `insertCatalogEntry` for why it's a snapshot rather than a
    // live join.
    creator: row.creatorName ? {userId: row.createdBy, name: row.creatorName, color: row.creatorColor ?? "#888888"} : null,
    replayOf: row.replayOf,
    replayCount: row.replayCount,
});
