import {DurableObject} from "cloudflare:workers";
import type {z} from "@hono/zod-openapi";
import {asc, desc, eq, inArray, isNotNull, sql} from "drizzle-orm";
import {migrate as runMigrations} from "drizzle-orm/durable-sqlite/migrator";
import {err, ok, type Result} from "neverthrow";
import {generateColor, isValidHexColor} from "@game-worker/shared/color";
import {maxPlayerLength} from "@game-worker/shared/game-session";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {publicImageUrl} from "@game-worker/shared/images";
import {lobbyCountdownSeconds, lobbyEndsAt, lobbyRemainingMs} from "@game-worker/shared/lobby";
import {fromRpcResult, type RpcResult, toRpcResult} from "@game-worker/shared/rpc-result";
import {currentUserFromRequestVia} from "@game-worker/shared/session";
import {WsEventType} from "@game-worker/shared/ws-messages";
import {createDb, type Db} from "./db/client";
import migrations from "./db/migrations";
import {moves, participants, puzzle} from "./db/schema";
import {puzzleImageKeyFor, puzzleMaxScore, puzzleMinSolvedScore} from "./puzzle.constants";
import type {
    MoveResultSchema,
    PuzzlePublicSchema,
    PuzzleResultSchema,
    PuzzleStatusSchema,
    PuzzleWsMessageSchema,
} from "./puzzle.schema";
import {
    PuzzleWsClientEventType,
    PuzzleWsClientMessageSchema,
    PuzzleWsEventType,
} from "./puzzle.schema";

export type PuzzleStatus = z.infer<typeof PuzzleStatusSchema>;
export type PuzzlePublic = z.infer<typeof PuzzlePublicSchema>;
export type PuzzleResult = z.infer<typeof PuzzleResultSchema>;
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
    username: string | null;
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
 * joining is allowed. Once a puzzle is `playing` it's in progress, so
 * letting someone join then would let them play a match already underway
 * rather than just spectate it. */
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
 * which their browser stores and must present to start early. It's never
 * included in any broadcast or `getState()` — it only ever leaves the DO
 * once, in the creation response. Neither replaying nor regenerating a
 * finished puzzle reuses this token at all — see POST /puzzles/{id}/replay
 * and POST /puzzles/{id}/regenerate, both of which spin up a whole new
 * instance (and a new host token) rather than resetting this one in place.
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

    async init(
        puzzleId: string,
        theme: string | null,
        gridSize: number,
        timeLimitMs: number,
    ): Promise<string> {
        await this.ctx.storage.deleteAlarm();
        const hostToken = crypto.randomUUID();
        this.db
            .insert(puzzle)
            .values({
                id: puzzleId,
                theme,
                themeGenerated: 0,
                prompt: null,
                status: GameSessionStatus.Queued,
                error: null,
                gridSize,
                board: "[]",
                timeLimitMs,
                startedAt: null,
                lobbyEndsAt: null,
                endedAt: null,
                solvedBy: null,
                scoredCells: "[]",
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
     * hosted the original. `themeGenerated` is carried over from the source
     * puzzle as-is (see puzzle.controller.ts's `/replay`) — whether a theme
     * was typed in or picked for it is a property of the theme itself, not
     * of this particular instance, so a replay of an auto-generated theme
     * is still an auto-generated theme even though `theme` here is now a
     * concrete, known string either way. */
    async initFromSource(
        puzzleId: string,
        theme: string | null,
        gridSize: number,
        timeLimitMs: number,
        prompt: string,
        themeGenerated: boolean,
    ): Promise<string> {
        await this.ctx.storage.deleteAlarm();
        const hostToken = crypto.randomUUID();
        const endsAt = lobbyEndsAt(Date.now(), await lobbyCountdownSeconds(this.env.FLAGS));
        this.db
            .insert(puzzle)
            .values({
                id: puzzleId,
                theme,
                themeGenerated: themeGenerated ? 1 : 0,
                prompt,
                status: GameSessionStatus.Waiting,
                error: null,
                gridSize,
                board: "[]",
                timeLimitMs,
                startedAt: null,
                lobbyEndsAt: endsAt,
                endedAt: null,
                solvedBy: null,
                scoredCells: "[]",
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
     * so players can gather, and the host can preview/start early.
     * `theme` is the resolved theme this prompt was written around — the
     * caller's own if they gave one, otherwise whatever
     * `generateImagePrompt()` (a Flagship preset, or the model's own idea)
     * came back with; `themeGenerated` says which case it was. Writing both
     * here (rather than a separate RPC) keeps "the theme became known" and
     * "the image it produced" a single atomic update, since they're always
     * resolved together by the same `generateImagePrompt()` call — see
     * puzzle.queue.ts's `processPuzzle()`. */
    async setReady(prompt: string, theme: string, themeGenerated: boolean): Promise<void> {
        const endsAt = lobbyEndsAt(Date.now(), await lobbyCountdownSeconds(this.env.FLAGS));
        this.db
            .update(puzzle)
            .set({
                prompt,
                theme,
                themeGenerated: themeGenerated ? 1 : 0,
                status: GameSessionStatus.Waiting,
                error: null,
                lobbyEndsAt: endsAt,
            })
            .run();
        await this.ctx.storage.setAlarm(endsAt);
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
    }

    // --- RPC: host-only lobby actions ----------------------------------------

    /** Ends the lobby countdown immediately and starts play. */
    async startNow(hostToken: string): Promise<RpcResult<void>> {
        const validated = this.requireRow()
            .andThen((row) => this.assertHost(row, hostToken))
            .andThen((row) =>
                row.status === GameSessionStatus.Waiting
                    ? ok(row)
                    : err("puzzle is not waiting to start"),
            );
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
     * refreshes) and keep their account name and color (`playerName` is only
     * ever the client-supplied name for an anonymous caller — the caller
     * resolves it from the account's own `username` for a logged-in one,
     * same as `userColor` is never `requestedColor` — an account's identity
     * is authoritative everywhere else in the app, so letting either be
     * overridden per-puzzle would be surprising); anonymous
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
    ): Promise<RpcResult<{participantId: string; token: string | null; color: string}>> {
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
                .values({
                    id: userId,
                    name: playerName,
                    userId,
                    token: null,
                    color,
                    joinedAt: Date.now(),
                })
                .onConflictDoUpdate({
                    target: participants.id,
                    set: {
                        name: sql`excluded
                        .
                        name`,
                        color: sql`excluded
                        .
                        color`,
                    },
                })
                .run();
            this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color});
            return toRpcResult(ok({participantId: userId, token: null, color}));
        }

        const participantId = crypto.randomUUID();
        const token = crypto.randomUUID();
        this.db
            .insert(participants)
            .values({
                id: participantId,
                name: playerName,
                userId: null,
                token,
                color,
                joinedAt: Date.now(),
            })
            .run();
        this.broadcast({type: WsEventType.PlayerJoined, name: playerName, color});
        return toRpcResult(ok({participantId, token, color}));
    }

    // --- RPC: joining --------------------------------------------------------

    /** Unlike the old "whoever finishes it wins the whole pot" score, this
     * scores each swap on its own — see `scoreForMove()` — and broadcasts
     * it immediately, so every participant who places a tile earns points
     * in real time, not just the one who happens to make the puzzle's very
     * last move. `userId` is null for anonymous guests — their moves still
     * score against this puzzle's own live board (`results`, see
     * `readPublicState()`), they just aren't logged to the leaderboard,
     * which only happens once per player as a single total when the puzzle
     * finishes (see `finalizePuzzle()`) rather than per move — mirrors
     * `GameDO.submitGuess()`'s own userId handling. `participantId`/`token`
     * prove the caller joined before the puzzle started — see `join()` and
     * `requireParticipant()`.
     *
     * A cell only ever scores once (see `row.scoredCells`/`db/schema.ts`'s
     * doc comment on it): without that, swapping the same pair of tiles
     * into place and back out again would pay out every single time — the
     * naive "did this swap increase the number of correct cells" check
     * can't tell "genuinely made progress" apart from "undid my own last
     * move and redid it", since both look identical from inside one swap.
     * Tracking which cells have *ever* been credited closes that off: the
     * second (and every later) time a given cell lands correctly, it's
     * already in the set and simply doesn't score again, however many
     * times it gets shuffled away and back. */
    async swapTiles(
        participantId: string,
        token: string | null,
        cellA: number,
        cellB: number,
        userId: string | null,
    ): Promise<RpcResult<MoveResult>> {
        const validated = this.requireParticipant(participantId, token, userId).andThen(
            (participant) =>
                this.requireRow().andThen((row) => {
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
        if (validated.isErr()) {
            return {ok: false, error: validated.error};
        }
        const {participant, row} = validated.value;

        const board: number[] = JSON.parse(row.board);

        // Not in progress (not yet started, already solved, or timed out) —
        // rather than error, this is a no-op: report the puzzle's actual
        // current state back with nothing earned for this attempt, same
        // shape as a real move's result so callers don't need a separate
        // "was this a no-op" branch.
        if (row.status !== GameSessionStatus.Playing) {
            const totalScore =
                this.db
                    .select({total: sql<number>`COALESCE(SUM(${moves.score}),0)`})
                    .from(moves)
                    .where(eq(moves.participantId, participantId))
                    .get()?.total ?? 0;
            return toRpcResult(
                ok({
                    status: row.status,
                    board,
                    solved: board.every((tile, cell) => tile === cell),
                    score: null,
                    totalScore,
                }),
            );
        }

        [board[cellA], board[cellB]] = [board[cellB]!, board[cellA]!];

        const scoredCells = new Set<number>(JSON.parse(row.scoredCells));
        // Only cellA/cellB can possibly have changed, so there's no need to
        // diff the whole board — a cell counts as newly placed only if it's
        // correct *now* and hasn't already banked points at any earlier
        // point in this puzzle's life (see this method's doc comment).
        const newlyPlacedCells = [cellA, cellB].filter(
            (cell) => board[cell] === cell && !scoredCells.has(cell),
        );
        for (const cell of newlyPlacedCells) scoredCells.add(cell);

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

        const [maxScore, minScore] = await Promise.all([
            puzzleMaxScore(this.env),
            puzzleMinSolvedScore(this.env),
        ]);
        const cellCount = row.gridSize * row.gridSize;
        const score = scoreForMove(
            row.startedAt,
            row.timeLimitMs,
            maxScore,
            minScore,
            newlyPlacedCells.length,
            cellCount,
        );

        // Every attempt is logged (not just scoring ones) — mirrors
        // `GameDO.submitGuess()`'s `guesses` insert.
        this.db
            .insert(moves)
            .values({
                participantId,
                player: participant.name,
                cellA,
                cellB,
                cellsPlaced: newlyPlacedCells.length,
                score,
                createdAt: Date.now(),
            })
            .run();

        // This participant's running total across every scoring move this
        // puzzle so far, including the one just inserted — recomputed here
        // (rather than incrementally tracked) so it can't drift from
        // `readPublicState()`'s own `results`, same reasoning as
        // `GameDO.submitGuess()`'s `totalScore`.
        const totalScore =
            this.db
                .select({
                    total: sql<number>`COALESCE(SUM(${moves.score}),0)`,
                })
                .from(moves)
                .where(eq(moves.participantId, participantId))
                .get()?.total ?? 0;

        this.db
            .update(puzzle)
            .set({board: JSON.stringify(board), scoredCells: JSON.stringify([...scoredCells])})
            .run();

        if (solved) {
            const endedAt = Date.now();
            const remainingMs = Math.max(
                0,
                row.timeLimitMs - (endedAt - (row.startedAt ?? endedAt)),
            );
            const results = await this.finalizePuzzle(row.id, GameSessionStatus.Solved, endedAt, {
                name: participant.name,
                color: participant.color,
            });
            this.broadcast({
                type: PuzzleWsEventType.Solved,
                board,
                solvedBy: participant.name,
                solvedByColor: participant.color,
                remainingMs,
                results,
            });
            return toRpcResult(
                ok({status: GameSessionStatus.Solved, board, solved: true, score, totalScore}),
            );
        }

        this.broadcast({
            type: PuzzleWsEventType.Move,
            cellA,
            cellB,
            by: participant.name,
            color: participant.color,
            score,
        });
        return toRpcResult(
            ok({status: GameSessionStatus.Playing, board, solved: false, score, totalScore}),
        );
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
        const validated = this.requireParticipant(participantId, token, userId).andThen(
            (participant) =>
                this.requireRow().andThen((row) => {
                    const cellCount = row.gridSize * row.gridSize;
                    if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount)
                        return err("invalid cell index");
                    return ok({participant, row});
                }),
        );
        if (validated.isErr()) return {ok: false, error: validated.error};
        const {participant, row} = validated.value;

        // Not in progress (not yet started, already solved, or timed out) —
        // rather than error, this is a no-op: nothing to highlight once
        // there's no more play happening, same idea as `swapTiles()`'s own
        // no-op for this case.
        if (row.status !== GameSessionStatus.Playing) return toRpcResult(ok(undefined));

        if (participant.selectedCell !== null && participant.selectedCell !== cell) {
            this.broadcast({
                type: PuzzleWsEventType.TileDeselected,
                cell: participant.selectedCell,
            });
        }

        this.db
            .update(participants)
            .set({selectedCell: cell})
            .where(eq(participants.id, participantId))
            .run();
        this.broadcast({
            type: PuzzleWsEventType.TileSelected,
            cell,
            player: participant.name,
            color: participant.color,
        });
        return toRpcResult(ok(undefined));
    }

    /** The flip side of `selectTile()` — clears this participant's current
     * selection (if any) and broadcasts a `tile_deselected` naming it, so
     * every other connected client drops the highlight too. A no-op if
     * nothing's currently selected, same idea as `webSocketClose()`
     * tolerating a socket that was never really tracked. */
    async deselectTile(
        participantId: string,
        token: string | null,
        userId: string | null,
    ): Promise<RpcResult<void>> {
        const validated = this.requireParticipant(participantId, token, userId).andThen(
            (participant) =>
                this.requireRow().andThen((row) =>
                    row.status !== GameSessionStatus.Playing
                        ? err("puzzle is not in progress")
                        : ok(participant),
                ),
        );
        if (validated.isErr()) return {ok: false, error: validated.error};
        const participant = validated.value;

        if (participant.selectedCell === null) return toRpcResult(ok(undefined));

        this.db
            .update(participants)
            .set({selectedCell: null})
            .where(eq(participants.id, participantId))
            .run();
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
            // Whatever partial progress got made before time ran out still
            // scores — a timeout only means nobody (or not everybody) placed
            // the last tile, not that every earlier correct placement this
            // game is wiped out. Mirrors `GameDO.alarm()`'s own guess-timeout
            // handling.
            const results = await this.finalizePuzzle(
                row.id,
                GameSessionStatus.Timeout,
                Date.now(),
                null,
            );
            this.broadcast({type: PuzzleWsEventType.Timeout, results});
        }
        // Any other status means the puzzle moved on (solved, errored, etc.)
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
            username: user?.username ?? null,
            color: user?.color ?? null,
        } satisfies ConnectionIdentity);
        this.send(pair[1], {type: PuzzleWsEventType.State, ...this.readPublicState()});
        // Let every other connected client know the player count changed.
        this.broadcast({
            type: WsEventType.Presence,
            connectedPlayers: this.ctx.getWebSockets().length,
        });
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
            this.send(ws, {
                type: PuzzleWsEventType.Error,
                action: PuzzleWsAction.Unknown,
                error: "malformed message",
            });
            return;
        }
        const parsed = PuzzleWsClientMessageSchema.safeParse(json);
        if (!parsed.success) {
            this.send(ws, {
                type: PuzzleWsEventType.Error,
                action: PuzzleWsAction.Unknown,
                error: "invalid message",
            });
            return;
        }

        const identity = (ws.deserializeAttachment() as ConnectionIdentity | null) ?? {
            userId: null,
            username: null,
            color: null,
        };
        const data = parsed.data;

        switch (data.type) {
            case PuzzleWsClientEventType.Join: {
                const player = identity.userId
                    ? (identity.username ?? "")
                    : (data.player?.trim().slice(0, await maxPlayerLength(this.env.FLAGS)) ?? "");
                if (!player) {
                    this.send(ws, {
                        type: PuzzleWsEventType.Error,
                        action: PuzzleWsAction.Join,
                        error: "player is required",
                    });
                    return;
                }
                const outcome = fromRpcResult(
                    await this.join(identity.userId, player, identity.color, data.color ?? null),
                );
                this.reply(ws, PuzzleWsAction.Join, outcome, (joined) => ({
                    type: PuzzleWsEventType.JoinResult,
                    ...joined,
                }));
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
                    await this.swapTiles(
                        participantId,
                        token ?? null,
                        cellA,
                        cellB,
                        identity.userId,
                    ),
                );
                this.reply(ws, PuzzleWsAction.Move, outcome);
                return;
            }
            case PuzzleWsClientEventType.Select: {
                const {cell, participantId, token} = data;
                const outcome = fromRpcResult(
                    await this.selectTile(participantId, token ?? null, cell, identity.userId),
                );
                this.reply(ws, PuzzleWsAction.Select, outcome);
                return;
            }
            case PuzzleWsClientEventType.Deselect: {
                const {participantId, token} = data;
                const outcome = fromRpcResult(
                    await this.deselectTile(participantId, token ?? null, identity.userId),
                );
                this.reply(ws, PuzzleWsAction.Deselect, outcome);
                return;
            }
        }
    }

    async webSocketClose(): Promise<void> {
        // -1 because this handler runs before the closing socket drops out of
        // getWebSockets() on some runtimes; broadcasting a stale +1 count is
        // more confusing than a same-tick undercount that self-corrects on the
        // next presence event.
        this.broadcast({
            type: WsEventType.Presence,
            connectedPlayers: Math.max(0, this.ctx.getWebSockets().length - 1),
        });
    }

    // --- WebSocket upgrade (DOs use fetch() for this, not RPC) --------------

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
    ): Result<{name: string; color: string; selectedCell: number | null}, string> {
        const row = this.db
            .select()
            .from(participants)
            .where(eq(participants.id, participantId))
            .get();
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
    private async beginPlaying(
        puzzleId: string,
        gridSize: number,
        timeLimitMs: number,
    ): Promise<void> {
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
                solvedBy: null,
                scoredCells: "[]",
            })
            .run();
        await this.ctx.storage.setAlarm(startedAt + timeLimitMs);
        this.broadcast({type: PuzzleWsEventType.State, ...this.readPublicState()});
        this.updateCatalogPlayStatus(puzzleId, "active");
    }

    /** Closes out the puzzle, however it ended: sums every scoring move
     * logged so far (grouped by participant, highest first — same shape as
     * `readPublicState()`'s own `results`, which this can't drift from
     * since both read the same `moves` table), records one leaderboard
     * entry per logged-in participant for their total, and tells `browse`
     * the join window is closed for good. Mirrors `GameDO.finalizeGame()`.
     * Doesn't touch `board`/`scoredCells` — `swapTiles()`'s caller has
     * already persisted those itself by the time it calls this for a solve;
     * a timeout leaves them exactly as they were. `solvedBy` is null for a
     * timeout, or whoever made the winning move for a solve. */
    private async finalizePuzzle(
        puzzleId: string,
        status: "solved" | "timeout",
        endedAt: number,
        solvedBy: {name: string; color: string} | null,
    ): Promise<PuzzleResult[]> {
        await this.ctx.storage.deleteAlarm();
        this.db
            .update(puzzle)
            .set({status, endedAt, solvedBy: solvedBy?.name ?? null})
            .run();

        const totalExpr = sql<number>`SUM(
        ${moves.score}
        )`;
        const results: PuzzleResult[] = this.db
            .select({participantId: moves.participantId, score: totalExpr})
            .from(moves)
            .where(isNotNull(moves.score))
            .groupBy(moves.participantId)
            .orderBy(desc(totalExpr))
            .all();

        // One batched lookup for every scoring participant's account, rather
        // than one query per participant — same "N round trips -> 1" shape
        // as AccountsRpc.getUsersByIds / leaderboard.service.ts's
        // withUserInfo, whose flatMap-an-empty-array-to-skip idiom the two
        // flatMaps below also borrow.
        const scorerIds = results.filter((r) => r.score > 0).map((r) => r.participantId);
        const userIdByParticipant = new Map(
            scorerIds.length === 0
                ? []
                : this.db
                      .select({id: participants.id, userId: participants.userId})
                      .from(participants)
                      .where(inArray(participants.id, scorerIds))
                      .all()
                      .flatMap((p) => (p.userId ? [[p.id, p.userId] as const] : [])),
        );

        await Promise.all(
            results.flatMap(({participantId, score}) => {
                const userId = userIdByParticipant.get(participantId);
                if (!userId) return [];
                return [
                    this.env.LEADERBOARD.recordScore({
                        userId,
                        kind: "puzzle",
                        sessionId: puzzleId,
                        score,
                    }).catch((err) => {
                        console.error(
                            "failed to record puzzle score",
                            puzzleId,
                            participantId,
                            err,
                        );
                    }),
                ];
            }),
        );

        this.updateCatalogPlayStatus(puzzleId, "finished");
        return results;
    }

    /** Tells `browse` this instance's join window opened/closed (see
     * catalog.service.ts's `updatePlayStatus`) — fire-and-forget-ish:
     * awaited so it completes before this DO call returns, but its failure
     * is only logged, never thrown, so a `browse` hiccup can't break a live
     * puzzle move or the lobby's auto-start. `puzzleId` is `row.id`, not
     * `this.ctx.id` — the latter is the DO's internal unique id, not the
     * name it was routed by (`getByName(puzzleId)`), so it'd write the
     * wrong catalog row. */
    private updateCatalogPlayStatus(
        puzzleId: string,
        playStatus: "joinable" | "active" | "finished",
    ): void {
        this.ctx.waitUntil(
            this.env.BROWSE.updatePlayStatus(puzzleId, playStatus).catch((err) => {
                console.error("failed to update catalog play status", puzzleId, err);
            }),
        );
    }

    /** Passes `row` through unchanged on success, so callers can chain it
     * straight into a further `.andThen()` (see `startNow()`) without
     * re-fetching it. */
    private assertHost(row: PuzzleRow, hostToken: string): Result<PuzzleRow, string> {
        return hostToken && hostToken === row.hostToken
            ? ok(row)
            : err("forbidden: only the host can do that");
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
                themeGenerated: false,
                prompt: null,
                sourceImageUrl: null,
                status: GameSessionStatus.Queued,
                gridSize: 0,
                board: [],
                timeLimitMs: 0,
                startedAt: null,
                remainingMs: null,
                lobbyRemainingMs: null,
                endedAt: null,
                solvedBy: null,
                connectedPlayers: this.ctx.getWebSockets().length,
                participants: [],
                selections: [],
                results: [],
            };
        }

        const remainingMs =
            row.status === GameSessionStatus.Playing && row.startedAt !== null
                ? Math.max(0, row.timeLimitMs - (Date.now() - row.startedAt))
                : null;
        // `row.status === "waiting"` isn't checked separately here — `lobby_ends_at`
        // is always nulled out the moment the lobby ends (see beginPlaying()),
        // so lobbyRemainingMs() already reads null outside the lobby window.
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

        // Same "sum of every scoring move, grouped by participant" this
        // participant's own `totalScore` is built from in `swapTiles()` —
        // recomputed here (rather than incrementally tracked) so it can't
        // drift from that figure. Mirrors `GameDO.readPublicState()`'s own
        // `results` query.
        const totalExpr = sql<number>`SUM(
        ${moves.score}
        )`;
        const results = this.db
            .select({participantId: moves.participantId, total: totalExpr})
            .from(moves)
            .where(isNotNull(moves.score))
            .groupBy(moves.participantId)
            .orderBy(desc(totalExpr))
            .all();

        return {
            id: row.id,
            theme: row.theme,
            themeGenerated: row.themeGenerated === 1,
            prompt: row.prompt,
            // Gated on `prompt` rather than `status`: the queue consumer
            // only ever sets `prompt` once the image is actually in R2 (see
            // puzzle.queue.ts's processPuzzle(), which uploads before
            // calling setReady()), so this is never null once the image
            // genuinely exists.
            sourceImageUrl: row.prompt
                ? publicImageUrl(this.env.IMAGES_PUBLIC_URL, puzzleImageKeyFor(row.id))
                : null,
            status: row.status,
            error: row.error ?? undefined,
            gridSize: row.gridSize,
            board: JSON.parse(row.board),
            timeLimitMs: row.timeLimitMs,
            startedAt: row.startedAt,
            remainingMs,
            lobbyRemainingMs: lobbyRemainingMs(row.lobbyEndsAt),
            endedAt: row.endedAt,
            solvedBy: row.solvedBy,
            connectedPlayers: this.ctx.getWebSockets().length,
            participants: participantRows.map((p) => ({id: p.id, name: p.name, color: p.color})),
            selections: selections.map((s) => ({
                cell: s.cell,
                participantId: s.participantId,
                player: s.name,
                color: s.color,
            })),
            results: results.map((r) => ({participantId: r.participantId, score: r.total})),
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

/** See `puzzleMaxScore()`/`puzzleMinSolvedScore()`: the whole puzzle's
 * point pool (`maxScore`) is split evenly across every cell, so each
 * tile's own share decays linearly from `maxScore / cellCount` at zero
 * elapsed time (the instant the puzzle started — `startedAt`, stamped by
 * `beginPlaying()`) down to `minScore / cellCount` at the time limit or
 * beyond — mirrors guess.model.ts's `scoreForGuess()`, just paid out per
 * correctly-placed tile instead of per correct guess, and by whoever
 * placed it rather than only whoever happens to make the puzzle's last
 * move. `matchesDelta` is how many of this move's two cells went from
 * wrong to right (0 means the move didn't improve the board at all — a
 * "wrong move", unlike `scoreForGuess()`'s "wrong guess earns nothing"
 * rule, still earns a flat consolation point here rather than nothing, so
 * this never returns `null`). `startedAt` is only null for a puzzle
 * somehow being scored before `beginPlaying()` ran; treated as "just
 * started" (max score) rather than throwing, same fallback
 * `scoreForGuess()` uses for its own `startedAt`. */
function scoreForMove(
    startedAt: number | null,
    limitMs: number,
    maxScore: number,
    minScore: number,
    matchesDelta: number,
    cellCount: number,
): number {
    if (matchesDelta <= 0) return 1;
    const elapsedMs = Date.now() - (startedAt ?? Date.now());
    const remainingMs = Math.max(0, limitMs - elapsedMs);
    const maxPerTile = maxScore / cellCount;
    const minPerTile = minScore / cellCount;
    const perTile = Math.max(minPerTile, (remainingMs / limitMs) * maxPerTile);
    return Math.round(perTile * matchesDelta);
}
