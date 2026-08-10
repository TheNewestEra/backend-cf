// D1-backed catalog: an index of every generated game/puzzle across all
// users, used for the browse page and post-session ratings. Each game
// service's Durable Object remains the source of truth for live gameplay —
// this table exists purely because a Durable Object can't be listed or
// queried across instances, and browsing is inherently a "many rows,
// sort/filter" relational job.
//
// `guess` and `puzzle` write to this table via the `CatalogService` RPC
// entrypoint (see index.ts), not a direct D1 binding — this is the only
// Worker that ever writes `catalog`/`ratings`.

import type {Database} from "@game-worker/shared/db";
import {playUrlFor} from "@game-worker/shared/game";
import type {CatalogEntrySchema, PlayStatusSchema} from "./catalog.schema";
import type {z} from "@hono/zod-openapi";

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type CatalogKind = CatalogEntry["kind"];
export type CatalogStatus = "generating" | "ready" | "error";
export type PlayStatus = z.infer<typeof PlayStatusSchema>;

interface CatalogRow {
    id: string;
    kind: CatalogKind;
    theme: string | null;
    status: CatalogStatus;
    thumbnail_key: string | null;
    play_status: PlayStatus;
    rating_sum: number;
    rating_count: number;
    created_at: number;
    updated_at: number;
}

export async function insertCatalogEntry(
    db: Database,
    id: string,
    kind: CatalogKind,
    theme: string | null,
): Promise<void> {
    const now = Date.now();
    await db
        .prepare(
            `INSERT INTO catalog (id, kind, theme, status, thumbnail_key, play_status, rating_sum, rating_count,
                                  created_at, updated_at)
             VALUES (?, ?, ?, 'generating', NULL, 'joinable', 0, 0, ?, ?)`,
        )
        .bind(id, kind, theme, now, now)
        .run();
}

/** Called by `guess`/`puzzle` whenever their own Durable Object's join
 * window opens or closes — see each one's `join()` gate and, for Piece
 * Puzzle, `beginPlaying()`/solve/timeout. Kept as its own write (distinct
 * from `markCatalogReady`) because the two don't move in lockstep: a
 * Piece Puzzle becomes `ready` (has a thumbnail) the moment it enters its
 * lobby, which is still `joinable`, not `active`. */
export async function updatePlayStatus(db: Database, id: string, playStatus: PlayStatus): Promise<void> {
    await db.prepare("UPDATE catalog SET play_status = ?, updated_at = ? WHERE id = ?").bind(playStatus, Date.now(), id).run();
}

export async function markCatalogGenerating(db: Database, id: string): Promise<void> {
    await db.prepare("UPDATE catalog SET status = 'generating', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

export async function markCatalogReady(db: Database, id: string, thumbnailKey: string): Promise<void> {
    await db
        .prepare("UPDATE catalog SET status = 'ready', thumbnail_key = ?, updated_at = ? WHERE id = ?")
        .bind(thumbnailKey, Date.now(), id)
        .run();
}

export async function markCatalogError(db: Database, id: string): Promise<void> {
    await db.prepare("UPDATE catalog SET status = 'error', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

/** The R2 key `guess`/`puzzle` recorded for this entry via `markCatalogReady`,
 * for GET /api/catalog/{id}/thumbnail to serve straight out of the shared
 * `IMAGES` bucket. Null for an unknown id or one that hasn't generated a
 * thumbnail yet. */
export async function getThumbnailKey(db: Database, id: string): Promise<string | null> {
    const row = await db.prepare("SELECT thumbnail_key FROM catalog WHERE id = ?").bind(id).first<{ thumbnail_key: string | null }>();
    return row?.thumbnail_key ?? null;
}

export interface ListCatalogOptions {
    kind: CatalogKind | null;
    sort: "recent" | "rating";
    /** Unset (default): the plain browse gallery — same as before this
     * filter existed, only entries with a generated thumbnail
     * (`status = 'ready'`). Set: answers "what can I join/spectate right
     * now" instead, which also means surfacing still-generating rows (no
     * thumbnail yet but already `joinable`) rather than hiding them —
     * `status != 'error'` is enough to keep dead entries out. */
    playStatus: PlayStatus | null;
    limit: number;
    offset: number;
}

export async function listCatalog(db: Database, opts: ListCatalogOptions): Promise<CatalogEntry[]> {
    // opts.kind/opts.sort/opts.playStatus are validated to a fixed enum by
    // the caller before reaching here, so interpolating these clause
    // fragments (never raw user input) into the query text is safe — only
    // the bound values below carry user-supplied data.
    const statusClause = opts.playStatus ? "status != 'error'" : "status = 'ready'";
    const kindClause = opts.kind ? "AND kind = ?" : "";
    const playStatusClause = opts.playStatus ? "AND play_status = ?" : "";
    const orderClause =
        opts.sort === "rating"
            ? "ORDER BY (CASE WHEN rating_count > 0 THEN rating_sum * 1.0 / rating_count ELSE -1 END) DESC, created_at DESC"
            : "ORDER BY created_at DESC";

    const binds: unknown[] = [];
    if (opts.kind) binds.push(opts.kind);
    if (opts.playStatus) binds.push(opts.playStatus);
    binds.push(opts.limit, opts.offset);

    const {results} = await db
        .prepare(`SELECT *
                  FROM catalog
                  WHERE ${statusClause} ${kindClause} ${playStatusClause} ${orderClause} LIMIT ?
                  OFFSET ?`)
        .bind(...binds)
        .all<CatalogRow>();

    return results.map(toPublic);
}

export type RatingResult = { average: number; count: number } | null;

export async function submitRating(
    db: Database,
    catalogId: string,
    stars: number,
    rater: string | null,
): Promise<RatingResult> {
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
}

function toPublic(row: CatalogRow): CatalogEntry {
    return {
        id: row.id,
        kind: row.kind,
        theme: row.theme,
        // Served by this same Worker (see GET /api/catalog/{id}/thumbnail)
        // rather than pointing across to `guess`/`puzzle` — the browse page
        // only ever has to talk to one origin for a page of results.
        thumbnailUrl: row.thumbnail_key ? `/api/catalog/${row.id}/thumbnail` : null,
        playUrl: playUrlFor(row.kind, row.id),
        playStatus: row.play_status,
        averageRating: row.rating_count > 0 ? row.rating_sum / row.rating_count : null,
        ratingCount: row.rating_count,
        createdAt: row.created_at,
    };
}
