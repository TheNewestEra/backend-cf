import {z} from "@hono/zod-openapi";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {
    WsPlayerJoinedMessageSchema,
    WsPongMessageSchema,
    WsPresenceMessageSchema,
    WsStatusMessageSchema,
} from "@game-worker/shared/ws-messages";

/** Sourced from `@game-worker/shared/game-session-status` — Piece Puzzle's
 * own `PuzzleStatusSchema` (see puzzle.schema.ts) is built off the exact
 * same enum object, so the two games' status values can't drift apart. */
export const GameStatusSchema = z.nativeEnum(GameSessionStatus).openapi("GameStatus");

/** A round's own progress, independent of the game's overall `status`.
 * Rounds are played strictly sequentially once the game starts: `Ready`
 * means the image finished generating but it isn't this round's turn yet
 * (not guessable, no timer running); `Active` means it's the one current
 * round open for guessing right now (see guess.model.ts's `activateRound`/
 * `resolveCurrentRound` — at most one round is ever `Active` at a time).
 * Full lifecycle: `Pending → Generating → Ready → Active → Complete|Timeout`,
 * with `Error` as generation's own dead-end branch. */
export const RoundStatus = {
    Pending: "pending",
    Generating: "generating",
    Ready: "ready",
    Active: "active",
    Error: "error",
    Complete: "complete",
    Timeout: "timeout",
} as const;
export type RoundStatus = (typeof RoundStatus)[keyof typeof RoundStatus];
export const RoundStatusSchema = z.nativeEnum(RoundStatus).openapi("RoundStatus");

/** Statuses at which a round's image/prompt are safe to expose — the
 * spoiler gate: hidden while merely `Ready` (generated but not yet its
 * turn), visible from the moment it goes `Active` and forever after once
 * resolved, including for post-game review. Shared by guess.model.ts's
 * `revealRound()` and guess.controller.ts's image route so the two can't
 * drift on what counts as "visible". */
export const ROUND_VISIBLE_STATUSES: readonly RoundStatus[] = [
    RoundStatus.Active,
    RoundStatus.Complete,
    RoundStatus.Timeout,
];

export const RoundPublicSchema = z
    .object({
        index: z.number(),
        status: RoundStatusSchema,
        error: z.string().optional(),
        remainingMs: z
            .number()
            .nullable()
            .openapi({description: "ms left to guess this round; null unless this is the currently `active` round"}),
    })
    .openapi("Round");

/** A single participant's running total across every `correct` guess this
 * game — sorted highest-first, so index 0 is always the leader. Present
 * (and live-updating) throughout the game, not just once it's over; the
 * client can render it as a scoreboard at any point, but it's only the
 * *final* standings once `status` reaches `solved`/`timeout`. */
export const GameResultSchema = z
    .object({name: z.string(), color: z.string(), score: z.number()})
    .openapi("GameResult");

/** A joined player's public roster entry — just enough to render an avatar
 * list in the lobby/play page. No id/token here; those stay private to the
 * participant who owns them (see JoinResultSchema). Mirrors Piece Puzzle's
 * own participant roster entry. */
export const ParticipantPublicSchema = z
    .object({name: z.string(), color: z.string()})
    .openapi("Participant");

export const GamePublicSchema = z
    .object({
        id: z.string(),
        theme: z.string().nullable(),
        status: GameStatusSchema,
        error: z.string().optional(),
        rounds: z.array(RoundPublicSchema),
        currentRound: z
            .number()
            .nullable()
            .openapi({description: "Index of the round currently open for guessing; null before play starts or after the game has finished"}),
        lobbyRemainingMs: z
            .number()
            .nullable()
            .openapi({description: "ms left in the waiting room; null outside the `waiting` status"}),
        connectedPlayers: z.number().openapi({description: "Live WebSocket connection count (players + spectators)"}),
        participants: z.array(ParticipantPublicSchema).openapi({description: "Everyone who has joined, in join order"}),
        results: z
            .array(GameResultSchema)
            .openapi({description: "Per-player total score, highest first — the final standings once `status` is `solved`/`timeout`"}),
    })
    .openapi("Game");

export const GuessResultSchema = z
    .object({
        correct: z.boolean(),
        prompt: z.string().nullable(),
        score: z.number().nullable().openapi({description: "Time-weighted points earned; null when the guess was wrong"}),
    })
    .openapi("GuessResult");

/** `token` is only present for anonymous guests — it's the bearer secret
 * they must resend with every guess/reveal (see guess.model.ts's
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

// --- WebSocket message shapes ---------------------------------------------
//
// `GameDO` (see guess.model.ts) pushes each of these to connected clients.
// The WS upgrade route itself has no OpenAPI 3 representation (see
// index.ts's doc description), but `GameWsMessageSchema` is registered
// directly on the OpenAPI registry so its member shapes still show up as
// named components — and therefore as generated model types — in this
// service's spec/client for the FE to import and use.

/** The `type` discriminator values for this game's own WS events — the
 * shared ones (`status`, `player_joined`, `presence`, `pong`) live in
 * `@game-worker/shared/ws-messages`'s `WsEventType` instead, since those are
 * byte-for-byte identical to Piece Puzzle's. Together the two enums cover
 * every member of `GameWsMessageSchema` below, and `guess.model.ts`
 * broadcasts using these same values rather than raw string literals. */
export const GameWsEventType = {
    State: "state",
    PromptsReady: "prompts_ready",
    RoundStatus: "round_status",
    RoundReady: "round_ready",
    Guess: "guess",
    Revealed: "revealed",
    PlayerTyping: "player_typing",
} as const;
export type GameWsEventType = (typeof GameWsEventType)[keyof typeof GameWsEventType];

/** A full state snapshot — sent on connect and after any status-changing
 * RPC. `.extend()` on an already-`.openapi()`-named schema (`Game`) makes
 * zod-to-openapi generate this as a composition over that component rather
 * than flattening/duplicating its fields. */
export const GameWsStateMessageSchema = GamePublicSchema.extend({
    type: z.literal(GameWsEventType.State),
}).openapi("GameWsStateMessage");

export const GameWsPromptsReadyMessageSchema = z
    .object({type: z.literal(GameWsEventType.PromptsReady), count: z.number()})
    .openapi("GameWsPromptsReadyMessage");

export const GameWsRoundStatusMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.RoundStatus),
        index: z.number(),
        status: RoundPublicSchema.shape.status,
        error: z.string().optional(),
    })
    .openapi("GameWsRoundStatusMessage");

export const GameWsRoundReadyMessageSchema = z
    .object({type: z.literal(GameWsEventType.RoundReady), index: z.number()})
    .openapi("GameWsRoundReadyMessage");

export const GameWsGuessMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.Guess),
        index: z.number(),
        player: z.string(),
        color: z.string(),
        correct: z.boolean(),
        score: z.number().nullable(),
    })
    .openapi("GameWsGuessMessage");

export const GameWsRevealedMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.Revealed),
        index: z.number(),
        prompt: z.string(),
        player: z.string(),
        color: z.string(),
    })
    .openapi("GameWsRevealedMessage");

/** Purely a live typing indicator — see guess.model.ts's `broadcastTyping`. */
export const GameWsPlayerTypingMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.PlayerTyping),
        index: z.number(),
        player: z.string(),
        color: z.string(),
    })
    .openapi("GameWsPlayerTypingMessage");

/** Every message shape `GameDO` ever sends over its WebSocket, discriminated
 * by `type` — see guess.model.ts's `broadcast()`/`send()`. */
export const GameWsMessageSchema = z
    .discriminatedUnion("type", [
        GameWsStateMessageSchema,
        WsStatusMessageSchema,
        GameWsPromptsReadyMessageSchema,
        GameWsRoundStatusMessageSchema,
        GameWsRoundReadyMessageSchema,
        WsPlayerJoinedMessageSchema,
        GameWsGuessMessageSchema,
        GameWsRevealedMessageSchema,
        GameWsPlayerTypingMessageSchema,
        WsPresenceMessageSchema,
        WsPongMessageSchema,
    ])
    .openapi("GameWsMessage");
