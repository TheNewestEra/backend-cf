// Leaderboard: aggregates `leaderboard_entries` (one row per scoring event —
// a solved puzzle, a correctly-guessed round; written exclusively through
// `LeaderboardService.recordScore`, this Worker's RPC entrypoint — see
// index.ts) into per-user totals. Kept as an event log rather than a
// running total specifically so time-windowed queries ("top scores this
// week") can filter on created_at directly instead of reconstructing
// history.
//
// Accounts only: anonymous/guest play is never recorded here, so every row
// in the table has a real `users` row behind it — no "guest bucket" to
// special-case. `users` itself is owned by the accounts Worker; display
// names/colors are resolved through its `AccountsRpc.getUsersByIds` (one
// batched round trip per request, not a direct table read) rather than a
// SQL join — see `withUserInfo` below.

import type {AccountRecord, AccountsRpc, FriendsRpc} from "@game-worker/shared/rpc-types";
import type {GameKind} from "@game-worker/shared/game";
import {and, desc, eq, gt, gte, inArray, sql} from "drizzle-orm";
import type {Db} from "./db/client";
import {leaderboardEntries} from "./db/schema";
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
export async function recordScore(db: Db, input: RecordScoreInput): Promise<void> {
    if (input.score <= 0) return;
    await db.insert(leaderboardEntries).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        kind: input.kind,
        sessionId: input.sessionId,
        score: input.score,
        createdAt: Date.now(),
    });
}

export interface LeaderboardQuery {
    kind: LeaderboardKind | null;
    period: LeaderboardPeriod;
}

/** Builds the `kind`/`period` half of a WHERE clause against
 * `leaderboard_entries` — shared by every query below so the two filters
 * can't drift apart. Conditionally includes each condition rather than
 * always emitting both, so `and(...filtersFor(query))` degrades to
 * `undefined` (no WHERE clause at all) when neither filter applies. */
function filtersFor(query: LeaderboardQuery) {
    const conditions = [];
    if (query.kind) conditions.push(eq(leaderboardEntries.kind, query.kind));
    const cutoff = cutoffFor(query.period);
    if (cutoff !== null) conditions.push(gte(leaderboardEntries.createdAt, cutoff));
    return conditions;
}

/** What `totalsQuery` itself returns — no display fields, since it no
 * longer joins `users` (see this file's header). */
interface RawTotalRow {
    userId: string;
    totalScore: number;
    lastPlayed: number;
}

interface TotalRow extends RawTotalRow {
    username: string;
    color: string;
}

/** Resolves each row's `userId` to a display name/color via one batched
 * `AccountsRpc.getUsersByIds` call — the replacement for the SQL join
 * `totalsQuery` used to do directly against `users`. A row whose id doesn't
 * resolve (shouldn't happen — see this file's header on why every
 * `leaderboard_entries.user_id` is a real account) is dropped rather than
 * crashing the whole page. Called with an already-paged slice of rows
 * (never the extra page-boundary row), so it never resolves more accounts
 * than actually end up in the response. */
async function withUserInfo(accounts: AccountsRpc, rows: RawTotalRow[]): Promise<TotalRow[]> {
    if (rows.length === 0) return [];
    const byId = new Map<string, AccountRecord>((await accounts.getUsersByIds(rows.map((r) => r.userId))).map((u) => [u.id, u]));
    return rows.flatMap((row) => {
        const user = byId.get(row.userId);
        return user ? [{...row, username: user.username, color: user.color}] : [];
    });
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
        userId: row.userId,
        username: row.username,
        color: row.color,
        score: row.totalScore,
        kind,
        lastPlayedAt: row.lastPlayed,
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

/** Shared totals query: `leaderboard_entries` GROUPed BY user, ORDERed by
 * summed score descending, page-boundary trick applied via `limit`/`offset`
 * (see call sites for why `limit` is always one past the actual page
 * size). No display fields — those come from `withUserInfo` afterward, not
 * a join, so this never resolves more accounts than the actual page needs.
 * The `SUM(...)` expression is built once and reused in both `select` and
 * `orderBy` so the ORDER BY unambiguously refers to the same aggregate
 * rather than a string alias. */
function totalsQuery(db: Db, where: ReturnType<typeof and>, limit: number, offset: number) {
    const totalScore = sql<number>`SUM(${leaderboardEntries.score})`;
    return db
        .select({
            userId: leaderboardEntries.userId,
            totalScore,
            lastPlayed: sql<number>`MAX(${leaderboardEntries.createdAt})`,
        })
        .from(leaderboardEntries)
        .where(where)
        .groupBy(leaderboardEntries.userId)
        .orderBy(desc(totalScore))
        .limit(limit)
        .offset(offset);
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
    db: Db,
    flags: Flagship,
    accounts: AccountsRpc,
    friends: FriendsRpc,
    query: LeaderboardQuery,
    page: number,
    viewerId: string | null,
): Promise<LeaderboardPage> {
    const where = and(...filtersFor(query));
    const pageSize = await topScoresPageSize(flags);
    const offset = (page - 1) * pageSize;

    // Independent reads — the viewer's friend list doesn't depend on the
    // page of totals or vice versa — so fetch them concurrently. Display
    // fields are resolved afterward, only for the page that actually ships
    // (see `withUserInfo`), since they depend on `rawResults`.
    const [rawResults, viewerFriendIds] = await Promise.all([
        totalsQuery(db, where, pageSize + 1, offset),
        viewerId ? friends.getFriendIds(viewerId).then((ids) => new Set(ids)) : Promise.resolve(null),
    ]);

    const hasMore = rawResults.length > pageSize;
    const results = await withUserInfo(accounts, rawResults.slice(0, pageSize));
    const entries = results.map((row, i) => {
        const entry = toEntry(row, offset + i + 1, query.kind);
        if (viewerFriendIds) entry.isFriend = viewerFriendIds.has(row.userId);
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
    db: Db,
    friends: FriendsRpc,
    accounts: AccountsRpc,
    userId: string,
    query: LeaderboardQuery,
    page: number,
): Promise<LeaderboardPage> {
    const ids = [userId, ...(await friends.getFriendIds(userId))];
    const where = and(inArray(leaderboardEntries.userId, ids), ...filtersFor(query));
    const offset = (page - 1) * FRIENDS_PAGE_SIZE;

    const rawResults = await totalsQuery(db, where, FRIENDS_PAGE_SIZE + 1, offset);

    const hasMore = rawResults.length > FRIENDS_PAGE_SIZE;
    const results = await withUserInfo(accounts, rawResults.slice(0, FRIENDS_PAGE_SIZE));
    const entries = results.map((row, i) => toEntry(row, offset + i + 1, query.kind));

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
export async function myScore(db: Db, accounts: AccountsRpc, userId: string, query: LeaderboardQuery): Promise<MyScore | null> {
    const user = await accounts.getUserById(userId);
    if (!user) return null;

    const conditions = filtersFor(query);

    const mine = await db
        .select({total: sql<number>`COALESCE(SUM(${leaderboardEntries.score}), 0)`})
        .from(leaderboardEntries)
        .where(and(...conditions, eq(leaderboardEntries.userId, userId)))
        .get();
    const score = mine?.total ?? 0;
    if (score === 0) return {userId, username: user.username, color: user.color, score: 0, rank: null};

    const totals = db
        .select({
            userId: leaderboardEntries.userId,
            totalScore: sql<number>`SUM(${leaderboardEntries.score})`.as("total_score"),
        })
        .from(leaderboardEntries)
        .where(and(...conditions))
        .groupBy(leaderboardEntries.userId)
        .as("t");

    const ranked = await db
        .select({rank: sql<number>`COUNT(*) + 1`})
        .from(totals)
        .where(gt(totals.totalScore, score))
        .get();

    return {userId, username: user.username, color: user.color, score, rank: ranked?.rank ?? 1};
}
