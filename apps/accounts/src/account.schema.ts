import {z} from "@hono/zod-openapi";

export const UserSchema = z
    .object({id: z.string(), username: z.string()})
    .openapi("User");
