import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema} from "@game-worker/shared/common.schema";
import {GameKindSchema} from "@game-worker/shared/game";
import {err, ok, type Result} from "neverthrow";
import type {AccountRecord} from "@game-worker/shared/rpc-types";
import {currentUser} from "./auth.middleware";
import {createDb} from "./db/client";
import {
    LeaderboardEntrySchema,
    LeaderboardPeriod,
    LeaderboardPeriodSchema,
    LeaderboardScope,
    LeaderboardScopeSchema,
    MyLeaderboardScoreSchema,
} from "./leaderboard.schema";
import {friendScores, type LeaderboardQuery, myScore, topScores} from "./leaderboard.service";

export const leaderboardRoutes = new OpenAPIHono<{Bindings: Env}>();

/** `scope=friends` is the only thing this route can actually reject — it
 * needs a signed-in viewer to know whose friend group to restrict to, so
 * `Err` here is the sole source of the route's 401. Never crosses a Workers
 * RPC boundary (this Worker's own controller calls it directly), so a live
 * `Result` is fine to hand back as-is — same reasoning as browse's
 * `submitRating` (see catalog.service.ts). Passes `user` through unchanged
 * on success so the caller doesn't need to re-derive it. */
function requireViewerFor(
    scope: LeaderboardScope,
    user: AccountRecord | null,
): Result<AccountRecord | null, string> {
    if (scope === LeaderboardScope.Friends && !user)
        return err("log in to see the friends leaderboard");
    return ok(user);
}

leaderboardRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/leaderboard",
        tags: ["Leaderboard"],
        summary: "Top scores, plus the current user's own score and rank",
        description:
            "Scores are per-account only — anonymous/guest play isn't recorded. " +
            "Guess the Prompt awards a time-weighted score per correct guess; " +
            "Piece Puzzle awards one time-weighted score per solve. `entries` is " +
            "paginated, page size sourced from Flagship's `leaderboard-page-size` " +
            "flag for scope=global (10 per page for scope=friends). `me` is null " +
            "when there's no session; its `rank` is null when the user has no " +
            "score in the selected window. `scope=friends` restricts `entries` " +
            "to the signed-in user and their friends, and requires being logged " +
            "in.",
        request: {
            query: z.object({
                kind: GameKindSchema.optional().openapi({description: "Filter to one game type"}),
                period: LeaderboardPeriodSchema.optional().openapi({
                    description: "Defaults to all-time",
                }),
                scope: LeaderboardScopeSchema.optional().openapi({
                    description: "Defaults to global",
                }),
                page: z.coerce
                    .number()
                    .int()
                    .min(1)
                    .optional()
                    .openapi({description: "1-indexed; defaults to 1"}),
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
                            page: z.number(),
                            hasMore: z
                                .boolean()
                                .openapi({description: "Whether a further page exists"}),
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
        const query: LeaderboardQuery = {
            kind: kind ?? null,
            period: period ?? LeaderboardPeriod.All,
        };
        const user = await currentUser(c);

        const viewer = requireViewerFor(scope ?? LeaderboardScope.Global, user);
        if (viewer.isErr()) return c.json({error: viewer.error}, 401);

        const pageNum = page ?? 1;
        const db = createDb(c.env.DB);

        // Independent reads — the current user's standing doesn't depend on
        // the entries list or vice versa — so fetch them concurrently.
        const [{entries, hasMore}, me] = await Promise.all([
            scope === LeaderboardScope.Friends && user
                ? friendScores(db, c.env.FRIENDS, c.env.ACCOUNTS, user.id, query, pageNum)
                : topScores(
                      db,
                      c.env.FLAGS,
                      c.env.ACCOUNTS,
                      c.env.FRIENDS,
                      query,
                      pageNum,
                      user?.id ?? null,
                  ),
            user ? myScore(db, c.env.ACCOUNTS, user.id, query) : Promise.resolve(null),
        ]);

        return c.json({entries, me, page: pageNum, hasMore}, 200);
    },
);
