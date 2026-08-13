import {DurableObject} from "cloudflare:workers";
import type {z} from "@hono/zod-openapi";
import {asc, eq, inArray, isNotNull, sql} from "drizzle-orm";
import {migrate as runMigrations} from "drizzle-orm/durable-sqlite/migrator";
import {err, ok, type Result} from "neverthrow";
import {generateColor, isValidHexColor} from "@game-worker/shared/color";
import {maxPlayerLength} from "@game-worker/shared/game-session";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {lobbyCountdownSeconds, lobbyEndsAt, lobbyRemainingMs} from "@game-worker/shared/lobby";
import {fromRpcResult, toRpcResult, type RpcResult} from "@game-worker/shared/rpc-result";
import {currentUserFromRequestVia} from "@game-worker/shared/session";
import {WsEventType} from "@game-worker/shared/ws-messages";
import {createDb, type Db} from "./db/client";
import migrations from "./db/migrations";
import {participants, puzzle} from "./db/schema";
import {puzzleMaxScore, puzzleMinSolvedScore} from "./puzzle.constants";
import type {MoveResultSchema, PuzzlePublicSchema, PuzzleStatusSchema, PuzzleWsMessageSchema,} from "./puzzle.schema";
import {PuzzleWsClientEventType, PuzzleWsClientMessageSchema, PuzzleWsEventType} from "./puzzle.schema";

export type PuzzleStatus = z.infer<typeof PuzzleStatusSchema>;
export type PuzzlePublic = z.infer<typeof PuzzlePublicSchema>;
export type MoveResult = z.infer<typeof MoveResultSchema>;
export type PuzzleWsMessage = z.infer<typeof PuzzleWsMessageSchema>;

/** What a connected socket knows about who it's speaking for — resolved
 * once at `fetch()`/upgrade time (the only point a WS connection carries
 * the session cookie) and kept on the socket itself via
 * `serializeAttachment`/`deserializeAttachment` for the rest of its
 * lifetime, since individual WS messages don't carry cookies the way HTTP
 * requests did. `null`/`null` for an anonymous connection — same as
 * `currentUser(c)` returning `null` used to mean over HTTP. */
interface ConnectionIdentity {
    userId: string | null;
    color: string | null;
}

/** The `action` values `PuzzleWsErrorMessage` (see puzzle.schema.ts's
 * `PuzzleWsErrorMessageSchema`) tags a rejected client message with —
 * matches that schema's own `z.enum([...])` literal-for-literal, so an
 * `as const` object rather than a TS `enum` (same pattern as
 * `PuzzleWsEventType`/`PuzzleWsClientEventType`): a TS `enum` member isn't
 * assignable to the schema's plain string-literal union without a cast,
 * where this is. Used by `webSocketMessage()`'s `reply()` helper below. */
export const PuzzleWsAction = {
    Unknown: "unknown",
    Join: "join",
    Move: "move",
    Select: "select",
    Deselect: "deselect",
} as const;
export type PuzzleWsAction = (typeof PuzzleWsAction)[keyof typeof PuzzleWsAction];

// Row types come straight from the Drizzle table definitions (./db/schema.ts)
// rather than a hand-written interface — `drizzle-orm/durable-sqlite`'s
// query builder doesn't need the `Record<string, SqlStorageValue>` bound
// the raw `ctx.storage.sql.exec<T>()` calls this replaced used to require.
// `puzzle.status`'s inferred type is `GameSessionStatus` (see schema.ts's
// comment on why it isn't typed against `PuzzleStatus` directly) — the same
// set of string literals as `PuzzleStatus` below, so the two are freely
// interchangeable.
type PuzzleRow = typeof puzzle.$inferSelect;
type ParticipantRow = typeof participants.$inferSelect;

/** Narrower than `ParticipantRow` — just the columns `readPublicState()`'s
 * roster query actually selects. */
type ParticipantPublic = Pick<ParticipantRow, "id" | "name" | "color">;

/** Shape of `readPublicState()`'s "who has what selected" query — a
 * `participants` row filtered to `selectedCell IS NOT NULL` and reshaped
 * (`selectedCell` -> `cell`, `id` -> `participantId`) to match
 * `PuzzlePublic.selections`' own field names one-for-one. */
interface SelectionRow {
    cell: number;
    participantId: string;
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

    async init(puzzleId: string, theme: string | null, gridSize: number, timeLimitMs: number): Promise<string> {
        await this.ctx.storage.deleteAlarm();
        const hostToken = crypto.randomUUID();
        this.db
            .insert(puzzle)
            .values({
                id: puzzleId,
                theme,
                prompt: null,
                status: GameSessionStatus.Queued,
                error: null,
                gridSize,
                board: "[]",
                timeLimitMs,
                startedAt: null,
                lobbyEndsAt: null,
                endedAt: null,
                score: null,
                solvedBy: null,
                hostToken,
                createdAt: Date.now(),
            })
            .run();
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
        const endsAt = lobbyEndsAt(Date.now(), await lobbyCountdownSeconds(this.env.FLAGS));
        this.db
            .insert(puzzle)
            .values({
                id: puzzleId,
                theme,
                prompt,
                status: GameSessionStatus.Waiting,
                error: null,
                gridSize,
                board: "[]",
                timeLimitMs,
                startedAt: null,
                lobbyEndsAt: endsAt,
                endedAt: null,
                score: null,
                solvedBy: null,
                hostToken,
                createdAt: Date.now(),
            })
            .run();
        await this.ctx.storage.setAlarm(endsAt);
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
        return hostToken;
    }

    getState(): PuzzlePublic {
        return this.readPublicState();
    }

    // --- RPC: read-only snapshot (HTTP polling + WebSocket connect) --------

    async setGenerating(): Promise<void> {
        this.db.update(puzzle).set({status: GameSessionStatus.Generating}).run();
        this.broadcast({type: WsEventType.Status, status: GameSessionStatus.Generating});
    }

    // --- RPC: progress updates from the queue consumer ----------------------

    async setError(message: string): Promise<void> {
        this.db.update(puzzle).set({status: GameSessionStatus.Error, error: message}).run();
        this.broadcast({type: WsEventType.Status, status: GameSessionStatus.Error, error: message});
    }

    /** Image is ready — enter the waiting room rather than starting instantly,
     * so players can gather, and the host can preview/regenerate/start early. */
    async setReady(prompt: string): Promise<void> {
        const endsAt = lobbyEndsAt(Date.now(), await lobbyCountdownSeconds(this.env.FLAGS));
        this.db
            .update(puzzle)
            .set({prompt, status: GameSessionStatus.Waiting, error: null, lobbyEndsAt: endsAt})
            .run();
        await this.ctx.storage.setAlarm(endsAt);
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
    }

    /** Starts a fresh generation run — new AI image, new prompt. Returns the
     * theme to re-enqueue with; keeps the same host token. Only available
     * pre-start: once the puzzle is `playing`, other joined players are
     * mid-game, so wiping it out from under them is no longer this action's
     * job — see POST /puzzles/{id}/replay instead, which spins up a whole
     * new instance. */
    async resetForRegenerate(hostToken: string): Promise<RpcResult<string | null>> {
        const validated = this.requireRow()
            .andThen((row) => this.assertHost(row, hostToken))
            .andThen((row) =>
                JOINABLE_STATUSES.includes(row.status)
                    ? ok(row)
                    : err("regenerate is only available before the puzzle starts"),
            );
        if (validated.isErr()) return {ok: false, error: validated.error};
        const row = validated.value;

        await this.ctx.storage.deleteAlarm();
        this.db
            .update(puzzle)
            .set({
                prompt: null,
                status: GameSessionStatus.Queued,
                error: null,
                board: "[]",
                startedAt: null,
                lobbyEndsAt: null,
                endedAt: null,
                score: null,
                solvedBy: null,
            })
            .run();
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
        return toRpcResult(ok(row.theme));
    }

    // --- RPC: host-only lobby actions ----------------------------------------

    /** Ends the lobby countdown immediately and starts play. */
    async startNow(hostToken: string): Promise<RpcResult<void>> {
        const validated = this.requireRow()
            .andThen((row) => this.assertHost(row, hostToken))
            .andThen((row) => (row.status === GameSessionStatus.Waiting ? ok(row) : err("puzzle is not waiting to start")));
        if (validated.isErr()) return {ok: false, error: validated.error};

        const row = validated.value;
        await this.beginPlaying(row.id, row.gridSize, row.timeLimitMs);
        return toRpcResult(ok(undefined));
    }

    /** Registers a player as allowed to move tiles in this puzzle, only
     * while it hasn't started (see JOINABLE_STATUSES) — once it's `playing`
     * this resolves to an `Err`, so late arrivals can still spectate over
     * the WebSocket/`getState()` but can't play. Called from `webSocketMessage()`
     * for a `join` client message, using the identity resolved once at that
     * socket's `fetch()`/upgrade time (see `ConnectionIdentity`). Logged-in
     * users are upserted by `userId` (idempotent across reconnects/tab
     * refreshes) and keep their account color (never `requestedColor` — an
     * account's color is authoritative everywhere else in the app, so
     * letting it be overridden per-puzzle would be surprising); anonymous
     * guests get a fresh bearer token they must resend with every `move`/
     * `select`/`deselect` message (since a free-text name alone isn't a real
     * identity, and a new WebSocket connection has no memory of a previous
     * one's identity) and either their own `requestedColor` (if it's a
     * well-formed hex color — see `isValidHexColor`) or, absent that, a
     * freshly generated one. Either way, the color is returned so the
     * caller's own client knows what to render before the next broadcast. */
    async join(
        userId: string | null,
        playerName: string,
        userColor: string | null,
        requestedColor: string | null,
    ): Promise<RpcResult<{ participantId: string; token: string | null; color: string }>> {
        const validated = this.requireRow().andThen((row) =>
            JOINABLE_STATUSES.includes(row.status)
                ? ok(row)
                : err("puzzle has already started; you can spectate but not join"),
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
            this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color});
            return toRpcResult(ok({participantId: userId, token: null, color}));
        }

        const participantId = crypto.randomUUID();
        const token = crypto.randomUUID();
        this.db
            .insert(participants)
            .values({id: participantId, name: playerName, userId: null, token, color, joinedAt: Date.now()})
            .run();
        this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color});
        return toRpcResult(ok({participantId, token, color}));
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
    ): Promise<RpcResult<MoveResult>> {
        const validated = this.requireParticipant(participantId, token, userId).andThen((participant) =>
            this.requireRow().andThen((row) => {
                if (row.status !== GameSessionStatus.Playing) return err("puzzle is not in progress");
                const cellCount = row.gridSize * row.gridSize;
                if (
                    !Number.isInteger(cellA) ||
                    !Number.isInteger(cellB) ||
                    cellA === cellB ||
                    cellA < 0 ||
                    cellA >= cellCount ||
                    cellB < 0 ||
                    cellB >= cellCount
                ) {
                    return err("invalid cell indices");
                }
                return ok({participant, row});
            }),
        );
        if (validated.isErr()) return {ok: false, error: validated.error};
        const {participant, row} = validated.value;

        const board: number[] = JSON.parse(row.board);
        [board[cellA], board[cellB]] = [board[cellB]!, board[cellA]!];

        // Whoever had cellA/cellB selected (typically just the mover, whose
        // own selectedCell fed one half of this swap) no longer has anything
        // meaningful selected there — the tile that was under it just moved.
        // Cleared unconditionally rather than only for the mover: the `move`
        // broadcast below already tells every connected client to drop these
        // two cells from their local selection view (see the FE's
        // `clearTileSelections`), so this just keeps the persisted picture
        // (`readPublicState()`'s `selections`) in sync with that for anyone
        // who reconnects afterward.
        this.db
            .update(participants)
            .set({selectedCell: null})
            .where(inArray(participants.selectedCell, [cellA, cellB]))
            .run();

        const solved = board.every((tile, cell) => tile === cell);

        if (solved) {
            const endedAt = Date.now();
            const elapsedMs = endedAt - (row.startedAt ?? endedAt);
            const remainingMs = Math.max(0, row.timeLimitMs - elapsedMs);
            const [minSolvedScore, maxScore] = await Promise.all([
                puzzleMinSolvedScore(this.env),
                puzzleMaxScore(this.env),
            ]);
            const score = Math.max(minSolvedScore, Math.round((remainingMs / row.timeLimitMs) * maxScore));

            this.db
                .update(puzzle)
                .set({
                    board: JSON.stringify(board),
                    status: GameSessionStatus.Solved,
                    endedAt,
                    score,
                    solvedBy: participant.name,
                })
                .run();
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
            return toRpcResult(ok({status: GameSessionStatus.Solved, board, solved: true, score}));
        }

        this.db.update(puzzle).set({board: JSON.stringify(board)}).run();
        this.broadcast({type: PuzzleWsEventType.Move, cellA, cellB, by: participant.name, color: participant.color});
        return toRpcResult(ok({status: GameSessionStatus.Playing, board, solved: false, score: null}));
    }

    /** Records and broadcasts that a player has selected/highlighted a
     * block, before they've picked its swap partner — a live UX cue (no
     * swap happens here; see `swapTiles()` for the actual move), so other
     * connected clients can see who's about to move which tile and in what
     * color. Persisted (`participants.selected_cell`), unlike the old
     * HTTP-only version of this action, specifically so a client that
     * reconnects (e.g. a page refresh) can restore the same picture from
     * the next `state` snapshot instead of just missing it. A participant
     * only ever has one active selection: picking a new cell while another
     * is still selected replaces it, broadcasting a `tile_deselected` for
     * the old one first so everyone else's view stays consistent. */
    async selectTile(
        participantId: string,
        token: string | null,
        cell: number,
        userId: string | null,
    ): Promise<RpcResult<void>> {
        const validated = this.requireParticipant(participantId, token, userId).andThen((participant) =>
            this.requireRow().andThen((row) => {
                if (row.status !== GameSessionStatus.Playing) return err("puzzle is not in progress");
                const cellCount = row.gridSize * row.gridSize;
                if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount) return err("invalid cell index");
                return ok(participant);
            }),
        );
        if (validated.isErr()) return {ok: false, error: validated.error};
        const participant = validated.value;

        if (participant.selectedCell !== null && participant.selectedCell !== cell) {
            this.broadcast({type: PuzzleWsEventType.TileDeselected, cell: participant.selectedCell});
        }

        this.db.update(participants).set({selectedCell: cell}).where(eq(participants.id, participantId)).run();
        this.broadcast({
            type: PuzzleWsEventType.TileSelected,
            cell,
            player: participant.name,
            color: participant.color
        });
        return toRpcResult(ok(undefined));
    }

    /** The flip side of `selectTile()` — clears this participant's current
     * selection (if any) and broadcasts a `tile_deselected` naming it, so
     * every other connected client drops the highlight too. A no-op if
     * nothing's currently selected, same idea as `webSocketClose()`
     * tolerating a socket that was never really tracked. */
    async deselectTile(participantId: string, token: string | null, userId: string | null): Promise<RpcResult<void>> {
        const validated = this.requireParticipant(participantId, token, userId).andThen((participant) =>
            this.requireRow().andThen((row) =>
                row.status !== GameSessionStatus.Playing ? err("puzzle is not in progress") : ok(participant),
            ),
        );
        if (validated.isErr()) return {ok: false, error: validated.error};
        const participant = validated.value;

        if (participant.selectedCell === null) return toRpcResult(ok(undefined));

        this.db.update(participants).set({selectedCell: null}).where(eq(participants.id, participantId)).run();
        this.broadcast({type: PuzzleWsEventType.TileDeselected, cell: participant.selectedCell});
        return toRpcResult(ok(undefined));
    }

    // --- RPC: player interaction ---------------------------------------------

    async alarm(): Promise<void> {
        // Not part of `PuzzleDO`'s RPC surface — there's no caller to hand a
        // `Result` back to, and the DO alarm subsystem's own retry policy is
        // exactly what an uncaught rejection here should drive, same as a
        // thrown error always did — so `requireRow()`'s `Err` is rethrown
        // rather than propagated as a value.
        const row = this.requireRow().match(
            (row) => row,
            (error) => {
                throw new Error(error);
            },
        );
        if (row.status === GameSessionStatus.Waiting) {
            await this.beginPlaying(row.id, row.gridSize, row.timeLimitMs);
            return;
        }
        if (row.status === GameSessionStatus.Playing) {
            this.db.update(puzzle).set({status: GameSessionStatus.Timeout, endedAt: Date.now(), score: 0}).run();
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
        // Resolved once, here, because this is the only point a WS
        // connection ever carries the session cookie — see
        // `ConnectionIdentity`'s doc comment.
        const user = await currentUserFromRequestVia(request, this.env.ACCOUNTS);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({
            userId: user?.id ?? null,
            color: user?.color ?? null
        } satisfies ConnectionIdentity);
        this.send(pair[1], {type: PuzzleWsEventType.State, ...this.readPublicState()});
        // Let every other connected client know the player count changed.
        this.broadcast({type: WsEventType.Presence, connectedPlayers: this.ctx.getWebSockets().length});
        return new Response(null, {status: 101, webSocket: pair[0]});
    }

    // --- alarm: drives both the lobby auto-start and the countdown timeout --

    /** Dispatches one parsed client message to its RPC and replies once,
     * to the sending socket only — broadcasts to everyone else still happen
     * inside the RPC itself (`join()`/`swapTiles()`/`selectTile()`/
     * `deselectTile()`), same as before. Each arm's own validation (e.g.
     * `player` being non-empty, `cellA !== cellB`) is checked up front and
     * short-circuits with a `PuzzleWsErrorMessage` the same way a rejected
     * RPC call would; the RPC call itself already returns a
     * `RpcResult` (see @game-worker/shared/rpc-result) instead of throwing, so there's
     * no `try/catch` here at all — just `fromRpcResult()` to rehydrate a
     * real `neverthrow` `Result`, and `reply()` to `.match()` it into
     * whichever message actually goes back to the sender. */
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
            this.send(ws, {type: PuzzleWsEventType.Error, action: PuzzleWsAction.Unknown, error: "malformed message"});
            return;
        }
        const parsed = PuzzleWsClientMessageSchema.safeParse(json);
        if (!parsed.success) {
            this.send(ws, {type: PuzzleWsEventType.Error, action: PuzzleWsAction.Unknown, error: "invalid message"});
            return;
        }

        const identity = (ws.deserializeAttachment() as ConnectionIdentity | null) ?? {userId: null, color: null};
        const data = parsed.data;

        switch (data.type) {
            case PuzzleWsClientEventType.Join: {
                const player = data.player?.trim().slice(0, await maxPlayerLength(this.env.FLAGS)) ?? "";
                if (!player) {
                    this.send(ws, {type: PuzzleWsEventType.Error, action: PuzzleWsAction.Join, error: "player is required"});
                    return;
                }
                // join() only ever rejects with the "already started" case —
                // see puzzle.controller.ts's old POST .../join handler,
                // which this mirrors.
                const outcome = fromRpcResult(
                    await this.join(identity.userId, player, identity.color, data.color ?? null),
                );
                this.reply(ws, PuzzleWsAction.Join, outcome, (joined) => ({type: PuzzleWsEventType.JoinResult, ...joined}));
                return;
            }
            case PuzzleWsClientEventType.Move: {
                const {cellA, cellB, participantId, token} = data;
                if (cellA === cellB) {
                    this.send(ws, {
                        type: PuzzleWsEventType.Error,
                        action: PuzzleWsAction.Move,
                        error: "cellA and cellB must be different",
                    });
                    return;
                }
                const outcome = fromRpcResult(
                    await this.swapTiles(participantId, token ?? null, cellA, cellB, identity.userId),
                );
                this.reply(ws, PuzzleWsAction.Move, outcome);
                return;
            }
            case PuzzleWsClientEventType.Select: {
                const {cell, participantId, token} = data;
                const outcome = fromRpcResult(await this.selectTile(participantId, token ?? null, cell, identity.userId));
                this.reply(ws, PuzzleWsAction.Select, outcome);
                return;
            }
            case PuzzleWsClientEventType.Deselect: {
                const {participantId, token} = data;
                const outcome = fromRpcResult(await this.deselectTile(participantId, token ?? null, identity.userId));
                this.reply(ws, PuzzleWsAction.Deselect, outcome);
                return;
            }
        }
    }

    /** Folds a `fromRpcResult()`-rehydrated `Result` into the single reply
     * `webSocketMessage()` sends the originating socket for one action:
     * `toMessage(value)` on `Ok` — default "nothing", since `swapTiles()`/
     * `selectTile()`/`deselectTile()` already broadcast their own result,
     * which reaches the sender too as just another connected client — or a
     * `PuzzleWsErrorMessage` tagged with `action` on `Err`. */
    private reply<T>(
        ws: WebSocket,
        action: PuzzleWsAction,
        outcome: Result<T, string>,
        toMessage: (value: T) => PuzzleWsMessage | null = () => null,
    ): void {
        outcome.match(
            (value) => {
                const message = toMessage(value);
                if (message) this.send(ws, message);
            },
            (error) => this.send(ws, {type: PuzzleWsEventType.Error, action, error}),
        );
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

    // Real Drizzle migrations now, replacing the hand-rolled idempotent
    // `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` bootstrap this used to run
    // directly against `ctx.storage.sql`. `drizzle-kit generate` (run from
    // apps/puzzle) is schema.ts's source of truth for the SQL under
    // ../../drizzle; `./db/migrations.ts` hand-wires those generated files
    // in as importable modules (a DO can't read them off disk at runtime)
    // for `drizzle-orm/durable-sqlite/migrator`'s `migrate()` to apply. See
    // ./db/README.md for the full story and the workflow for a future
    // schema change. Mirrors `GameDO`'s own `migrate()`
    // (apps/guess/src/guess.model.ts), which moved to this same mechanism
    // first.
    //
    // NOTE: migration `0000` is `drizzle-kit`'s plain generated
    // `CREATE TABLE` output, not `CREATE TABLE IF NOT EXISTS` — deliberately
    // not softened to tolerate a table that already exists. Any `PuzzleDO`
    // instance that was already bootstrapped by the old raw-SQL `migrate()`
    // before this change will fail this migration (table already exists)
    // the next time it's touched. Accepted trade-off, not an oversight.
    private migrate = async (): Promise<void> => runMigrations(this.db, migrations);

    /** Resolves and authorizes a participant: logged-in callers must be
     * signed in as the same user who joined; anonymous callers must present
     * the token issued at join time. `Err("forbidden: ...")` for either
     * failure — every caller (`swapTiles()`/`selectTile()`/`deselectTile()`)
     * folds that straight into its own `RpcResult` (see
     * shared/rpc-result.ts), which `webSocketMessage()`'s `reply()` then surfaces
     * as a `PuzzleWsErrorMessage` addressed to the sending socket, same idea
     * as the `hostActionError` (shared/http-exceptions.ts) mapping to a 403
     * that the host-only actions above use — someone who never joined can
     * still spectate, they just can't act. Resolves to the joined display
     * name/color (to record on the move and broadcast alongside it) plus
     * the cell they currently have selected, if any (see
     * `selectTile()`/`deselectTile()`). */
    private requireParticipant(
        participantId: string,
        token: string | null,
        userId: string | null,
    ): Result<{ name: string; color: string; selectedCell: number | null }, string> {
        const row = this.db.select().from(participants).where(eq(participants.id, participantId)).get();
        if (!row) return err("forbidden: join the puzzle before playing");
        if (row.userId) {
            if (row.userId !== userId) return err("forbidden: not your participant id");
        } else if (!token || token !== row.token) {
            return err("forbidden: invalid participant token");
        }
        return ok({name: row.name, color: row.color, selectedCell: row.selectedCell});
    }

    // --- internals -----------------------------------------------------------

    /** Shared by the host's "start now" and the lobby alarm's auto-start. */
    private async beginPlaying(puzzleId: string, gridSize: number, timeLimitMs: number): Promise<void> {
        const board = shuffledBoard(gridSize);
        const startedAt = Date.now();
        this.db
            .update(puzzle)
            .set({
                status: GameSessionStatus.Playing,
                board: JSON.stringify(board),
                startedAt,
                lobbyEndsAt: null,
                endedAt: null,
                score: null,
                solvedBy: null,
            })
            .run();
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

    /** Passes `row` through unchanged on success, so callers can chain it
     * straight into a further `.andThen()` (see `startNow()`/
     * `resetForRegenerate()`) without re-fetching it. */
    private assertHost(row: PuzzleRow, hostToken: string): Result<PuzzleRow, string> {
        return hostToken && hostToken === row.hostToken ? ok(row) : err("forbidden: only the host can do that");
    }

    private requireRow(): Result<PuzzleRow, string> {
        const row = this.db.select().from(puzzle).limit(1).get();
        return row ? ok(row) : err("puzzle not initialized");
    }

    private readPublicState(): PuzzlePublic {
        const row = this.db.select().from(puzzle).limit(1).get();
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
                selections: [],
            };
        }

        const remainingMs =
            row.status === GameSessionStatus.Playing && row.startedAt !== null
                ? Math.max(0, row.timeLimitMs - (Date.now() - row.startedAt))
                : null;
        // `row.status === "waiting"` isn't checked separately here — `lobby_ends_at`
        // is always nulled out the moment the lobby ends (see beginPlaying()/
        // resetForRegenerate()), so lobbyRemainingMs() already reads null outside
        // the lobby window.
        const participantRows: ParticipantPublic[] = this.db
            .select({id: participants.id, name: participants.name, color: participants.color})
            .from(participants)
            .orderBy(asc(participants.joinedAt))
            .all();
        // Only ever non-empty while `playing` (selectTile()/deselectTile()
        // both require it), but read unconditionally rather than gated on
        // status — cheap, and one less thing that could drift out of sync.
        // `cell`'s non-null assertion is safe: `isNotNull()` below is the
        // exact same filter the original `WHERE selected_cell IS NOT NULL`
        // applied, Drizzle's inferred column type just can't express that.
        const selections: SelectionRow[] = this.db
            .select({
                cell: participants.selectedCell,
                participantId: participants.id,
                name: participants.name,
                color: participants.color,
            })
            .from(participants)
            .where(isNotNull(participants.selectedCell))
            .all()
            .map((s) => ({...s, cell: s.cell!}));

        return {
            id: row.id,
            theme: row.theme,
            prompt: row.prompt,
            status: row.status,
            error: row.error ?? undefined,
            gridSize: row.gridSize,
            board: JSON.parse(row.board),
            timeLimitMs: row.timeLimitMs,
            startedAt: row.startedAt,
            remainingMs,
            lobbyRemainingMs: lobbyRemainingMs(row.lobbyEndsAt),
            endedAt: row.endedAt,
            score: row.score,
            solvedBy: row.solvedBy,
            connectedPlayers: this.ctx.getWebSockets().length,
            participants: participantRows.map((p) => ({id: p.id, name: p.name, color: p.color})),
            selections: selections.map((s) => ({
                cell: s.cell,
                participantId: s.participantId,
                player: s.name,
                color: s.color,
            })),
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
