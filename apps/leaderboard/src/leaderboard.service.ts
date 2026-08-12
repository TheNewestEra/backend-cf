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
import type {GameKind} from "@game-worker/shared/game";
import {LeaderboardPeriod} from "./leaderboard.schema";

export type LeaderboardKind = GameKind;
export type {LeaderboardPeriod};

const PERIOD_MS: Record<Exclude<LeaderboardPeriod, "all">, number> = {
    [LeaderboardPeriod.Day]: 24 * 60 * 60 * 1000,
    [LeaderboardPeriod.Week]: 7 * 24 * 60 * 60 * 1000,
    [LeaderboardPeriod.Month]: 30 * 24 * 60 * 60 * 1000,
};

function cutoffFor(period: LeaderboardPeriod): number | null {
    return period === LeaderboardPeriod.All ? null : Date.now() - PERIOD_MS[period];
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
    return {conditions, binds};
}

interface TotalRow {
    user_id: string;
    username: string;
    color: string;
    total_score: number;
    last_played: number;
}

export interface LeaderboardEntry {
    rank: number;
    userId: string;
    username: string;
    color: string;
    score: number;
    /** Echoes `query.kind`; null when unfiltered (the total spans both games). */
    kind: LeaderboardKind | null;
    /** Epoch ms of this user's most recent scoring event counted in `score`. */
    lastPlayedAt: number;
    /** Whether this row's user is a friend of the requesting viewer. Only
     * ever set by `topScores` (and only when it's given a logged-in
     * viewer) — every `friendScores` row is a friend by construction, so
     * it's left undefined there rather than redundantly always-true. */
    isFriend?: boolean;
}

/** Builds every `LeaderboardEntry` field derivable from a `TotalRow` alone
 * — `rank` and `kind` come from the caller, since a row doesn't carry
 * either. `isFriend` (only ever set by `topScores`) is added afterward by
 * the caller, not here. */
function toEntry(row: TotalRow, rank: number, kind: LeaderboardKind | null): LeaderboardEntry {
    return {
        rank,
        userId: row.user_id,
        username: row.username,
        color: row.color,
        score: row.total_score,
        kind,
        lastPlayedAt: row.last_played,
    };
}

// Fallback used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with the flag's own
// default variation.
const DEFAULT_PAGE_SIZE = 10;

/** Page size for `topScores`, sourced from Cloudflare Flagship's
 * "leaderboard-page-size" flag — flip it in the Flagship dashboard/CLI to
 * change it without a redeploy. */
export async function topScoresPageSize(flags: Flagship): Promise<number> {
    return flags.getNumberValue("leaderboard-page-size", DEFAULT_PAGE_SIZE);
}

export interface LeaderboardPage {
    entries: LeaderboardEntry[];
    hasMore: boolean;
}

/** IDs of `userId`'s friends (not including `userId` itself) — a direct
 * read against the `friendships` table owned by the `friends` Worker, the
 * same pragmatic cross-app read this file already does against `users`. */
async function friendIds(db: Database, userId: string): Promise<string[]> {
    const {results} = await db
        .prepare("SELECT friend_id FROM friendships WHERE user_id = ?")
        .bind(userId)
        .all<{ friend_id: string }>();
    return results.map((r) => r.friend_id);
}

/** Page `page` of users ranked by summed score in the given window, `page`
 * size sourced from Flagship (see `topScoresPageSize`). `page` is
 * 1-indexed; `rank` keeps counting up across pages rather than restarting
 * at 1 each time. Fetches one row past the page boundary instead of a
 * separate COUNT(*) to learn whether another page exists — same trick as
 * `friendScores` below. `viewerId` (the logged-in requester, if any) sets
 * each entry's `isFriend`; pass null when there's no session, and every
 * entry's `isFriend` comes back undefined. */
export async function topScores(
    db: Database,
    flags: Flagship,
    query: LeaderboardQuery,
    page: number,
    viewerId: string | null,
): Promise<LeaderboardPage> {
    const {conditions, binds} = filtersFor(query);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const pageSize = await topScoresPageSize(flags);
    const offset = (page - 1) * pageSize;

    // Independent reads — the viewer's friend list doesn't depend on the
    // page of totals or vice versa — so fetch them concurrently.
    const [{results}, viewerFriendIds] = await Promise.all([
        db
            .prepare(
                `SELECT e.user_id AS user_id, u.username AS username, u.color AS color, SUM(e.score) AS total_score,
                        MAX(e.created_at) AS last_played
                 FROM leaderboard_entries e
                          JOIN users u ON u.id = e.user_id
                     ${where}
                 GROUP BY e.user_id
                 ORDER BY total_score DESC LIMIT ?
                 OFFSET ?`,
            )
            .bind(...binds, pageSize + 1, offset)
            .all<TotalRow>(),
        viewerId ? friendIds(db, viewerId).then((ids) => new Set(ids)) : Promise.resolve(null),
    ]);

    const hasMore = results.length > pageSize;
    const entries = results.slice(0, pageSize).map((row, i) => {
        const entry = toEntry(row, offset + i + 1, query.kind);
        if (viewerFriendIds) entry.isFriend = viewerFriendIds.has(row.user_id);
        return entry;
    });

    return {entries, hasMore};
}

export const FRIENDS_PAGE_SIZE = 10;

/** Leaderboard scoped to `userId` and their friends, 10 to a page —
 * ranked the same way as `topScores` (summed score in the window, highest
 * first) but restricted to that group instead of everyone. `page` is
 * 1-indexed; `rank` reflects standing within the friend group and keeps
 * counting up across pages rather than restarting at 1 each time.
 * Fetches one row past the page boundary instead of a separate COUNT(*)
 * to learn whether another page exists. */
export async function friendScores(
    db: Database,
    userId: string,
    query: LeaderboardQuery,
    page: number,
): Promise<LeaderboardPage> {
    const ids = [userId, ...(await friendIds(db, userId))];
    const {conditions, binds} = filtersFor(query);
    const idPlaceholders = ids.map(() => "?").join(", ");
    const where = [`e.user_id IN (${idPlaceholders})`, ...conditions].join(" AND ");
    const offset = (page - 1) * FRIENDS_PAGE_SIZE;

    const {results} = await db
        .prepare(
            `SELECT e.user_id AS user_id, u.username AS username, u.color AS color, SUM(e.score) AS total_score,
                    MAX(e.created_at) AS last_played
             FROM leaderboard_entries e
                      JOIN users u ON u.id = e.user_id
             WHERE ${where}
             GROUP BY e.user_id
             ORDER BY total_score DESC LIMIT ?
             OFFSET ?`,
        )
        .bind(...ids, ...binds, FRIENDS_PAGE_SIZE + 1, offset)
        .all<TotalRow>();

    const hasMore = results.length > FRIENDS_PAGE_SIZE;
    const entries = results.slice(0, FRIENDS_PAGE_SIZE).map((row, i) => toEntry(row, offset + i + 1, query.kind));

    return {entries, hasMore};
}

export interface MyScore {
    userId: string;
    username: string;
    color: string;
    score: number;
    rank: number | null;
}

/** The given user's total score (0 if they have none in this window) and
 * their rank among everyone who does — computed even when they're outside
 * `topScores`' range. `rank` is null when the user has no score in the
 * window (nothing to rank them against). Returns null only if `userId`
 * doesn't resolve to an account at all. */
export async function myScore(db: Database, userId: string, query: LeaderboardQuery): Promise<MyScore | null> {
    const user = await db
        .prepare("SELECT username, color FROM users WHERE id = ?")
        .bind(userId)
        .first<{ username: string; color: string }>();
    if (!user) return null;

    const {conditions, binds} = filtersFor(query);

    const mine = await db
        .prepare(
            `SELECT COALESCE(SUM(e.score), 0) AS total
             FROM leaderboard_entries e
             WHERE ${[...conditions, "e.user_id = ?"].join(" AND ")}`,
        )
        .bind(...binds, userId)
        .first<{ total: number }>();
    const score = mine?.total ?? 0;
    if (score === 0) return {userId, username: user.username, color: user.color, score: 0, rank: null};

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

    return {userId, username: user.username, color: user.color, score, rank: ranked?.rank ?? 1};
}
