import {z} from "@hono/zod-openapi";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {MAX_PLAYER_LENGTH} from "@game-worker/shared/game-session";
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

/** A tile currently selected/highlighted by some participant — persisted
 * (see puzzle.model.ts's `participants.selected_cell`), not just a live
 * broadcast cue, so a client that reconnects mid-game (e.g. a page refresh)
 * can rebuild the same "who's about to move what" picture from the state
 * snapshot instead of just missing whatever it wasn't connected to see live.
 * `participantId` (unlike `ParticipantPublicSchema`'s roster entries) is
 * included here specifically so a reconnecting client can tell *its own*
 * selection apart from everyone else's and restore it locally. */
export const SelectionPublicSchema = z
    .object({cell: z.number(), participantId: z.string(), player: z.string(), color: z.string()})
    .openapi("Selection");

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
        selections: z
            .array(SelectionPublicSchema)
            .openapi({description: "Every tile currently selected by a participant, for state restore on (re)connect"}),
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
    TileDeselected: "tile_deselected",
    Timeout: "timeout",
    JoinResult: "join_result",
    Error: "error",
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

/** A live "about to move this tile" cue — see puzzle.model.ts's
 * `selectTile`. Also persisted (`participants.selected_cell`), so a
 * reconnecting client sees it again in the next `state` snapshot's
 * `selections` (see `SelectionPublicSchema`) even if it missed this
 * broadcast. */
export const PuzzleWsTileSelectedMessageSchema = z
    .object({
        type: z.literal(PuzzleWsEventType.TileSelected),
        cell: z.number(),
        player: z.string(),
        color: z.string(),
    })
    .openapi("PuzzleWsTileSelectedMessage");

/** The flip side of `PuzzleWsTileSelectedMessageSchema` — broadcast when a
 * participant clears their own selection (clicking the same tile again) or
 * when whatever they'd selected gets superseded (picking a different tile,
 * or that cell getting consumed by a move) — see puzzle.model.ts's
 * `deselectTile()`/`selectTile()`/`swapTiles()`. */
export const PuzzleWsTileDeselectedMessageSchema = z
    .object({type: z.literal(PuzzleWsEventType.TileDeselected), cell: z.number()})
    .openapi("PuzzleWsTileDeselectedMessage");

export const PuzzleWsTimeoutMessageSchema = z
    .object({type: z.literal(PuzzleWsEventType.Timeout)})
    .openapi("PuzzleWsTimeoutMessage");

/** Direct reply to a `join` client message (see `PuzzleWsJoinRequestSchema`
 * below) — sent only to the joining socket, never broadcast, since the
 * `token`/`participantId` it carries are that participant's own secret.
 * `.extend()` on `JoinResultSchema` composes over that component rather
 * than duplicating its fields, same reasoning as `PuzzleWsStateMessageSchema`
 * above. */
export const PuzzleWsJoinResultMessageSchema = JoinResultSchema.extend({
    type: z.literal(PuzzleWsEventType.JoinResult),
}).openapi("PuzzleWsJoinResultMessage");

/** Direct reply to a rejected client message (`join`/`move`/`select`, or one
 * that failed to parse at all) — sent only to the sender, mirroring the
 * 4xx bodies these actions used to return over HTTP before they moved onto
 * the WebSocket (see puzzle.model.ts's `webSocketMessage`). */
export const PuzzleWsErrorMessageSchema = z
    .object({
        type: z.literal(PuzzleWsEventType.Error),
        action: z.enum(["join", "move", "select", "deselect", "unknown"]),
        error: z.string(),
    })
    .openapi("PuzzleWsErrorMessage");

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
        PuzzleWsTileDeselectedMessageSchema,
        PuzzleWsTimeoutMessageSchema,
        PuzzleWsJoinResultMessageSchema,
        PuzzleWsErrorMessageSchema,
        WsPresenceMessageSchema,
        WsPongMessageSchema,
    ])
    .openapi("PuzzleWsMessage");

// --- WebSocket client→server message shapes --------------------------------
//
// What used to be POST /puzzles/:id/join, /move, and /select are now sent as
// messages over the same WebSocket connection instead — see this file's
// header comment on `PuzzleWsMessageSchema` for why the upgrade route itself
// still has no OpenAPI representation, and puzzle.model.ts's
// `webSocketMessage()` for how these get dispatched. Registered on the
// OpenAPI registry the same way as `PuzzleWsMessageSchema` (see index.ts) so
// the generated client has typed models for the outgoing side too.

export const PuzzleWsClientEventType = {
    Join: "join",
    Move: "move",
    Select: "select",
    Deselect: "deselect",
} as const;
export type PuzzleWsClientEventType = (typeof PuzzleWsClientEventType)[keyof typeof PuzzleWsClientEventType];

/** Was POST /puzzles/:id/join's body. `player` is only used for anonymous
 * guests — a logged-in caller is identified by the session resolved once at
 * WebSocket-upgrade time (see puzzle.model.ts's `fetch()`), same as it used
 * to be resolved per-request over HTTP. `color` is also guest-only: lets an
 * anonymous caller bring whatever color its own UI already shows for "you"
 * (e.g. a color picked client-side before ever joining a game) instead of
 * always getting a server-generated one — ignored for logged-in callers,
 * whose account color is always authoritative (see puzzle.model.ts's
 * `join()`). Must look like `generateColor()`'s own output
 * (`#`+6 hex digits) or it's discarded in favor of a generated one, same as
 * omitting it entirely. Reply comes back as a `PuzzleWsJoinResultMessage`
 * (success) or `PuzzleWsErrorMessage` (already started), addressed only to
 * this socket. */
export const PuzzleWsJoinRequestSchema = z
    .object({
        type: z.literal(PuzzleWsClientEventType.Join),
        player: z.string().max(MAX_PLAYER_LENGTH).optional(),
        color: z.string().optional(),
    })
    .openapi("PuzzleWsJoinRequest");

/** Was POST /puzzles/:id/move's body. `token` is only needed for anonymous
 * guests — see `JoinResultSchema`. Success is observed via the resulting
 * `move`/`solved` broadcast (which reaches the sender too, since it's a
 * connected client like any other); failure comes back as a
 * `PuzzleWsErrorMessage` addressed only to this socket. */
export const PuzzleWsMoveRequestSchema = z
    .object({
        type: z.literal(PuzzleWsClientEventType.Move),
        cellA: z.number().int(),
        cellB: z.number().int(),
        participantId: z.string(),
        token: z.string().optional(),
    })
    .openapi("PuzzleWsMoveRequest");

/** Was POST /puzzles/:id/select's body — see `PuzzleWsMoveRequestSchema`
 * above for the token/reply-addressing notes, which apply identically here. */
export const PuzzleWsSelectRequestSchema = z
    .object({
        type: z.literal(PuzzleWsClientEventType.Select),
        cell: z.number().int(),
        participantId: z.string(),
        token: z.string().optional(),
    })
    .openapi("PuzzleWsSelectRequest");

/** Clears whatever tile this participant currently has selected — the WS
 * equivalent of clicking an already-selected tile again. No `cell` field:
 * a participant only ever has one active selection at a time (see
 * puzzle.model.ts's `participants.selected_cell`), so the server already
 * knows which cell to clear and broadcasts a `PuzzleWsTileDeselectedMessage`
 * naming it. A no-op if nothing's currently selected. */
export const PuzzleWsDeselectRequestSchema = z
    .object({
        type: z.literal(PuzzleWsClientEventType.Deselect),
        participantId: z.string(),
        token: z.string().optional(),
    })
    .openapi("PuzzleWsDeselectRequest");

/** Every message shape `PuzzleDO` ever accepts over its WebSocket
 * (`"ping"` is handled separately as a bare string — see
 * puzzle.model.ts's `webSocketMessage()` — and isn't part of this union). */
export const PuzzleWsClientMessageSchema = z
    .discriminatedUnion("type", [
        PuzzleWsJoinRequestSchema,
        PuzzleWsMoveRequestSchema,
        PuzzleWsSelectRequestSchema,
        PuzzleWsDeselectRequestSchema,
    ])
    .openapi("PuzzleWsClientMessage");
