// Zod schemas shared by more than one service's controller — kept separate
// from each service's own *.schema.ts files so shapes that genuinely cross
// service boundaries have exactly one definition instead of being
// redeclared per router. Domain-specific schemas (User, Game, Puzzle, ...)
// live with their owning service instead.

import {z} from "@hono/zod-openapi";

export const ErrorSchema = z.object({error: z.string()}).openapi("Error");
export const OkSchema = z.object({ok: z.literal(true)}).openapi("Ok");
