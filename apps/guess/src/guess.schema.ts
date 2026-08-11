import { z } from "@hono/zod-openapi";

export const RoundPublicSchema = z
  .object({
    index: z.number(),
    status: z.enum(["pending", "generating", "ready", "error"]),
    error: z.string().optional(),
  })
  .openapi("Round");

/** A joined player's public roster entry — just enough to render an avatar
 * list in the lobby/play page. No id/token here; those stay private to the
 * participant who owns them (see JoinResultSchema). Mirrors Piece Puzzle's
 * own participant roster entry. */
export const ParticipantPublicSchema = z
  .object({ name: z.string(), color: z.string() })
  .openapi("Participant");

export const GamePublicSchema = z
  .object({
    id: z.string(),
    theme: z.string().nullable(),
    status: z.enum(["queued", "generating", "waiting", "playing", "error"]),
    error: z.string().optional(),
    rounds: z.array(RoundPublicSchema),
    lobbyRemainingMs: z
      .number()
      .nullable()
      .openapi({ description: "ms left in the waiting room; null outside the `waiting` status" }),
    connectedPlayers: z.number().openapi({ description: "Live WebSocket connection count (players + spectators)" }),
    participants: z.array(ParticipantPublicSchema).openapi({ description: "Everyone who has joined, in join order" }),
  })
  .openapi("Game");

export const GuessResultSchema = z
  .object({
    correct: z.boolean(),
    prompt: z.string().nullable(),
    score: z.number().nullable().openapi({ description: "Time-weighted points earned; null when the guess was wrong" }),
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
