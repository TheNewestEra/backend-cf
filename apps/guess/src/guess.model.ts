import { DurableObject } from "cloudflare:workers";
import type { z } from "@hono/zod-openapi";
import { isGuessCorrect } from "./guess-matching";
import type { GamePublicSchema, GuessResultSchema, RoundPublicSchema } from "./guess.schema";
import { GUESS_MAX_SCORE, GUESS_MIN_SCORE, GUESS_TIME_LIMIT_SECONDS, ROUND_COUNT } from "./guess.constants";

export type RoundStatus = z.infer<typeof RoundPublicSchema>["status"];
export type GameStatus = z.infer<typeof GamePublicSchema>["status"];
export type GamePublic = z.infer<typeof GamePublicSchema>;
export type GuessResult = z.infer<typeof GuessResultSchema>;

// The `Record<string, SqlStorageValue>` bound is what `storage.sql.exec<T>`
// requires its row type to satisfy.
interface GameRow extends Record<string, SqlStorageValue> {
  id: string;
  theme: string | null;
  status: GameStatus;
  error: string | null;
  created_at: number;
}

interface RoundRow extends Record<string, SqlStorageValue> {
  idx: number;
  prompt: string | null;
  status: RoundStatus;
  image_key: string | null;
  ready_at: number | null;
  error: string | null;
}

/**
 * One instance per game (routed via `env.GAME_DO.getByName(gameId)`).
 * Owns the game's durable state (prompts, round/image status, guesses) and
 * pushes live progress to every connected WebSocket as the queue consumer
 * calls its RPC methods.
 */
export class GameDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS game (
        id TEXT PRIMARY KEY,
        theme TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rounds (
        idx INTEGER PRIMARY KEY,
        prompt TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        image_key TEXT,
        ready_at INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS guesses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_idx INTEGER NOT NULL,
        player TEXT NOT NULL,
        guess TEXT NOT NULL,
        correct INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // --- RPC: create (or fully reset, for /regenerate) a game's state -----

  async init(gameId: string, theme: string | null): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM guesses");
    this.ctx.storage.sql.exec("DELETE FROM rounds");
    this.ctx.storage.sql.exec(
      `INSERT INTO game (id, theme, status, error, created_at) VALUES (?, ?, 'queued', NULL, ?)
       ON CONFLICT(id) DO UPDATE SET theme = excluded.theme, status = 'queued', error = NULL`,
      gameId,
      theme,
      now,
    );
    for (let i = 0; i < ROUND_COUNT; i++) {
      this.ctx.storage.sql.exec("INSERT INTO rounds (idx, status) VALUES (?, 'pending')", i);
    }
    this.broadcast({ type: "state", ...this.readPublicState() });
  }

  // --- RPC: read-only snapshot (HTTP polling + WebSocket connect) -------

  getState(): GamePublic {
    return this.readPublicState();
  }

  // --- RPC: progress updates from the queue consumer ---------------------

  async setStatus(status: GameStatus, error?: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE game SET status = ?, error = ?", status, error ?? null);
    this.broadcast({ type: "status", status, error });
  }

  async setPrompts(prompts: string[]): Promise<void> {
    prompts.forEach((prompt, idx) => {
      this.ctx.storage.sql.exec("UPDATE rounds SET prompt = ? WHERE idx = ?", prompt, idx);
    });
    this.broadcast({ type: "prompts_ready", count: prompts.length });
  }

  async setRoundStatus(index: number, status: RoundStatus, error?: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE rounds SET status = ?, error = ? WHERE idx = ?",
      status,
      error ?? null,
      index,
    );
    this.broadcast({ type: "round_status", index, status, error });
  }

  async setRoundImage(index: number, imageKey: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE rounds SET image_key = ?, status = 'ready', ready_at = ?, error = NULL WHERE idx = ?",
      imageKey,
      Date.now(),
      index,
    );
    this.broadcast({ type: "round_ready", index });
  }

  // --- RPC: player interaction --------------------------------------------

  /** `userId` is null for anonymous guests — their guesses still count in
   * this game's own state, they just aren't logged to the leaderboard
   * (recorded via the LEADERBOARD service binding — see wrangler.jsonc). */
  async submitGuess(index: number, player: string, guess: string, userId: string | null): Promise<GuessResult> {
    const round = this.ctx.storage.sql
      .exec<RoundRow>("SELECT * FROM rounds WHERE idx = ?", index)
      .toArray()[0];
    if (!round || round.status !== "ready" || !round.prompt) {
      throw new Error("round not ready");
    }

    const correct = isGuessCorrect(guess, round.prompt);
    const score = correct ? scoreForGuess(round.ready_at) : null;

    this.ctx.storage.sql.exec(
      "INSERT INTO guesses (round_idx, player, guess, correct, created_at) VALUES (?, ?, ?, ?, ?)",
      index,
      player,
      guess,
      correct ? 1 : 0,
      Date.now(),
    );

    this.broadcast({ type: "guess", index, player, correct, score });

    if (score !== null && userId) {
      const game = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM game LIMIT 1").toArray()[0];
      if (game) await this.env.LEADERBOARD.recordScore({ userId, kind: "guess", sessionId: game.id, score });
    }

    return { correct, prompt: correct ? round.prompt : null, score };
  }

  async revealRound(index: number): Promise<string | null> {
    const round = this.ctx.storage.sql
      .exec<RoundRow>("SELECT * FROM rounds WHERE idx = ?", index)
      .toArray()[0];
    if (!round?.prompt) return null;
    this.broadcast({ type: "revealed", index, prompt: round.prompt });
    return round.prompt;
  }

  // --- WebSocket upgrade (DOs use fetch() for this, not RPC) --------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "state", ...this.readPublicState() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Clients are push-only observers; the one exception is a keepalive ping.
    if (typeof message === "string" && message === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  async webSocketClose(): Promise<void> {
    // No per-connection state to clean up; the runtime auto-replies to the
    // close frame at this compatibility date.
  }

  // --- internals -----------------------------------------------------------

  private readPublicState(): GamePublic {
    const game = this.ctx.storage.sql.exec<GameRow>("SELECT * FROM game LIMIT 1").toArray()[0];
    const rounds = this.ctx.storage.sql
      .exec<RoundRow>("SELECT * FROM rounds ORDER BY idx ASC")
      .toArray();

    return {
      id: game?.id ?? "",
      theme: game?.theme ?? null,
      status: game?.status ?? "queued",
      error: game?.error ?? undefined,
      rounds: rounds.map((r) => ({
        index: r.idx,
        status: r.status,
        error: r.error ?? undefined,
      })),
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

/** See GUESS_TIME_LIMIT_SECONDS: linear falloff from GUESS_MAX_SCORE at 0
 * elapsed to GUESS_MIN_SCORE at the limit or beyond. `readyAt` is only null
 * for a round created before this column existed; treated as "just became
 * ready" (max score) rather than throwing. */
function scoreForGuess(readyAt: number | null): number {
  const elapsedMs = Date.now() - (readyAt ?? Date.now());
  const limitMs = GUESS_TIME_LIMIT_SECONDS * 1000;
  const remainingMs = Math.max(0, limitMs - elapsedMs);
  return Math.max(GUESS_MIN_SCORE, Math.round((remainingMs / limitMs) * GUESS_MAX_SCORE));
}
