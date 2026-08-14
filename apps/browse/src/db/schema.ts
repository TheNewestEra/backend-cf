// Drizzle schema for the tables `apps/browse` owns (see wrangler.jsonc's
// comment on the `DB` binding). This is now the source of truth for these
// two tables — future changes go schema.ts -> `npx drizzle-kit generate`
// -> copy the emitted SQL into the next-numbered file in the shared
// `migrations/` folder -> `wrangler d1 migrations apply`, same as every
// other hand-written migration already in that folder (`wrangler d1
// migrations apply` doesn't care who authored the SQL). See this
// directory's README for the one-time baselining story: these tables
// already exist (created by migrations/0001_catalog.sql, `play_status`
// added later by migrations/0007_catalog_play_status.sql), so drizzle-kit
// was pointed at an app-local `./drizzle` output folder — never the shared
// one — for its first `generate`, so that initial CREATE-TABLE snapshot
// never gets handed to `wrangler d1 migrations apply` and asked to recreate
// tables that are already live.

import type {GameKind} from "@game-worker/shared/game";
import {check, index, integer, sqliteTable, text} from "drizzle-orm/sqlite-core";
import {sql} from "drizzle-orm";
import type {CatalogStatus, PlayStatus} from "../catalog.schema";

/** One row per generated game/puzzle, across all users — the browse page's
 * index and the target of post-session ratings. The Durable Objects
 * (GameDO/PuzzleDO) remain the source of truth for live gameplay; this is
 * purely discovery (see migrations/0001_catalog.sql's header comment). */
export const catalog = sqliteTable(
    "catalog",
    {
        id: text("id").primaryKey(), // same id as the GameDO/PuzzleDO instance
        kind: text("kind").notNull().$type<GameKind>(),
        theme: text("theme"),
        // Whether `theme` was picked for this entry (a Flagship preset, or
        // the prompt model's own idea) rather than typed in by its creator —
        // see CatalogRpc's `insertCatalogEntry`/`updateCatalogTheme` doc
        // comments (@game-worker/shared/rpc-types) for how/when it's set.
        // 0/1, same boolean-as-integer convention as guess/puzzle's own
        // `theme_generated` columns.
        themeGenerated: integer("theme_generated").notNull().default(0),
        status: text("status").notNull().default("generating").$type<CatalogStatus>(),
        thumbnailKey: text("thumbnail_key"), // R2 key, set once generation succeeds
        // Live play status, separate from `status` (which only ever reflects
        // generation progress / thumbnail availability) — see
        // migrations/0007_catalog_play_status.sql's header comment.
        playStatus: text("play_status").notNull().default("joinable").$type<PlayStatus>(),
        ratingSum: integer("rating_sum").notNull().default(0),
        ratingCount: integer("rating_count").notNull().default(0),
        // Who created this entry, for the "created by friends" browse filter
        // and the creator name/color shown alongside each entry — see
        // migrations/0009_catalog_creator.sql's header comment for why all
        // three are nullable (anonymous hosts, and rows that predate this
        // column) and why `creatorName`/`creatorColor` are a snapshot taken
        // at creation time rather than a live join back to `users` (same
        // snapshot pattern `theme` above already uses).
        createdBy: text("created_by"), // account id of the creating user; null for anonymous hosts
        creatorName: text("creator_name"),
        creatorColor: text("creator_color"),
        // `replayOf`/`rootId` model a replay chain — see
        // migrations/0010_catalog_replay.sql's header comment. `replayOf` is
        // the entry replayed *from* (one hop back), null for an entry that
        // was created directly. `rootId` is resolved once at insert time to
        // the chain's very first entry's id (itself, if this entry started
        // the chain) so `listCatalog` can group a whole chain with a single
        // `GROUP BY root_id` instead of a recursive walk back through
        // `replayOf` on every read; nullable only because a column added via
        // `ALTER TABLE` can't backfill itself off another column of the same
        // row (SQLite computes a constant default, not an expression) — every
        // row `insertCatalogEntry` writes from here on always sets it, same
        // "nullable only for rows that predate the column" shape as
        // `createdBy`/`creatorName` above. Every reader treats a null the
        // same as `id` itself (`COALESCE(root_id, id)`) rather than special-
        // casing it.
        replayOf: text("replay_of"),
        rootId: text("root_id"),
        createdAt: integer("created_at").notNull(),
        updatedAt: integer("updated_at").notNull(),
    },
    // Original migrations sort each of these DESC on `created_at` (newest
    // first, matching `listCatalog`'s default ordering) — sqlite-core's
    // `index()` builder in this drizzle-orm version has no `.desc()` column
    // modifier, so it's expressed via a raw `sql` fragment instead.
    (table) => [
        index("idx_catalog_created").on(sql`${table.createdAt} desc`),
        index("idx_catalog_kind_created").on(table.kind, sql`${table.createdAt} desc`),
        index("idx_catalog_play_status_created").on(table.playStatus, sql`${table.createdAt} desc`),
        index("idx_catalog_created_by").on(table.createdBy),
        // Grouping index for `listCatalog`'s "one card per replay chain"
        // query — same DESC-on-created_at shape as the indexes above.
        index("idx_catalog_root_created").on(table.rootId, sql`${table.createdAt} desc`),
    ],
);

/** A single 1-5 star rating against a `catalog` entry. `catalogId`
 * references `catalog(id)` at the DB level (see migrations/0001_catalog.sql)
 * but that FK isn't enforced by SQLite itself (no `PRAGMA foreign_keys`),
 * same as every other cross-table reference in this codebase — modeled
 * here anyway via `.references()` since, unlike friends' `users` case,
 * `catalog` is owned by this same app/schema. */
export const ratings = sqliteTable(
    "ratings",
    {
        id: integer("id").primaryKey({autoIncrement: true}),
        catalogId: text("catalog_id")
            .notNull()
            .references(() => catalog.id),
        rater: text("rater"),
        stars: integer("stars").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        index("idx_ratings_catalog").on(table.catalogId),
        check("stars_between_1_and_5", sql`${table.stars} BETWEEN 1 AND 5`),
    ],
);
