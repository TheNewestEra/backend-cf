import {z} from "@hono/zod-openapi";

export const PuzzleStatusSchema = z
    .enum(["queued", "generating", "waiting", "playing", "solved", "timeout", "error"])
    .openapi("PuzzleStatus");

/** A joined player's public roster entry — just enough to render an avatar
 * list in the lobby/play page. No id/token here; those stay private to the
 * participant who owns them (see JoinResultSchema). Mirrors Guess the
 * Prompt's own participant roster entry. */
export const ParticipantPublicSchema = z
    .object({name: z.string(), color: z.string()})
    .openapi("Participant");

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
        participants: z.array(ParticipantPublicSchema).openapi({description: "Everyone who has joined, in join order"}),
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

export const ReplayResultSchema = z
    .object({
        puzzleId: z.string(),
        hostToken: z.string(),
    })
    .openapi("ReplayResult");
