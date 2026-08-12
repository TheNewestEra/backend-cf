// Drizzle schema for `PuzzleDO`'s own SQLite storage (`ctx.storage.sql` —
// see puzzle.model.ts's `migrate()`). Unlike the D1 apps' schema.ts, this
// isn't the source of truth applied via `wrangler d1 migrations apply` —
// there's no such mechanism for a Durable Object's own storage. Instead
// this file is a hand-kept DESCRIPTION of what `migrate()`'s idempotent,
// hand-rolled `CREATE TABLE`/`ALTER TABLE` bootstrap is expected to produce
// — it exists purely so `drizzle-orm/durable-sqlite`'s typed query builder
// (see ./client.ts) has table/column definitions to build queries against,
// and so `drizzle-kit generate` has something to diff a local baseline
// snapshot against for tooling/CI-drift-check purposes (see this
// directory's README). Whenever `migrate()` changes, this file must be
// updated BY HAND to match — nothing keeps the two in sync automatically.

import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";
import type {GameSessionStatus} from "@game-worker/shared/game-session-status";

// `status`'s column type is `GameSessionStatus` rather than
// `PuzzleStatus` (puzzle.model.ts's own alias for the exact same union,
// via `z.infer<typeof PuzzleStatusSchema>`) specifically to avoid an
// import cycle: puzzle.model.ts imports this file (for `puzzle`/
// `participants`) to build its `this.db` queries, so this file importing
// a type back out of puzzle.model.ts would cycle. `GameSessionStatus` is
// the shared-package enum `PuzzleStatusSchema` itself is built from (see
// puzzle.schema.ts), so it's the exact same set of string literals with
// no re-derivation/duplication needed.

/** Single-row table — exactly one puzzle per `PuzzleDO` instance (see
 * `requireRow()`/`readPublicState()`'s `SELECT * FROM puzzle LIMIT 1`).
 * Columns match `migrate()`'s `CREATE TABLE IF NOT EXISTS puzzle` block
 * verbatim — nothing's been backfilled onto this table since. */
export const puzzle = sqliteTable("puzzle", {
    id: text("id").primaryKey(),
    theme: text("theme"),
    prompt: text("prompt"),
    status: text("status").notNull().default("queued").$type<GameSessionStatus>(),
    error: text("error"),
    gridSize: integer("grid_size").notNull(),
    board: text("board").notNull().default("[]"),
    timeLimitMs: integer("time_limit_ms").notNull(),
    startedAt: integer("started_at"),
    lobbyEndsAt: integer("lobby_ends_at"),
    endedAt: integer("ended_at"),
    score: integer("score"),
    solvedBy: text("solved_by"),
    hostToken: text("host_token").notNull(),
    createdAt: integer("created_at").notNull(),
});

/** One row per joined player (host or guest). `color`/`selectedCell` were
 * both backfilled onto this table after some `PuzzleDO` instances already
 * existed — see `migrate()`'s idempotent `ALTER TABLE ... ADD COLUMN` /
 * try-catch block right after the `CREATE TABLE IF NOT EXISTS` — so this
 * describes the table as it looks TODAY, not just what the original
 * `CREATE TABLE` produced. */
export const participants = sqliteTable("participants", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id"),
    token: text("token"),
    color: text("color").notNull().default("#888888"),
    joinedAt: integer("joined_at").notNull(),
    selectedCell: integer("selected_cell"),
});
