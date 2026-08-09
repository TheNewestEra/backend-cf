import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, OkSchema } from "@game-worker/shared/common.schema";
import { currentUser } from "./auth.middleware";
import { imageKeyFor, ROUND_COUNT } from "./guess.constants";
import type { GuessQueueMessage } from "./guess.queue";
import { GamePublicSchema, GuessResultSchema } from "./guess.schema";

const MAX_THEME_LENGTH = 120;
const MAX_PLAYER_LENGTH = 40;

export const guessRoutes = new OpenAPIHono<{ Bindings: Env }>();

guessRoutes.openapi(
  createRoute({
    method: "post",
    path: "/games",
    tags: ["Guess the Prompt"],
    summary: "Create a new game",
    description: "Enqueues generation (5 rounds of AI prompt + image); poll GET /games/{id} or connect to the WebSocket for progress.",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ theme: z.string().max(MAX_THEME_LENGTH).optional() }),
          },
        },
        required: false,
      },
    },
    responses: {
      202: {
        description: "Generation queued",
        content: { "application/json": { schema: z.object({ gameId: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json") ?? {};
    const theme = body.theme?.trim() ? body.theme.trim().slice(0, MAX_THEME_LENGTH) : null;

    const gameId = crypto.randomUUID();
    const stub = c.env.GAME_DO.getByName(gameId);
    await stub.init(gameId, theme);
    await c.env.BROWSE.insertCatalogEntry(gameId, "guess", theme);
    await c.env.GAME_QUEUE.send({ gameId, theme } satisfies GuessQueueMessage);

    return c.json({ gameId }, 202);
  },
);

guessRoutes.openapi(
  createRoute({
    method: "get",
    path: "/games/{id}",
    tags: ["Guess the Prompt"],
    summary: "Get a game's current state",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Game state", content: { "application/json": { schema: GamePublicSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
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
    path: "/games/{id}/regenerate",
    tags: ["Guess the Prompt"],
    summary: "Re-run generation for an existing game (same theme)",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: "Regeneration queued", content: { "application/json": { schema: OkSchema } } },
    },
  }),
  async (c) => {
    const { id: gameId } = c.req.valid("param");
    const stub = c.env.GAME_DO.getByName(gameId);
    const state = await stub.getState();
    await stub.init(gameId, state.theme);
    await c.env.GAME_QUEUE.send({ gameId, theme: state.theme } satisfies GuessQueueMessage);
    return c.json({ ok: true as const }, 200);
  },
);

guessRoutes.openapi(
  createRoute({
    method: "post",
    path: "/games/{id}/guess",
    tags: ["Guess the Prompt"],
    summary: "Submit a guess for a round",
    description: "Logged-in players are identified server-side by their session; `player` is only used for anonymous guests.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              index: z.number().int().min(0).max(ROUND_COUNT - 1),
              player: z.string().max(MAX_PLAYER_LENGTH).optional(),
              guess: z.string(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Guess result", content: { "application/json": { schema: GuessResultSchema } } },
      400: { description: "Missing/invalid fields", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "Round not ready yet", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { index, player: bodyPlayer, guess: rawGuess } = c.req.valid("json");
    // Logged-in players are identified by their real username server-side —
    // the client only gets to pick a name when there's no account to spoof.
    const user = await currentUser(c);
    const player = user ? user.username : (bodyPlayer?.trim().slice(0, MAX_PLAYER_LENGTH) ?? "");
    const guess = rawGuess.trim();

    if (!player || !guess) {
      return c.json({ error: "index, player, and guess are required" }, 400);
    }

    const stub = c.env.GAME_DO.getByName(id);
    try {
      return c.json(await stub.submitGuess(index, player, guess, user?.id ?? null), 200);
    } catch {
      return c.json({ error: "round not ready yet" }, 409);
    }
  },
);

guessRoutes.openapi(
  createRoute({
    method: "post",
    path: "/games/{id}/reveal",
    tags: ["Guess the Prompt"],
    summary: "Reveal a round's prompt without guessing",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: z.object({ index: z.number().int().min(0).max(ROUND_COUNT - 1) }) },
        },
      },
    },
    responses: {
      200: { description: "Revealed prompt", content: { "application/json": { schema: z.object({ prompt: z.string() }) } } },
      409: { description: "Round not ready yet", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { index } = c.req.valid("json");

    const stub = c.env.GAME_DO.getByName(id);
    const prompt = await stub.revealRound(index);
    if (!prompt) return c.json({ error: "round not ready yet" }, 409);
    return c.json({ prompt }, 200);
  },
);

// Not OpenAPI-documented: serves a raw image (binary body), not JSON.
guessRoutes.get("/games/:id/images/:index", async (c) => {
  const gameId = c.req.param("id");
  const index = Number(c.req.param("index"));
  if (!Number.isInteger(index) || index < 0 || index >= ROUND_COUNT) return c.notFound();

  const object = await c.env.IMAGES.get(imageKeyFor(gameId, index));
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});
