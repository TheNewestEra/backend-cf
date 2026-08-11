import {z} from "@hono/zod-openapi";

export const ErrorSchema = z.object({error: z.string()}).openapi("Error");
export const OkSchema = z.object({ok: z.literal(true)}).openapi("Ok");
