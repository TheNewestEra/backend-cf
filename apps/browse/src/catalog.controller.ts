import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema} from "@game-worker/shared/common.schema";
import {GameKindSchema} from "@game-worker/shared/game";
import {immutableImageResponse} from "@game-worker/shared/images";
import {CatalogEntrySchema, CatalogSort, CatalogSortSchema, PlayStatusSchema,} from "./catalog.schema";
import {getThumbnailKey, listCatalog, submitRating} from "./catalog.service";
import {createDb} from "./db/client";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
const MAX_RATER_LENGTH = 40;

export const browseRoutes = new OpenAPIHono<{ Bindings: Env }>();

browseRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/catalog",
        tags: ["Browse"],
        summary: "List games/puzzles across all users",
        description:
            "Without `playStatus`, this is the plain browse gallery: only entries with a generated thumbnail " +
            "(unchanged from before `playStatus` existed). Pass `playStatus=joinable` for open lobbies/still-" +
            "generating games you can join as a player, or `playStatus=active` for started games/puzzles you " +
            "can only spectate — both also include entries with no thumbnail yet.",
        request: {
            query: z.object({
                kind: GameKindSchema.optional().openapi({description: "Filter to one game type"}),
                sort: CatalogSortSchema.optional().openapi({description: `Defaults to ${CatalogSort.Recent}`}),
                playStatus: PlayStatusSchema.optional().openapi({
                    description: "Filter to what's joinable, in progress, or finished right now",
                }),
                limit: z.coerce.number().optional().openapi({description: `1-${MAX_LIMIT}, defaults to ${DEFAULT_LIMIT}`}),
                offset: z.coerce.number().optional(),
            }),
        },
        responses: {
            200: {
                description: "Catalog page",
                content: {"application/json": {schema: z.object({entries: z.array(CatalogEntrySchema)})}},
            },
        },
    }),
    async (c) => {
        const {kind, sort, playStatus, limit, offset} = c.req.valid("query");
        const origin = new URL(c.req.url).origin;

        const entries = await listCatalog(
            createDb(c.env.DB),
            {
                kind: kind ?? null,
                sort: sort ?? CatalogSort.Recent,
                playStatus: playStatus ?? null,
                limit: clamp(limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT),
                offset: Math.max(0, offset ?? 0),
            },
            origin
        );
        return c.json({entries}, 200);
    },
);

browseRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/catalog/{id}/rate",
        tags: ["Browse"],
        summary: "Rate a catalog entry 1-5 stars",
        request: {
            params: z.object({id: z.string()}),
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            stars: z.number().int().min(1).max(5),
                            rater: z.string().max(MAX_RATER_LENGTH).optional(),
                        }),
                    },
                },
            },
        },
        responses: {
            200: {
                description: "Updated rating",
                content: {"application/json": {schema: z.object({average: z.number(), count: z.number()})}},
            },
            404: {
                description: "No catalog entry with that id",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const {stars, rater} = c.req.valid("json");

        const result = await submitRating(createDb(c.env.DB), id, stars, rater?.trim().slice(0, MAX_RATER_LENGTH) || null);
        if (result.isErr()) return c.json({error: result.error}, 404);
        return c.json(result.value, 200);
    },
);

browseRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/catalog/{id}/thumbnail",
        tags: ["Browse"],
        summary: "Get a catalog entry's thumbnail image",
        description:
            "Raw image bytes, not JSON — the same image a `CatalogEntry.thumbnailUrl` points at once the entry " +
            "is `ready`. Served straight out of the `IMAGES` bucket `guess`/`puzzle` write to (this Worker only " +
            "reads it), keyed off the `thumbnail_key` recorded via the `CatalogService` RPC. Immutable/long-" +
            "cached once served, since an entry's thumbnail never changes in place.",
        request: {params: z.object({id: z.string()})},
        responses: {
            200: {
                description: "Thumbnail image",
                content: {"image/png": {schema: z.string().openapi({format: "binary"})}},
            },
            404: {description: "No such catalog entry, or it hasn't generated a thumbnail yet"},
        },
    }),
    async (c) => {
        const {id} = c.req.valid("param");
        const key = await getThumbnailKey(createDb(c.env.DB), id);
        if (!key) return c.notFound();

        const object = await c.env.IMAGES.get(key);
        if (!object) return c.notFound();

        return immutableImageResponse(object);
    },
);

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
