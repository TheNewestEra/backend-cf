import type {Database} from "@game-worker/shared/db";
import {type GameKind, playUrlFor} from "@game-worker/shared/game";
import {type CatalogEntry, CatalogSort, CatalogStatus, PlayStatus} from "./catalog.schema";
import {D1Result} from "@cloudflare/workers-types";

interface CatalogRow {
    readonly id: string;
    readonly kind: GameKind;
    readonly theme: string | null;
    readonly status: CatalogStatus;
    readonly thumbnail_key: string | null;
    readonly play_status: PlayStatus;
    readonly rating_sum: number;
    readonly rating_count: number;
    readonly created_at: number;
    readonly updated_at: number;
}

export const insertCatalogEntry = (
    db: Database,
    id: string,
    kind: GameKind,
    theme: string | null,
): Promise<D1Result> =>
    db
        .prepare(
            `INSERT INTO catalog (id, kind, theme, status, thumbnail_key, play_status, rating_sum, rating_count,
                                  created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, ?, 0, 0, ?, ?)`,
        )
        .bind(id, kind, theme, CatalogStatus.Generating, PlayStatus.Joinable, Date.now(), Date.now())
        .run();

export const updatePlayStatus = (db: Database, id: string, playStatus: PlayStatus): Promise<D1Result> =>
    db
        .prepare("UPDATE catalog SET play_status = ?, updated_at = ? WHERE id = ?")
        .bind(playStatus, Date.now(), id)
        .run();

export const markCatalogGenerating = (db: Database, id: string): Promise<D1Result> =>
    db
        .prepare("UPDATE catalog SET status = ?, updated_at = ? WHERE id = ?")
        .bind(CatalogStatus.Generating, Date.now(), id)
        .run();

export const markCatalogReady = (db: Database, id: string, thumbnailKey: string): Promise<D1Result> =>
    db
        .prepare("UPDATE catalog SET status = ?, thumbnail_key = ?, updated_at = ? WHERE id = ?")
        .bind(CatalogStatus.Ready, thumbnailKey, Date.now(), id)
        .run();

export const markCatalogError = (db: Database, id: string): Promise<D1Result> =>
    db
        .prepare("UPDATE catalog SET status = ?, updated_at = ? WHERE id = ?")
        .bind(CatalogStatus.Error, Date.now(), id)
        .run();

export const getThumbnailKey = async (db: Database, id: string): Promise<string | null> => {
    const row = await db
        .prepare("SELECT thumbnail_key FROM catalog WHERE id = ?")
        .bind(id)
        .first<{ thumbnail_key: string | null }>();
    return row?.thumbnail_key ?? null;
};

export interface ListCatalogOptions {
    kind: GameKind | null;
    sort: CatalogSort;
    playStatus: PlayStatus | null;
    limit: number;
    offset: number;
}

const buildListQuery = (opts: ListCatalogOptions) => {
    const clauses = [
        opts.playStatus
            ? {sql: "status != ?", bind: CatalogStatus.Error}
            : {sql: "status = ?", bind: CatalogStatus.Ready},
        opts.playStatus ? {sql: "play_status = ?", bind: opts.playStatus} : null,
        opts.kind ? {sql: "kind = ?", bind: opts.kind} : null,
    ].filter((clause): clause is { sql: string; bind: GameKind } => clause !== null);

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.map((c) => c.sql).join(" AND ")}` : "";

    const orderClause =
        opts.sort === CatalogSort.Rating
            ? "ORDER BY (CASE WHEN rating_count > 0 THEN rating_sum * 1.0 / rating_count ELSE -1 END) DESC, created_at DESC"
            : "ORDER BY created_at DESC";

    return {
        query: `SELECT *
                FROM catalog ${whereClause} ${orderClause} LIMIT ?
                OFFSET ?`,
        binds: [...clauses.map((c) => c.bind), opts.limit, opts.offset],
    };
};

export const listCatalog = async (
    db: Database,
    opts: ListCatalogOptions,
    origin: string
): Promise<CatalogEntry[]> => {
    const {query, binds} = buildListQuery(opts);
    return db
        .prepare(query)
        .bind(...binds)
        .all<CatalogRow>()
        .then(({results}) => results.map(row => toPublic(row, origin)));
};

export type RatingResult = { average: number; count: number } | null;

export const submitRating = async (
    db: Database,
    catalogId: string,
    stars: number,
    rater: string | null,
): Promise<RatingResult> => {
    const existing = await db
        .prepare("SELECT rating_sum, rating_count FROM catalog WHERE id = ?")
        .bind(catalogId)
        .first<{ rating_sum: number; rating_count: number }>();
    if (!existing) return null;

    const now = Date.now();
    await db.batch([
        db
            .prepare("INSERT INTO ratings (catalog_id, rater, stars, created_at) VALUES (?, ?, ?, ?)")
            .bind(catalogId, rater, stars, now),
        db
            .prepare(
                "UPDATE catalog SET rating_sum = rating_sum + ?, rating_count = rating_count + 1, updated_at = ? WHERE id = ?",
            )
            .bind(stars, now, catalogId),
    ]);

    return {
        average: (existing.rating_sum + stars) / (existing.rating_count + 1),
        count: existing.rating_count + 1,
    };
};

const toPublic = (row: CatalogRow, origin: string): CatalogEntry => ({
    id: row.id,
    kind: row.kind,
    theme: row.theme,
    thumbnailUrl: row.thumbnail_key ? new URL(`/api/catalog/${row.id}/thumbnail`, origin) : null,
    playUrl: playUrlFor(row.kind, row.id),
    playStatus: row.play_status,
    averageRating: row.rating_count > 0 ? row.rating_sum / row.rating_count : null,
    ratingCount: row.rating_count,
    createdAt: row.created_at,
});
