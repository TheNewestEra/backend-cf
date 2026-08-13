import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {maxPlayerLength, maxThemeLength} from "@game-worker/shared/game-session";
import {hostActionError} from "@game-worker/shared/http-exceptions";
import {immutableImageResponse} from "@game-worker/shared/images";
import {fromRpcResult} from "@game-worker/shared/rpc-result";
import {currentUser} from "./auth.middleware";
import {HostBodySchema, imageKeyFor} from "./guess.constants";
import type {GuessQueueMessage} from "./guess.queue";
import {GamePublicSchema, JoinResultSchema, ROUND_VISIBLE_STATUSES} from "./guess.schema";

export const guessRoutes = new OpenAPIHono<{ Bindings: Env }>();

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games",
        tags: ["Guess the Prompt"],
        summary: "Create a new game",
        description:
            "Enqueues generation (each round is an AI prompt + image — see GET /games/{id}'s rounds array for how " +
            "many this particular game has); poll GET /games/{id} or connect to the WebSocket for progress. The " +
            "returned hostToken authorizes starting the lobby early for this game (replaying it later gets its " +
            "own, separate host token). The host is auto-joined as this game's first participant — a logged-in " +
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
                            player: z.string().optional().openapi({
                                description: "Anonymous-host display name — ignored (and unnecessary) when logged in.",
                            }),
                            color: z.string().optional().openapi({
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
                        schema: JoinResultSchema.extend({gameId: z.string(), hostToken: z.string()}),
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
        const user = await currentUser(c);
        const maxPlayer = await maxPlayerLength(c.env.FLAGS);
        const player = user ? user.username : (body.player?.trim().slice(0, maxPlayer) ?? "");
        if (!player) return c.json({error: "player is required"}, 400);

        const maxTheme = await maxThemeLength(c.env.FLAGS);
        const theme = body.theme?.trim() ? body.theme.trim().slice(0, maxTheme) : null;

        const gameId = crypto.randomUUID();
        const stub = c.env.GAME_DO.getByName(gameId);
        // Same technique browse's catalog.service.ts uses for
        // `thumbnailUrl` — captured once here (rather than per-read) since
        // later broadcasts (queue consumer, DO alarm) have no request of
        // their own to derive it from. See GameRow's `origin` field.
        const origin = new URL(c.req.url).origin;
        const hostToken = await stub.init(gameId, theme, origin);
        // The game is freshly `queued` (a JOINABLE_STATUS), so this can't
        // actually reject — see guess.model.ts's `join()`.
        const joined = fromRpcResult(await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null));
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        await c.env.BROWSE.insertCatalogEntry(gameId, "guess", theme, {id: user?.id ?? null, name: player, color: joined.value.color});
        await c.env.GAME_QUEUE.send({gameId, theme} satisfies GuessQueueMessage);

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
            200: {description: "Game state", content: {"application/json": {schema: GamePublicSchema}}},
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const stub = c.env.GAME_DO.getByName(id);
        return c.json(await stub.getState(), 200);
    },
);

// Not OpenAPI-documented: this is a WebSocket upgrade, not a request/response
// JSON endpoint — OpenAPI 3 has no representation for it. Carries more than
// broadcasts out — joining, guessing, and revealing are all sent as messages
// over this same connection now (see guess.schema.ts's
// `GameWsClientMessageSchema` and guess.model.ts's `webSocketMessage()`);
// there's no separate POST for any of them any more.
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
            403: {description: "Missing/incorrect host token", content: {"application/json": {schema: ErrorSchema}}},
            409: {description: "Game isn't waiting to start", content: {"application/json": {schema: ErrorSchema}}},
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
        path: "/games/{id}/replay",
        tags: ["Guess the Prompt"],
        summary: "Start a brand-new game with the same theme",
        description:
            "Creates an independent game instance (its own id, lobby, host token, rounds, and guesses) seeded from " +
            "this one's theme and re-runs generation — it never touches the source game, so anyone can replay a " +
            "game they're spectating/browsing and invite their own friends to the new instance without disrupting " +
            "whoever's still playing the original. The host is auto-joined as this new game's first participant, " +
            "same as POST /games — a logged-in caller joins under their account name/color; an anonymous caller " +
            "must supply `player` (and, optionally, `color`). `participantId`/`token`/`color` come back already " +
            "resolved.",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            player: z.string().optional().openapi({
                                description: "Anonymous-host display name — ignored (and unnecessary) when logged in.",
                            }),
                            color: z.string().optional().openapi({
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
                        schema: JoinResultSchema.extend({gameId: z.string(), hostToken: z.string()}),
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
        const {id: sourceId} = c.req.valid("param");
        const body = c.req.valid("json") ?? {};
        const user = await currentUser(c);
        const maxPlayer = await maxPlayerLength(c.env.FLAGS);
        const player = user ? user.username : (body.player?.trim().slice(0, maxPlayer) ?? "");
        if (!player) return c.json({error: "player is required"}, 400);

        const source = await c.env.GAME_DO.getByName(sourceId).getState();

        const gameId = crypto.randomUUID();
        const stub = c.env.GAME_DO.getByName(gameId);
        const origin = new URL(c.req.url).origin;
        const hostToken = await stub.init(gameId, source.theme, origin);
        // The game is freshly `queued` (a JOINABLE_STATUS), so this can't
        // actually reject — see guess.model.ts's `join()`.
        const joined = fromRpcResult(await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null));
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        await c.env.BROWSE.insertCatalogEntry(gameId, "guess", source.theme, {id: user?.id ?? null, name: player, color: joined.value.color});
        await c.env.GAME_QUEUE.send({gameId, theme: source.theme} satisfies GuessQueueMessage);

        return c.json({gameId, hostToken, ...joined.value}, 202);
    },
);

guessRoutes.openapi(
    createRoute({
        method: "get",
        path: "/games/{id}/images/{index}",
        tags: ["Guess the Prompt"],
        summary: "Get a round's generated image",
        description:
            "Raw image bytes, not JSON — the same image a round's public state points at once that round becomes " +
            "the active one. Spoiler-gated until then: a round not yet its turn 404s even once its image exists, " +
            "same as one that hasn't generated yet — visible again once it's the current round, and stays visible " +
            "forever after (including once the game finishes, for post-game review). Immutable/long-cached once " +
            "served, since a round's image never changes after it's generated.",
        request: {
            params: z.object({
                id: z.string(),
                // Kept as a plain string (not z.coerce.number()) so an
                // out-of-range/non-numeric index still 404s exactly like a
                // missing image, rather than the validator's 400 — see the
                // manual check below.
                index: z.string().openapi({description: "0-based round index (see this game's rounds array for the valid count)"}),
            }),
        },
        responses: {
            200: {
                description: "Round image",
                content: {"image/png": {schema: z.string().openapi({format: "binary"})}},
            },
            404: {description: "No such game/round, the image hasn't generated yet, or it isn't this round's turn yet"},
        },
    }),
    async (c) => {
        const {id: gameId, index: rawIndex} = c.req.valid("param");
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0) return c.notFound();

        const state = await c.env.GAME_DO.getByName(gameId).getState();
        const round = state.rounds[index];
        if (!round || !ROUND_VISIBLE_STATUSES.includes(round.status)) return c.notFound();

        const object = await c.env.IMAGES.get(imageKeyFor(gameId, index));
        if (!object) return c.notFound();

        return immutableImageResponse(object);
    },
);
