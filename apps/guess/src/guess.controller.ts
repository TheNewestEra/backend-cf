import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {maxPlayerLength, maxThemeLength} from "@game-worker/shared/game-session";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {hostActionError} from "@game-worker/shared/http-exceptions";
import {CACHE_CONTROL_IMMUTABLE} from "@game-worker/shared/images";
import {fromRpcResult} from "@game-worker/shared/rpc-result";
import {currentUser} from "./auth.middleware";
import {HostBodySchema, imageKeyFor} from "./guess.constants";
import type {GuessQueueMessage} from "./guess.queue";
import type {GamePublic} from "./guess.model";
import type {RoundPublic} from "./guess.schema";
import {GamePublicSchema, JoinResultSchema} from "./guess.schema";

export const guessRoutes = new OpenAPIHono<{Bindings: Env}>();

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games",
        tags: ["Guess the Prompt"],
        summary: "Create a new game",
        description:
            "Enqueues generation (each round is an AI prompt + image — see GET /games/{id}'s rounds array for how " +
            "many this particular game has); poll GET /games/{id} or connect to the WebSocket for progress. " +
            "Without `theme`, one gets picked for you (a Flagship preset, or the prompt model's own idea) — " +
            "GamePublic's `theme`/`themeGenerated` report what was actually used once generation resolves it. The " +
            "returned hostToken authorizes starting the lobby early for this game (replaying it later gets its " +
            "own, separate host token). `roundCount` and `roundTimeLimitSeconds`, if given, are each clamped to " +
            "their own configured [min, max] rather than rejected out of range. The host is auto-joined as this game's first participant — a logged-in " +
            "caller joins under their account name/color; an anonymous caller must supply `player` (and, " +
            "optionally, `color`), same as POST /games/{id}/ws's `join` message. `participantId`/`token`/`color` " +
            "come back already resolved, so the host's client can guess/reveal immediately without sending its " +
            "own `join` message first.",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            theme: z.string().optional(),
                            roundCount: z
                                .number()
                                .int()
                                .optional()
                                .openapi({
                                    description:
                                        "How many rounds this game has — clamped to this game's configured " +
                                        "[min, max] rather than rejected out of range. Absent a value, falls back " +
                                        'to Flagship\'s "round-count" flag.',
                                }),
                            roundTimeLimitSeconds: z
                                .number()
                                .int()
                                .optional()
                                .openapi({
                                    description:
                                        "How long each round's guess countdown runs, in seconds — clamped to " +
                                        "this game's configured [min, max] rather than rejected out of range, " +
                                        "and applied to every round of this game. Absent a value, falls back to " +
                                        'Flagship\'s "guess-time-seconds" flag.',
                                }),
                            player: z.string().optional().openapi({
                                description:
                                    "Anonymous-host display name — ignored (and unnecessary) when logged in.",
                            }),
                            color: z
                                .string()
                                .optional()
                                .openapi({
                                    description:
                                        "Anonymous-host color; must look like generateColor()'s output (`#`+6 hex " +
                                        "digits) or it's discarded in favor of a generated one. Ignored when logged " +
                                        "in — an account's color is always authoritative.",
                                }),
                        }),
                    },
                },
                required: false,
            },
        },
        responses: {
            202: {
                description: "Generation queued; the host is already joined",
                content: {
                    "application/json": {
                        schema: JoinResultSchema.extend({
                            gameId: z.string(),
                            hostToken: z.string(),
                        }),
                    },
                },
            },
            400: {
                description: "Missing player name (required for an anonymous host)",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const body = c.req.valid("json") ?? {};
        const [user, maxPlayer] = await Promise.all([currentUser(c), maxPlayerLength(c.env.FLAGS)]);
        const player = user ? user.username : (body.player?.trim().slice(0, maxPlayer) ?? "");
        if (!player) return c.json({error: "player is required"}, 400);

        const maxTheme = await maxThemeLength(c.env.FLAGS);
        const theme = body.theme?.trim() ? body.theme.trim().slice(0, maxTheme) : null;

        const gameId = crypto.randomUUID();
        const stub = c.env.GAME_DO.getByName(gameId);
        const origin = new URL(c.req.url).origin;
        const hostToken = await stub.init(
            gameId,
            theme,
            origin,
            body.roundCount,
            body.roundTimeLimitSeconds,
        );
        const joined = fromRpcResult(
            await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null),
        );
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        const themeGenerated = theme === null;
        await c.env.BROWSE.insertCatalogEntry(
            gameId,
            "guess",
            theme,
            {id: user?.id ?? null, name: player, color: joined.value.color},
            null,
            themeGenerated,
        );
        await c.env.GAME_QUEUE.send({gameId, theme, themeGenerated} satisfies GuessQueueMessage);

        return c.json({gameId, hostToken, ...joined.value}, 202);
    },
);

guessRoutes.openapi(
    createRoute({
        method: "get",
        path: "/games/{id}",
        tags: ["Guess the Prompt"],
        summary: "Get a game's current state",
        request: {params: z.object({id: z.string()})},
        responses: {
            200: {
                description: "Game state",
                content: {"application/json": {schema: GamePublicSchema}},
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const stub = c.env.GAME_DO.getByName(id);
        return c.json(await stub.getState(), 200);
    },
);

guessRoutes.get("/games/:id/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
        return c.text("Expected WebSocket", 426);
    }
    const stub = c.env.GAME_DO.getByName(c.req.param("id"));
    return stub.fetch(c.req.raw);
});

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games/{id}/start",
        tags: ["Guess the Prompt"],
        summary: "Host-only: end the lobby countdown early and start play",
        request: {
            params: z.object({id: z.string()}),
            body: {content: {"application/json": {schema: HostBodySchema}}, required: false},
        },
        responses: {
            200: {description: "Started", content: {"application/json": {schema: OkSchema}}},
            403: {
                description: "Missing/incorrect host token",
                content: {"application/json": {schema: ErrorSchema}},
            },
            409: {
                description: "Game isn't waiting to start",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {hostToken} = c.req.valid("json");
        const stub = c.env.GAME_DO.getByName(id);
        const result = fromRpcResult(await stub.startNow(hostToken ?? ""));
        if (result.isErr()) {
            const {status, body} = hostActionError(result.error);
            return c.json(body, status);
        }
        return c.json({ok: true as const}, 200);
    },
);

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games/{id}/regenerate",
        tags: ["Guess the Prompt"],
        summary: "Start a brand-new game with the same theme, freshly generated",
        description:
            "Only once this game is finished (solved/timeout). Creates an independent game instance (its own id, " +
            "lobby, host token, rounds, and guesses) seeded from this one's theme and re-runs generation (fresh " +
            "AI prompts/images) — it never touches the source game, so anyone can regenerate a game they're " +
            "spectating/browsing and invite their own friends to the new instance without disrupting whoever's " +
            "still viewing the original. Same as POST /games/{id}/replay except the new instance's rounds are " +
            "freshly generated rather than copied — see that endpoint instead if you want the exact same rounds. " +
            "The host is auto-joined as this new game's first participant, same as POST /games — a logged-in " +
            "caller joins under their account name/color; an anonymous caller must supply `player` (and, " +
            "optionally, `color`). `participantId`/`token`/`color` come back already resolved.",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            player: z.string().optional().openapi({
                                description:
                                    "Anonymous-host display name — ignored (and unnecessary) when logged in.",
                            }),
                            color: z
                                .string()
                                .optional()
                                .openapi({
                                    description:
                                        "Anonymous-host color; must look like generateColor()'s output (`#`+6 hex " +
                                        "digits) or it's discarded in favor of a generated one. Ignored when logged " +
                                        "in — an account's color is always authoritative.",
                                }),
                        }),
                    },
                },
                required: false,
            },
        },
        responses: {
            202: {
                description: "New game's generation queued; the host is already joined",
                content: {
                    "application/json": {
                        schema: JoinResultSchema.extend({
                            gameId: z.string(),
                            hostToken: z.string(),
                        }),
                    },
                },
            },
            400: {
                description: "Missing player name (required for an anonymous host)",
                content: {"application/json": {schema: ErrorSchema}},
            },
            409: {
                description: "Source game isn't finished yet",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {id: sourceId} = c.req.valid("param");
        const body = c.req.valid("json") ?? {};
        const [user, maxPlayer] = await Promise.all([currentUser(c), maxPlayerLength(c.env.FLAGS)]);
        const player = user ? user.username : (body.player?.trim().slice(0, maxPlayer) ?? "");
        if (!player) return c.json({error: "player is required"}, 400);

        const source: GamePublic = await c.env.GAME_DO.getByName(sourceId).getState();
        if (
            source.status !== GameSessionStatus.Solved &&
            source.status !== GameSessionStatus.Timeout
        ) {
            return c.json({error: "game must be finished before regenerating"}, 409);
        }

        const gameId = crypto.randomUUID();
        const stub = c.env.GAME_DO.getByName(gameId);
        const origin = new URL(c.req.url).origin;
        const hostToken = await stub.init(gameId, source.theme, origin);
        // The game is freshly `queued` (a JOINABLE_STATUS), so this can't
        // actually reject — see guess.model.ts's `join()`.
        const joined = fromRpcResult(
            await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null),
        );
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        await c.env.BROWSE.insertCatalogEntry(
            gameId,
            "guess",
            source.theme,
            {id: user?.id ?? null, name: player, color: joined.value.color},
            sourceId,
            source.themeGenerated,
            "regenerate",
        );
        await c.env.GAME_QUEUE.send({
            gameId,
            theme: source.theme,
            themeGenerated: source.themeGenerated,
        } satisfies GuessQueueMessage);

        return c.json({gameId, hostToken, ...joined.value}, 202);
    },
);

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games/{id}/replay",
        tags: ["Guess the Prompt"],
        summary: "Start a brand-new game with the same rounds",
        description:
            "Only once this game is finished (solved/timeout). Creates an independent game instance (its own id, " +
            "lobby, host token, rounds, and guesses) that reuses the same round prompts/images without a fresh AI " +
            "call — it never touches the source game, so anyone can replay a game they're spectating/browsing and " +
            "invite their own friends to the new instance without disrupting whoever's still viewing the original. " +
            "Same as POST /games/{id}/regenerate except the new instance's rounds are copied rather than freshly " +
            "generated — see that endpoint instead if you want a fresh take on the same theme. " +
            "The host is auto-joined as this new game's first participant, same as POST /games — a logged-in " +
            "caller joins under their account name/color; an anonymous caller must supply `player` (and, " +
            "optionally, `color`). `participantId`/`token`/`color` come back already resolved.",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            player: z.string().optional().openapi({
                                description:
                                    "Anonymous-host display name — ignored (and unnecessary) when logged in.",
                            }),
                            color: z
                                .string()
                                .optional()
                                .openapi({
                                    description:
                                        "Anonymous-host color; must look like generateColor()'s output (`#`+6 hex " +
                                        "digits) or it's discarded in favor of a generated one. Ignored when logged " +
                                        "in — an account's color is always authoritative.",
                                }),
                        }),
                    },
                },
                required: false,
            },
        },
        responses: {
            202: {
                description: "New game created, waiting in its lobby; the host is already joined",
                content: {
                    "application/json": {
                        schema: JoinResultSchema.extend({
                            gameId: z.string(),
                            hostToken: z.string(),
                        }),
                    },
                },
            },
            400: {
                description: "Missing player name (required for an anonymous host)",
                content: {"application/json": {schema: ErrorSchema}},
            },
            409: {
                description: "Source game isn't finished yet, or has no images",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {id: sourceId} = c.req.valid("param");
        const body = c.req.valid("json") ?? {};
        // Independent reads — neither depends on the other's result — so
        // fetch them concurrently.
        const [user, maxPlayer] = await Promise.all([currentUser(c), maxPlayerLength(c.env.FLAGS)]);
        const player = user ? user.username : (body.player?.trim().slice(0, maxPlayer) ?? "");
        if (!player) return c.json({error: "player is required"}, 400);

        const source: GamePublic = await c.env.GAME_DO.getByName(sourceId).getState();
        if (
            source.status !== GameSessionStatus.Solved &&
            source.status !== GameSessionStatus.Timeout
        ) {
            return c.json({error: "game must be finished before replaying"}, 409);
        }
        // Every round's `prompt` is only exposed once it's resolved (see
        // ROUND_RESOLVED_STATUSES) — a finished game has resolved every
        // round, so this is really just a defensive check, same spirit as
        // Piece Puzzle's own "no image to replay" guard. `RoundPublic`
        // annotated explicitly on the callback — `GamePublicSchema`'s
        // `.openapi()`-decorated array field doesn't carry a concrete
        // element type back through the DO RPC stub's return type.
        const prompts: (string | null)[] = source.rounds.map((r: RoundPublic) => r.prompt);
        if (prompts.length === 0 || prompts.some((p: string | null) => !p)) {
            return c.json({error: "no images to replay"}, 409);
        }

        const gameId = crypto.randomUUID();
        const origin = new URL(c.req.url).origin;
        // Copy every round's image into the new game's own R2 keys rather
        // than spending a fresh AI call per round — mirrors POST
        // /puzzles/{id}/replay's image copy.
        for (let index = 0; index < prompts.length; index++) {
            const sourceImage = await c.env.IMAGES.get(imageKeyFor(sourceId, index));
            if (!sourceImage) return c.json({error: "no images to replay"}, 409);
            await c.env.IMAGES.put(imageKeyFor(gameId, index), sourceImage.body, {
                httpMetadata: {
                    ...sourceImage.httpMetadata,
                    cacheControl: CACHE_CONTROL_IMMUTABLE,
                },
            });
        }

        const stub = c.env.GAME_DO.getByName(gameId);
        const hostToken = await stub.initFromSource(
            gameId,
            source.theme,
            origin,
            prompts as string[],
            source.themeGenerated,
        );
        // The game is freshly `waiting` (a JOINABLE_STATUS), so this can't
        // actually reject — see guess.model.ts's `join()`.
        const joined = fromRpcResult(
            await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null),
        );
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        await c.env.BROWSE.insertCatalogEntry(
            gameId,
            "guess",
            source.theme,
            {id: user?.id ?? null, name: player, color: joined.value.color},
            sourceId,
            source.themeGenerated,
            "replay",
        );
        await c.env.BROWSE.markCatalogReady(gameId, imageKeyFor(gameId, 0));

        return c.json({gameId, hostToken, ...joined.value}, 202);
    },
);
