// Drizzle schema for `PuzzleDO`'s own Durable Object SQLite storage (see
// wrangler.jsonc's `new_sqlite_classes: ["PuzzleDO"]`) — NOT a D1-backed
// schema like accounts/browse/friends/leaderboard's. Each `PuzzleDO`
// instance (one per puzzle, `env.PUZZLE_DO.getByName(puzzleId)`) owns its
// own private SQLite database; there is no shared physical database and no
// `wrangler d1 migrations apply` step anywhere in this story. This IS the
// source of truth: `drizzle-kit generate` reads it to produce the SQL under
// ../../drizzle, which `puzzle.model.ts`'s `migrate()` applies via
// `drizzle-orm/durable-sqlite/migrator` on every instance's construction.
// See this directory's README for the full story and the workflow for a
// future schema change. Mirrors apps/guess's own schema.ts.

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
 * `requireRow()`/`readPublicState()`'s `SELECT * FROM puzzle LIMIT 1`). */
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

/** One row per joined player (host or guest) — see `join()`. */
export const participants = sqliteTable("participants", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id"),
    token: text("token"),
    color: text("color").notNull().default("#888888"),
    joinedAt: integer("joined_at").notNull(),
    selectedCell: integer("selected_cell"),
});
