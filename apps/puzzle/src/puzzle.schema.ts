import {z} from "@hono/zod-openapi";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {
        WsPlayerJoinedMessageSchema,
        WsPongMessageSchema,
        WsPresenceMessageSchema,
        WsStatusMessageSchema,
} from "@game-worker/shared/ws-messages";

/** Sourced from `@game-worker/shared/game-session-status` — Guess the
 * Prompt's own `GameStatusSchema` (see guess.schema.ts) is built off the
 * exact same enum object, so the two games' status values can't drift
 * apart. */
export const PuzzleStatusSchema = z
    .nativeEnum(GameSessionStatus)
    .openapi("PuzzleStatus");

/** A joined player's public roster entry — just enough to render an avatar
 * list in the lobby/play page. No id/token here; those stay private to the
 * participant who owns them (see JoinResultSchema). Mirrors Guess the
 * Prompt's own participant roster entry. */
export const ParticipantPublicSchema = z
    .object({name: z.string(), color: z.string()})
    .openapi("Participant");

export const PuzzlePublicSchema = z
    .object({
        id: z.string(),
        theme: z.string().nullable(),
        prompt: z.string().nullable(),
        status: PuzzleStatusSchema,
        error: z.string().optional(),
        gridSize: z.number(),
        board: z.array(z.number()),
        timeLimitMs: z.number(),
        startedAt: z.number().nullable(),
        remainingMs: z.number().nullable(),
        lobbyRemainingMs: z.number().nullable(),
        endedAt: z.number().nullable(),
        score: z.number().nullable(),
        solvedBy: z.string().nullable(),
        connectedPlayers: z.number(),
        participants: z.array(ParticipantPublicSchema).openapi({description: "Everyone who has joined, in join order"}),
    })
    .openapi("Puzzle");

export const MoveResultSchema = z
    .object({
        status: PuzzleStatusSchema,
        board: z.array(z.number()),
        solved: z.boolean(),
        score: z.number().nullable(),
    })
    .openapi("MoveResult");

/** `token` is only present for anonymous guests — it's the bearer secret
 * they must resend with every move (see puzzle.model.ts's
 * `requireParticipant`). Logged-in players are re-identified by their
 * session on every request instead, so `token` is null for them. `color`
 * is always present: the account's stored color when logged in, otherwise
 * a fresh one generated at join time — returned so the caller's own client
 * knows what to render immediately, without waiting on a broadcast. */
export const JoinResultSchema = z
    .object({
        participantId: z.string(),
        token: z.string().nullable(),
        color: z.string(),
    })
    .openapi("JoinResult");

export const ReplayResultSchema = z
    .object({
        puzzleId: z.string(),
        hostToken: z.string(),
    })
    .openapi("ReplayResult");

// --- WebSocket message shapes ---------------------------------------------
//
// `PuzzleDO` (see puzzle.model.ts) pushes each of these to connected
// clients. The WS upgrade route itself has no OpenAPI 3 representation (see
// index.ts's doc description), but `PuzzleWsMessageSchema` is registered
// directly on the OpenAPI registry so its member shapes still show up as
// named components — and therefore as generated model types — in this
// service's spec/client for the FE to import and use.

/** The `type` discriminator values for this game's own WS events — the
 * shared ones (`status`, `player_joined`, `presence`, `pong`) live in
 * `@game-worker/shared/ws-messages`'s `WsEventType` instead, since those are
 * byte-for-byte identical to Guess the Prompt's. Together the two enums
 * cover every member of `PuzzleWsMessageSchema` below, and `puzzle.model.ts`
 * broadcasts using these same values rather than raw string literals. */
export const PuzzleWsEventType = {
    State: "state",
    Solved: "solved",
    Move: "move",
    TileSelected: "tile_selected",
    Timeout: "timeout",
} as const;
export type PuzzleWsEventType = (typeof PuzzleWsEventType)[keyof typeof PuzzleWsEventType];

/** A full state snapshot — sent on connect and after any status-changing
 * RPC. `.extend()` on an already-`.openapi()`-named schema (`Puzzle`) makes
 * zod-to-openapi generate this as a composition over that component rather
 * than flattening/duplicating its fields. */
export const PuzzleWsStateMessageSchema = PuzzlePublicSchema.extend({
    type: z.literal(PuzzleWsEventType.State),
}).openapi("PuzzleWsStateMessage");

export const PuzzleWsSolvedMessageSchema = z
    .object({
        type: z.literal(PuzzleWsEventType.Solved),
        board: z.array(z.number()),
        score: z.number(),
        solvedBy: z.string(),
        solvedByColor: z.string(),
        remainingMs: z.number(),
    })
    .openapi("PuzzleWsSolvedMessage");

export const PuzzleWsMoveMessageSchema = z
    .object({
        type: z.literal(PuzzleWsEventType.Move),
        cellA: z.number(),
        cellB: z.number(),
        by: z.string(),
        color: z.string(),
    })
    .openapi("PuzzleWsMoveMessage");

/** Purely a live "about to move this tile" cue — see puzzle.model.ts's
 * `selectTile`. */
export const PuzzleWsTileSelectedMessageSchema = z
    .object({
        type: z.literal(PuzzleWsEventType.TileSelected),
        cell: z.number(),
        player: z.string(),
        color: z.string(),
    })
    .openapi("PuzzleWsTileSelectedMessage");

export const PuzzleWsTimeoutMessageSchema = z
    .object({type: z.literal(PuzzleWsEventType.Timeout)})
    .openapi("PuzzleWsTimeoutMessage");

/** Every message shape `PuzzleDO` ever sends over its WebSocket,
 * discriminated by `type` — see puzzle.model.ts's `broadcast()`/`send()`. */
export const PuzzleWsMessageSchema = z
    .discriminatedUnion("type", [
        PuzzleWsStateMessageSchema,
        WsStatusMessageSchema,
        WsPlayerJoinedMessageSchema,
        PuzzleWsSolvedMessageSchema,
        PuzzleWsMoveMessageSchema,
        PuzzleWsTileSelectedMessageSchema,
        PuzzleWsTimeoutMessageSchema,
        WsPresenceMessageSchema,
        WsPongMessageSchema,
    ])
    .openapi("PuzzleWsMessage");
