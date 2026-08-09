import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {hostActionError} from "@game-worker/shared/http-exceptions";
import {currentUser} from "./auth.middleware";
import {
    DEFAULT_GRID_SIZE,
    MAX_GRID_SIZE,
    MAX_TIME_LIMIT_SECONDS,
    MIN_GRID_SIZE,
    MIN_TIME_LIMIT_SECONDS,
    puzzleImageKeyFor,
    SECONDS_PER_TILE,
} from "./puzzle.constants";
import type {PuzzleQueueMessage} from "./puzzle.queue";
import {MoveResultSchema, PuzzlePublicSchema} from "./puzzle.schema";

const MAX_THEME_LENGTH = 120;
const MAX_PLAYER_LENGTH = 40;

const hostBodySchema = z.object({hostToken: z.string().optional()});

export const puzzleRoutes = new OpenAPIHono<{ Bindings: Env }>();

puzzleRoutes.openapi(
    createRoute({
        method: "post",
        path: "/puzzles",
        tags: ["Piece Puzzle"],
        summary: "Create a new puzzle",
        description: "Enqueues generation (one AI image); poll GET /puzzles/{id} or connect to the WebSocket for progress. The returned hostToken authorizes regenerate/start/replay for this puzzle.",
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
        const timeLimitMs = timeLimitMsFor(gridSize);

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
// JSON endpoint — OpenAPI 3 has no representation for it.
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
            body: {content: {"application/json": {schema: hostBodySchema}}, required: false},
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
            body: {content: {"application/json": {schema: hostBodySchema}}, required: false},
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
        summary: "Host-only: reshuffle the same image and return to the lobby",
        request: {
            params: z.object({id: z.string()}),
            body: {content: {"application/json": {schema: hostBodySchema}}, required: false},
        },
        responses: {
            200: {description: "Back in the lobby", content: {"application/json": {schema: OkSchema}}},
            403: {description: "Missing/incorrect host token", content: {"application/json": {schema: ErrorSchema}}},
            409: {
                description: "Puzzle must be finished before replaying",
                content: {"application/json": {schema: ErrorSchema}}
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {hostToken} = c.req.valid("json");
        const stub = c.env.PUZZLE_DO.getByName(id);
        try {
            await stub.replay(hostToken ?? "");
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
        path: "/puzzles/{id}/move",
        tags: ["Piece Puzzle"],
        summary: "Swap two tiles",
        description: "Logged-in players are identified server-side by their session; `player` is only used for anonymous guests.",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            cellA: z.number().int(),
                            cellB: z.number().int(),
                            player: z.string().max(MAX_PLAYER_LENGTH).optional(),
                        }),
                    },
                },
            },
        },
        responses: {
            200: {description: "Move applied", content: {"application/json": {schema: MoveResultSchema}}},
            400: {description: "Missing/invalid fields", content: {"application/json": {schema: ErrorSchema}}},
            409: {
                description: "Move rejected (not playing, invalid cells, etc.)",
                content: {"application/json": {schema: ErrorSchema}}
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {cellA, cellB, player: bodyPlayer} = c.req.valid("json");
        // Logged-in players are identified by their real username server-side —
        // the client only gets to pick a name when there's no account to spoof.
        const user = await currentUser(c);
        const player = user ? user.username : (bodyPlayer?.trim().slice(0, MAX_PLAYER_LENGTH) ?? "");

        if (cellA === cellB || !player) {
            return c.json({error: "cellA, cellB (different), and player are required"}, 400);
        }

        const stub = c.env.PUZZLE_DO.getByName(id);
        try {
            return c.json(await stub.swapTiles(player, cellA, cellB, user?.id ?? null), 200);
        } catch (err) {
            return c.json({error: err instanceof Error ? err.message : "move rejected"}, 409);
        }
    },
);

// Not OpenAPI-documented: serves a raw image (binary body), not JSON.
puzzleRoutes.get("/puzzles/:id/image", async (c) => {
    const object = await c.env.IMAGES.get(puzzleImageKeyFor(c.req.param("id")));
    if (!object) return c.notFound();

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(object.body, {headers});
});

function clampGridSize(input: number | undefined): number {
    if (!Number.isInteger(input)) return DEFAULT_GRID_SIZE;
    return Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, input as number));
}

function timeLimitMsFor(gridSize: number): number {
    const tileCount = gridSize * gridSize;
    const seconds = Math.min(
        MAX_TIME_LIMIT_SECONDS,
        Math.max(MIN_TIME_LIMIT_SECONDS, tileCount * SECONDS_PER_TILE),
    );
    return seconds * 1000;
}
