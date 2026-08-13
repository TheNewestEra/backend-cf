import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {currentUser, logIn, logOut} from "./auth.middleware";
import {UserSchema} from "./account.schema";
import {createAccount, verifyCode} from "./account.service";
import {createDb} from "./db/client";

export const accountRoutes = new OpenAPIHono<{ Bindings: Env }>();

accountRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/me",
        tags: ["Account"],
        summary: "Get the current session's user, if any",
        responses: {
            200: {
                description: "The logged-in user, or null when there's no session",
                content: {"application/json": {schema: z.object({user: UserSchema.nullable()})}},
            },
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        return c.json({user});
    },
);

accountRoutes.openapi(
    createRoute({
        method: "post",
        path: "/account/register",
        tags: ["Account"],
        summary: "Create an account and log in",
        description: "Returns a one-time 6-digit login code — the only time it's ever available.",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({username: z.string().openapi({example: "ryan"})}),
                    },
                },
            },
        },
        responses: {
            200: {
                description: "Account created",
                content: {"application/json": {schema: z.object({user: UserSchema, code: z.string()})}},
            },
            400: {
                description: "Invalid or taken username",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {username} = c.req.valid("json");
        const result = await createAccount(createDb(c.env.DB), username);
        if (result.isErr()) return c.json({error: result.error}, 400);

        await logIn(c, result.value.user.id);
        return c.json({user: result.value.user, code: result.value.code}, 200);
    },
);

accountRoutes.openapi(
    createRoute({
        method: "post",
        path: "/account/login",
        tags: ["Account"],
        summary: "Log in with a username + login code",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({username: z.string(), code: z.string().openapi({example: "004821"})}),
                    },
                },
            },
        },
        responses: {
            200: {
                description: "Logged in",
                content: {"application/json": {schema: z.object({user: UserSchema})}},
            },
            401: {
                description: "Incorrect username or code",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const {username, code} = c.req.valid("json");
        const user = await verifyCode(createDb(c.env.DB), username, code);
        if (!user) return c.json({error: "Incorrect username or code."}, 401);

        await logIn(c, user.id);
        return c.json({user}, 200);
    },
);

accountRoutes.openapi(
    createRoute({
        method: "post",
        path: "/account/logout",
        tags: ["Account"],
        summary: "Log out and clear the session",
        responses: {
            200: {
                description: "Logged out",
                content: {"application/json": {schema: OkSchema}},
            },
        },
    }),
    async (c) => {
        await logOut(c);
        return c.json({ok: true as const}, 200);
    },
);
