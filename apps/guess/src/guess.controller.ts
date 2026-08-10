import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, OkSchema } from "@game-worker/shared/common.schema";
import { hostActionError } from "@game-worker/shared/http-exceptions";
import { immutableImageResponse } from "@game-worker/shared/images";
import { currentUser } from "./auth.middleware";
import { HostBodySchema, imageKeyFor, MAX_PLAYER_LENGTH, MAX_THEME_LENGTH, ROUND_COUNT } from "./guess.constants";
import type { GuessQueueMessage } from "./guess.queue";
import { GamePublicSchema, GuessResultSchema, JoinResultSchema } from "./guess.schema";

export const guessRoutes = new OpenAPIHono<{ Bindings: Env }>();

guessRoutes.openapi(
  createRoute({
    method: "post",
    path: "/games",
    tags: ["Guess the Prompt"],
    summary: "Create a new game",
    description:
      "Enqueues generation (5 rounds of AI prompt + image); poll GET /games/{id} or connect to the WebSocket " +
      "for progress. The returned hostToken authorizes starting the lobby early for this game (replaying it " +
      "later gets its own, separate host token).",
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
        content: { "application/json": { schema: z.object({ gameId: z.string(), hostToken: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json") ?? {};
    const theme = body.theme?.trim() ? body.theme.trim().slice(0, MAX_THEME_LENGTH) : null;

    const gameId = crypto.randomUUID();
    const stub = c.env.GAME_DO.getByName(gameId);
    const hostToken = await stub.init(gameId, theme);
    await c.env.BROWSE.insertCatalogEntry(gameId, "guess", theme);
    await c.env.GAME_QUEUE.send({ gameId, theme } satisfies GuessQueueMessage);

    return c.json({ gameId, hostToken }, 202);
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
    path: "/games/{id}/start",
    tags: ["Guess the Prompt"],
    summary: "Host-only: end the lobby countdown early and start play",
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { "application/json": { schema: HostBodySchema } }, required: false },
    },
    responses: {
      200: { description: "Started", content: { "application/json": { schema: OkSchema } } },
      403: { description: "Missing/incorrect host token", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "Game isn't waiting to start", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { hostToken } = c.req.valid("json");
    const stub = c.env.GAME_DO.getByName(id);
    try {
      await stub.startNow(hostToken ?? "");
      return c.json({ ok: true as const }, 200);
    } catch (err) {
      const { status, body } = hostActionError(err);
      return c.json(body, status);
    }
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
    request: { params: z.object({ id: z.string() }) },
    responses: {
      202: {
        description: "New game's generation queued",
        content: { "application/json": { schema: z.object({ gameId: z.string(), hostToken: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const { id: sourceId } = c.req.valid("param");
    const source = await c.env.GAME_DO.getByName(sourceId).getState();

    const gameId = crypto.randomUUID();
    const stub = c.env.GAME_DO.getByName(gameId);
    const hostToken = await stub.init(gameId, source.theme);
    await c.env.BROWSE.insertCatalogEntry(gameId, "guess", source.theme);
    await c.env.GAME_QUEUE.send({ gameId, theme: source.theme } satisfies GuessQueueMessage);

    return c.json({ gameId, hostToken }, 202);
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
      "(`queued`/`generating_prompts`/`generating_images`/`waiting`); once the game is `ready` this returns " +
      "409 and late arrivals can only spectate over the WebSocket. Logged-in players are identified by their " +
      "session and keep their account color; `player` is only used for anonymous guests, who get back a " +
      "`token` they must resend with every guess/reveal, plus a freshly generated `color`.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: z.object({ player: z.string().max(MAX_PLAYER_LENGTH).optional() }) },
        },
        required: false,
      },
    },
    responses: {
      200: { description: "Joined", content: { "application/json": { schema: JoinResultSchema } } },
      400: { description: "Missing player name", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "Game has already started", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json") ?? {};
    const user = await currentUser(c);
    const player = user ? user.username : (body.player?.trim().slice(0, MAX_PLAYER_LENGTH) ?? "");

    if (!player) return c.json({ error: "player is required" }, 400);

    const stub = c.env.GAME_DO.getByName(id);
    try {
      return c.json(await stub.join(user?.id ?? null, player, user?.color ?? null), 200);
    } catch (err) {
      // join() only ever throws the "already started" case (never a
      // "forbidden: ..." one), so this is always a 409 — unlike the
      // participant-gated actions below, there's no host/participant
      // check to fail here.
      const message = err instanceof Error ? err.message : "unable to join";
      return c.json({ error: message }, 409);
    }
  },
);

guessRoutes.openapi(
  createRoute({
    method: "post",
    path: "/games/{id}/guess",
    tags: ["Guess the Prompt"],
    summary: "Submit a guess for a round",
    description: "Requires having joined via POST /games/{id}/join first — see that endpoint for why.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              index: z.number().int().min(0).max(ROUND_COUNT - 1),
              participantId: z.string(),
              token: z.string().optional(),
              guess: z.string(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Guess result", content: { "application/json": { schema: GuessResultSchema } } },
      400: { description: "Missing/invalid fields", content: { "application/json": { schema: ErrorSchema } } },
      403: { description: "Didn't join this game before it started", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "Round not ready yet", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { index, participantId, token, guess: rawGuess } = c.req.valid("json");
    const user = await currentUser(c);
    const guess = rawGuess.trim();

    if (!guess) return c.json({ error: "guess is required" }, 400);

    const stub = c.env.GAME_DO.getByName(id);
    try {
      return c.json(await stub.submitGuess(index, participantId, token ?? null, guess, user?.id ?? null), 200);
    } catch (err) {
      const { status, body } = hostActionError(err);
      return c.json(body, status);
    }
  },
);

guessRoutes.openapi(
  createRoute({
    method: "post",
    path: "/games/{id}/reveal",
    tags: ["Guess the Prompt"],
    summary: "Reveal a round's prompt without guessing",
    description: "Requires having joined via POST /games/{id}/join first — see that endpoint for why.",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              index: z.number().int().min(0).max(ROUND_COUNT - 1),
              participantId: z.string(),
              token: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: "Revealed prompt", content: { "application/json": { schema: z.object({ prompt: z.string() }) } } },
      403: { description: "Didn't join this game before it started", content: { "application/json": { schema: ErrorSchema } } },
      409: { description: "Round not ready yet", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { index, participantId, token } = c.req.valid("json");
    const user = await currentUser(c);

    const stub = c.env.GAME_DO.getByName(id);
    try {
      const prompt = await stub.revealRound(index, participantId, token ?? null, user?.id ?? null);
      if (!prompt) return c.json({ error: "round not ready yet" }, 409);
      return c.json({ prompt }, 200);
    } catch (err) {
      const { status, body } = hostActionError(err);
      return c.json(body, status);
    }
  },
);

guessRoutes.openapi(
  createRoute({
    method: "get",
    path: "/games/{id}/images/{index}",
    tags: ["Guess the Prompt"],
    summary: "Get a round's generated image",
    description:
      "Raw image bytes, not JSON — the same image a round's public state points at once it's `ready`. " +
      "Immutable/long-cached once served, since a round's image never changes after it's generated.",
    request: {
      params: z.object({
        id: z.string(),
        // Kept as a plain string (not z.coerce.number()) so an
        // out-of-range/non-numeric index still 404s exactly like a
        // missing image, rather than the validator's 400 — see the
        // manual check below.
        index: z.string().openapi({ description: `0-${ROUND_COUNT - 1}` }),
      }),
    },
    responses: {
      200: {
        description: "Round image",
        content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } },
      },
      404: { description: "No such game/round, or the image hasn't generated yet" },
    },
  }),
  async (c) => {
    const { id: gameId, index: rawIndex } = c.req.valid("param");
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= ROUND_COUNT) return c.notFound();

    const object = await c.env.IMAGES.get(imageKeyFor(gameId, index));
    if (!object) return c.notFound();

    return immutableImageResponse(object);
  },
);
