import {z} from "@hono/zod-openapi";

export const PuzzlePublicSchema = z
    .object({
        id: z.string(),
        theme: z.string().nullable(),
        prompt: z.string().nullable(),
        status: z.enum(["queued", "generating", "waiting", "playing", "solved", "timeout", "error"]),
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
        status: z.enum(["queued", "generating", "waiting", "playing", "solved", "timeout", "error"]),
        board: z.array(z.number()),
        solved: z.boolean(),
        score: z.number().nullable(),
    })
    .openapi("MoveResult");
