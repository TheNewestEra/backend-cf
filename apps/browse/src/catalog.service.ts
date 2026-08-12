import {type GameKind, playUrlFor} from "@game-worker/shared/game";
import type {D1Response} from "@cloudflare/workers-types";
import {and, desc, eq, ne, sql} from "drizzle-orm";
import {err, ok, type Result} from "neverthrow";
import {type CatalogEntry, CatalogSort, CatalogStatus, PlayStatus} from "./catalog.schema";
import type {Db} from "./db/client";
import {catalog, ratings} from "./db/schema";

export const insertCatalogEntry = (db: Db, id: string, kind: GameKind, theme: string | null): Promise<D1Response> =>
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
    limit: number;
    offset: number;
}

/** Rating-ratio expression for `CatalogSort.Rating`'s ORDER BY — entries
 * with no ratings yet (`rating_count = 0`) sort as `-1`, i.e. last, exactly
 * matching the raw-SQL `CASE` this replaced. */
const ratingRatio = sql`CASE WHEN ${catalog.ratingCount} > 0 THEN ${catalog.ratingSum} * 1.0 / ${catalog.ratingCount} ELSE -1 END`;

export const listCatalog = async (db: Db, opts: ListCatalogOptions, origin: string): Promise<CatalogEntry[]> => {
    const conditions = [
        opts.playStatus ? ne(catalog.status, CatalogStatus.Error) : eq(catalog.status, CatalogStatus.Ready),
        opts.playStatus ? eq(catalog.playStatus, opts.playStatus) : undefined,
        opts.kind ? eq(catalog.kind, opts.kind) : undefined,
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
});
