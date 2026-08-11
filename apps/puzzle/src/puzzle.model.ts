import {DurableObject} from "cloudflare:workers";
import type {z} from "@hono/zod-openapi";
import {generateColor} from "@game-worker/shared/color";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {lobbyEndsAt, lobbyRemainingMs} from "@game-worker/shared/lobby";
import {WsEventType} from "@game-worker/shared/ws-messages";
import {PUZZLE_MAX_SCORE, PUZZLE_MIN_SOLVED_SCORE} from "./puzzle.constants";
import type {MoveResultSchema, PuzzlePublicSchema, PuzzleStatusSchema, PuzzleWsMessageSchema,} from "./puzzle.schema";
import {PuzzleWsEventType} from "./puzzle.schema";

export type PuzzleStatus = z.infer<typeof PuzzleStatusSchema>;
export type PuzzlePublic = z.infer<typeof PuzzlePublicSchema>;
export type MoveResult = z.infer<typeof MoveResultSchema>;
export type PuzzleWsMessage = z.infer<typeof PuzzleWsMessageSchema>;

// The `Record<string, SqlStorageValue>` bound is what `storage.sql.exec<T>`
// requires its row type to satisfy.
interface PuzzleRow extends Record<string, SqlStorageValue> {
    id: string;
    theme: string | null;
    prompt: string | null;
    status: PuzzleStatus;
    error: string | null;
    grid_size: number;
    board: string;
    time_limit_ms: number;
    started_at: number | null;
    lobby_ends_at: number | null;
    ended_at: number | null;
    score: number | null;
    solved_by: string | null;
    host_token: string;
    created_at: number;
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

/** Statuses in which play hasn't started yet — the only window during which
 * joining (and, separately, the host's "regenerate") is allowed. Once a
 * puzzle is `playing` it's in progress, so letting someone join then would
 * let them play a match already underway rather than just spectate it. */
const JOINABLE_STATUSES: readonly PuzzleStatus[] = [
    GameSessionStatus.Queued,
    GameSessionStatus.Generating,
    GameSessionStatus.Waiting,
];

/**
 * One instance per puzzle (routed via `env.PUZZLE_DO.getByName(puzzleId)`).
 * Two or more players connect to the same instance's WebSocket and see
 * every move broadcast in real time — the DO is the single source of
 * truth for the board, so there's no client-side conflict resolution to
 * get wrong. A single DO alarm does double duty: it fires the lobby's
 * auto-start, then (once playing starts) gets replaced with the
 * countdown's timeout — both enforced server-side regardless of who's
 * still connected.
 *
 * The creator ("host") gets a one-time secret token back from `init()`,
 * which their browser stores and must present to regenerate or start
 * early. It's never included in any broadcast or `getState()` — it only
 * ever leaves the DO once, in the creation response. Replaying a finished
 * puzzle doesn't reuse this token at all — see POST /puzzles/{id}/replay,
 * which spins up a whole new instance (and a new host token) instead of
 * resetting this one in place.
 */
export class PuzzleDO extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        ctx.blockConcurrencyWhile(async () => this.migrate());
    }

    async init(puzzleId: string, theme: string | null, gridSize: number, timeLimitMs: number): Promise<string> {
        await this.ctx.storage.deleteAlarm();
        const hostToken = crypto.randomUUID();
        this.ctx.storage.sql.exec(
            `INSERT INTO puzzle (id, theme, prompt, status, error, grid_size, board, time_limit_ms,
                                 started_at, lobby_ends_at, ended_at, score, solved_by, host_token, created_at)
             VALUES (?, ?, NULL, 'queued', NULL, ?, '[]', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
            puzzleId,
            theme,
            gridSize,
            timeLimitMs,
            hostToken,
            Date.now(),
        );
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
        return hostToken;
    }

    // --- RPC: create a brand new puzzle (never called twice for the same id) -

    /** Creates a brand-new puzzle instance already sitting in the waiting
     * room with a known image — used by POST /puzzles/{id}/replay, which
     * reuses a *finished* puzzle's image (copied into this new id's R2 key
     * by the caller) rather than spending a fresh AI call. Never called
     * twice for the same id, same as `init()`. Returns a fresh host token —
     * whoever replays becomes this new instance's host, independent of who
     * hosted the original. */
    async initFromSource(
        puzzleId: string,
        theme: string | null,
        gridSize: number,
        timeLimitMs: number,
        prompt: string,
    ): Promise<string> {
        await this.ctx.storage.deleteAlarm();
        const hostToken = crypto.randomUUID();
        const endsAt = lobbyEndsAt(Date.now());
        this.ctx.storage.sql.exec(
            `INSERT INTO puzzle (id, theme, prompt, status, error, grid_size, board, time_limit_ms,
                                 started_at, lobby_ends_at, ended_at, score, solved_by, host_token, created_at)
             VALUES (?, ?, ?, 'waiting', NULL, ?, '[]', ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
            puzzleId,
            theme,
            prompt,
            gridSize,
            timeLimitMs,
            endsAt,
            hostToken,
            Date.now(),
        );
        await this.ctx.storage.setAlarm(endsAt);
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
        return hostToken;
    }

    getState(): PuzzlePublic {
        return this.readPublicState();
    }

    // --- RPC: read-only snapshot (HTTP polling + WebSocket connect) --------

    async setGenerating(): Promise<void> {
        this.ctx.storage.sql.exec("UPDATE puzzle SET status = 'generating'");
        this.broadcast({type: WsEventType.Status, status: GameSessionStatus.Generating});
    }

    // --- RPC: progress updates from the queue consumer ----------------------

    async setError(message: string): Promise<void> {
        this.ctx.storage.sql.exec("UPDATE puzzle SET status = 'error', error = ?", message);
        this.broadcast({type: WsEventType.Status, status: GameSessionStatus.Error, error: message});
    }

    /** Image is ready — enter the waiting room rather than starting instantly,
     * so players can gather, and the host can preview/regenerate/start early. */
    async setReady(prompt: string): Promise<void> {
        const endsAt = lobbyEndsAt(Date.now());
        this.ctx.storage.sql.exec(
            "UPDATE puzzle SET prompt = ?, status = 'waiting', error = NULL, lobby_ends_at = ?",
            prompt,
            endsAt,
        );
        await this.ctx.storage.setAlarm(endsAt);
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
    }

    /** Starts a fresh generation run — new AI image, new prompt. Returns the
     * theme to re-enqueue with; keeps the same host token. Only available
     * pre-start: once the puzzle is `playing`, other joined players are
     * mid-game, so wiping it out from under them is no longer this action's
     * job — see POST /puzzles/{id}/replay instead, which spins up a whole
     * new instance. */
    async resetForRegenerate(hostToken: string): Promise<string | null> {
        const row = this.requireRow();
        this.assertHost(row, hostToken);
        if (!JOINABLE_STATUSES.includes(row.status)) {
            throw new Error("regenerate is only available before the puzzle starts");
        }
        await this.ctx.storage.deleteAlarm();
        this.ctx.storage.sql.exec(
            `UPDATE puzzle
             SET prompt        = NULL,
                 status        = 'queued',
                 error         = NULL,
                 board         = '[]',
                 started_at = NULL,
                 lobby_ends_at = NULL,
                 ended_at = NULL,
                 score = NULL,
                 solved_by = NULL`,
        );
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
        return row.theme;
    }

    // --- RPC: host-only lobby actions ----------------------------------------

    /** Ends the lobby countdown immediately and starts play. */
    async startNow(hostToken: string): Promise<void> {
        const row = this.requireRow();
        this.assertHost(row, hostToken);
        if (row.status !== GameSessionStatus.Waiting) throw new Error("puzzle is not waiting to start");
        await this.beginPlaying(row.id, row.grid_size, row.time_limit_ms);
    }

    /** Registers a player as allowed to move tiles in this puzzle, only
     * while it hasn't started (see JOINABLE_STATUSES) — once it's `playing`
     * this throws, so late arrivals can still spectate over the
     * WebSocket/`getState()` but can't play. Logged-in users are upserted by
     * `userId` (idempotent across reconnects/tab refreshes, no token needed
     * since the session re-proves identity on every request) and keep their
     * account color; anonymous guests get a fresh bearer token they must
     * resend with every move (since a free-text name alone isn't a real
     * identity) and a freshly generated color. Either way, the color is
     * returned so the caller's own client knows what to render before the
     * next broadcast. */
    async join(
        userId: string | null,
        playerName: string,
        userColor: string | null,
    ): Promise<{ participantId: string; token: string | null; color: string }> {
        const row = this.requireRow();
        if (!JOINABLE_STATUSES.includes(row.status)) {
            throw new Error("puzzle has already started; you can spectate but not join");
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

    /** `userId` is null for anonymous guests — a solve still counts for this
     * puzzle's own state, it just isn't logged to the leaderboard (recorded
     * via the LEADERBOARD service binding — see wrangler.jsonc).
     * `participantId`/`token` prove the caller joined before the puzzle
     * started — see `join()` and `requireParticipant()`. */
    async swapTiles(
        participantId: string,
        token: string | null,
        cellA: number,
        cellB: number,
        userId: string | null,
    ): Promise<MoveResult> {
        const participant = this.requireParticipant(participantId, token, userId);
        const row = this.requireRow();
        if (row.status !== GameSessionStatus.Playing) throw new Error("puzzle is not in progress");

        const cellCount = row.grid_size * row.grid_size;
        if (
            !Number.isInteger(cellA) ||
            !Number.isInteger(cellB) ||
            cellA === cellB ||
            cellA < 0 ||
            cellA >= cellCount ||
            cellB < 0 ||
            cellB >= cellCount
        ) {
            throw new Error("invalid cell indices");
        }

        const board: number[] = JSON.parse(row.board);
        [board[cellA], board[cellB]] = [board[cellB]!, board[cellA]!];

        const solved = board.every((tile, cell) => tile === cell);

        if (solved) {
            const endedAt = Date.now();
            const elapsedMs = endedAt - (row.started_at ?? endedAt);
            const remainingMs = Math.max(0, row.time_limit_ms - elapsedMs);
            const score = Math.max(
                PUZZLE_MIN_SOLVED_SCORE,
                Math.round((remainingMs / row.time_limit_ms) * PUZZLE_MAX_SCORE),
            );

            this.ctx.storage.sql.exec(
                "UPDATE puzzle SET board = ?, status = 'solved', ended_at = ?, score = ?, solved_by = ?",
                JSON.stringify(board),
                endedAt,
                score,
                participant.name,
            );
            await this.ctx.storage.deleteAlarm();
            this.broadcast({
                type: PuzzleWsEventType.Solved,
                board,
                score,
                solvedBy: participant.name,
                solvedByColor: participant.color,
                remainingMs,
            });
            this.updateCatalogPlayStatus(row.id, "finished");
            if (userId) await this.env.LEADERBOARD.recordScore({userId, kind: "puzzle", sessionId: row.id, score});
            return {status: GameSessionStatus.Solved, board, solved: true, score};
        }

        this.ctx.storage.sql.exec("UPDATE puzzle SET board = ?", JSON.stringify(board));
        this.broadcast({type: PuzzleWsEventType.Move, cellA, cellB, by: participant.name, color: participant.color});
        return {status: GameSessionStatus.Playing, board, solved: false, score: null};
    }

    /** Broadcasts that a player has selected/highlighted a block, before
     * they've picked its swap partner — purely a live UX cue (no swap
     * happens here; see `swapTiles()` for the actual move), so other
     * connected clients can see who's about to move which tile and in what
     * color. Not persisted: a reconnecting client just won't see stale
     * selections, which is preferable to a selection outliving the player's
     * attention. */
    async selectTile(
        participantId: string,
        token: string | null,
        cell: number,
        userId: string | null,
    ): Promise<void> {
        const participant = this.requireParticipant(participantId, token, userId);
        const row = this.requireRow();
        if (row.status !== GameSessionStatus.Playing) throw new Error("puzzle is not in progress");

        const cellCount = row.grid_size * row.grid_size;
        if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount) {
            throw new Error("invalid cell index");
        }

        this.broadcast({
            type: PuzzleWsEventType.TileSelected,
            cell,
            player: participant.name,
            color: participant.color
        });
    }

    // --- RPC: player interaction ---------------------------------------------

    async alarm(): Promise<void> {
        const row = this.requireRow();
        if (row.status === GameSessionStatus.Waiting) {
            await this.beginPlaying(row.id, row.grid_size, row.time_limit_ms);
            return;
        }
        if (row.status === GameSessionStatus.Playing) {
            this.ctx.storage.sql.exec("UPDATE puzzle SET status = 'timeout', ended_at = ?, score = 0", Date.now());
            this.broadcast({type: PuzzleWsEventType.Timeout});
            this.updateCatalogPlayStatus(row.id, "finished");
        }
        // Any other status means the puzzle moved on (solved, regenerated, etc.)
        // before this stale alarm fired — nothing to do.
    }

    override async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", {status: 426});
        }
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        this.send(pair[1], {type: PuzzleWsEventType.State, ...this.readPublicState()});
        // Let every other connected client know the player count changed.
        this.broadcast({type: WsEventType.Presence, connectedPlayers: this.ctx.getWebSockets().length});
        return new Response(null, {status: 101, webSocket: pair[0]});
    }

    // --- alarm: drives both the lobby auto-start and the countdown timeout --

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (typeof message === "string" && message === "ping") {
            this.send(ws, {type: WsEventType.Pong});
        }
    }

    // --- WebSocket upgrade (DOs use fetch() for this, not RPC) --------------

    async webSocketClose(): Promise<void> {
        // -1 because this handler runs before the closing socket drops out of
        // getWebSockets() on some runtimes; broadcasting a stale +1 count is
        // more confusing than a same-tick undercount that self-corrects on the
        // next presence event.
        this.broadcast({
            type: WsEventType.Presence,
            connectedPlayers: Math.max(0, this.ctx.getWebSockets().length - 1)
        });
    }

    private migrate(): void {
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS puzzle
            (
                id
                TEXT
                PRIMARY
                KEY,
                theme
                TEXT,
                prompt
                TEXT,
                status
                TEXT
                NOT
                NULL
                DEFAULT
                'queued',
                error
                TEXT,
                grid_size
                INTEGER
                NOT
                NULL,
                board
                TEXT
                NOT
                NULL
                DEFAULT
                '[]',
                time_limit_ms
                INTEGER
                NOT
                NULL,
                started_at
                INTEGER,
                lobby_ends_at
                INTEGER,
                ended_at
                INTEGER,
                score
                INTEGER,
                solved_by
                TEXT,
                host_token
                TEXT
                NOT
                NULL,
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
        // `color` was added after some DO instances already had this table —
        // `CREATE TABLE IF NOT EXISTS` only helps brand-new ones, so existing
        // instances need a backfill too. There's no `ALTER TABLE ... ADD
        // COLUMN IF NOT EXISTS`, so a "duplicate column" failure (on an
        // instance that already has it) is just swallowed.
        try {
            this.ctx.storage.sql.exec("ALTER TABLE participants ADD COLUMN color TEXT NOT NULL DEFAULT '#888888'");
        } catch {
            // Column already exists on this instance — nothing to do.
        }
    }

    /** Resolves and authorizes a participant: logged-in callers must be
     * signed in as the same user who joined; anonymous callers must present
     * the token issued at join time. Throws `Error("forbidden: ...")` for
     * either failure, which `hostActionError` (shared/http-exceptions.ts)
     * maps to a 403 — someone who never joined can still spectate, they just
     * can't act. Returns the joined display name/color to record on the
     * move and broadcast alongside it. */
    private requireParticipant(
        participantId: string,
        token: string | null,
        userId: string | null,
    ): { name: string; color: string } {
        const row = this.ctx.storage.sql
            .exec<ParticipantRow>("SELECT * FROM participants WHERE id = ?", participantId)
            .toArray()[0];
        if (!row) throw new Error("forbidden: join the puzzle before playing");
        if (row.user_id) {
            if (row.user_id !== userId) throw new Error("forbidden: not your participant id");
        } else if (!token || token !== row.token) {
            throw new Error("forbidden: invalid participant token");
        }
        return {name: row.name, color: row.color};
    }

    // --- internals -----------------------------------------------------------

    /** Shared by the host's "start now" and the lobby alarm's auto-start. */
    private async beginPlaying(puzzleId: string, gridSize: number, timeLimitMs: number): Promise<void> {
        const board = shuffledBoard(gridSize);
        const startedAt = Date.now();
        this.ctx.storage.sql.exec(
            "UPDATE puzzle SET status = 'playing', board = ?, started_at = ?, lobby_ends_at = NULL, ended_at = NULL, score = NULL, solved_by = NULL",
            JSON.stringify(board),
            startedAt,
        );
        await this.ctx.storage.setAlarm(startedAt + timeLimitMs);
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
        this.updateCatalogPlayStatus(puzzleId, "active");
    }

    /** Tells `browse` this instance's join window opened/closed (see
     * catalog.service.ts's `updatePlayStatus`) — fire-and-forget-ish:
     * awaited so it completes before this DO call returns, but its failure
     * is only logged, never thrown, so a `browse` hiccup can't break a live
     * puzzle move or the lobby's auto-start. `puzzleId` is `row.id`, not
     * `this.ctx.id` — the latter is the DO's internal unique id, not the
     * name it was routed by (`getByName(puzzleId)`), so it'd write the
     * wrong catalog row. */
    private updateCatalogPlayStatus(puzzleId: string, playStatus: "joinable" | "active" | "finished"): void {
        this.ctx.waitUntil(
            this.env.BROWSE.updatePlayStatus(puzzleId, playStatus).catch((err) => {
                console.error("failed to update catalog play status", puzzleId, err);
            }),
        );
    }

    private assertHost(row: PuzzleRow, hostToken: string): void {
        if (!hostToken || hostToken !== row.host_token) {
            throw new Error("forbidden: only the host can do that");
        }
    }

    private requireRow(): PuzzleRow {
        const row = this.ctx.storage.sql.exec<PuzzleRow>("SELECT * FROM puzzle LIMIT 1").toArray()[0];
        if (!row) throw new Error("puzzle not initialized");
        return row;
    }

    private readPublicState(): PuzzlePublic {
        const row = this.ctx.storage.sql.exec<PuzzleRow>("SELECT * FROM puzzle LIMIT 1").toArray()[0];
        if (!row) {
            return {
                id: "",
                theme: null,
                prompt: null,
                status: GameSessionStatus.Queued,
                gridSize: 0,
                board: [],
                timeLimitMs: 0,
                startedAt: null,
                remainingMs: null,
                lobbyRemainingMs: null,
                endedAt: null,
                score: null,
                solvedBy: null,
                connectedPlayers: this.ctx.getWebSockets().length,
                participants: [],
            };
        }

        const remainingMs =
            row.status === GameSessionStatus.Playing && row.started_at !== null
                ? Math.max(0, row.time_limit_ms - (Date.now() - row.started_at))
                : null;
        // `row.status === "waiting"` isn't checked separately here — `lobby_ends_at`
        // is always nulled out the moment the lobby ends (see beginPlaying()/
        // resetForRegenerate()), so lobbyRemainingMs() already reads null outside
        // the lobby window.
        const participants = this.ctx.storage.sql
            .exec<ParticipantPublic>("SELECT name, color FROM participants ORDER BY joined_at ASC")
            .toArray();

        return {
            id: row.id,
            theme: row.theme,
            prompt: row.prompt,
            status: row.status,
            error: row.error ?? undefined,
            gridSize: row.grid_size,
            board: JSON.parse(row.board),
            timeLimitMs: row.time_limit_ms,
            startedAt: row.started_at,
            remainingMs,
            lobbyRemainingMs: lobbyRemainingMs(row.lobby_ends_at),
            endedAt: row.ended_at,
            score: row.score,
            solvedBy: row.solved_by,
            connectedPlayers: this.ctx.getWebSockets().length,
            participants: participants.map((p) => ({name: p.name, color: p.color})),
        };
    }

    private broadcast(payload: PuzzleWsMessage): void {
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
    private send(ws: WebSocket, payload: PuzzleWsMessage): void {
        ws.send(JSON.stringify(payload));
    }
}

/** Fisher-Yates shuffle. Not security-sensitive (it's a puzzle layout, not
 * a token), so Math.random() is fine here. Reshuffles on the astronomically
 * unlikely chance it lands on the already-solved order. */
function shuffledBoard(gridSize: number): number[] {
    const tiles = Array.from({length: gridSize * gridSize}, (_, i) => i);
    do {
        for (let i = tiles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
        }
    } while (tiles.every((tile, i) => tile === i));
    return tiles;
}
