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

/** Statuses at which a round is fully over — unlike `ROUND_VISIBLE_STATUSES`
 * (which also covers the still-being-guessed `Active` round, visible there
 * only via the deliberate, broadcast-to-everyone `revealRound()` give-up
 * action), these are the ones whose `prompt` is safe to include directly in
 * `RoundPublicSchema`/state pushes without spoiling anything — the round is
 * no longer guessable either way, so there's no give-up action left to
 * short-circuit. Drives the post-round reveal (see guess.constants.ts's
 * `postRoundSeconds()`). */
export const ROUND_RESOLVED_STATUSES: readonly RoundStatus[] = [
    RoundStatus.Complete,
    RoundStatus.Timeout,
];

export const RoundPublicSchema = z
    .object({
        index: z.number(),
        status: RoundStatusSchema,
        error: z.string().optional(),
        remainingMs: z.number().nullable().openapi({
            description:
                "ms left to guess this round; null unless this is the currently `active` round",
        }),
        imageUrl: z
            .string()
            .nullable()
            .openapi({
                description:
                    "Direct R2 URL to this round's generated image. Null while it isn't yet this round's turn " +
                    "(or the image hasn't generated yet) — see ROUND_VISIBLE_STATUSES — though note this only " +
                    "gates the field, not the underlying object: the bucket is public, so the same URL is " +
                    "guessable from the round's index once a game's id is known.",
            }),
        prompt: z
            .string()
            .nullable()
            .openapi({
                description:
                    "This round's real prompt; null until the round is fully resolved (`complete`/`timeout`) — " +
                    "see ROUND_RESOLVED_STATUSES. Never present early for the still-guessable `active` round; use " +
                    "POST /games/{id}/reveal for that give-up path instead.",
            }),
    })
    .openapi("Round");
export type RoundPublic = z.infer<typeof RoundPublicSchema>;

/** A single participant's running total across every `correct` guess this
 * game — sorted highest-first, so index 0 is always the leader. Present
 * (and live-updating) throughout the game, not just once it's over; the
 * client can render it as a scoreboard at any point, but it's only the
 * *final* standings once `status` reaches `solved`/`timeout`. Identified by
 * `participantId` alone — no `name`/`color` here, since those are already on
 * that participant's `ParticipantPublicSchema` roster entry (and two
 * participants can share a display `name` anyway); join against `id` there
 * to render a row. */
export const GameResultSchema = z
    .object({participantId: z.string(), score: z.number()})
    .openapi("GameResult");

/** A joined player's public roster entry — enough to render an avatar list
 * in the lobby/play page and to key it by `id` rather than the free-text
 * (and possibly duplicate) `name` — e.g. to highlight the caller's own
 * entry, or to tell two same-named guests apart. `token` stays private to
 * the participant who owns it (see JoinResultSchema); `id` isn't a secret,
 * so it's fine here. */
export const ParticipantPublicSchema = z
    .object({id: z.string(), name: z.string(), color: z.string()})
    .openapi("Participant");

export const GamePublicSchema = z
    .object({
        id: z.string(),
        theme: z.string().nullable(),
        themeGenerated: z.boolean().openapi({
            description:
                "Whether `theme` was picked for this game (a Flagship preset, or the prompt model's own idea) " +
                "rather than typed in by whoever created it — null/false until generation resolves a theme for a " +
                "game that started with none.",
        }),
        status: GameStatusSchema,
        error: z.string().optional(),
        rounds: z.array(RoundPublicSchema),
        currentRound: z.number().nullable().openapi({
            description:
                "Index of the round currently open for guessing; null before play starts or after the game has finished",
        }),
        postRoundIndex: z
            .number()
            .nullable()
            .openapi({
                description:
                    "Index of the round currently in its post-round reveal pause (see postRoundRemainingMs); " +
                    "null outside that window. Never set at the same time as currentRound — see " +
                    "guess.model.ts's resolveCurrentRound/advanceAfterPostRound.",
            }),
        postRoundRemainingMs: z
            .number()
            .nullable()
            .openapi({
                description:
                    "ms left in the post-round reveal pause for postRoundIndex — that round's real prompt is " +
                    "already visible (rounds[postRoundIndex].prompt) for the client to display alongside whether " +
                    "the current player got it right; null unless postRoundIndex is set.",
            }),
        lobbyRemainingMs: z.number().nullable().openapi({
            description: "ms left in the waiting room; null outside the `waiting` status",
        }),
        connectedPlayers: z
            .number()
            .openapi({description: "Live WebSocket connection count (players + spectators)"}),
        participants: z
            .array(ParticipantPublicSchema)
            .openapi({description: "Everyone who has joined, in join order"}),
        results: z.array(GameResultSchema).openapi({
            description:
                "Per-player total score, highest first — the final standings once `status` is `solved`/`timeout`",
        }),
    })
    .openapi("Game");

export const GuessResultSchema = z
    .object({
        correct: z.boolean(),
        prompt: z.string().nullable(),
        score: z.number().nullable().openapi({
            description:
                "Time-weighted points earned for this guess; null when the guess was wrong",
        }),
        totalScore: z.number().openapi({
            description:
                "This participant's running total across every correct guess this game so far (including this one, if correct) — same figure as their entry in GamePublicSchema's `results`",
        }),
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
    JoinResult: "join_result",
    GuessResult: "guess_result",
    Error: "error",
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
        remainingMs: z.number().optional(),
    })
    .openapi("GameWsRoundStatusMessage");

export const GameWsRoundReadyMessageSchema = z
    .object({type: z.literal(GameWsEventType.RoundReady), index: z.number()})
    .openapi("GameWsRoundReadyMessage");

export const GameWsGuessMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.Guess),
        index: z.number(),
        participantId: z.string(),
        player: z.string(),
        color: z.string(),
        correct: z.boolean(),
        score: z.number().nullable(),
        guess: z.string().optional().openapi({
            description:
                "What was actually typed — only present when `correct` is false; omitted on a correct guess so this broadcast can't spoil the prompt for anyone still guessing this round",
        }),
        createdAt: z.number().openapi({
            description:
                "Epoch ms this guess was recorded — same instant as the `guesses` row's own `createdAt`",
        }),
    })
    .openapi("GameWsGuessMessage");

export const GameWsRevealedMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.Revealed),
        index: z.number(),
        prompt: z.string(),
        participantId: z.string(),
        player: z.string(),
        color: z.string(),
    })
    .openapi("GameWsRevealedMessage");

/** Purely a live typing indicator — see guess.model.ts's `broadcastTyping`. */
export const GameWsPlayerTypingMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.PlayerTyping),
        index: z.number(),
        participantId: z.string(),
        player: z.string(),
        color: z.string(),
    })
    .openapi("GameWsPlayerTypingMessage");

/** Direct reply to a `join` client message (see `GameWsJoinRequestSchema`
 * below) — sent only to the joining socket, never broadcast, since the
 * `token`/`participantId` it carries are that participant's own secret.
 * `.extend()` on `JoinResultSchema` composes over that component rather
 * than duplicating its fields, same reasoning as `GameWsStateMessageSchema`
 * above. Mirrors Piece Puzzle's `PuzzleWsJoinResultMessageSchema`. */
export const GameWsJoinResultMessageSchema = JoinResultSchema.extend({
    type: z.literal(GameWsEventType.JoinResult),
}).openapi("GameWsJoinResultMessage");

/** Direct reply to a `guess` client message — sent only to the guessing
 * socket, since `prompt` (once correct) and `totalScore` are that
 * participant's own private view. Distinct from the public
 * `GameWsGuessMessageSchema` broadcast above (which every connected client,
 * including the guesser, also receives) — that one carries just enough for
 * everyone else's UI (`correct`/`score`) without spoiling the prompt for
 * anyone still guessing this round. `.extend()` on `GuessResultSchema`
 * composes over that component the same way `GameWsJoinResultMessageSchema`
 * does over `JoinResultSchema`. */
export const GameWsGuessResultMessageSchema = GuessResultSchema.extend({
    type: z.literal(GameWsEventType.GuessResult),
}).openapi("GameWsGuessResultMessage");

/** Direct reply to a rejected client message (`join`/`guess`/`reveal`, or one
 * that failed to parse at all) — sent only to the sender, mirroring the 4xx
 * bodies these actions used to return over HTTP before they moved onto the
 * WebSocket (see guess.model.ts's `webSocketMessage`). Mirrors Piece
 * Puzzle's `PuzzleWsErrorMessageSchema`; `typing` never rejects (see
 * `broadcastTyping()`) but is still a valid `action` tag for a malformed
 * `typing` message caught by the outer parse failure instead. */
export const GameWsErrorMessageSchema = z
    .object({
        type: z.literal(GameWsEventType.Error),
        action: z.enum(["join", "guess", "reveal", "typing", "unknown"]),
        error: z.string(),
    })
    .openapi("GameWsErrorMessage");

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
        GameWsJoinResultMessageSchema,
        GameWsGuessResultMessageSchema,
        GameWsErrorMessageSchema,
        WsPresenceMessageSchema,
        WsPongMessageSchema,
    ])
    .openapi("GameWsMessage");

// --- WebSocket client→server message shapes --------------------------------
//
// What used to be POST /games/:id/join, /guess, and /reveal are now sent as
// messages over the same WebSocket connection instead — see this file's
// header comment on `GameWsMessageSchema` for why the upgrade route itself
// still has no OpenAPI representation, and guess.model.ts's
// `webSocketMessage()` for how these get dispatched. Registered on the
// OpenAPI registry the same way as `GameWsMessageSchema` (see index.ts) so
// the generated client has typed models for the outgoing side too. Mirrors
// Piece Puzzle's own client→server union in puzzle.schema.ts.

export const GameWsClientEventType = {
    Join: "join",
    Guess: "guess",
    Reveal: "reveal",
    Typing: "typing",
} as const;
export type GameWsClientEventType =
    (typeof GameWsClientEventType)[keyof typeof GameWsClientEventType];

/** Was POST /games/:id/join's body. `player` is used as the display name
 * regardless of login state — identity (`userId`/`color`) is resolved once
 * at WebSocket-upgrade time instead (see guess.model.ts's `fetch()` and
 * `ConnectionIdentity`), same as Piece Puzzle's own `PuzzleWsJoinRequestSchema`.
 * `color` is guest-only: lets an anonymous caller bring whatever color its
 * own UI already shows for "you" (e.g. a color picked client-side before
 * ever joining a game) instead of always getting a server-generated one —
 * ignored for logged-in callers, whose account color is always
 * authoritative (see guess.model.ts's `join()`). Must look like
 * `generateColor()`'s own output (`#`+6 hex digits) or it's discarded in
 * favor of a generated one, same as omitting it entirely. Reply comes back
 * as a `GameWsJoinResultMessage` (success) or `GameWsErrorMessage` (already
 * started), addressed only to this socket. `player` isn't length-capped
 * here — Flagship's "max-player-length" flag is async, so it can't back a
 * static schema bound the way this used to; over-length names are
 * truncated instead, at the point `player` actually gets used (see
 * guess.model.ts's `webSocketMessage()`). */
export const GameWsJoinRequestSchema = z
    .object({
        type: z.literal(GameWsClientEventType.Join),
        player: z.string().optional(),
        color: z.string().optional(),
    })
    .openapi("GameWsJoinRequest");

/** Was POST /games/:id/guess's body. `token` is only needed for anonymous
 * guests — see `JoinResultSchema`. Reply comes back as a
 * `GameWsGuessResultMessage` (this guesser's own private view — see that
 * schema's doc comment) or a `GameWsErrorMessage`, addressed only to this
 * socket; everyone else only ever sees the public `GameWsGuessMessage`
 * broadcast. `index` isn't bounds-checked against this game's actual round
 * count here — an out-of-range index just fails the same as any other round
 * that isn't currently active. */
export const GameWsGuessRequestSchema = z
    .object({
        type: z.literal(GameWsClientEventType.Guess),
        index: z.number().int().min(0),
        participantId: z.string(),
        token: z.string().optional(),
        guess: z.string(),
    })
    .openapi("GameWsGuessRequest");

/** Was POST /games/:id/reveal's body — see `GameWsGuessRequestSchema` above
 * for the token/index notes, which apply identically here. Success is
 * observed via the resulting `GameWsRevealedMessage` broadcast (which
 * reaches the sender too, since it's a connected client like any other);
 * failure — including a round that isn't visible yet — comes back as a
 * `GameWsErrorMessage` addressed only to this socket. */
export const GameWsRevealRequestSchema = z
    .object({
        type: z.literal(GameWsClientEventType.Reveal),
        index: z.number().int().min(0),
        participantId: z.string(),
        token: z.string().optional(),
    })
    .openapi("GameWsRevealRequest");

/** A live "player is typing a guess" cue — see guess.model.ts's
 * `broadcastTyping()`. Purely cosmetic and fire-and-forget: never replied
 * to (success or failure), unlike every other client message here. */
export const GameWsTypingRequestSchema = z
    .object({
        type: z.literal(GameWsClientEventType.Typing),
        index: z.number(),
        participantId: z.string(),
        token: z.string().optional(),
    })
    .openapi("GameWsTypingRequest");

/** Every message shape `GameDO` ever accepts over its WebSocket
 * (`"ping"` is handled separately as a bare string — see
 * guess.model.ts's `webSocketMessage()` — and isn't part of this union). */
export const GameWsClientMessageSchema = z
    .discriminatedUnion("type", [
        GameWsJoinRequestSchema,
        GameWsGuessRequestSchema,
        GameWsRevealRequestSchema,
        GameWsTypingRequestSchema,
    ])
    .openapi("GameWsClientMessage");
