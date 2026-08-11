// WS broadcast message shapes that are byte-for-byte identical between
// `apps/guess`'s `GameDO` and `apps/puzzle`'s `PuzzleDO` — both push these
// over their (otherwise game-specific) WebSocket connection, so they're kept
// here rather than duplicated. Each service composes these together with its
// own game-specific message schemas into a single `z.discriminatedUnion`
// (see guess.schema.ts's `GameWsMessageSchema` / puzzle.schema.ts's
// `PuzzleWsMessageSchema`), which its `index.ts` registers directly on the
// OpenAPI registry (`app.openAPIRegistry.register(...)`) so it shows up as a
// named component in the generated spec/client even though the WebSocket
// upgrade route itself isn't representable in OpenAPI 3.

import { z } from "@hono/zod-openapi";
import { GameSessionStatus } from "./game-session-status";

export const WsStatusMessageSchema = z
  .object({
    type: z.literal("status"),
    status: z.nativeEnum(GameSessionStatus),
    error: z.string().optional(),
  })
  .openapi("WsStatusMessage");

/** Broadcast whenever someone joins — see each DO's `join()`. */
export const WsPlayerJoinedMessageSchema = z
  .object({ type: z.literal("player_joined"), name: z.string(), color: z.string() })
  .openapi("WsPlayerJoinedMessage");

/** Broadcast whenever the live WebSocket connection count changes — see each
 * DO's `fetch()`/`webSocketClose()`. */
export const WsPresenceMessageSchema = z
  .object({ type: z.literal("presence"), connectedPlayers: z.number() })
  .openapi("WsPresenceMessage");

/** Reply to a client's `"ping"` — sent directly to the asking socket, never
 * broadcast to everyone else. */
export const WsPongMessageSchema = z.object({ type: z.literal("pong") }).openapi("WsPongMessage");
