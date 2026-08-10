import {z} from "@hono/zod-openapi";

export const PuzzleStatusSchema = z
    .enum(["queued", "generating", "waiting", "playing", "solved", "timeout", "error"])
    .openapi("PuzzleStatus");

export const PuzzlePublicSchema = z
    .object({
        id: z.string(),
        theme: z.string().nullable(),
        prompt: z.string().nullable(),
        status: PuzzleStatusSchema,
        error: z.string().optional(),
        gridSize: z.number(),
        board: z.array(z.number()),
        timeLimitMs: z.number(),
        startedAt: z.number().nullable(),
        remainingMs: z.number().nullable(),
        lobbyRemainingMs: z.number().nullable(),
        endedAt: z.number().nullable(),
        score: z.number().nullable(),
        solvedBy: z.string().nullable(),
        connectedPlayers: z.number(),
    })
    .openapi("Puzzle");

export const MoveResultSchema = z
    .object({
        status: PuzzleStatusSchema,
        board: z.array(z.number()),
        solved: z.boolean(),
        score: z.number().nullable(),
    })
    .openapi("MoveResult");

/** `token` is only present for anonymous guests — it's the bearer secret
 * they must resend with every move (see puzzle.model.ts's
 * `requireParticipant`). Logged-in players are re-identified by their
 * session on every request instead, so `token` is null for them. */
export const JoinResultSchema = z
    .object({
        participantId: z.string(),
        token: z.string().nullable(),
    })
    .openapi("JoinResult");

export const ReplayResultSchema = z
    .object({
        puzzleId: z.string(),
        hostToken: z.string(),
    })
    .openapi("ReplayResult");
