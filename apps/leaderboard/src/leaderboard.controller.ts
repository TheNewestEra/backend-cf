import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema} from "@game-worker/shared/common.schema";
import {GameKindSchema} from "@game-worker/shared/game";
import {currentUser} from "./auth.middleware";
import {
    LeaderboardEntrySchema,
    LeaderboardPeriod,
    LeaderboardPeriodSchema,
    LeaderboardScope,
    LeaderboardScopeSchema,
    MyLeaderboardScoreSchema,
} from "./leaderboard.schema";
import {friendScores, type LeaderboardQuery, myScore, topScores} from "./leaderboard.service";

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
            "score in the selected window. `scope=friends` restricts `entries` to " +
            "the signed-in user and their friends, 10 per page, and requires " +
            "being logged in.",
        request: {
            query: z.object({
                kind: GameKindSchema.optional().openapi({description: "Filter to one game type"}),
                period: LeaderboardPeriodSchema.optional().openapi({description: "Defaults to all-time"}),
                scope: LeaderboardScopeSchema.optional().openapi({description: "Defaults to global"}),
                page: z.coerce
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .openapi({description: "1-indexed; only meaningful for scope=friends, which returns 10 entries per page"}),
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
                            page: z.number().openapi({description: "Always 1 for scope=global"}),
                            hasMore: z.boolean().openapi({description: "Whether a further page exists; always false for scope=global"}),
                        }),
                    },
                },
            },
            401: {
                description: "scope=friends requires being logged in",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {kind, period, scope, page} = c.req.valid("query");
        const query: LeaderboardQuery = {kind: kind ?? null, period: period ?? LeaderboardPeriod.All};
        const user = await currentUser(c);

        if (scope === LeaderboardScope.Friends && !user) {
            return c.json({error: "log in to see the friends leaderboard"}, 401);
        }

        const pageNum = page ?? 1;

        // Independent reads — the current user's standing doesn't depend on
        // the entries list or vice versa — so fetch them concurrently.
        const [{entries, hasMore}, me] = await Promise.all([
            scope === LeaderboardScope.Friends && user
                ? friendScores(c.env.DB, user.id, query, pageNum)
                : topScores(c.env.DB, query).then((entries) => ({entries, hasMore: false})),
            user ? myScore(c.env.DB, user.id, query) : Promise.resolve(null),
        ]);

        return c.json({entries, me, page: scope === LeaderboardScope.Friends ? pageNum : 1, hasMore}, 200);
    },
);
