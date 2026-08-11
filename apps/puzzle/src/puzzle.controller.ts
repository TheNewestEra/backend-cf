import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {hostActionError} from "@game-worker/shared/http-exceptions";
import {immutableImageResponse} from "@game-worker/shared/images";
import {
    DEFAULT_GRID_SIZE,
    HostBodySchema,
    MAX_GRID_SIZE,
    MAX_THEME_LENGTH,
    MIN_GRID_SIZE,
    puzzleImageKeyFor,
    puzzleTimeLimitMs,
} from "./puzzle.constants";
import type {PuzzleQueueMessage} from "./puzzle.queue";
import {PuzzlePublicSchema, ReplayResultSchema} from "./puzzle.schema";

export const puzzleRoutes = new OpenAPIHono<{ Bindings: Env }>();

puzzleRoutes.openapi(
    createRoute({
        method: "post",
        path: "/puzzles",
        tags: ["Piece Puzzle"],
        summary: "Create a new puzzle",
        description: "Enqueues generation (one AI image); poll GET /puzzles/{id} or connect to the WebSocket for progress. The returned hostToken authorizes regenerate/start for this puzzle (replaying it later gets its own, separate host token).",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            theme: z.string().max(MAX_THEME_LENGTH).optional(),
                            gridSize: z.number().int().min(MIN_GRID_SIZE).max(MAX_GRID_SIZE).optional(),
                        }),
                    },
                },
                required: false,
            },
        },
        responses: {
            202: {
                description: "Generation queued",
                content: {"application/json": {schema: z.object({puzzleId: z.string(), hostToken: z.string()})}},
            },
        },
    }),
    async (c) => {
        const body = c.req.valid("json");
        const theme = body.theme?.trim() ? body.theme.trim().slice(0, MAX_THEME_LENGTH) : null;
        const gridSize = clampGridSize(body.gridSize);
        const timeLimitMs = await puzzleTimeLimitMs(c.env);

        const puzzleId = crypto.randomUUID();
        const stub = c.env.PUZZLE_DO.getByName(puzzleId);
        const hostToken = await stub.init(puzzleId, theme, gridSize, timeLimitMs);
        await c.env.BROWSE.insertCatalogEntry(puzzleId, "puzzle", theme);
        await c.env.PUZZLE_QUEUE.send({puzzleId, theme} satisfies PuzzleQueueMessage);

        return c.json({puzzleId, hostToken}, 202);
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
            200: {description: "Puzzle state", content: {"application/json": {schema: PuzzlePublicSchema}}},
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
        summary: "Host-only: start a fresh generation run (new image, same theme)",
        request: {
            params: z.object({id: z.string()}),
            body: {content: {"application/json": {schema: HostBodySchema}}, required: false},
        },
        responses: {
            200: {description: "Regeneration queued", content: {"application/json": {schema: OkSchema}}},
            403: {description: "Missing/incorrect host token", content: {"application/json": {schema: ErrorSchema}}},
            409: {
                description: "Puzzle not in a state that allows this",
                content: {"application/json": {schema: ErrorSchema}}
            },
        },
    }),
    async (c) => {
        const {id: puzzleId} = c.req.valid("param");
        const {hostToken} = c.req.valid("json");
        const stub = c.env.PUZZLE_DO.getByName(puzzleId);
        try {
            const theme = await stub.resetForRegenerate(hostToken ?? "");
            await c.env.PUZZLE_QUEUE.send({puzzleId, theme} satisfies PuzzleQueueMessage);
            return c.json({ok: true as const}, 200);
        } catch (err) {
            const {status, body} = hostActionError(err);
            return c.json(body, status);
        }
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
            403: {description: "Missing/incorrect host token", content: {"application/json": {schema: ErrorSchema}}},
            409: {description: "Puzzle isn't waiting to start", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {hostToken} = c.req.valid("json");
        const stub = c.env.PUZZLE_DO.getByName(id);
        try {
            await stub.startNow(hostToken ?? "");
            return c.json({ok: true as const}, 200);
        } catch (err) {
            const {status, body} = hostActionError(err);
            return c.json(body, status);
        }
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
            "invite their own friends to the new lobby without disrupting anyone still viewing the original.",
        request: {params: z.object({id: z.string()})},
        responses: {
            201: {
                description: "New puzzle created, waiting in its lobby",
                content: {"application/json": {schema: ReplayResultSchema}}
            },
            409: {
                description: "Source puzzle isn't finished yet, or has no image",
                content: {"application/json": {schema: ErrorSchema}}
            },
        },
    }),
    async (c) => {
        const {id: sourceId} = c.req.valid("param");
        const source = await c.env.PUZZLE_DO.getByName(sourceId).getState();
        if (source.status !== GameSessionStatus.Solved && source.status !== GameSessionStatus.Timeout) {
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
        const hostToken = await stub.initFromSource(puzzleId, source.theme, source.gridSize, timeLimitMs, source.prompt);
        await c.env.BROWSE.insertCatalogEntry(puzzleId, "puzzle", source.theme);
        await c.env.BROWSE.markCatalogReady(puzzleId, puzzleImageKeyFor(puzzleId));

        return c.json({puzzleId, hostToken}, 201);
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

function clampGridSize(input: number | undefined): number {
    if (!Number.isInteger(input)) return DEFAULT_GRID_SIZE;
    return Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, input as number));
}
