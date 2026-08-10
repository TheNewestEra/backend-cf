import { z } from "@hono/zod-openapi";

export const RoundPublicSchema = z
  .object({
    index: z.number(),
    status: z.enum(["pending", "generating", "ready", "error"]),
    error: z.string().optional(),
  })
  .openapi("Round");

export const GamePublicSchema = z
  .object({
    id: z.string(),
    theme: z.string().nullable(),
    status: z.enum(["queued", "generating_prompts", "generating_images", "ready", "error"]),
    error: z.string().optional(),
    rounds: z.array(RoundPublicSchema),
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
 * session on every request instead, so `token` is null for them. */
export const JoinResultSchema = z
  .object({
    participantId: z.string(),
    token: z.string().nullable(),
  })
  .openapi("JoinResult");
