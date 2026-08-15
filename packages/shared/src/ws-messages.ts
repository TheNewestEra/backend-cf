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

import {z} from "@hono/zod-openapi";
import {GameSessionStatus} from "./game-session-status";

/** The `type` discriminator values shared by every game's WS union — see
 * this file's header for why these particular shapes live here instead of
 * per-game. Each game's own schema (guess.schema.ts's `GameWsEventType` /
 * puzzle.schema.ts's `PuzzleWsEventType`) covers the rest of its union with
 * the same pattern. */
export const WsEventType = {
    Status: "status",
    PlayerJoined: "player_joined",
    Presence: "presence",
    Pong: "pong",
} as const;
export type WsEventType = (typeof WsEventType)[keyof typeof WsEventType];

export const WsStatusMessageSchema = z
    .object({
        type: z.literal(WsEventType.Status),
        status: z.nativeEnum(GameSessionStatus),
        error: z.string().optional(),
    })
    .openapi("WsStatusMessage");

/** Broadcast whenever someone joins — see each DO's `join()`. `participantId`
 * is optional here (rather than each game's own schema, which is where a
 * required field would normally belong) purely because this shape is shared:
 * `apps/guess` always sets it, `apps/puzzle` doesn't populate it yet — making
 * it required would break puzzle's existing broadcast payload. */
export const WsPlayerJoinedMessageSchema = z
    .object({
        type: z.literal(WsEventType.PlayerJoined),
        name: z.string(),
        color: z.string(),
        participantId: z.string().optional(),
    })
    .openapi("WsPlayerJoinedMessage");

/** Broadcast whenever the live WebSocket connection count changes — see each
 * DO's `fetch()`/`webSocketClose()`. */
export const WsPresenceMessageSchema = z
    .object({type: z.literal(WsEventType.Presence), connectedPlayers: z.number()})
    .openapi("WsPresenceMessage");

/** Reply to a client's `"ping"` — sent directly to the asking socket, never
 * broadcast to everyone else. */
export const WsPongMessageSchema = z
    .object({type: z.literal(WsEventType.Pong)})
    .openapi("WsPongMessage");
