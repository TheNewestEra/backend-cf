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

/** How an entry with a `replayOf` source relates to it — set by whichever
 * of guess/puzzle's two "start again" endpoints created the entry, and
 * carried straight through `insertCatalogEntry`. `Replay` reuses the
 * source's exact image/rounds (POST .../replay), so it's genuinely the
 * same content and `listCatalog` folds it into the source's existing
 * family card. `Regenerate` re-runs generation for a fresh image/rounds
 * off the same theme (POST .../regenerate) — since that can (and often
 * does) produce a different image, collapsing it into the source's card
 * would hide a distinct thumbnail behind whichever one happened to be
 * newest, so it starts its own family instead (see catalog.service.ts's
 * `insertCatalogEntry`, which only inherits the source's `rootId` for
 * `Replay`). Null for an entry with no `replayOf` source at all. */
export const ReplayKind = {
    Replay: "replay",
    Regenerate: "regenerate",
} as const;
export type ReplayKind = (typeof ReplayKind)[keyof typeof ReplayKind];
export const ReplayKindSchema = z.nativeEnum(ReplayKind).openapi("ReplayKind");

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
        averageRating: z
            .number()
            .nullable()
            .openapi({description: "Mean of every 1-5 star rating across this entry's whole replay chain, rounded to the nearest half star; null until it has at least one rating"}),
        ratingCount: z.number().int().nonnegative(),
        createdAt: z.number().int().positive(),
        creator: CatalogCreatorSchema.nullable().openapi({description: "Null only for entries that predate creator tracking"}),
        replayOf: z.string().nullable().openapi({
            description: "Catalog id this entry was replayed or regenerated from, one hop back; null if it wasn't created from another entry",
        }),
        replayKind: ReplayKindSchema.nullable().openapi({
            description: "Whether `replayOf` names a same-image replay or a freshly-regenerated source; null when `replayOf` is null",
        }),
        replayCount: z.number().int().nonnegative().openapi({
            description:
                "How many other instances (in either direction along the chain) currently represent this same " +
                "replay chain — this entry is always the newest of them, since listCatalog collapses a chain of " +
                "true replays down to a single card. A regenerate always starts a new chain of its own rather than " +
                "extending this count, since it can produce a different image. 0 means this entry has never been " +
                "replayed and isn't itself a replay.",
        }),
    })
    .openapi("CatalogEntry");

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
