import { z } from "@hono/zod-openapi";

export const LeaderboardPeriodSchema = z.enum(["all", "day", "week", "month"]).openapi("LeaderboardPeriod");

export const LeaderboardEntrySchema = z
  .object({
    rank: z.number(),
    userId: z.string(),
    username: z.string(),
    score: z.number(),
  })
  .openapi("LeaderboardEntry");

/** The requesting user's own standing in the selected window — present
 * even when they're outside the top 10 (or have no score at all yet, in
 * which case `score` is 0 and `rank` is null). */
export const MyLeaderboardScoreSchema = z
  .object({
    userId: z.string(),
    username: z.string(),
    score: z.number(),
    rank: z.number().nullable(),
  })
  .openapi("MyLeaderboardScore");
