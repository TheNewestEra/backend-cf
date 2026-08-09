import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { currentUser } from "./auth.middleware";
import { LeaderboardEntrySchema, LeaderboardPeriodSchema, MyLeaderboardScoreSchema } from "./leaderboard.schema";
import { type LeaderboardQuery, myScore, topScores } from "./leaderboard.service";

export const leaderboardRoutes = new OpenAPIHono<{ Bindings: Env }>();

leaderboardRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/leaderboard",
    tags: ["Leaderboard"],
    summary: "Top 10 scores, plus the current user's own score and rank",
    description:
      "Scores are per-account only — anonymous/guest play isn't recorded. " +
      "Guess the Prompt awards a time-weighted score per correct guess; " +
      "Piece Puzzle awards one time-weighted score per solve. `me` is null " +
      "when there's no session; its `rank` is null when the user has no " +
      "score in the selected window.",
    request: {
      query: z.object({
        kind: z.enum(["guess", "puzzle"]).optional().openapi({ description: "Filter to one game type" }),
        period: LeaderboardPeriodSchema.optional().openapi({ description: "Defaults to all-time" }),
      }),
    },
    responses: {
      200: {
        description: "Leaderboard",
        content: {
          "application/json": {
            schema: z.object({
              entries: z.array(LeaderboardEntrySchema),
              me: MyLeaderboardScoreSchema.nullable(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const { kind, period } = c.req.valid("query");
    const query: LeaderboardQuery = { kind: kind ?? null, period: period ?? "all" };
    const user = await currentUser(c);

    // Independent reads — the current user's standing doesn't depend on
    // the top-10 list or vice versa — so fetch them concurrently.
    const [entries, me] = await Promise.all([
      topScores(c.env.DB, query),
      user ? myScore(c.env.DB, user.id, query) : Promise.resolve(null),
    ]);

    return c.json({ entries, me }, 200);
  },
);
