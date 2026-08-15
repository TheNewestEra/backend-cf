import {z} from "@hono/zod-openapi";
import {GameKindSchema} from "@game-worker/shared/game";

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
        kind: GameKindSchema.nullable().openapi({description: "Echoes the request's `kind` filter; null when unfiltered (totals span both games)"}),
        lastPlayedAt: z.number().openapi({description: "Epoch ms of this user's most recent scoring event counted in `score`"}),
        isFriend: z
            .boolean()
            .nullable()
            .optional()
            .openapi({description: "Whether this row's user is a friend of the signed-in requester; true for every row under scope=friends, null for the viewer's own row, and omitted when there's no session"}),
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
