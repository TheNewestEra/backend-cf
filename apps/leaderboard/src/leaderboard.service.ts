// Leaderboard: aggregates `leaderboard_entries` (one row per scoring event —
// a solved puzzle, a correctly-guessed round; written exclusively through
// `LeaderboardService.recordScore`, this Worker's RPC entrypoint — see
// index.ts) into per-user totals. Kept as an event log rather than a
// running total specifically so time-windowed queries ("top scores this
// week") can filter on created_at directly instead of reconstructing
// history.
//
// Accounts only: anonymous/guest play is never recorded here, so every row
// in the table has a real `users` row to join against — no "guest bucket"
// to special-case. `users` itself is owned by the accounts Worker; this
// Worker only ever reads it (for display names), never writes it.

import type {Database} from "@game-worker/shared/db";

export type LeaderboardKind = "guess" | "puzzle";
export type LeaderboardPeriod = "all" | "day" | "week" | "month";

const PERIOD_MS: Record<Exclude<LeaderboardPeriod, "all">, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function cutoffFor(period: LeaderboardPeriod): number | null {
  return period === "all" ? null : Date.now() - PERIOD_MS[period];
}

export interface RecordScoreInput {
  userId: string;
  kind: LeaderboardKind;
  sessionId: string;
  score: number;
}

/** Logs one scoring event. Called from `LeaderboardService.recordScore`
 * (this Worker's RPC entrypoint), in turn called from the `guess`/`puzzle`
 * Workers' Durable Objects right after they compute a score
 * (GameDO.submitGuess, PuzzleDO.swapTiles) — never directly from a
 * controller. A non-positive score (a wrong guess) is a no-op rather than
 * an error, so callers don't need to guard the call themselves. */
export async function recordScore(db: Database, input: RecordScoreInput): Promise<void> {
  if (input.score <= 0) return;
  await db
    .prepare(
      `INSERT INTO leaderboard_entries (id, user_id, kind, session_id, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), input.userId, input.kind, input.sessionId, input.score, Date.now())
    .run();
}

export interface LeaderboardQuery {
  kind: LeaderboardKind | null;
  period: LeaderboardPeriod;
}

/** Builds the `kind`/`period` half of a WHERE clause against `leaderboard_entries
 * e` — shared by every query below so the two filters can't drift apart. */
function filtersFor(query: LeaderboardQuery): { conditions: string[]; binds: unknown[] } {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (query.kind) {
    conditions.push("e.kind = ?");
    binds.push(query.kind);
  }
  const cutoff = cutoffFor(query.period);
  if (cutoff !== null) {
    conditions.push("e.created_at >= ?");
    binds.push(cutoff);
  }
  return { conditions, binds };
}

interface TotalRow {
  user_id: string;
  username: string;
  total_score: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  score: number;
}

const TOP_N = 10;

/** Top 10 users by summed score in the given window. */
export async function topScores(db: Database, query: LeaderboardQuery): Promise<LeaderboardEntry[]> {
  const { conditions, binds } = filtersFor(query);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { results } = await db
    .prepare(
      `SELECT e.user_id AS user_id, u.username AS username, SUM(e.score) AS total_score
       FROM leaderboard_entries e
       JOIN users u ON u.id = e.user_id
       ${where}
       GROUP BY e.user_id
       ORDER BY total_score DESC
       LIMIT ?`,
    )
    .bind(...binds, TOP_N)
    .all<TotalRow>();

  return results.map((row, i) => ({ rank: i + 1, userId: row.user_id, username: row.username, score: row.total_score }));
}

export interface MyScore {
  userId: string;
  username: string;
  score: number;
  rank: number | null;
}

/** The given user's total score (0 if they have none in this window) and
 * their rank among everyone who does — computed even when they're outside
 * the top 10. `rank` is null when the user has no score in the window
 * (nothing to rank them against). Returns null only if `userId` doesn't
 * resolve to an account at all. */
export async function myScore(db: Database, userId: string, query: LeaderboardQuery): Promise<MyScore | null> {
  const user = await db.prepare("SELECT username FROM users WHERE id = ?").bind(userId).first<{ username: string }>();
  if (!user) return null;

  const { conditions, binds } = filtersFor(query);

  const mine = await db
    .prepare(
      `SELECT COALESCE(SUM(e.score), 0) AS total
       FROM leaderboard_entries e
       WHERE ${[...conditions, "e.user_id = ?"].join(" AND ")}`,
    )
    .bind(...binds, userId)
    .first<{ total: number }>();
  const score = mine?.total ?? 0;
  if (score === 0) return { userId, username: user.username, score: 0, rank: null };

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const ranked = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM (
         SELECT e.user_id AS user_id, SUM(e.score) AS total_score
         FROM leaderboard_entries e
         ${where}
         GROUP BY e.user_id
       ) t
       WHERE t.total_score > ?`,
    )
    .bind(...binds, score)
    .first<{ rank: number }>();

  return { userId, username: user.username, score, rank: ranked?.rank ?? 1 };
}
