import {z} from "@hono/zod-openapi";

export const UserSchema = z
    .object({id: z.string(), username: z.string(), color: z.string().openapi({example: "#4f9d69"})})
    .openapi("User");
