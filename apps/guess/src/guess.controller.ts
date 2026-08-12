import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {maxPlayerLength, maxThemeLength} from "@game-worker/shared/game-session";
import {hostActionError} from "@game-worker/shared/http-exceptions";
import {immutableImageResponse} from "@game-worker/shared/images";
import {fromRpcResult} from "@game-worker/shared/rpc-result";
import {currentUser} from "./auth.middleware";
import {HostBodySchema, imageKeyFor} from "./guess.constants";
import type {GuessQueueMessage} from "./guess.queue";
import {GamePublicSchema, GuessResultSchema, JoinResultSchema, ROUND_VISIBLE_STATUSES} from "./guess.schema";

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
            "own, separate host token).",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({theme: z.string().optional()}),
                    },
                },
                required: false,
            },
        },
        responses: {
            202: {
                description: "Generation queued",
                content: {"application/json": {schema: z.object({gameId: z.string(), hostToken: z.string()})}},
            },
        },
    }),
    async (c) => {
        const body = c.req.valid("json") ?? {};
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
        await c.env.BROWSE.insertCatalogEntry(gameId, "guess", theme);
        await c.env.GAME_QUEUE.send({gameId, theme} satisfies GuessQueueMessage);

        return c.json({gameId, hostToken}, 202);
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
// JSON endpoint — OpenAPI 3 has no representation for it.
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
            "whoever's still playing the original.",
        request: {params: z.object({id: z.string()})},
        responses: {
            202: {
                description: "New game's generation queued",
                content: {"application/json": {schema: z.object({gameId: z.string(), hostToken: z.string()})}},
            },
        },
    }),
    async (c) => {
        const {id: sourceId} = c.req.valid("param");
        const source = await c.env.GAME_DO.getByName(sourceId).getState();

        const gameId = crypto.randomUUID();
        const stub = c.env.GAME_DO.getByName(gameId);
        const origin = new URL(c.req.url).origin;
        const hostToken = await stub.init(gameId, source.theme, origin);
        await c.env.BROWSE.insertCatalogEntry(gameId, "guess", source.theme);
        await c.env.GAME_QUEUE.send({gameId, theme: source.theme} satisfies GuessQueueMessage);

        return c.json({gameId, hostToken}, 202);
    },
);

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games/{id}/join",
        tags: ["Guess the Prompt"],
        summary: "Join a game as a player before it starts",
        description:
            "Must be called (and must succeed) before submitting any guess or reveal — it's what distinguishes a " +
            "player from a spectator. Only possible while rounds are still generating or the lobby is open " +
            "(`queued`/`generating`/`waiting`); once the game is `playing` this returns " +
            "409 and late arrivals can only spectate over the WebSocket. Logged-in players are identified by their " +
            "session and keep their account color; `player` is only used for anonymous guests, who get back a " +
            "`token` they must resend with every guess/reveal, plus a freshly generated `color`.",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {schema: z.object({player: z.string().optional()})},
                },
                required: false,
            },
        },
        responses: {
            200: {description: "Joined", content: {"application/json": {schema: JoinResultSchema}}},
            400: {description: "Missing player name", content: {"application/json": {schema: ErrorSchema}}},
            409: {description: "Game has already started", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const body = c.req.valid("json") ?? {};
        const user = await currentUser(c);
        const maxPlayer = await maxPlayerLength(c.env.FLAGS);
        const player = user ? user.username : (body.player?.trim().slice(0, maxPlayer) ?? "");

        if (!player) return c.json({error: "player is required"}, 400);

        const stub = c.env.GAME_DO.getByName(id);
        const result = fromRpcResult(await stub.join(user?.id ?? null, player, user?.color ?? null));
        if (result.isErr()) {
            // join() only ever rejects with the "already started" case
            // (never a "forbidden: ..." one), so this is always a 409 —
            // unlike the participant-gated actions below, there's no
            // host/participant check to fail here.
            return c.json({error: result.error}, 409);
        }
        return c.json(result.value, 200);
    },
);

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games/{id}/guess",
        tags: ["Guess the Prompt"],
        summary: "Submit a guess for a round",
        description:
            "Requires having joined via POST /games/{id}/join first — see that endpoint for why. `index` isn't " +
            "bounds-checked against this game's actual round count here (that count is per-game, see GET " +
            "/games/{id}'s rounds array) — an out-of-range index just 409s the same as any other round that isn't " +
            "currently active.",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            index: z.number().int().min(0),
                            participantId: z.string(),
                            token: z.string().optional(),
                            guess: z.string(),
                        }),
                    },
                },
            },
        },
        responses: {
            200: {description: "Guess result", content: {"application/json": {schema: GuessResultSchema}}},
            400: {description: "Missing/invalid fields", content: {"application/json": {schema: ErrorSchema}}},
            403: {
                description: "Didn't join this game before it started",
                content: {"application/json": {schema: ErrorSchema}}
            },
            409: {
                description: "Round isn't the currently active one, or you already answered it correctly",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {index, participantId, token, guess: rawGuess} = c.req.valid("json");
        const user = await currentUser(c);
        const guess = rawGuess.trim();

        if (!guess) return c.json({error: "guess is required"}, 400);

        const stub = c.env.GAME_DO.getByName(id);
        const result = fromRpcResult(await stub.submitGuess(index, participantId, token ?? null, guess, user?.id ?? null));
        if (result.isErr()) {
            const {status, body} = hostActionError(result.error);
            return c.json(body, status);
        }
        return c.json(result.value, 200);
    },
);

guessRoutes.openapi(
    createRoute({
        method: "post",
        path: "/games/{id}/reveal",
        tags: ["Guess the Prompt"],
        summary: "Reveal a round's prompt without guessing",
        description:
            "Requires having joined via POST /games/{id}/join first — see that endpoint for why. `index` isn't " +
            "bounds-checked against this game's actual round count here — see POST /games/{id}/guess's note on " +
            "the same thing.",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            index: z.number().int().min(0),
                            participantId: z.string(),
                            token: z.string().optional(),
                        }),
                    },
                },
            },
        },
        responses: {
            200: {
                description: "Revealed prompt",
                content: {"application/json": {schema: z.object({prompt: z.string()})}}
            },
            403: {
                description: "Didn't join this game before it started",
                content: {"application/json": {schema: ErrorSchema}}
            },
            409: {
                description: "No such round, or it isn't visible yet (not the active round or a past one)",
                content: {"application/json": {schema: ErrorSchema}}
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {index, participantId, token} = c.req.valid("json");
        const user = await currentUser(c);

        const stub = c.env.GAME_DO.getByName(id);
        const result = fromRpcResult(await stub.revealRound(index, participantId, token ?? null, user?.id ?? null));
        if (result.isErr()) {
            const {status, body} = hostActionError(result.error);
            return c.json(body, status);
        }
        if (!result.value) return c.json({error: "round not visible yet"}, 409);
        return c.json({prompt: result.value}, 200);
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

        // Spoiler gate: only serve a round's image once it's been played (the
        // active round, or one that's already resolved) — never a round that's
        // merely generated and waiting its turn. See ROUND_VISIBLE_STATUSES.
        // The upper bound on `index` is enforced implicitly here too: an
        // out-of-range index just means `state.rounds[index]` is undefined,
        // same as any other not-visible round — this game's round count is
        // per-game (see roundCount() in guess.constants.ts), not a static
        // import-time value to check against.
        const state = await c.env.GAME_DO.getByName(gameId).getState();
        const round = state.rounds[index];
        if (!round || !ROUND_VISIBLE_STATUSES.includes(round.status)) return c.notFound();

        const object = await c.env.IMAGES.get(imageKeyFor(gameId, index));
        if (!object) return c.notFound();

        return immutableImageResponse(object);
    },
);
