import {z} from "@hono/zod-openapi";

export const LeaderboardPeriod = {
    All: "all",
    Day: "day",
    Week: "week",
    Month: "month",
} as const;
export type LeaderboardPeriod = (typeof LeaderboardPeriod)[keyof typeof LeaderboardPeriod];
export const LeaderboardPeriodSchema = z.nativeEnum(LeaderboardPeriod).openapi("LeaderboardPeriod");

/** `global` (the default) is everyone; `friends` restricts the list to the
 * signed-in user and their friends and requires being logged in. */
export const LeaderboardScope = {
    Global: "global",
    Friends: "friends",
} as const;
export type LeaderboardScope = (typeof LeaderboardScope)[keyof typeof LeaderboardScope];
export const LeaderboardScopeSchema = z.nativeEnum(LeaderboardScope).openapi("LeaderboardScope");

export const LeaderboardEntrySchema = z
    .object({
        rank: z.number(),
        userId: z.string(),
        username: z.string(),
        color: z.string(),
        score: z.number(),
    })
    .openapi("LeaderboardEntry");

/** The requesting user's own standing in the selected window — present
 * even when they're outside the top N (or have no score at all yet, in
 * which case `score` is 0 and `rank` is null). */
export const MyLeaderboardScoreSchema = z
    .object({
        userId: z.string(),
        username: z.string(),
        color: z.string(),
        score: z.number(),
        rank: z.number().nullable(),
    })
    .openapi("MyLeaderboardScore");
