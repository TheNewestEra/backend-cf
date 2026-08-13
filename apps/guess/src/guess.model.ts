import {DurableObject} from "cloudflare:workers";
import type {z} from "@hono/zod-openapi";
import {and, asc, desc, eq, sql} from "drizzle-orm";
import {migrate as runMigrations} from "drizzle-orm/durable-sqlite/migrator";
import {err, ok, type Result} from "neverthrow";
import {generateColor, isValidHexColor} from "@game-worker/shared/color";
import {maxPlayerLength} from "@game-worker/shared/game-session";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {lobbyCountdownSeconds, lobbyEndsAt, lobbyRemainingMs} from "@game-worker/shared/lobby";
import {fromRpcResult, type RpcResult, toRpcResult} from "@game-worker/shared/rpc-result";
import {currentUserFromRequestVia} from "@game-worker/shared/session";
import {WsEventType} from "@game-worker/shared/ws-messages";
import {createDb, type Db} from "./db/client";
import migrations from "./db/migrations";
import {game, guesses, participants, rounds} from "./db/schema";
import {isGuessCorrect} from "./guess-matching";
import type {GamePublicSchema, GameResultSchema, GameWsMessageSchema, GuessResultSchema} from "./guess.schema";
import {
    GameWsClientEventType,
    GameWsClientMessageSchema,
    GameWsEventType,
    ROUND_RESOLVED_STATUSES,
    ROUND_VISIBLE_STATUSES,
    RoundStatus,
} from "./guess.schema";
import {
    DEFAULT_GUESS_TIME_LIMIT_SECONDS,
    guessMatchThreshold,
    guessMaxScore,
    guessMinScore,
    guessTimeLimitSeconds,
    imageUrlPathFor,
    postRoundSeconds,
    roundCount,
} from "./guess.constants";

export {ROUND_VISIBLE_STATUSES, RoundStatus};
export type GameStatus = z.infer<typeof GamePublicSchema>["status"];
export type GamePublic = z.infer<typeof GamePublicSchema>;
export type GuessResult = z.infer<typeof GuessResultSchema>;
export type GameResult = z.infer<typeof GameResultSchema>;
export type GameWsMessage = z.infer<typeof GameWsMessageSchema>;

// Row types inferred straight off the Drizzle schema (see ./db/schema.ts)
// rather than hand-maintained interfaces — same transition
// apps/browse/src/catalog.service.ts made for its own `CatalogRow`.
type GameRow = typeof game.$inferSelect;
type RoundRow = typeof rounds.$inferSelect;
type ParticipantRow = typeof participants.$inferSelect;

/** What a connected socket knows about who it's speaking for — resolved
 * once at `fetch()`/upgrade time (the only point a WS connection carries
 * the session cookie) and kept on the socket itself via
 * `serializeAttachment`/`deserializeAttachment` for the rest of its
 * lifetime, since individual WS messages don't carry cookies the way HTTP
 * requests did. `null`/`null` for an anonymous connection. Mirrors Piece
 * Puzzle's `PuzzleDO`'s own `ConnectionIdentity`. */
interface ConnectionIdentity {
    userId: string | null;
    color: string | null;
}

/** The `action` values `GameWsErrorMessage` (see guess.schema.ts's
 * `GameWsErrorMessageSchema`) tags a rejected client message with —
 * matches that schema's own `z.enum([...])` literal-for-literal, same
 * pattern as `GameWsClientEventType` (a TS `enum` member isn't assignable
 * to the schema's plain string-literal union without a cast, where this
 * is). Used by `webSocketMessage()`'s `reply()` helper below. Mirrors
 * Piece Puzzle's `PuzzleWsAction`. */
export const GameWsAction = {
    Unknown: "unknown",
    Join: "join",
    Guess: "guess",
    Reveal: "reveal",
    Typing: "typing",
} as const;
export type GameWsAction = (typeof GameWsAction)[keyof typeof GameWsAction];

/** Statuses in which a game hasn't started yet — the only window during
 * which joining is allowed. Once a game reaches `playing` its rounds are
 * playable, so letting someone join at that point would let them play a
 * game already in progress rather than just spectate it; `waiting` is the
 * lobby itself, still open to joiners same as Piece Puzzle's; `error` is a
 * dead end with nothing left to join (replay creates a fresh instance
 * instead). */
const JOINABLE_STATUSES: readonly GameStatus[] = [
    GameSessionStatus.Queued,
    GameSessionStatus.Generating,
    GameSessionStatus.Waiting,
];

/**
 * One instance per game (routed via `env.GAME_DO.getByName(gameId)`).
 * Owns the game's durable state (prompts, round/image status, guesses) and
 * pushes live progress to every connected WebSocket as the queue consumer
 * calls its RPC methods.
 *
 * Rounds are generated up front (all of them, in parallel — see
 * guess.queue.ts and `round_count` on the `game` table) but played
 * strictly sequentially: once play begins, round
 * 0 is the only one `Active` (open for guessing); each subsequent round only
 * opens once the previous one resolves, either because every joined
 * participant answered it correctly (early advance) or its own guess-timeout
 * fired — see `activateRound()`/`resolveCurrentRound()`. At most one round is
 * ever `Active` at a time.
 *
 * Mirrors `apps/puzzle`'s `PuzzleDO` lobby shape: once every round's image
 * is ready, the game sits in a `waiting` room (see `setReady()`) instead of
 * starting instantly, so players can gather before play begins — either
 * automatically after Flagship's "lobby-countdown-seconds" flag elapses
 * (a DO alarm — see `lobbyCountdownSeconds()`) or early via
 * the host's `startNow()`. The creator ("host") gets a one-time secret
 * token back from `init()`, never broadcast or included in `getState()`,
 * which their browser must present to start early — same contract as
 * `PuzzleDO`'s `host_token`.
 */
class GameDO extends DurableObject<Env> {
    // Threaded through as a class field (rather than a parameter, unlike
    // the D1 apps' module-level functions) since every method already has
    // `this.ctx` available. `drizzle-orm/durable-sqlite` wraps `ctx.storage`
    // directly and stays SYNCHRONOUS — see ./db/client.ts's doc comment.
    private readonly db: Db;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        // `this.db` has to exist before `migrate()` runs — the real Drizzle
        // migrator (see `migrate()`'s own doc comment) queries through it,
        // unlike the old hand-rolled bootstrap this replaced, which only
        // ever touched `ctx.storage.sql` directly.
        this.db = createDb(ctx.storage);
        ctx.blockConcurrencyWhile(this.migrate);
    }

    // `origin` is the scheme+host the creating request came in on (see
    // guess.controller.ts — `new URL(c.req.url).origin`, same technique
    // `browse`'s catalog.service.ts uses for `thumbnailUrl`), persisted on
    // the game row and reused for every round's `imageUrl` thereafter — see
    // the `origin` field's doc comment on ./db/schema.ts's `game` table.
    async init(gameId: string, theme: string | null, origin: string): Promise<string> {
        await this.ctx.storage.deleteAlarm();
        const hostToken = crypto.randomUUID();
        const now = Date.now();
        // Resolved once, here, and persisted on the game row — see the
        // `round_count` field's doc comment on ./db/schema.ts's `game` table.
        const roundsCount = await roundCount(this.env);
        this.db.delete(guesses).run();
        this.db.delete(rounds).run();
        this.db.delete(participants).run();
        this.db
            .insert(game)
            .values({
                id: gameId,
                theme,
                status: "queued",
                error: null,
                hostToken,
                origin,
                lobbyEndsAt: null,
                postRoundIndex: null,
                postRoundEndsAt: null,
                roundCount: roundsCount,
                createdAt: now,
            })
            // Mixes `excluded.col` references with literal constants
            // ('queued', NULL) — same SET clause as the raw SQL this
            // replaced.
            .onConflictDoUpdate({
                target: game.id,
                set: {
                    theme: sql`excluded.theme`,
                    status: "queued",
                    error: null,
                    hostToken: sql`excluded.host_token`,
                    origin: sql`excluded.origin`,
                    lobbyEndsAt: null,
                    postRoundIndex: null,
                    postRoundEndsAt: null,
                    roundCount: sql`excluded.round_count`,
                },
            })
            .run();
        for (let i = 0; i < roundsCount; i++) {
            this.db.insert(rounds).values({idx: i, status: "pending"}).run();
        }
        this.broadcast({type: GameWsEventType.State, ...this.readPublicState()});
        return hostToken;
    }

    // --- RPC: create a brand new game's state (never called twice for the
    // same id — /replay always targets a fresh, independent gameId) --------

    getState(): GamePublic {
        return this.readPublicState();
    }

    // --- RPC: read-only snapshot (HTTP polling + WebSocket connect) -------

    async setStatus(status: GameStatus, error?: string): Promise<void> {
        // `error` is terminal (see guess.queue.ts) — drop any armed round-
        // timeout/lobby alarm so a stale one can't fire against a dead game.
        if (status === GameSessionStatus.Error) await this.ctx.storage.deleteAlarm();
        this.db.update(game).set({status, error: error ?? null}).run();
        this.broadcast({type: WsEventType.Status, status, error});
    }

    // --- RPC: progress updates from the queue consumer ---------------------

    async setPrompts(prompts: string[]): Promise<void> {
        prompts.forEach((prompt, idx) => {
            this.db.update(rounds).set({prompt}).where(eq(rounds.idx, idx)).run();
        });
        this.broadcast({type: GameWsEventType.PromptsReady, count: prompts.length});
    }

    async setRoundStatus(index: number, status: RoundStatus, error?: string): Promise<void> {
        this.db
            .update(rounds)
            .set({status, error: error ?? null})
            .where(eq(rounds.idx, index))
            .run();
        this.broadcast({type: GameWsEventType.RoundStatus, index, status, error});
    }

    /** Image done generating — the round is now `ready`, i.e. queued up
     * waiting its turn. Not guessable yet and no timer runs from here:
     * `ready_at` is purely informational (when generation finished); the
     * round only starts counting down once it actually becomes the current
     * round (see `activateRound()`, which stamps `started_at`). */
    async setRoundImage(index: number, imageKey: string): Promise<void> {
        this.db
            .update(rounds)
            .set({imageKey, status: "ready", readyAt: Date.now(), error: null})
            .where(eq(rounds.idx, index))
            .run();
        this.broadcast({type: GameWsEventType.RoundReady, index});
    }

    /** Every round's image is ready — open the waiting room rather than
     * starting instantly (see the class doc comment). Mirrors
     * `PuzzleDO.setReady()`. */
    async setReady(): Promise<void> {
        const endsAt = lobbyEndsAt(Date.now(), await lobbyCountdownSeconds(this.env.FLAGS));
        this.db.update(game).set({status: "waiting", error: null, lobbyEndsAt: endsAt}).run();
        await this.scheduleNextAlarm();
        this.broadcast({type: GameWsEventType.State, ...this.readPublicState()});
    }

    /** Ends the lobby countdown immediately and starts play. Mirrors
     * `PuzzleDO.startNow()`. */
    async startNow(hostToken: string): Promise<RpcResult<void>> {
        const validated = this.requireGameRow()
            .andThen((row) => this.assertHost(row, hostToken))
            .andThen((row) => (row.status === GameSessionStatus.Waiting ? ok(row) : err("game is not waiting to start")));
        if (validated.isErr()) return {ok: false, error: validated.error};

        const row = validated.value;
        await this.beginPlaying(row.id);
        return toRpcResult(ok(undefined));
    }

    // --- RPC: host-only lobby action ----------------------------------------

    /** Registers a player as allowed to guess/reveal in this game, only while
     * a round hasn't been generated yet or the lobby is open (see
     * JOINABLE_STATUSES) — once the game is `playing` this throws, so late
     * arrivals can still spectate over the WebSocket/`getState()` but can't
     * play. Logged-in users are upserted by `userId` (idempotent across
     * reconnects/tab refreshes, no token needed since the session re-proves
     * identity on every request) and keep their account color (never
     * `requestedColor` — an account's color is authoritative everywhere else
     * in the app, so letting it be overridden per-game would be surprising);
     * anonymous guests get a fresh bearer token they must resend with every
     * guess/reveal (since a free-text name alone isn't a real identity) and
     * either their own `requestedColor` (if it's a well-formed hex color —
     * see `isValidHexColor`) or, absent that, a freshly generated one.
     * Either way, the color is returned so the caller's own client knows
     * what to render before the next broadcast. Mirrors `PuzzleDO.join()`. */
    async join(
        userId: string | null,
        playerName: string,
        userColor: string | null,
        requestedColor: string | null,
    ): Promise<RpcResult<{ participantId: string; token: string | null; color: string }>> {
        const validated = this.requireGameRow().andThen((row) =>
            JOINABLE_STATUSES.includes(row.status)
                ? ok(row)
                : err("game has already started; you can spectate but not join"),
        );
        if (validated.isErr()) return {ok: false, error: validated.error};

        const color = userId
            ? (userColor ?? generateColor())
            : requestedColor && isValidHexColor(requestedColor)
                ? requestedColor
                : generateColor();

        if (userId) {
            this.db
                .insert(participants)
                .values({id: userId, name: playerName, userId, token: null, color, joinedAt: Date.now()})
                .onConflictDoUpdate({
                    target: participants.id,
                    set: {name: sql`excluded.name`, color: sql`excluded.color`},
                })
                .run();
            this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color, participantId: userId});
            return toRpcResult(ok({participantId: userId, token: null, color}));
        }

        const participantId = crypto.randomUUID();
        const token = crypto.randomUUID();
        this.db
            .insert(participants)
            .values({id: participantId, name: playerName, userId: null, token, color, joinedAt: Date.now()})
            .run();
        this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color, participantId});
        return toRpcResult(ok({participantId, token, color}));
    }

    // --- RPC: joining --------------------------------------------------------

    /** `userId` is null for anonymous guests — their guesses still count
     * toward this game's own scoreboard (`results`, see `readPublicState()`),
     * they just aren't logged to the leaderboard, which only happens once
     * per player as a single total when the game finishes (see
     * `finalizeGame()`) rather than per guess. `participantId`/`token` prove
     * the caller joined before the game started — see `join()` and
     * `requireParticipant()`. Only the current round (`RoundStatus.Active`)
     * accepts guesses — a not-yet-active, already-resolved, or unknown index
     * all reject the same way. Wrong guesses can be resubmitted any number of
     * times; a correct one locks the participant out of guessing this round
     * again (enforced below) — once every joined participant has answered
     * correctly, the round advances immediately via `resolveCurrentRound()`
     * rather than waiting out its timer. Scores off `round.timeLimitMs` —
     * the limit stamped by `activateRound()` when this round began, not
     * whatever Flagship says right now — so a flag flip mid-round can't
     * retroactively change what this guess is worth. */
    async submitGuess(
        index: number,
        participantId: string,
        token: string | null,
        guess: string,
        userId: string | null,
    ): Promise<RpcResult<GuessResult>> {
        const validated = this.requireParticipant(participantId, token, userId).andThen((participant) =>
            this.requireGameRow().andThen((gameRow) => {
                const round = this.db.select().from(rounds).where(eq(rounds.idx, index)).get();
                if (!round || round.status !== RoundStatus.Active || !round.prompt) {
                    return err("round not active");
                }
                // Captured as its own binding (rather than relying on
                // `round.prompt` after this point) so the narrowing to
                // non-null above survives being carried inside the `ok()`
                // object literal — TS doesn't propagate a property
                // narrowing through an object literal's field.
                const prompt = round.prompt;

                const alreadyCorrect = this.db
                    .select({n: sql<number>`COUNT(*)`})
                    .from(guesses)
                    .where(
                        and(
                            eq(guesses.roundIdx, index),
                            eq(guesses.participantId, participantId),
                            eq(guesses.correct, 1),
                        ),
                    )
                    .get()?.n;
                if (alreadyCorrect && alreadyCorrect > 0) {
                    return err("you already answered this round correctly");
                }

                return ok({participant, gameRow, round, prompt});
            }),
        );
        if (validated.isErr()) return {ok: false, error: validated.error};
        const {participant, gameRow, round, prompt} = validated.value;

        const correct = isGuessCorrect(guess, prompt, await guessMatchThreshold(this.env));
        const score = correct
            ? scoreForGuess(round.startedAt, round.timeLimitMs, await guessMaxScore(this.env), await guessMinScore(this.env))
            : null;

        this.db
            .insert(guesses)
            .values({
                roundIdx: index,
                participantId,
                player: participant.name,
                guess,
                correct: correct ? 1 : 0,
                score,
                createdAt: Date.now(),
            })
            .run();

        // Same "sum of every correct guess" this participant has ever
        // banked as readPublicState()'s `results` — recomputed here (rather
        // than incrementally tracked) so it can't drift from that figure.
        const totalScore =
            this.db
                .select({total: sql<number>`COALESCE(SUM(${guesses.score}), 0)`})
                .from(guesses)
                .where(and(eq(guesses.participantId, participantId), eq(guesses.correct, 1)))
                .get()?.total ?? 0;

        this.broadcast({
            type: GameWsEventType.Guess,
            index,
            participantId,
            player: participant.name,
            color: participant.color,
            correct,
            score,
        });

        if (correct) {
            const participantCount = this.db.select({n: sql<number>`COUNT(*)`}).from(participants).get()?.n ?? 0;
            const correctCount =
                this.db
                    .select({n: sql<number>`COUNT(DISTINCT ${guesses.participantId})`})
                    .from(guesses)
                    .where(and(eq(guesses.roundIdx, index), eq(guesses.correct, 1)))
                    .get()?.n ?? 0;
            if (participantCount > 0 && correctCount >= participantCount) {
                // Everyone's answered correctly — advance now rather than waiting
                // out the timer.
                await this.resolveCurrentRound(gameRow.id, index);
            }
        }

        return toRpcResult(ok({correct, prompt: correct ? prompt : null, score, totalScore}));
    }

    /** Reveals a round's prompt without guessing — gated the same as guessing
     * itself against spoilers (see `ROUND_VISIBLE_STATUSES`): only the
     * current round or one that's already resolved can be revealed, never a
     * round still queued up waiting its turn — `Err("round not visible
     * yet")` rather than a silent `ok(null)` for that case (unlike this
     * method's old HTTP-era shape, which needed the `null` to tell its 200
     * from its 409), since `webSocketMessage()`'s `reply()` now folds every
     * rejection into a `GameWsErrorMessage` the same way regardless of which
     * one it is. */
    async revealRound(
        index: number,
        participantId: string,
        token: string | null,
        userId: string | null,
    ): Promise<RpcResult<string>> {
        const validated = this.requireParticipant(participantId, token, userId).andThen((participant) => {
            const round = this.db.select().from(rounds).where(eq(rounds.idx, index)).get();
            if (!round?.prompt || !ROUND_VISIBLE_STATUSES.includes(round.status)) return err("round not visible yet");
            // Captured as its own binding (rather than relying on
            // `round.prompt` after this point) so the narrowing to non-null
            // above survives being carried inside the `ok()` object literal
            // — same reasoning as `submitGuess()`'s own `prompt` binding.
            const prompt = round.prompt;
            return ok({participant, prompt});
        });
        if (validated.isErr()) return {ok: false, error: validated.error};
        const {participant, prompt} = validated.value;

        this.broadcast({
            type: GameWsEventType.Revealed,
            index,
            prompt,
            participantId,
            player: participant.name,
            color: participant.color
        });
        return toRpcResult(ok(prompt));
    }

    // --- RPC: player interaction --------------------------------------------

    /** A DO has exactly one alarm slot, shared here by two different
     * deadlines: the lobby countdown (`waiting` → `playing`) and, once
     * playing, the single current round's own guess-timeout — at most one
     * round is ever `Active` at a time (see the class doc comment), so
     * there's only ever one round deadline to consider. `scheduleNextAlarm()`
     * always arms it for whichever deadline is soonest. */
    async alarm(): Promise<void> {
        // Not part of `GameDO`'s RPC surface — there's no caller to hand a
        // `Result` back to, and the DO alarm subsystem's own retry policy is
        // exactly what an uncaught rejection here should drive, same as a
        // thrown error always did — so `requireGameRow()`'s `Err` is
        // rethrown rather than propagated as a value. Mirrors PuzzleDO's
        // `alarm()`.
        const row = this.requireGameRow().match(
            (row) => row,
            (error) => {
                throw new Error(error);
            },
        );

        if (row.status === GameSessionStatus.Waiting && row.lobbyEndsAt !== null && Date.now() >= row.lobbyEndsAt) {
            await this.beginPlaying(row.id);
            return;
        }

        if (row.status !== GameSessionStatus.Playing) {
            // Game already moved on to a terminal status (error, resolved by an
            // earlier tick, or still waiting on a lobby deadline that isn't due
            // yet) before this stale alarm fired — nothing to do.
            return;
        }

        if (row.postRoundIndex !== null) {
            if (row.postRoundEndsAt === null || Date.now() < row.postRoundEndsAt) {
                // Stale/early firing — rearm rather than advancing early.
                await this.scheduleNextAlarm();
                return;
            }
            await this.advanceAfterPostRound(row.id, row.postRoundIndex);
            return;
        }

        const active = this.db.select().from(rounds).where(eq(rounds.status, "active")).limit(1).get();
        if (!active) return; // shouldn't happen while playing, but nothing to resolve

        const limitMs = active.timeLimitMs ?? (await guessTimeLimitSeconds(this.env)) * 1000;
        if (active.startedAt === null || Date.now() < active.startedAt + limitMs) {
            // Stale/early firing (e.g. rearmed to a later deadline since this
            // alarm was set) — rearm rather than resolving early.
            await this.scheduleNextAlarm();
            return;
        }

        await this.resolveCurrentRound(row.id, active.idx);
    }

    override async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", {status: 426});
        }
        // Resolved once, here, because this is the only point a WS
        // connection ever carries the session cookie — see
        // `ConnectionIdentity`'s doc comment. Mirrors `PuzzleDO.fetch()`.
        const user = await currentUserFromRequestVia(request, this.env.ACCOUNTS);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({
            userId: user?.id ?? null,
            color: user?.color ?? null,
        } satisfies ConnectionIdentity);
        this.send(pair[1], {type: GameWsEventType.State, ...this.readPublicState()});
        // Let every other connected client know the spectator/player count
        // changed — mirrors PuzzleDO's presence broadcast.
        this.broadcast({type: WsEventType.Presence, connectedPlayers: this.ctx.getWebSockets().length});
        return new Response(null, {status: 101, webSocket: pair[0]});
    }

    /** Dispatches one parsed client message to its RPC and replies once, to
     * the sending socket only — broadcasts to everyone else still happen
     * inside the RPC itself (`join()`/`submitGuess()`/`revealRound()`), same
     * as before. Each arm's own validation (e.g. `player`/`guess` being
     * non-empty) is checked up front and short-circuits with a
     * `GameWsErrorMessage` the same way a rejected RPC call would; the RPC
     * call itself already returns an `RpcResult` (see
     * @game-worker/shared/rpc-result) instead of throwing, so there's no
     * `try/catch` here at all — just `fromRpcResult()` to rehydrate a real
     * `neverthrow` `Result`, and `reply()` to `.match()` it into whichever
     * message actually goes back to the sender. Mirrors `PuzzleDO`'s own
     * `webSocketMessage()`; `typing` is the one arm that never replies
     * (fire-and-forget, same as before this migration — see
     * `broadcastTyping()`). */
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (typeof message !== "string") return;
        if (message === "ping") {
            this.send(ws, {type: WsEventType.Pong});
            return;
        }

        let json: unknown;
        try {
            json = JSON.parse(message);
        } catch {
            this.send(ws, {type: GameWsEventType.Error, action: GameWsAction.Unknown, error: "malformed message"});
            return;
        }
        const parsed = GameWsClientMessageSchema.safeParse(json);
        if (!parsed.success) {
            this.send(ws, {type: GameWsEventType.Error, action: GameWsAction.Unknown, error: "invalid message"});
            return;
        }

        const identity = (ws.deserializeAttachment() as ConnectionIdentity | null) ?? {userId: null, color: null};
        const data = parsed.data;

        switch (data.type) {
            case GameWsClientEventType.Join: {
                const player = data.player?.trim().slice(0, await maxPlayerLength(this.env.FLAGS)) ?? "";
                if (!player) {
                    this.send(ws, {type: GameWsEventType.Error, action: GameWsAction.Join, error: "player is required"});
                    return;
                }
                // join() only ever rejects with the "already started" case —
                // see guess.controller.ts's old POST .../join handler, which
                // this mirrors.
                const outcome = fromRpcResult(
                    await this.join(identity.userId, player, identity.color, data.color ?? null),
                );
                this.reply(ws, GameWsAction.Join, outcome, (joined) => ({type: GameWsEventType.JoinResult, ...joined}));
                return;
            }
            case GameWsClientEventType.Guess: {
                const guess = data.guess.trim();
                if (!guess) {
                    this.send(ws, {type: GameWsEventType.Error, action: GameWsAction.Guess, error: "guess is required"});
                    return;
                }
                const outcome = fromRpcResult(
                    await this.submitGuess(data.index, data.participantId, data.token ?? null, guess, identity.userId),
                );
                this.reply(ws, GameWsAction.Guess, outcome, (result) => ({type: GameWsEventType.GuessResult, ...result}));
                return;
            }
            case GameWsClientEventType.Reveal: {
                const outcome = fromRpcResult(
                    await this.revealRound(data.index, data.participantId, data.token ?? null, identity.userId),
                );
                this.reply(ws, GameWsAction.Reveal, outcome);
                return;
            }
            case GameWsClientEventType.Typing: {
                this.broadcastTyping(data.index, data.participantId, data.token ?? null);
                return;
            }
        }
    }

    /** Folds a `fromRpcResult()`-rehydrated `Result` into the single reply
     * `webSocketMessage()` sends the originating socket for one action:
     * `toMessage(value)` on `Ok` — default "nothing", since `revealRound()`
     * already broadcasts its own result, which reaches the sender too as
     * just another connected client — or a `GameWsErrorMessage` tagged with
     * `action` on `Err`. Mirrors `PuzzleDO.reply()`. */
    private reply<T>(
        ws: WebSocket,
        action: GameWsAction,
        outcome: Result<T, string>,
        toMessage: (value: T) => GameWsMessage | null = () => null,
    ): void {
        outcome.match(
            (value) => {
                const message = toMessage(value);
                if (message) this.send(ws, message);
            },
            (error) => this.send(ws, {type: GameWsEventType.Error, action, error}),
        );
    }

    // --- alarm: drives the lobby's auto-start, then the current round's own
    // guess-timeout -------------------------------------------------------------

    async webSocketClose(): Promise<void> {
        // -1 because this handler runs before the closing socket drops out of
        // getWebSockets() on some runtimes; broadcasting a stale +1 count is
        // more confusing than a same-tick undercount that self-corrects on the
        // next presence event. Mirrors PuzzleDO's webSocketClose.
        this.broadcast({
            type: WsEventType.Presence,
            connectedPlayers: Math.max(0, this.ctx.getWebSockets().length - 1)
        });
    }

    // --- WebSocket upgrade (DOs use fetch() for this, not RPC) --------------

    // Real Drizzle migrations now, replacing the hand-rolled idempotent
    // `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` bootstrap this used to run
    // directly against `ctx.storage.sql`. `drizzle-kit generate` (run from
    // apps/guess) is schema.ts's source of truth for the SQL under
    // ../../drizzle; `./db/migrations.ts` hand-wires those generated files
    // in as importable modules (a DO can't read them off disk at runtime)
    // for `drizzle-orm/durable-sqlite/migrator`'s `migrate()` to apply. See
    // ./db/README.md for the full story and the workflow for a future
    // schema change.
    //
    // NOTE: migration `0000` is `drizzle-kit`'s plain generated
    // `CREATE TABLE` output, not `CREATE TABLE IF NOT EXISTS` — deliberately
    // not softened to tolerate a table that already exists. Any `GameDO`
    // instance that was already bootstrapped by the old raw-SQL `migrate()`
    // before this change will fail this migration (table already exists)
    // the next time it's touched. Accepted trade-off, not an oversight.
    private migrate = async (): Promise<void> => runMigrations(this.db, migrations);

    /** Resolves and authorizes a participant: logged-in callers must be
     * signed in as the same user who joined; anonymous callers must present
     * the token issued at join time. `Err("forbidden: ...")` for either
     * failure — every caller (`submitGuess()`/`revealRound()`) folds that
     * straight into its own `RpcResult` (see shared/rpc-result.ts), which
     * guess.controller.ts's `hostActionError` maps to a 403 — someone who
     * never joined can still spectate, they just can't act. Resolves to the
     * joined display name/color to record on the action and broadcast
     * alongside it. Mirrors `PuzzleDO.requireParticipant()`. */
    private requireParticipant(
        participantId: string,
        token: string | null,
        userId: string | null,
    ): Result<{ name: string; color: string }, string> {
        const row = this.db.select().from(participants).where(eq(participants.id, participantId)).get();
        if (!row) return err("forbidden: join the game before playing");
        if (row.userId) {
            if (row.userId !== userId) return err("forbidden: not your participant id");
        } else if (!token || token !== row.token) {
            return err("forbidden: invalid participant token");
        }
        return ok({name: row.name, color: row.color});
    }

    /** Broadcasts that a player is actively typing a guess for a round —
     * purely a live UX cue (see the class doc comment on interactivity), not
     * persisted anywhere: a client that misses it just won't see the
     * indicator, which is preferable to it outliving the player's attention.
     * Routed through `webSocketMessage` rather than an RPC/HTTP route since
     * it's fire-and-forget and only meaningful while the socket is open —
     * which also means there's no session cookie to check a logged-in
     * participant's `userId` against here (unlike `requireParticipant()`'s
     * HTTP callers). Low stakes enough (cosmetic only, no state mutation)
     * that a guest still needs their token, but a logged-in participant is
     * just trusted by `participantId` — never broadcast to anyone else, so
     * not guessable by another player anyway. */
    private broadcastTyping(index: number, participantId: string, token: string | null): void {
        const row = this.db.select().from(participants).where(eq(participants.id, participantId)).get();
        if (!row) return;
        if (!row.userId && (!token || token !== row.token)) return;
        this.broadcast({type: GameWsEventType.PlayerTyping, index, participantId, player: row.name, color: row.color});
    }

    // --- internals -----------------------------------------------------------

    /** Shared by the host's "start now" and the lobby alarm's auto-start.
     * Mirrors `PuzzleDO.beginPlaying()`. Activates round 0 — the only round
     * that's ever open for guessing the instant play begins; every round
     * after it opens only once its predecessor resolves (see
     * `resolveCurrentRound()`). */
    private async beginPlaying(gameId: string): Promise<void> {
        this.db.update(game).set({status: "playing", lobbyEndsAt: null}).run();
        await this.activateRound(0);
        this.broadcast({type: GameWsEventType.State, ...this.readPublicState()});
        // Distinct write from markCatalogReady (already fired back in
        // setReady()'s caller, guess.queue.ts) — see that RPC's own doc
        // comment on `updatePlayStatus`. `.catch()`'d so a `browse` hiccup
        // can't break a live lobby auto-start.
        this.ctx.waitUntil(
            this.env.BROWSE.updatePlayStatus(gameId, "active").catch((err) => {
                console.error("failed to update catalog play status", gameId, err);
            }),
        );
    }

    /** Marks round `index` as the current round: stamps `started_at` and
     * `time_limit_ms` (the scoring/deadline/remaining-time anchor — see
     * `scoreForGuess()` and `readPublicState()`'s `remainingMs`), flips its
     * status to `Active`, arms the alarm for its own guess-timeout deadline,
     * and broadcasts the transition. The limit is read from Flagship once
     * here and stuck to for this round's whole lifetime, rather than
     * re-fetched on every later use — so a flag flip mid-round can't leave
     * the armed alarm, the eventual score, and the displayed countdown
     * disagreeing with each other. Every round is guaranteed `ready` by the
     * time this is ever called — generation fully gates `waiting`/`playing`
     * (see guess.queue.ts) — so there's no status check to make first. Shared
     * by `beginPlaying()` (round 0) and `resolveCurrentRound()` (every round
     * after). */
    private async activateRound(index: number): Promise<void> {
        const startedAt = Date.now();
        const timeLimitMs = (await guessTimeLimitSeconds(this.env)) * 1000;
        this.db
            .update(rounds)
            .set({status: "active", startedAt, timeLimitMs})
            .where(eq(rounds.idx, index))
            .run();
        this.broadcast({
            type: GameWsEventType.RoundStatus,
            index,
            status: RoundStatus.Active,
            remainingMs: timeLimitMs,
        });
        await this.scheduleNextAlarm();
    }

    /** Closes out the current round (`complete` if it got at least one
     * correct guess, `timeout` if none), then opens its post-round reveal
     * pause (see `postRoundSeconds()`) rather than immediately moving on —
     * `advanceAfterPostRound()` does that once the pause elapses. Called from
     * two independent triggers: `alarm()` once a round's own deadline
     * passes, and `submitGuess()` the instant every joined participant has
     * answered correctly (early advance, before the timer). Because those
     * two triggers can interleave around an `await` (Durable Objects can
     * process another incoming call while one is awaiting a binding, e.g.
     * `guessTimeLimitSeconds()`), this re-checks the round is still `Active`
     * as its very first, synchronous step — whichever trigger gets here
     * first wins and the other is a clean no-op instead of double-resolving.
     * That first check-then-write sequence (the `still` read through the
     * `UPDATE rounds` below) has no `await` anywhere in it — same as the
     * `ctx.storage.sql.exec()` calls it replaced, since
     * `drizzle-orm/durable-sqlite` stays synchronous too (see ./db/client.ts)
     * — so the race this comment describes is still closed the same way. */
    private async resolveCurrentRound(gameId: string, index: number): Promise<void> {
        const still = this.db.select({status: rounds.status}).from(rounds).where(eq(rounds.idx, index)).get();
        if (still?.status !== RoundStatus.Active) return; // already resolved by the other trigger

        const correct = this.db
            .select({n: sql<number>`COUNT(*)`})
            .from(guesses)
            .where(and(eq(guesses.roundIdx, index), eq(guesses.correct, 1)))
            .get()?.n;
        const status: RoundStatus = correct && correct > 0 ? RoundStatus.Complete : RoundStatus.Timeout;
        this.db.update(rounds).set({status}).where(eq(rounds.idx, index)).run();
        this.broadcast({type: GameWsEventType.RoundStatus, index, status});

        const postRoundEndsAt = Date.now() + (await postRoundSeconds(this.env)) * 1000;
        this.db.update(game).set({postRoundIndex: index, postRoundEndsAt}).run();
        // Full state push (not just the RoundStatus one above) so clients pick
        // up postRoundIndex/postRoundRemainingMs and this round's now-visible
        // `prompt` (see ROUND_RESOLVED_STATUSES) together in one message.
        this.broadcast({type: GameWsEventType.State, ...this.readPublicState()});
        await this.scheduleNextAlarm();
    }

    /** Ends round `index`'s post-round reveal pause: either activates the
     * next round or, once the last round's pause elapses, finalizes the
     * game. Split out from `resolveCurrentRound()` so the reveal pause is a
     * real wait — driven by `alarm()` — rather than something clients only
     * see for an instant. */
    private async advanceAfterPostRound(gameId: string, index: number): Promise<void> {
        // Internal orchestration, not part of the RPC surface — see
        // `alarm()`'s doc comment on why this unwraps-and-rethrows rather
        // than propagating an `Err`.
        const row = this.requireGameRow().match(
            (row) => row,
            (error) => {
                throw new Error(error);
            },
        );
        this.db.update(game).set({postRoundIndex: null, postRoundEndsAt: null}).run();

        const nextIndex = index + 1;
        if (nextIndex < row.roundCount) {
            await this.activateRound(nextIndex);
            this.broadcast({type: GameWsEventType.State, ...this.readPublicState()});
            return;
        }

        // Every round has now resolved — same "solved if anyone ever completed
        // a round, timeout only if none were ever completed" rule as before.
        const anyComplete = this.db
            .select({n: sql<number>`COUNT(*)`})
            .from(rounds)
            .where(eq(rounds.status, "complete"))
            .get()?.n;
        const gameStatus = anyComplete && anyComplete > 0 ? GameSessionStatus.Solved : GameSessionStatus.Timeout;
        await this.finalizeGame(gameId, gameStatus);
    }

    /** Every round has resolved — decide the game (`solved` if at least one
     * round was completed by someone, `timeout` only if every round went
     * unguessed), total each participant's correct-guess scores, and record
     * one leaderboard entry per logged-in player for their total (replacing
     * the old per-guess recording, so a player is only scored once here
     * rather than once per correct round). */
    private async finalizeGame(gameId: string, status: "solved" | "timeout"): Promise<void> {
        await this.ctx.storage.deleteAlarm();
        this.db.update(game).set({status, error: null}).run();

        const totalExpr = sql<number>`SUM(${guesses.score})`;
        const totals = this.db
            .select({participantId: guesses.participantId, total: totalExpr})
            .from(guesses)
            .where(eq(guesses.correct, 1))
            .groupBy(guesses.participantId)
            .all();

        for (const {participantId, total} of totals) {
            if (total <= 0) continue;
            const participant = this.db
                .select({userId: participants.userId})
                .from(participants)
                .where(eq(participants.id, participantId))
                .get();
            if (!participant?.userId) continue;
            try {
                await this.env.LEADERBOARD.recordScore({
                    userId: participant.userId,
                    kind: "guess",
                    sessionId: gameId,
                    score: total,
                });
            } catch (err) {
                console.error("failed to record guess game score", gameId, participant.userId, err);
            }
        }

        this.broadcast({type: GameWsEventType.State, ...this.readPublicState()});
        // Mirrors PuzzleDO's solve/timeout: distinct from markCatalogReady
        // (fired back in guess.queue.ts) — the game's join/spectate window is
        // now closed for good. `.catch()`'d so a `browse` hiccup can't break
        // a live game's finish.
        this.ctx.waitUntil(
            this.env.BROWSE.updatePlayStatus(gameId, "finished").catch((err) => {
                console.error("failed to update catalog play status", gameId, err);
            }),
        );
    }

    /** Recomputes and (re)arms the single DO alarm to whichever is next: the
     * lobby countdown while `waiting`; while `playing`, either the current
     * round's own guess-timeout (measured from its `started_at` — matching
     * the time-weighted scoring in `scoreForGuess()`) or, if a round just
     * resolved, the post-round reveal pause's own deadline instead — the two
     * never overlap (see `resolveCurrentRound()`/`advanceAfterPostRound()`),
     * so there's still only ever one deadline to arm for. Deletes the alarm
     * entirely once nothing is pending. */
    private async scheduleNextAlarm(): Promise<void> {
        // Internal orchestration, not part of the RPC surface — see
        // `alarm()`'s doc comment on why this unwraps-and-rethrows rather
        // than propagating an `Err`.
        const row = this.requireGameRow().match(
            (row) => row,
            (error) => {
                throw new Error(error);
            },
        );

        if (row.status === GameSessionStatus.Waiting && row.lobbyEndsAt !== null) {
            await this.ctx.storage.setAlarm(row.lobbyEndsAt);
            return;
        }

        if (row.status === GameSessionStatus.Playing) {
            if (row.postRoundIndex !== null && row.postRoundEndsAt !== null) {
                await this.ctx.storage.setAlarm(row.postRoundEndsAt);
                return;
            }

            const active = this.db
                .select({startedAt: rounds.startedAt, timeLimitMs: rounds.timeLimitMs})
                .from(rounds)
                .where(eq(rounds.status, "active"))
                .limit(1)
                .get();
            if (active?.startedAt != null && active.timeLimitMs != null) {
                await this.ctx.storage.setAlarm(active.startedAt + active.timeLimitMs);
                return;
            }
        }

        await this.ctx.storage.deleteAlarm();
    }

    /** Passes `row` through unchanged on success, so callers can chain it
     * straight into a further `.andThen()` (see `startNow()`) without
     * re-fetching it. Mirrors `PuzzleDO.assertHost()`. */
    private assertHost(row: GameRow, hostToken: string): Result<GameRow, string> {
        return hostToken && hostToken === row.hostToken ? ok(row) : err("forbidden: only the host can do that");
    }

    private requireGameRow(): Result<GameRow, string> {
        const row = this.db.select().from(game).limit(1).get();
        return row ? ok(row) : err("game not initialized");
    }

    private readPublicState(): GamePublic {
        const gameRow = this.db.select().from(game).limit(1).get();
        const roundRows = this.db.select().from(rounds).orderBy(asc(rounds.idx)).all();
        const participantRows = this.db
            .select({id: participants.id, name: participants.name, color: participants.color})
            .from(participants)
            .orderBy(asc(participants.joinedAt))
            .all();
        // Built once and reused in both `select` and `orderBy` so the ORDER
        // BY unambiguously refers to the same aggregate rather than a string
        // alias — same pattern apps/leaderboard/src/leaderboard.service.ts's
        // `totalsQuery()` uses for its own SUM.
        const totalExpr = sql<number>`SUM(${guesses.score})`;
        const results = this.db
            .select({participantId: guesses.participantId, total: totalExpr})
            .from(guesses)
            .where(eq(guesses.correct, 1))
            .groupBy(guesses.participantId)
            .orderBy(desc(totalExpr))
            .all();

        return {
            id: gameRow?.id ?? "",
            theme: gameRow?.theme ?? null,
            status: gameRow?.status ?? GameSessionStatus.Queued,
            error: gameRow?.error ?? undefined,
            rounds: roundRows.map((r) => ({
                index: r.idx,
                status: r.status,
                error: r.error ?? undefined,
                remainingMs:
                    r.status === RoundStatus.Active && r.startedAt !== null
                        ? Math.max(0, (r.timeLimitMs ?? DEFAULT_GUESS_TIME_LIMIT_SECONDS * 1000) - (Date.now() - r.startedAt))
                        : null,
                imageUrl:
                    gameRow?.origin && ROUND_VISIBLE_STATUSES.includes(r.status)
                        ? new URL(imageUrlPathFor(gameRow.id, r.idx), gameRow.origin).toString()
                        : null,
                prompt: ROUND_RESOLVED_STATUSES.includes(r.status) ? r.prompt : null,
            })),
            currentRound: roundRows.find((r) => r.status === RoundStatus.Active)?.idx ?? null,
            postRoundIndex: gameRow?.postRoundIndex ?? null,
            postRoundRemainingMs:
                gameRow?.postRoundEndsAt != null ? Math.max(0, gameRow.postRoundEndsAt - Date.now()) : null,
            lobbyRemainingMs: gameRow ? lobbyRemainingMs(gameRow.lobbyEndsAt) : null,
            connectedPlayers: this.ctx.getWebSockets().length,
            participants: participantRows.map((p) => ({id: p.id, name: p.name, color: p.color})),
            results: results.map((r) => ({participantId: r.participantId, score: r.total})),
        };
    }

    private broadcast(payload: GameWsMessage): void {
        const message = JSON.stringify(payload);
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(message);
            } catch {
                // Dead socket — hibernation cleans it up on close, nothing to do here.
            }
        }
    }

    /** Same message shapes as `broadcast()`, but to a single socket — used for
     * the initial state-on-connect and the `pong` reply, neither of which
     * should go to every other connected client. */
    private send(ws: WebSocket, payload: GameWsMessage): void {
        ws.send(JSON.stringify(payload));
    }
}

export default GameDO

/** See guessTimeLimitSeconds(): linear falloff from `maxScore` at 0 elapsed
 * (the instant a round became the current one — `started_at`, stamped by
 * `activateRound()`) to `minScore` at the limit or beyond — both resolved by
 * the caller (`submitGuess()`) from Flagship's "guess-max-score"/
 * "guess-min-score" flags right before calling this, same "resolve once,
 * use once" shape as `limitMs` itself. `startedAt` is only null for a round
 * that's somehow being scored before `activateRound()` ran; treated as
 * "just started" (max score) rather than throwing. `limitMs` is likewise
 * only null for a round some already-live DO instance had mid-flight when
 * the `time_limit_ms` column was added — falls back to the same default
 * `guessTimeLimitSeconds()` itself falls back to, rather than throwing. */
function scoreForGuess(startedAt: number | null, limitMs: number | null, maxScore: number, minScore: number): number {
    const elapsedMs = Date.now() - (startedAt ?? Date.now());
    const effectiveLimitMs = limitMs ?? DEFAULT_GUESS_TIME_LIMIT_SECONDS * 1000;
    const remainingMs = Math.max(0, effectiveLimitMs - elapsedMs);
    return Math.max(minScore, Math.round((remainingMs / effectiveLimitMs) * maxScore));
}
