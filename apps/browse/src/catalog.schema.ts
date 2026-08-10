import {z} from "@hono/zod-openapi";

/** 'joinable' — spectate *or* join in as a player (still generating, or a
 * Piece Puzzle lobby). 'active' — started; spectate only. 'finished' —
 * Piece Puzzle only; Guess the Prompt never leaves 'active' once ready. */
export const PlayStatusSchema = z.enum(["joinable", "active", "finished"]).openapi("PlayStatus");

export const CatalogEntrySchema = z
    .object({
        id: z.string(),
        kind: z.enum(["guess", "puzzle"]),
        theme: z.string().nullable(),
        thumbnailUrl: z.string().nullable(),
        playUrl: z.string(),
        playStatus: PlayStatusSchema,
        averageRating: z.number().nullable(),
        ratingCount: z.number(),
        createdAt: z.number(),
    })
    .openapi("CatalogEntry");
