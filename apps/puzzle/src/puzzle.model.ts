import { DurableObject } from "cloudflare:workers";
import type { z } from "@hono/zod-openapi";
import { LOBBY_COUNTDOWN_SECONDS, PUZZLE_MAX_SCORE, PUZZLE_MIN_SOLVED_SCORE } from "./puzzle.constants";
import type { MoveResultSchema, PuzzlePublicSchema } from "./puzzle.schema";

export type PuzzleStatus = z.infer<typeof PuzzlePublicSchema>["status"];
export type PuzzlePublic = z.infer<typeof PuzzlePublicSchema>;
export type MoveResult = z.infer<typeof MoveResultSchema>;

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
 * which their browser stores and must present to regenerate, start early,
 * or replay. It's never included in any broadcast or `getState()` — it
 * only ever leaves the DO once, in the creation response.
 */
export class PuzzleDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS puzzle (
        id TEXT PRIMARY KEY,
        theme TEXT,
        prompt TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        grid_size INTEGER NOT NULL,
        board TEXT NOT NULL DEFAULT '[]',
        time_limit_ms INTEGER NOT NULL,
        started_at INTEGER,
        lobby_ends_at INTEGER,
        ended_at INTEGER,
        score INTEGER,
        solved_by TEXT,
        host_token TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // --- RPC: create a brand new puzzle (never called twice for the same id) -

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
    this.broadcast({ type: "state", ...this.readPublicState() });
    return hostToken;
  }

  // --- RPC: read-only snapshot (HTTP polling + WebSocket connect) --------

  getState(): PuzzlePublic {
    return this.readPublicState();
  }

  // --- RPC: progress updates from the queue consumer ----------------------

  async setGenerating(): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE puzzle SET status = 'generating'");
    this.broadcast({ type: "status", status: "generating" });
  }

  async setError(message: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE puzzle SET status = 'error', error = ?", message);
    this.broadcast({ type: "status", status: "error", error: message });
  }

  /** Image is ready — enter the waiting room rather than starting instantly,
   * so players can gather, and the host can preview/regenerate/start early. */
  async setReady(prompt: string): Promise<void> {
    const lobbyEndsAt = Date.now() + LOBBY_COUNTDOWN_SECONDS * 1000;
    this.ctx.storage.sql.exec(
      "UPDATE puzzle SET prompt = ?, status = 'waiting', error = NULL, lobby_ends_at = ?",
      prompt,
      lobbyEndsAt,
    );
    await this.ctx.storage.setAlarm(lobbyEndsAt);
    this.broadcast({ type: "state", ...this.readPublicState() });
  }

  // --- RPC: host-only lobby actions ----------------------------------------

  /** Starts a fresh generation run — new AI image, new prompt. Returns the
   * theme to re-enqueue with; keeps the same host token. */
  async resetForRegenerate(hostToken: string): Promise<string | null> {
    const row = this.requireRow();
    this.assertHost(row, hostToken);
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.sql.exec(
      `UPDATE puzzle SET prompt = NULL, status = 'queued', error = NULL, board = '[]',
         started_at = NULL, lobby_ends_at = NULL, ended_at = NULL, score = NULL, solved_by = NULL`,
    );
    this.broadcast({ type: "state", ...this.readPublicState() });
    return row.theme;
  }

  /** Ends the lobby countdown immediately and starts play. */
  async startNow(hostToken: string): Promise<void> {
    const row = this.requireRow();
    this.assertHost(row, hostToken);
    if (row.status !== "waiting") throw new Error("puzzle is not waiting to start");
    await this.beginPlaying(row.grid_size, row.time_limit_ms);
  }

  /** Replays the *same* image: reshuffles and goes back through the lobby.
   * No new AI call — the source image in R2 is reused as-is. */
  async replay(hostToken: string): Promise<void> {
    const row = this.requireRow();
    this.assertHost(row, hostToken);
    if (row.status !== "solved" && row.status !== "timeout") {
      throw new Error("puzzle must be finished before replaying");
    }
    if (!row.prompt) throw new Error("no image to replay");

    const lobbyEndsAt = Date.now() + LOBBY_COUNTDOWN_SECONDS * 1000;
    this.ctx.storage.sql.exec(
      `UPDATE puzzle SET status = 'waiting', board = '[]', started_at = NULL,
         lobby_ends_at = ?, ended_at = NULL, score = NULL, solved_by = NULL`,
      lobbyEndsAt,
    );
    await this.ctx.storage.setAlarm(lobbyEndsAt);
    this.broadcast({ type: "state", ...this.readPublicState() });
  }

  // --- RPC: player interaction ---------------------------------------------

  /** `userId` is null for anonymous guests — a solve still counts for this
   * puzzle's own state, it just isn't logged to the leaderboard (recorded
   * via the LEADERBOARD service binding — see wrangler.jsonc). */
  async swapTiles(player: string, cellA: number, cellB: number, userId: string | null): Promise<MoveResult> {
    const row = this.requireRow();
    if (row.status !== "playing") throw new Error("puzzle is not in progress");

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
        player,
      );
      await this.ctx.storage.deleteAlarm();
      this.broadcast({ type: "solved", board, score, solvedBy: player, remainingMs });
      if (userId) await this.env.LEADERBOARD.recordScore({ userId, kind: "puzzle", sessionId: row.id, score });
      return { status: "solved", board, solved: true, score };
    }

    this.ctx.storage.sql.exec("UPDATE puzzle SET board = ?", JSON.stringify(board));
    this.broadcast({ type: "move", cellA, cellB, by: player });
    return { status: "playing", board, solved: false, score: null };
  }

  // --- alarm: drives both the lobby auto-start and the countdown timeout --

  async alarm(): Promise<void> {
    const row = this.requireRow();
    if (row.status === "waiting") {
      await this.beginPlaying(row.grid_size, row.time_limit_ms);
      return;
    }
    if (row.status === "playing") {
      this.ctx.storage.sql.exec("UPDATE puzzle SET status = 'timeout', ended_at = ?, score = 0", Date.now());
      this.broadcast({ type: "timeout" });
    }
    // Any other status means the puzzle moved on (solved, regenerated, etc.)
    // before this stale alarm fired — nothing to do.
  }

  // --- WebSocket upgrade (DOs use fetch() for this, not RPC) --------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "state", ...this.readPublicState() }));
    // Let every other connected client know the player count changed.
    this.broadcast({ type: "presence", connectedPlayers: this.ctx.getWebSockets().length });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  async webSocketClose(): Promise<void> {
    // -1 because this handler runs before the closing socket drops out of
    // getWebSockets() on some runtimes; broadcasting a stale +1 count is
    // more confusing than a same-tick undercount that self-corrects on the
    // next presence event.
    this.broadcast({ type: "presence", connectedPlayers: Math.max(0, this.ctx.getWebSockets().length - 1) });
  }

  // --- internals -----------------------------------------------------------

  /** Shared by the host's "start now" and the lobby alarm's auto-start. */
  private async beginPlaying(gridSize: number, timeLimitMs: number): Promise<void> {
    const board = shuffledBoard(gridSize);
    const startedAt = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE puzzle SET status = 'playing', board = ?, started_at = ?, lobby_ends_at = NULL, ended_at = NULL, score = NULL, solved_by = NULL",
      JSON.stringify(board),
      startedAt,
    );
    await this.ctx.storage.setAlarm(startedAt + timeLimitMs);
    this.broadcast({ type: "state", ...this.readPublicState() });
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
        status: "queued",
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
      };
    }

    const remainingMs =
      row.status === "playing" && row.started_at !== null
        ? Math.max(0, row.time_limit_ms - (Date.now() - row.started_at))
        : null;
    const lobbyRemainingMs =
      row.status === "waiting" && row.lobby_ends_at !== null
        ? Math.max(0, row.lobby_ends_at - Date.now())
        : null;

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
      lobbyRemainingMs,
      endedAt: row.ended_at,
      score: row.score,
      solvedBy: row.solved_by,
      connectedPlayers: this.ctx.getWebSockets().length,
    };
  }

  private broadcast(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Dead socket — hibernation cleans it up on close, nothing to do here.
      }
    }
  }
}

/** Fisher-Yates shuffle. Not security-sensitive (it's a puzzle layout, not
 * a token), so Math.random() is fine here. Reshuffles on the astronomically
 * unlikely chance it lands on the already-solved order. */
function shuffledBoard(gridSize: number): number[] {
  const tiles = Array.from({ length: gridSize * gridSize }, (_, i) => i);
  do {
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
    }
  } while (tiles.every((tile, i) => tile === i));
  return tiles;
}
