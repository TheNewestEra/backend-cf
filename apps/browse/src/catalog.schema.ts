import {z} from "@hono/zod-openapi";

export const CatalogEntrySchema = z
    .object({
        id: z.string(),
        kind: z.enum(["guess", "puzzle"]),
        theme: z.string().nullable(),
        thumbnailUrl: z.string().nullable(),
        playUrl: z.string(),
        averageRating: z.number().nullable(),
        ratingCount: z.number(),
        createdAt: z.number(),
    })
    .openapi("CatalogEntry");
