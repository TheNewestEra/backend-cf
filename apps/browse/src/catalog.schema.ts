import {z} from "@hono/zod-openapi";
import {GameKindSchema} from "@game-worker/shared/game";

export const CatalogStatus = {
    Generating: "generating",
    Ready: "ready",
    Error: "error",
} as const;
export type CatalogStatus = (typeof CatalogStatus)[keyof typeof CatalogStatus];

export const PlayStatus = {
    Joinable: "joinable",
    Active: "active",
    Finished: "finished",
} as const;
export type PlayStatus = (typeof PlayStatus)[keyof typeof PlayStatus];

export const CatalogSort = {
    Recent: "recent",
    Rating: "rating",
} as const;
export type CatalogSort = (typeof CatalogSort)[keyof typeof CatalogSort];

export const CatalogStatusSchema = z
    .nativeEnum(CatalogStatus)
    .openapi("CatalogStatus");

export const PlayStatusSchema = z
    .nativeEnum(PlayStatus)
    .openapi("PlayStatus");

export const CatalogSortSchema = z
    .nativeEnum(CatalogSort)
    .openapi("CatalogSort");

export const CatalogEntrySchema = z
    .object({
        id: z.string(),
        kind: GameKindSchema,
        theme: z.string().nullable(),
        thumbnailUrl: z.string().nullable(),
        playUrl: z.string(),
        playStatus: PlayStatusSchema,
        averageRating: z.number().nullable(),
        ratingCount: z.number().int().nonnegative(),
        createdAt: z.number().int().positive(),
    })
    .openapi("CatalogEntry");

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
