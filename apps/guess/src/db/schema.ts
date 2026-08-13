// Drizzle schema for `GameDO`'s own Durable Object SQLite storage (see
// wrangler.jsonc's `new_sqlite_classes: ["GameDO"]`) — NOT a D1-backed
// schema like accounts/browse/friends/leaderboard's. Each `GameDO` instance
// (one per game, `env.GAME_DO.getByName(gameId)`) owns its own private
// SQLite database; there is no shared physical database and no
// `wrangler d1 migrations apply` step anywhere in this story. This file
// describes the four tables as `guess.model.ts`'s `migrate()` actually
// leaves them TODAY — i.e. after its `CREATE TABLE IF NOT EXISTS` block
// *and* every idempotent `ALTER TABLE ... ADD COLUMN` that has since run
// against it — not just the original `CREATE TABLE`'s columns. See this
// directory's README for why `migrate()` stays hand-written raw SQL rather
// than something drizzle-kit drives, and for the workflow to follow when
// changing either it or this file.

import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";
import type {GameSessionStatus} from "@game-worker/shared/game-session-status";
// Type-only import from guess.schema.ts (not guess.model.ts) to avoid an
// import cycle: guess.model.ts will import `game`/`rounds`/`guesses`/
// `participants` from this file, so this file can't import back from
// guess.model.ts. guess.schema.ts doesn't import guess.model.ts (or this
// file), so importing `RoundStatus` from there directly is cycle-free.
// Mirrors how apps/browse/src/db/schema.ts sources its own status unions
// from `../catalog.schema` rather than `catalog.service.ts`.
import type {RoundStatus} from "../guess.schema";

/** One row per game (a `GameDO` instance only ever has one). */
export const game = sqliteTable("game", {
    id: text("id").primaryKey(),
    theme: text("theme"),
    status: text("status").notNull().default("queued").$type<GameSessionStatus>(),
    error: text("error"),
    hostToken: text("host_token").notNull().default(""),
    // Origin (scheme+host) this game was created against — see
    // guess.model.ts's `GameRow`-equivalent doc comment on `origin` (now on
    // `readPublicState()`/`init()`) for why it's captured once rather than
    // recomputed per read. Empty string (pre-migration rows) means
    // "unknown".
    origin: text("origin").notNull().default(""),
    lobbyEndsAt: integer("lobby_ends_at"),
    // Set together, by resolveCurrentRound(), while the just-resolved round
    // sits in its post-round reveal pause; both cleared together, by
    // advanceAfterPostRound(), once that pause ends.
    postRoundIndex: integer("post_round_index"),
    postRoundEndsAt: integer("post_round_ends_at"),
    // Resolved once, by init(), from Flagship's "round-count" flag and
    // never re-read after — the authoritative "how many rounds does this
    // game have" for its entire lifetime. DEFAULT 5 matches the static
    // ROUND_COUNT every pre-existing instance was actually created with,
    // before it became a per-game value.
    roundCount: integer("round_count").notNull().default(5),
    createdAt: integer("created_at").notNull(),
});

/** One row per round, `roundCount` rows per game — pre-created by `init()`. */
export const rounds = sqliteTable("rounds", {
    idx: integer("idx").primaryKey(),
    prompt: text("prompt"),
    status: text("status").notNull().default("pending").$type<RoundStatus>(),
    imageKey: text("image_key"),
    readyAt: integer("ready_at"),
    startedAt: integer("started_at"),
    timeLimitMs: integer("time_limit_ms"),
    error: text("error"),
});

/** One row per guess attempt (not just correct ones) — see `submitGuess()`. */
export const guesses = sqliteTable("guesses", {
    id: integer("id").primaryKey({autoIncrement: true}),
    roundIdx: integer("round_idx").notNull(),
    participantId: text("participant_id").notNull().default(""),
    player: text("player").notNull(),
    guess: text("guess").notNull(),
    correct: integer("correct").notNull(),
    score: integer("score"),
    createdAt: integer("created_at").notNull(),
});

/** One row per joined player — see `join()`. */
export const participants = sqliteTable("participants", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id"),
    token: text("token"),
    color: text("color").notNull().default("#888888"),
    joinedAt: integer("joined_at").notNull(),
});
