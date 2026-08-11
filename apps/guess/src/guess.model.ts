import { DurableObject } from "cloudflare:workers";
import type { z } from "@hono/zod-openapi";
import { generateColor } from "@game-worker/shared/color";
import { lobbyEndsAt, lobbyRemainingMs } from "@game-worker/shared/lobby";
import { isGuessCorrect } from "./guess-matching";
import type { GamePublicSchema, GuessResultSchema, RoundPublicSchema } from "./guess.schema";
import { GUESS_MAX_SCORE, GUESS_MIN_SCORE, ROUND_COUNT, guessTimeLimitSeconds } from "./guess.constants";

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
const JOINABLE_STATUSES: readonly GameStatus[] = ["queued", "generating", "waiting"];

/**
 * One instance per game (routed via `env.GAME_DO.getByName(gameId)`).
 * Owns the game's durable state (prompts, round/image status, guesses) and
 * pushes live progress to every connected WebSocket as the queue consumer
 * calls its RPC methods.
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

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS game (
        id TEXT PRIMARY KEY,
        theme TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        host_token TEXT NOT NULL DEFAULT '',
        lobby_ends_at INTEGER,
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
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_id TEXT,
        token TEXT,
        color TEXT NOT NULL DEFAULT '#888888',
        joined_at INTEGER NOT NULL
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
    ]) {
      try {
        this.ctx.storage.sql.exec(stmt);
      } catch {
        // Column already exists on this instance — nothing to do.
      }
    }
  }

  // --- RPC: create a brand new game's state (never called twice for the
  // same id — /replay always targets a fresh, independent gameId) --------

  async init(gameId: string, theme: string | null): Promise<string> {
    await this.ctx.storage.deleteAlarm();
    const hostToken = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM guesses");
    this.ctx.storage.sql.exec("DELETE FROM rounds");
    this.ctx.storage.sql.exec("DELETE FROM participants");
    this.ctx.storage.sql.exec(
      `INSERT INTO game (id, theme, status, error, host_token, lobby_ends_at, created_at)
       VALUES (?, ?, 'queued', NULL, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
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
    this.broadcast({ type: "state", ...this.readPublicState() });
    return hostToken;
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

  /** Every round's image is ready — open the waiting room rather than
   * starting instantly, so players can gather (see the class doc comment).
   * Mirrors `PuzzleDO.setReady()`. */
  async setReady(): Promise<void> {
    const endsAt = lobbyEndsAt(Date.now());
    this.ctx.storage.sql.exec(
      "UPDATE game SET status = 'waiting', error = NULL, lobby_ends_at = ?",
      endsAt,
    );
    await this.ctx.storage.setAlarm(endsAt);
    this.broadcast({ type: "state", ...this.readPublicState() });
  }

  // --- RPC: host-only lobby action ----------------------------------------

  /** Ends the lobby countdown immediately and starts play. Mirrors
   * `PuzzleDO.startNow()`. */
  async startNow(hostToken: string): Promise<void> {
    const row = this.requireGameRow();
    this.assertHost(row, hostToken);
    if (row.status !== "waiting") throw new Error("game is not waiting to start");
    await this.beginPlaying(row.id);
  }

  // --- RPC: joining --------------------------------------------------------

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
        `INSERT INTO participants (id, name, user_id, token, color, joined_at) VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color`,
        userId,
        playerName,
        userId,
        color,
        Date.now(),
      );
      this.broadcast({ type: "player_joined", name: playerName, color });
      return { participantId: userId, token: null, color };
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
    this.broadcast({ type: "player_joined", name: playerName, color });
    return { participantId, token, color };
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
    return { name: row.name, color: row.color };
  }

  // --- RPC: player interaction --------------------------------------------

  /** `userId` is null for anonymous guests — their guesses still count in
   * this game's own state, they just aren't logged to the leaderboard
   * (recorded via the LEADERBOARD service binding — see wrangler.jsonc).
   * `participantId`/`token` prove the caller joined before the game
   * started — see `join()` and `requireParticipant()`. */
  async submitGuess(
    index: number,
    participantId: string,
    token: string | null,
    guess: string,
    userId: string | null,
  ): Promise<GuessResult> {
    const participant = this.requireParticipant(participantId, token, userId);

    const round = this.ctx.storage.sql
      .exec<RoundRow>("SELECT * FROM rounds WHERE idx = ?", index)
      .toArray()[0];
    if (!round || round.status !== "ready" || !round.prompt) {
      throw new Error("round not ready");
    }

    const correct = isGuessCorrect(guess, round.prompt);
    const score = correct ? scoreForGuess(round.ready_at, await guessTimeLimitSeconds(this.env)) : null;

    this.ctx.storage.sql.exec(
      "INSERT INTO guesses (round_idx, player, guess, correct, created_at) VALUES (?, ?, ?, ?, ?)",
      index,
      participant.name,
      guess,
      correct ? 1 : 0,
      Date.now(),
    );

    this.broadcast({
      type: "guess",
      index,
      player: participant.name,
      color: participant.color,
      correct,
      score,
    });

    if (score !== null && userId) {
      const game = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM game LIMIT 1").toArray()[0];
      if (game) await this.env.LEADERBOARD.recordScore({ userId, kind: "guess", sessionId: game.id, score });
    }

    return { correct, prompt: correct ? round.prompt : null, score };
  }

  async revealRound(index: number, participantId: string, token: string | null, userId: string | null): Promise<string | null> {
    const participant = this.requireParticipant(participantId, token, userId);

    const round = this.ctx.storage.sql
      .exec<RoundRow>("SELECT * FROM rounds WHERE idx = ?", index)
      .toArray()[0];
    if (!round?.prompt) return null;
    this.broadcast({ type: "revealed", index, prompt: round.prompt, player: participant.name, color: participant.color });
    return round.prompt;
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
    this.broadcast({ type: "player_typing", index, player: row.name, color: row.color });
  }

  // --- alarm: drives the lobby's auto-start -------------------------------

  async alarm(): Promise<void> {
    const row = this.requireGameRow();
    if (row.status === "waiting") {
      await this.beginPlaying(row.id);
    }
    // Any other status means the game moved on (error, etc.) before this
    // stale alarm fired — nothing to do.
  }

  // --- WebSocket upgrade (DOs use fetch() for this, not RPC) --------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "state", ...this.readPublicState() }));
    // Let every other connected client know the spectator/player count
    // changed — mirrors PuzzleDO's presence broadcast.
    this.broadcast({ type: "presence", connectedPlayers: this.ctx.getWebSockets().length });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    // Anything else must be a small JSON envelope — currently only
    // "typing" (see broadcastTyping()). Malformed/unknown messages are
    // ignored rather than closing the socket, since clients are otherwise
    // push-only observers and a stray message shouldn't be fatal.
    try {
      const parsed = JSON.parse(message) as { type?: string; index?: number; participantId?: string; token?: string };
      if (parsed.type === "typing" && typeof parsed.index === "number" && typeof parsed.participantId === "string") {
        this.broadcastTyping(parsed.index, parsed.participantId, parsed.token ?? null);
      }
    } catch {
      // Not JSON — ignore.
    }
  }

  async webSocketClose(): Promise<void> {
    // -1 because this handler runs before the closing socket drops out of
    // getWebSockets() on some runtimes; broadcasting a stale +1 count is
    // more confusing than a same-tick undercount that self-corrects on the
    // next presence event. Mirrors PuzzleDO's webSocketClose.
    this.broadcast({ type: "presence", connectedPlayers: Math.max(0, this.ctx.getWebSockets().length - 1) });
  }

  // --- internals -----------------------------------------------------------

  /** Shared by the host's "start now" and the lobby alarm's auto-start.
   * Mirrors `PuzzleDO.beginPlaying()`. */
  private async beginPlaying(gameId: string): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.sql.exec("UPDATE game SET status = 'playing', lobby_ends_at = NULL");
    this.broadcast({ type: "state", ...this.readPublicState() });
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
      lobbyRemainingMs: game ? lobbyRemainingMs(game.lobby_ends_at) : null,
      connectedPlayers: this.ctx.getWebSockets().length,
      participants: participants.map((p) => ({ name: p.name, color: p.color })),
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

/** See guessTimeLimitSeconds(): linear falloff from GUESS_MAX_SCORE at 0
 * elapsed to GUESS_MIN_SCORE at the limit or beyond. `readyAt` is only null
 * for a round created before this column existed; treated as "just became
 * ready" (max score) rather than throwing. */
function scoreForGuess(readyAt: number | null, limitSeconds: number): number {
  const elapsedMs = Date.now() - (readyAt ?? Date.now());
  const limitMs = limitSeconds * 1000;
  const remainingMs = Math.max(0, limitMs - elapsedMs);
  return Math.max(GUESS_MIN_SCORE, Math.round((remainingMs / limitMs) * GUESS_MAX_SCORE));
}
