import {DurableObject} from "cloudflare:workers";
import type {z} from "@hono/zod-openapi";
import {generateColor} from "@game-worker/shared/color";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {lobbyEndsAt, lobbyRemainingMs} from "@game-worker/shared/lobby";
import {WsEventType} from "@game-worker/shared/ws-messages";
import {isGuessCorrect} from "./guess-matching";
import type {GamePublicSchema, GameResultSchema, GameWsMessageSchema, GuessResultSchema} from "./guess.schema";
import {GameWsEventType, ROUND_VISIBLE_STATUSES, RoundStatus} from "./guess.schema";
import {
  DEFAULT_GUESS_TIME_LIMIT_SECONDS,
  GUESS_MAX_SCORE,
  GUESS_MIN_SCORE,
  guessTimeLimitSeconds,
  ROUND_COUNT,
} from "./guess.constants";

export {ROUND_VISIBLE_STATUSES, RoundStatus};
export type GameStatus = z.infer<typeof GamePublicSchema>["status"];
export type GamePublic = z.infer<typeof GamePublicSchema>;
export type GuessResult = z.infer<typeof GuessResultSchema>;
export type GameResult = z.infer<typeof GameResultSchema>;
export type GameWsMessage = z.infer<typeof GameWsMessageSchema>;

// The `Record<string, SqlStorageValue>` bound is what `storage.sql.exec<T>`
// requires its row type to satisfy.
interface GameRow extends Record<string, SqlStorageValue> {
    id: string;
    theme: string | null;
    status: GameStatus;
    error: string | null;
    host_token: string;
    lobby_ends_at: number | null;
    created_at: number;
}

interface RoundRow extends Record<string, SqlStorageValue> {
    idx: number;
    prompt: string | null;
    status: RoundStatus;
    image_key: string | null;
    ready_at: number | null;
    started_at: number | null;
    time_limit_ms: number | null;
    error: string | null;
}

interface ParticipantRow extends Record<string, SqlStorageValue> {
    id: string;
    name: string;
    user_id: string | null;
    token: string | null;
    color: string;
    joined_at: number;
}

interface ParticipantPublic extends Record<string, SqlStorageValue> {
    name: string;
    color: string;
}

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
 * Rounds are generated up front (all `ROUND_COUNT` in parallel — see
 * guess.queue.ts) but played strictly sequentially: once play begins, round
 * 0 is the only one `Active` (open for guessing); each subsequent round only
 * opens once the previous one resolves, either because every joined
 * participant answered it correctly (early advance) or its own guess-timeout
 * fired — see `activateRound()`/`resolveCurrentRound()`. At most one round is
 * ever `Active` at a time.
 *
 * Mirrors `apps/puzzle`'s `PuzzleDO` lobby shape: once every round's image
 * is ready, the game sits in a `waiting` room (see `setReady()`) instead of
 * starting instantly, so players can gather before play begins — either
 * automatically after `LOBBY_COUNTDOWN_SECONDS` (a DO alarm) or early via
 * the host's `startNow()`. The creator ("host") gets a one-time secret
 * token back from `init()`, never broadcast or included in `getState()`,
 * which their browser must present to start early — same contract as
 * `PuzzleDO`'s `host_token`.
 */
export class GameDO extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        ctx.blockConcurrencyWhile(async () => this.migrate());
    }

    async init(gameId: string, theme: string | null): Promise<string> {
        await this.ctx.storage.deleteAlarm();
        const hostToken = crypto.randomUUID();
        const now = Date.now();
        this.ctx.storage.sql.exec("DELETE FROM guesses");
        this.ctx.storage.sql.exec("DELETE FROM rounds");
        this.ctx.storage.sql.exec("DELETE FROM participants");
        this.ctx.storage.sql.exec(
            `INSERT INTO game (id, theme, status, error, host_token, lobby_ends_at, created_at)
             VALUES (?, ?, 'queued', NULL, ?, NULL, ?) ON CONFLICT(id) DO
            UPDATE SET
                theme = excluded.theme, status = 'queued', error = NULL,
                host_token = excluded.host_token, lobby_ends_at = NULL`,
            gameId,
            theme,
            hostToken,
            now,
        );
        for (let i = 0; i < ROUND_COUNT; i++) {
            this.ctx.storage.sql.exec("INSERT INTO rounds (idx, status) VALUES (?, 'pending')", i);
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
        this.ctx.storage.sql.exec("UPDATE game SET status = ?, error = ?", status, error ?? null);
        this.broadcast({type: WsEventType.Status, status, error});
    }

    // --- RPC: progress updates from the queue consumer ---------------------

    async setPrompts(prompts: string[]): Promise<void> {
        prompts.forEach((prompt, idx) => {
            this.ctx.storage.sql.exec("UPDATE rounds SET prompt = ? WHERE idx = ?", prompt, idx);
        });
        this.broadcast({type: GameWsEventType.PromptsReady, count: prompts.length});
    }

    async setRoundStatus(index: number, status: RoundStatus, error?: string): Promise<void> {
        this.ctx.storage.sql.exec(
            "UPDATE rounds SET status = ?, error = ? WHERE idx = ?",
            status,
            error ?? null,
            index,
        );
        this.broadcast({type: GameWsEventType.RoundStatus, index, status, error});
    }

    /** Image done generating — the round is now `ready`, i.e. queued up
     * waiting its turn. Not guessable yet and no timer runs from here:
     * `ready_at` is purely informational (when generation finished); the
     * round only starts counting down once it actually becomes the current
     * round (see `activateRound()`, which stamps `started_at`). */
    async setRoundImage(index: number, imageKey: string): Promise<void> {
        this.ctx.storage.sql.exec(
            "UPDATE rounds SET image_key = ?, status = 'ready', ready_at = ?, error = NULL WHERE idx = ?",
            imageKey,
            Date.now(),
            index,
        );
        this.broadcast({type: GameWsEventType.RoundReady, index});
    }

    /** Every round's image is ready — open the waiting room rather than
     * starting instantly, so players can gather (see the class doc comment).
     * Mirrors `PuzzleDO.setReady()`. */
    async setReady(): Promise<void> {
        const endsAt = lobbyEndsAt(Date.now());
        this.ctx.storage.sql.exec(
            "UPDATE game SET status = 'waiting', error = NULL, lobby_ends_at = ?",
            endsAt,
        );
        await this.scheduleNextAlarm();
        this.broadcast({type: GameWsEventType.State, ...this.readPublicState()});
    }

    /** Ends the lobby countdown immediately and starts play. Mirrors
     * `PuzzleDO.startNow()`. */
    async startNow(hostToken: string): Promise<void> {
        const row = this.requireGameRow();
        this.assertHost(row, hostToken);
        if (row.status !== GameSessionStatus.Waiting) throw new Error("game is not waiting to start");
        await this.beginPlaying(row.id);
    }

    // --- RPC: host-only lobby action ----------------------------------------

    /** Registers a player as allowed to guess/reveal in this game, only while
     * a round hasn't been generated yet or the lobby is open (see
     * JOINABLE_STATUSES) — once the game is `playing` this throws, so late
     * arrivals can still spectate over the WebSocket/`getState()` but can't
     * play. Logged-in users are upserted by `userId` (idempotent across
     * reconnects/tab refreshes, no token needed since the session re-proves
     * identity on every request) and keep their account color; anonymous
     * guests get a fresh bearer token they must resend with every
     * guess/reveal (since a free-text name alone isn't a real identity) and
     * a freshly generated color. Either way, the color is returned so the
     * caller's own client knows what to render before the next broadcast. */
    async join(
        userId: string | null,
        playerName: string,
        userColor: string | null,
    ): Promise<{ participantId: string; token: string | null; color: string }> {
        const row = this.requireGameRow();
        if (!JOINABLE_STATUSES.includes(row.status)) {
            throw new Error("game has already started; you can spectate but not join");
        }
        const color = userColor ?? generateColor();

        if (userId) {
            this.ctx.storage.sql.exec(
                `INSERT INTO participants (id, name, user_id, token, color, joined_at)
                 VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO
                UPDATE SET name = excluded.name, color = excluded.color`,
                userId,
                playerName,
                userId,
                color,
                Date.now(),
            );
            this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color});
            return {participantId: userId, token: null, color};
        }

        const participantId = crypto.randomUUID();
        const token = crypto.randomUUID();
        this.ctx.storage.sql.exec(
            "INSERT INTO participants (id, name, user_id, token, color, joined_at) VALUES (?, ?, NULL, ?, ?, ?)",
            participantId,
            playerName,
            token,
            color,
            Date.now(),
        );
        this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color});
        return {participantId, token, color};
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
     * rather than waiting out its timer. Scores off `round.time_limit_ms` —
     * the limit stamped by `activateRound()` when this round began, not
     * whatever Flagship says right now — so a flag flip mid-round can't
     * retroactively change what this guess is worth. */
    async submitGuess(
        index: number,
        participantId: string,
        token: string | null,
        guess: string,
        userId: string | null,
    ): Promise<GuessResult> {
        const participant = this.requireParticipant(participantId, token, userId);

        const gameRow = this.requireGameRow();
        const round = this.ctx.storage.sql
            .exec<RoundRow>("SELECT * FROM rounds WHERE idx = ?", index)
            .toArray()[0];
        if (!round || round.status !== RoundStatus.Active || !round.prompt) {
            throw new Error("round not active");
        }

        const alreadyCorrect = this.ctx.storage.sql
            .exec<{ n: number }>(
                "SELECT COUNT(*) AS n FROM guesses WHERE round_idx = ? AND participant_id = ? AND correct = 1",
                index,
                participantId,
            )
            .toArray()[0]?.n;
        if (alreadyCorrect && alreadyCorrect > 0) {
            throw new Error("you already answered this round correctly");
        }

        const correct = isGuessCorrect(guess, round.prompt);
        const score = correct ? scoreForGuess(round.started_at, round.time_limit_ms) : null;

        this.ctx.storage.sql.exec(
            "INSERT INTO guesses (round_idx, participant_id, player, guess, correct, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            index,
            participantId,
            participant.name,
            guess,
            correct ? 1 : 0,
            score,
            Date.now(),
        );

        this.broadcast({
            type: GameWsEventType.Guess,
            index,
            player: participant.name,
            color: participant.color,
            correct,
            score,
        });

        if (correct) {
            const participantCount = this.ctx.storage.sql
                .exec<{ n: number }>("SELECT COUNT(*) AS n FROM participants")
                .toArray()[0]?.n ?? 0;
            const correctCount = this.ctx.storage.sql
                .exec<{ n: number }>(
                    "SELECT COUNT(DISTINCT participant_id) AS n FROM guesses WHERE round_idx = ? AND correct = 1",
                    index,
                )
                .toArray()[0]?.n ?? 0;
            if (participantCount > 0 && correctCount >= participantCount) {
                // Everyone's answered correctly — advance now rather than waiting
                // out the timer.
                await this.resolveCurrentRound(gameRow.id, index);
            }
        }

        return {correct, prompt: correct ? round.prompt : null, score};
    }

    /** Reveals a round's prompt without guessing — gated the same as guessing
     * itself against spoilers (see `ROUND_VISIBLE_STATUSES`): only the
     * current round or one that's already resolved can be revealed, never a
     * round still queued up waiting its turn. */
    async revealRound(index: number, participantId: string, token: string | null, userId: string | null): Promise<string | null> {
        const participant = this.requireParticipant(participantId, token, userId);

        const round = this.ctx.storage.sql
            .exec<RoundRow>("SELECT * FROM rounds WHERE idx = ?", index)
            .toArray()[0];
        if (!round?.prompt || !ROUND_VISIBLE_STATUSES.includes(round.status)) return null;
        this.broadcast({
            type: GameWsEventType.Revealed,
            index,
            prompt: round.prompt,
            player: participant.name,
            color: participant.color
        });
        return round.prompt;
    }

    // --- RPC: player interaction --------------------------------------------

    /** A DO has exactly one alarm slot, shared here by two different
     * deadlines: the lobby countdown (`waiting` → `playing`) and, once
     * playing, the single current round's own guess-timeout — at most one
     * round is ever `Active` at a time (see the class doc comment), so
     * there's only ever one round deadline to consider. `scheduleNextAlarm()`
     * always arms it for whichever deadline is soonest. */
    async alarm(): Promise<void> {
        const row = this.requireGameRow();

        if (row.status === GameSessionStatus.Waiting && row.lobby_ends_at !== null && Date.now() >= row.lobby_ends_at) {
            await this.beginPlaying(row.id);
            return;
        }

        if (row.status !== GameSessionStatus.Playing) {
            // Game already moved on to a terminal status (error, resolved by an
            // earlier tick, or still waiting on a lobby deadline that isn't due
            // yet) before this stale alarm fired — nothing to do.
            return;
        }

        const active = this.ctx.storage.sql
            .exec<RoundRow>("SELECT * FROM rounds WHERE status = 'active' LIMIT 1")
            .toArray()[0];
        if (!active) return; // shouldn't happen while playing, but nothing to resolve

        const limitMs = active.time_limit_ms ?? (await guessTimeLimitSeconds(this.env)) * 1000;
        if (active.started_at === null || Date.now() < active.started_at + limitMs) {
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
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        this.send(pair[1], {type: GameWsEventType.State, ...this.readPublicState()});
        // Let every other connected client know the spectator/player count
        // changed — mirrors PuzzleDO's presence broadcast.
        this.broadcast({type: WsEventType.Presence, connectedPlayers: this.ctx.getWebSockets().length});
        return new Response(null, {status: 101, webSocket: pair[0]});
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (typeof message !== "string") return;
        if (message === "ping") {
            this.send(ws, {type: WsEventType.Pong});
            return;
        }
        // Anything else must be a small JSON envelope — currently only
        // "typing" (see broadcastTyping()). Malformed/unknown messages are
        // ignored rather than closing the socket, since clients are otherwise
        // push-only observers and a stray message shouldn't be fatal.
        try {
            const parsed = JSON.parse(message) as {
                type?: string;
                index?: number;
                participantId?: string;
                token?: string
            };
            if (parsed.type === "typing" && typeof parsed.index === "number" && typeof parsed.participantId === "string") {
                this.broadcastTyping(parsed.index, parsed.participantId, parsed.token ?? null);
            }
        } catch {
            // Not JSON — ignore.
        }
    }

    // --- alarm: drives the lobby's auto-start, then the current round's own
    // guess-timeout -------------------------------------------------------------

    async webSocketClose(): Promise<void> {
        // -1 because this handler runs before the closing socket drops out of
        // getWebSockets() on some runtimes; broadcasting a stale +1 count is
        // more confusing than a same-tick undercount that self-corrects on the
        // next presence event. Mirrors PuzzleDO's webSocketClose.
        this.broadcast({type: WsEventType.Presence, connectedPlayers: Math.max(0, this.ctx.getWebSockets().length - 1)});
    }

    // --- WebSocket upgrade (DOs use fetch() for this, not RPC) --------------

    private migrate(): void {
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS game
            (
                id
                TEXT
                PRIMARY
                KEY,
                theme
                TEXT,
                status
                TEXT
                NOT
                NULL
                DEFAULT
                'queued',
                error
                TEXT,
                host_token
                TEXT
                NOT
                NULL
                DEFAULT
                '',
                lobby_ends_at
                INTEGER,
                created_at
                INTEGER
                NOT
                NULL
            );
            CREATE TABLE IF NOT EXISTS rounds
            (
                idx
                INTEGER
                PRIMARY
                KEY,
                prompt
                TEXT,
                status
                TEXT
                NOT
                NULL
                DEFAULT
                'pending',
                image_key
                TEXT,
                ready_at
                INTEGER,
                started_at
                INTEGER,
                time_limit_ms
                INTEGER,
                error
                TEXT
            );
            CREATE TABLE IF NOT EXISTS guesses
            (
                id
                INTEGER
                PRIMARY
                KEY
                AUTOINCREMENT,
                round_idx
                INTEGER
                NOT
                NULL,
                participant_id
                TEXT
                NOT
                NULL
                DEFAULT
                '',
                player
                TEXT
                NOT
                NULL,
                guess
                TEXT
                NOT
                NULL,
                correct
                INTEGER
                NOT
                NULL,
                score
                INTEGER,
                created_at
                INTEGER
                NOT
                NULL
            );
            CREATE TABLE IF NOT EXISTS participants
            (
                id
                TEXT
                PRIMARY
                KEY,
                name
                TEXT
                NOT
                NULL,
                user_id
                TEXT,
                token
                TEXT,
                color
                TEXT
                NOT
                NULL
                DEFAULT
                '#888888',
                joined_at
                INTEGER
                NOT
                NULL
            );
        `);
        // `CREATE TABLE IF NOT EXISTS` only helps a brand-new DO instance —
        // these columns were added after some instances already existed, so
        // existing ones need a backfill too. There's no `ALTER TABLE ... ADD
        // COLUMN IF NOT EXISTS`, so each statement's "duplicate column" failure
        // (on an instance that already has it) is just swallowed.
        for (const stmt of [
            "ALTER TABLE game ADD COLUMN host_token TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE game ADD COLUMN lobby_ends_at INTEGER",
            "ALTER TABLE participants ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'",
            "ALTER TABLE guesses ADD COLUMN participant_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE guesses ADD COLUMN score INTEGER",
            "ALTER TABLE rounds ADD COLUMN started_at INTEGER",
            "ALTER TABLE rounds ADD COLUMN time_limit_ms INTEGER",
        ]) {
            try {
                this.ctx.storage.sql.exec(stmt);
            } catch {
                // Column already exists on this instance — nothing to do.
            }
        }
    }

    /** Resolves and authorizes a participant: logged-in callers must be
     * signed in as the same user who joined; anonymous callers must present
     * the token issued at join time. Throws `Error("forbidden: ...")` for
     * either failure, which `hostActionError` (shared/http-exceptions.ts)
     * maps to a 403 — someone who never joined can still spectate, they just
     * can't act. Returns the joined display name/color to record on the
     * action and broadcast alongside it. */
    private requireParticipant(
        participantId: string,
        token: string | null,
        userId: string | null,
    ): { name: string; color: string } {
        const row = this.ctx.storage.sql
            .exec<ParticipantRow>("SELECT * FROM participants WHERE id = ?", participantId)
            .toArray()[0];
        if (!row) throw new Error("forbidden: join the game before playing");
        if (row.user_id) {
            if (row.user_id !== userId) throw new Error("forbidden: not your participant id");
        } else if (!token || token !== row.token) {
            throw new Error("forbidden: invalid participant token");
        }
        return {name: row.name, color: row.color};
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
        const row = this.ctx.storage.sql
            .exec<ParticipantRow>("SELECT * FROM participants WHERE id = ?", participantId)
            .toArray()[0];
        if (!row) return;
        if (!row.user_id && (!token || token !== row.token)) return;
        this.broadcast({type: GameWsEventType.PlayerTyping, index, player: row.name, color: row.color});
    }

    // --- internals -----------------------------------------------------------

    /** Shared by the host's "start now" and the lobby alarm's auto-start.
     * Mirrors `PuzzleDO.beginPlaying()`. Activates round 0 — the only round
     * that's ever open for guessing the instant play begins; every round
     * after it opens only once its predecessor resolves (see
     * `resolveCurrentRound()`). */
    private async beginPlaying(gameId: string): Promise<void> {
        this.ctx.storage.sql.exec("UPDATE game SET status = 'playing', lobby_ends_at = NULL");
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
        this.ctx.storage.sql.exec(
            "UPDATE rounds SET status = 'active', started_at = ?, time_limit_ms = ? WHERE idx = ?",
            startedAt,
            timeLimitMs,
            index,
        );
        this.broadcast({type: GameWsEventType.RoundStatus, index, status: RoundStatus.Active});
        await this.scheduleNextAlarm();
    }

    /** Closes out the current round (`complete` if it got at least one
     * correct guess, `timeout` if none), then either activates the next round
     * or — once the last round resolves — finalizes the game. Called from two
     * independent triggers: `alarm()` once a round's own deadline passes, and
     * `submitGuess()` the instant every joined participant has answered
     * correctly (early advance, before the timer). Because those two triggers
     * can interleave around an `await` (Durable Objects can process another
     * incoming call while one is awaiting a binding, e.g.
     * `guessTimeLimitSeconds()`), this re-checks the round is still `Active`
     * as its very first, synchronous step — whichever trigger gets here
     * first wins and the other is a clean no-op instead of double-advancing. */
    private async resolveCurrentRound(gameId: string, index: number): Promise<void> {
        const still = this.ctx.storage.sql
            .exec<{ status: RoundStatus }>("SELECT status FROM rounds WHERE idx = ?", index)
            .toArray()[0];
        if (still?.status !== RoundStatus.Active) return; // already resolved by the other trigger

        const correct = this.ctx.storage.sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM guesses WHERE round_idx = ? AND correct = 1", index)
            .toArray()[0]?.n;
        const status: RoundStatus = correct && correct > 0 ? RoundStatus.Complete : RoundStatus.Timeout;
        this.ctx.storage.sql.exec("UPDATE rounds SET status = ? WHERE idx = ?", status, index);
        this.broadcast({type: GameWsEventType.RoundStatus, index, status});

        const nextIndex = index + 1;
        if (nextIndex < ROUND_COUNT) {
            await this.activateRound(nextIndex);
            return;
        }

        // Every round has now resolved — same "solved if anyone ever completed
        // a round, timeout only if none were ever completed" rule as before.
        const anyComplete = this.ctx.storage.sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM rounds WHERE status = 'complete'")
            .toArray()[0]?.n;
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
        this.ctx.storage.sql.exec("UPDATE game SET status = ?, error = NULL", status);

        const totals = this.ctx.storage.sql
            .exec<{ participant_id: string; total: number }>(
                "SELECT participant_id, SUM(score) AS total FROM guesses WHERE correct = 1 GROUP BY participant_id",
            )
            .toArray();

        for (const {participant_id, total} of totals) {
            if (total <= 0) continue;
            const participant = this.ctx.storage.sql
                .exec<ParticipantRow>("SELECT user_id FROM participants WHERE id = ?", participant_id)
                .toArray()[0];
            if (!participant?.user_id) continue;
            try {
                await this.env.LEADERBOARD.recordScore({
                    userId: participant.user_id,
                    kind: "guess",
                    sessionId: gameId,
                    score: total,
                });
            } catch (err) {
                console.error("failed to record guess game score", gameId, participant.user_id, err);
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
     * lobby countdown while `waiting`, or the current round's own
     * guess-timeout (measured from its `started_at` — matching the
     * time-weighted scoring in `scoreForGuess()`) while `playing` — there's
     * at most one `active` round at a time (see `activateRound()`/
     * `resolveCurrentRound()`), so no scanning multiple rounds' deadlines the
     * way this used to. Deletes the alarm entirely once nothing is pending. */
    private async scheduleNextAlarm(): Promise<void> {
        const row = this.requireGameRow();

        if (row.status === GameSessionStatus.Waiting && row.lobby_ends_at !== null) {
            await this.ctx.storage.setAlarm(row.lobby_ends_at);
            return;
        }

        if (row.status === GameSessionStatus.Playing) {
            const active = this.ctx.storage.sql
                .exec<Pick<RoundRow, "started_at" | "time_limit_ms">>(
                    "SELECT started_at, time_limit_ms FROM rounds WHERE status = 'active' LIMIT 1",
                )
                .toArray()[0];
            if (active?.started_at != null && active.time_limit_ms != null) {
                await this.ctx.storage.setAlarm(active.started_at + active.time_limit_ms);
                return;
            }
        }

        await this.ctx.storage.deleteAlarm();
    }

    private assertHost(row: GameRow, hostToken: string): void {
        if (!hostToken || hostToken !== row.host_token) {
            throw new Error("forbidden: only the host can do that");
        }
    }

    private requireGameRow(): GameRow {
        const row = this.ctx.storage.sql.exec<GameRow>("SELECT * FROM game LIMIT 1").toArray()[0];
        if (!row) throw new Error("game not initialized");
        return row;
    }

    private readPublicState(): GamePublic {
        const game = this.ctx.storage.sql.exec<GameRow>("SELECT * FROM game LIMIT 1").toArray()[0];
        const rounds = this.ctx.storage.sql
            .exec<RoundRow>("SELECT * FROM rounds ORDER BY idx ASC")
            .toArray();
        const participants = this.ctx.storage.sql
            .exec<ParticipantPublic>("SELECT name, color FROM participants ORDER BY joined_at ASC")
            .toArray();
        // Live scoreboard, not just a finished-game summary — updates as
        // guesses land, and doubles as the final standings once `status` hits
        // `solved`/`timeout` (see `finalizeGame()`). Joined against
        // `participants` (rather than trusting `guesses.player`) so a display
        // name change after guessing still shows correctly here.
        const results = this.ctx.storage.sql
            .exec<{ name: string; color: string; total: number }>(
                `SELECT p.name AS name, p.color AS color, SUM(g.score) AS total
                 FROM guesses g
                          JOIN participants p ON p.id = g.participant_id
                 WHERE g.correct = 1
                 GROUP BY g.participant_id
                 ORDER BY total DESC`,
            )
            .toArray();

        return {
            id: game?.id ?? "",
            theme: game?.theme ?? null,
            status: game?.status ?? GameSessionStatus.Queued,
            error: game?.error ?? undefined,
            rounds: rounds.map((r) => ({
                index: r.idx,
                status: r.status,
                error: r.error ?? undefined,
                // Mirrors PuzzleDO's `remainingMs`: only ever ticking for the one
                // round that's currently open for guessing (see `activateRound()`'s
                // "at most one round is ever `Active`" invariant) — null for every
                // other round, whether it hasn't had its turn yet or has already
                // resolved.
                remainingMs:
                    r.status === RoundStatus.Active && r.started_at !== null
                        ? Math.max(0, (r.time_limit_ms ?? DEFAULT_GUESS_TIME_LIMIT_SECONDS * 1000) - (Date.now() - r.started_at))
                        : null,
            })),
            // At most one round is ever `Active` at a time (see `activateRound()`/
            // `resolveCurrentRound()`) — null before play starts and after the
            // game finishes, since nothing stays `Active` in either case.
            currentRound: rounds.find((r) => r.status === RoundStatus.Active)?.idx ?? null,
            lobbyRemainingMs: game ? lobbyRemainingMs(game.lobby_ends_at) : null,
            connectedPlayers: this.ctx.getWebSockets().length,
            participants: participants.map((p) => ({name: p.name, color: p.color})),
            results: results.map((r) => ({name: r.name, color: r.color, score: r.total})),
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

/** See guessTimeLimitSeconds(): linear falloff from GUESS_MAX_SCORE at 0
 * elapsed (the instant a round became the current one — `started_at`,
 * stamped by `activateRound()`) to GUESS_MIN_SCORE at the limit or beyond.
 * `startedAt` is only null for a round that's somehow being scored before
 * `activateRound()` ran; treated as "just started" (max score) rather than
 * throwing. `limitMs` is likewise only null for a round some already-live
 * DO instance had mid-flight when the `time_limit_ms` column was added —
 * falls back to the same default `guessTimeLimitSeconds()` itself falls
 * back to, rather than throwing. */
function scoreForGuess(startedAt: number | null, limitMs: number | null): number {
    const elapsedMs = Date.now() - (startedAt ?? Date.now());
    const effectiveLimitMs = limitMs ?? DEFAULT_GUESS_TIME_LIMIT_SECONDS * 1000;
    const remainingMs = Math.max(0, effectiveLimitMs - elapsedMs);
    return Math.max(GUESS_MIN_SCORE, Math.round((remainingMs / effectiveLimitMs) * GUESS_MAX_SCORE));
}
