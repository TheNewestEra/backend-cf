import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {maxPlayerLength, maxThemeLength} from "@game-worker/shared/game-session";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {hostActionError} from "@game-worker/shared/http-exceptions";
import {immutableImageResponse} from "@game-worker/shared/images";
import {fromRpcResult} from "@game-worker/shared/rpc-result";
import {currentUser} from "./auth.middleware";
import {
    HostBodySchema,
    puzzleImageKeyFor,
    puzzleTimeLimitMs,
    resolveGridSize,
} from "./puzzle.constants";
import type {PuzzleQueueMessage} from "./puzzle.queue";
import {JoinResultSchema, PuzzlePublicSchema} from "./puzzle.schema";

export const puzzleRoutes = new OpenAPIHono<{Bindings: Env}>();

puzzleRoutes.openapi(
    createRoute({
        method: "post",
        path: "/puzzles",
        tags: ["Piece Puzzle"],
        summary: "Create a new puzzle",
        description:
            "Enqueues generation (one AI image); poll GET /puzzles/{id} or connect to the WebSocket for progress. " +
            "Without `theme`, one gets picked for you (a Flagship preset, or the prompt model's own idea) — " +
            "PuzzlePublic's `theme`/`themeGenerated` report what was actually used once generation resolves it. " +
            "The returned hostToken authorizes starting the lobby early for this puzzle (regenerating/replaying " +
            "it later both spin up their own new instance with its own, separate host token — neither needs or " +
            "reuses this one). `gridSize`, if given, is clamped to Flagship's configured [min, max] rather " +
            "than rejected out of range. The host is auto-joined as this puzzle's first participant — a logged-in " +
            "caller joins under their account name/color; an anonymous caller must supply `player` (and, " +
            "optionally, `color`), same as POST /puzzles/{id}/ws's `join` message. `participantId`/`token`/`color` " +
            "come back already resolved, so the host's client can move/select tiles immediately without sending " +
            "its own `join` message first.",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            theme: z.string().optional(),
                            gridSize: z.number().int().optional(),
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
                            puzzleId: z.string(),
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
        const user = await currentUser(c);
        const maxPlayer = await maxPlayerLength(c.env.FLAGS);
        const player = user ? user.username : (body.player?.trim().slice(0, maxPlayer) ?? "");
        if (!player) return c.json({error: "player is required"}, 400);

        const maxTheme = await maxThemeLength(c.env.FLAGS);
        const theme = body.theme?.trim() ? body.theme.trim().slice(0, maxTheme) : null;
        const gridSize = await resolveGridSize(c.env, body.gridSize);
        const timeLimitMs = await puzzleTimeLimitMs(c.env);

        const puzzleId = crypto.randomUUID();
        const stub = c.env.PUZZLE_DO.getByName(puzzleId);
        const hostToken = await stub.init(puzzleId, theme, gridSize, timeLimitMs);
        // The puzzle is freshly `queued` (a JOINABLE_STATUS), so this can't
        // actually reject — see puzzle.model.ts's `join()`.
        const joined = fromRpcResult(
            await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null),
        );
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        // `theme === null` is the only signal that will ever exist for "will
        // this puzzle's theme end up picked rather than typed in" — capture
        // it now, since by the time generation resolves a theme
        // (puzzle.queue.ts) `theme` itself is indistinguishable from a
        // user-given one.
        const themeGenerated = theme === null;
        await c.env.BROWSE.insertCatalogEntry(
            puzzleId,
            "puzzle",
            theme,
            {id: user?.id ?? null, name: player, color: joined.value.color},
            null,
            themeGenerated,
        );
        await c.env.PUZZLE_QUEUE.send({
            puzzleId,
            theme,
            themeGenerated,
        } satisfies PuzzleQueueMessage);

        return c.json({puzzleId, hostToken, ...joined.value}, 202);
    },
);

puzzleRoutes.openapi(
    createRoute({
        method: "get",
        path: "/puzzles/{id}",
        tags: ["Piece Puzzle"],
        summary: "Get a puzzle's current state",
        request: {params: z.object({id: z.string()})},
        responses: {
            200: {
                description: "Puzzle state",
                content: {"application/json": {schema: PuzzlePublicSchema}},
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const stub = c.env.PUZZLE_DO.getByName(id);
        return c.json(await stub.getState(), 200);
    },
);

// Not OpenAPI-documented: this is a WebSocket upgrade, not a request/response
// JSON endpoint — OpenAPI 3 has no representation for it. Carries more than
// broadcasts out — joining, moving, and selecting a tile are all sent as
// messages over this same connection now (see puzzle.schema.ts's
// `PuzzleWsClientMessageSchema` and puzzle.model.ts's `webSocketMessage()`);
// there's no separate POST for any of them any more.
puzzleRoutes.get("/puzzles/:id/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
        return c.text("Expected WebSocket", 426);
    }
    const stub = c.env.PUZZLE_DO.getByName(c.req.param("id"));
    return stub.fetch(c.req.raw);
});

puzzleRoutes.openapi(
    createRoute({
        method: "post",
        path: "/puzzles/{id}/regenerate",
        tags: ["Piece Puzzle"],
        summary: "Start a brand-new puzzle with the same theme, freshly generated",
        description:
            "Only once this puzzle is finished (solved/timeout). Creates an independent puzzle instance (its own " +
            "id, lobby, and host token) seeded from this one's theme and re-runs generation (a fresh AI image) — " +
            "it never touches the source puzzle, so anyone can regenerate a puzzle they're spectating/browsing " +
            "and invite their own friends to the new lobby without disrupting anyone still viewing the original. " +
            "Same as POST /puzzles/{id}/replay except the new instance's image is freshly generated rather than " +
            "copied — see that endpoint instead if you want the exact same image. The host is auto-joined as " +
            "this new puzzle's first participant, same as POST /puzzles — a logged-in caller joins under their " +
            "account name/color; an anonymous caller must supply `player` (and, optionally, `color`). " +
            "`participantId`/`token`/`color` come back already resolved.",
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
                description: "New puzzle's generation queued; the host is already joined",
                content: {
                    "application/json": {
                        schema: JoinResultSchema.extend({
                            puzzleId: z.string(),
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
                description: "Source puzzle isn't finished yet",
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

        const source = await c.env.PUZZLE_DO.getByName(sourceId).getState();
        if (
            source.status !== GameSessionStatus.Solved &&
            source.status !== GameSessionStatus.Timeout
        ) {
            return c.json({error: "puzzle must be finished before regenerating"}, 409);
        }

        // Re-evaluate rather than reusing source.timeLimitMs: the flag may
        // have changed since the source puzzle was created, and a
        // regenerate is a fresh play session that should get today's time
        // limit — same reasoning as POST /puzzles/{id}/replay.
        const timeLimitMs = await puzzleTimeLimitMs(c.env);
        const puzzleId = crypto.randomUUID();
        const stub = c.env.PUZZLE_DO.getByName(puzzleId);
        const hostToken = await stub.init(puzzleId, source.theme, source.gridSize, timeLimitMs);
        // The puzzle is freshly `queued` (a JOINABLE_STATUS), so this can't
        // actually reject — see puzzle.model.ts's `join()`.
        const joined = fromRpcResult(
            await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null),
        );
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        await c.env.BROWSE.insertCatalogEntry(
            puzzleId,
            "puzzle",
            source.theme,
            {id: user?.id ?? null, name: player, color: joined.value.color},
            sourceId,
            source.themeGenerated,
            "regenerate",
        );
        await c.env.PUZZLE_QUEUE.send({
            puzzleId,
            theme: source.theme,
            themeGenerated: source.themeGenerated,
        } satisfies PuzzleQueueMessage);

        return c.json({puzzleId, hostToken, ...joined.value}, 202);
    },
);

puzzleRoutes.openapi(
    createRoute({
        method: "post",
        path: "/puzzles/{id}/start",
        tags: ["Piece Puzzle"],
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
                description: "Puzzle isn't waiting to start",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {hostToken} = c.req.valid("json");
        const stub = c.env.PUZZLE_DO.getByName(id);
        const result = fromRpcResult(await stub.startNow(hostToken ?? ""));
        if (result.isErr()) {
            const {status, body} = hostActionError(result.error);
            return c.json(body, status);
        }
        return c.json({ok: true as const}, 200);
    },
);

puzzleRoutes.openapi(
    createRoute({
        method: "post",
        path: "/puzzles/{id}/replay",
        tags: ["Piece Puzzle"],
        summary: "Start a brand-new puzzle with the same image",
        description:
            "Only once this puzzle is finished (solved/timeout). Creates an independent puzzle instance " +
            "(its own id, lobby, and host token) that reuses the same image without a fresh AI call — it " +
            "never touches the source puzzle, so anyone can replay a puzzle they're spectating/browsing and " +
            "invite their own friends to the new lobby without disrupting anyone still viewing the original. " +
            "Same as POST /puzzles/{id}/regenerate except the new instance's image is copied rather than " +
            "freshly generated — see that endpoint instead if you want a fresh take on the same theme. " +
            "The host is auto-joined as this new puzzle's first participant, same as POST /puzzles — a " +
            "logged-in caller joins under their account name/color; an anonymous caller must supply `player` " +
            "(and, optionally, `color`). `participantId`/`token`/`color` come back already resolved.",
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
                description: "New puzzle created, waiting in its lobby; the host is already joined",
                content: {
                    "application/json": {
                        schema: JoinResultSchema.extend({
                            puzzleId: z.string(),
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
                description: "Source puzzle isn't finished yet, or has no image",
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

        const source = await c.env.PUZZLE_DO.getByName(sourceId).getState();
        if (
            source.status !== GameSessionStatus.Solved &&
            source.status !== GameSessionStatus.Timeout
        ) {
            return c.json({error: "puzzle must be finished before replaying"}, 409);
        }
        if (!source.prompt) {
            return c.json({error: "no image to replay"}, 409);
        }

        const puzzleId = crypto.randomUUID();
        const sourceKey = puzzleImageKeyFor(sourceId);
        const sourceImage = await c.env.IMAGES.get(sourceKey);
        if (!sourceImage) {
            return c.json({error: "no image to replay"}, 409);
        }
        await c.env.IMAGES.put(puzzleImageKeyFor(puzzleId), sourceImage.body, {
            httpMetadata: sourceImage.httpMetadata,
        });

        // Re-evaluate rather than reusing source.timeLimitMs: the flag may
        // have changed since the source puzzle was created, and a replay is
        // a fresh play session that should get today's time limit.
        const timeLimitMs = await puzzleTimeLimitMs(c.env);
        const stub = c.env.PUZZLE_DO.getByName(puzzleId);
        const hostToken = await stub.initFromSource(
            puzzleId,
            source.theme,
            source.gridSize,
            timeLimitMs,
            source.prompt,
            source.themeGenerated,
        );
        // The puzzle is freshly `waiting` (a JOINABLE_STATUS), so this can't
        // actually reject — see puzzle.model.ts's `join()`.
        const joined = fromRpcResult(
            await stub.join(user?.id ?? null, player, user?.color ?? null, body.color ?? null),
        );
        if (joined.isErr()) return c.json({error: joined.error}, 400);
        await c.env.BROWSE.insertCatalogEntry(
            puzzleId,
            "puzzle",
            source.theme,
            {id: user?.id ?? null, name: player, color: joined.value.color},
            sourceId,
            source.themeGenerated,
            "replay",
        );
        await c.env.BROWSE.markCatalogReady(puzzleId, puzzleImageKeyFor(puzzleId));

        return c.json({puzzleId, hostToken, ...joined.value}, 202);
    },
);

puzzleRoutes.openapi(
    createRoute({
        method: "get",
        path: "/puzzles/{id}/image",
        tags: ["Piece Puzzle"],
        summary: "Get the puzzle's source image",
        description:
            "Raw image bytes, not JSON — the full, unsliced source image; the board renders every tile from " +
            "this same file via CSS background-position (see the README). Immutable/long-cached once served, " +
            "since a puzzle's image never changes in place (regenerate/replay always target a different id).",
        request: {params: z.object({id: z.string()})},
        responses: {
            200: {
                description: "Puzzle source image",
                content: {"image/png": {schema: z.string().openapi({format: "binary"})}},
            },
            404: {description: "No such puzzle, or the image hasn't generated yet"},
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const object = await c.env.IMAGES.get(puzzleImageKeyFor(id));
        if (!object) return c.notFound();

        return immutableImageResponse(object);
    },
);
