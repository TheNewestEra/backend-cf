import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema} from "@game-worker/shared/common.schema";
import {CatalogEntrySchema} from "./catalog.schema";
import {listCatalog, submitRating} from "./catalog.service";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
const MAX_RATER_LENGTH = 40;

export const browseRoutes = new OpenAPIHono<{ Bindings: Env }>();

browseRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/catalog",
        tags: ["Browse"],
        summary: "List ready games/puzzles across all users",
        request: {
            query: z.object({
                kind: z.enum(["guess", "puzzle"]).optional().openapi({description: "Filter to one game type"}),
                sort: z.enum(["recent", "rating"]).optional().openapi({description: "Defaults to recent"}),
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
        const {kind, sort, limit, offset} = c.req.valid("query");
        const entries = await listCatalog(c.env.DB, {
            kind: kind ?? null,
            sort: sort ?? "recent",
            limit: clamp(limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT),
            offset: Math.max(0, offset ?? 0),
        });
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

        const result = await submitRating(c.env.DB, id, stars, rater?.trim().slice(0, MAX_RATER_LENGTH) || null);
        if (!result) return c.json({error: "not found"}, 404);
        return c.json(result, 200);
    },
);

function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
}
