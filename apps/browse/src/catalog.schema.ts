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

/** `all` (the default) is every entry; `friends` restricts the list to
 * entries created by a friend of the signed-in viewer (never the viewer's
 * own entries) and requires being logged in — same shape as
 * apps/leaderboard's `LeaderboardScope`. */
export const CatalogScope = {
    All: "all",
    Friends: "friends",
} as const;
export type CatalogScope = (typeof CatalogScope)[keyof typeof CatalogScope];
export const CatalogScopeSchema = z.nativeEnum(CatalogScope).openapi("CatalogScope");

export const CatalogStatusSchema = z
    .nativeEnum(CatalogStatus)
    .openapi("CatalogStatus");

export const PlayStatusSchema = z
    .nativeEnum(PlayStatus)
    .openapi("PlayStatus");

export const CatalogSortSchema = z
    .nativeEnum(CatalogSort)
    .openapi("CatalogSort");

export const CatalogCreatorSchema = z
    .object({
        userId: z.string().nullable().openapi({description: "Null for an anonymous host"}),
        name: z.string(),
        color: z.string(),
    })
    .openapi("CatalogCreator");

export const CatalogEntrySchema = z
    .object({
        id: z.string(),
        kind: GameKindSchema,
        theme: z.string().nullable(),
        themeGenerated: z.boolean().openapi({
            description:
                "Whether `theme` was picked for this entry (a Flagship preset, or the prompt model's own idea) " +
                "rather than typed in by its creator — false until generation resolves a theme for an entry that " +
                "started with none.",
        }),
        thumbnailUrl: z.string().nullable(),
        playUrl: z.string(),
        playStatus: PlayStatusSchema,
        averageRating: z.number().nullable(),
        ratingCount: z.number().int().nonnegative(),
        createdAt: z.number().int().positive(),
        creator: CatalogCreatorSchema.nullable().openapi({description: "Null only for entries that predate creator tracking"}),
        replayOf: z.string().nullable().openapi({
            description: "Catalog id this entry was replayed from, one hop back; null if it wasn't a replay of anything",
        }),
        replayCount: z.number().int().nonnegative().openapi({
            description:
                "How many other instances (in either direction along the replay chain) currently represent this " +
                "same replay chain — this entry is always the newest of them, since listCatalog collapses a chain " +
                "down to a single card. 0 means this entry has never been replayed and isn't itself a replay.",
        }),
    })
    .openapi("CatalogEntry");

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
