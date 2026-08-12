import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {WorkerEntrypoint} from "cloudflare:workers";
import {accountRoutes} from "./account.controller";
import {
    createSession,
    deleteSession,
    findUserByUsername,
    getUserById,
    getUserBySession,
    type UserRecord
} from "./account.service";
import {createDb} from "./db/client";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", accountRoutes);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Accounts Service API",
        version: "1.0.0",
        description:
            "Owns local accounts (username + hashed login code) and sessions. Other services reach this data " +
            "through the `AccountsService` RPC entrypoint exported below, not by binding this Worker's D1 database.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

/** RPC surface for other Workers (bound via a `services` entry with
 * `entrypoint: "AccountsService"`). Thin wrappers around account.service.ts
 * — the same functions this Worker's own HTTP routes use — so the two never
 * drift apart. See @game-worker/shared/session for the client-side helpers
 * that call `getUserBySession`/`createSession`/`deleteSession` from another
 * service's `auth.middleware.ts`. */
export class AccountsService extends WorkerEntrypoint<Env> {
    getUserBySession(token: string): Promise<UserRecord | null> {
        return getUserBySession(createDb(this.env.DB), token);
    }

    createSession(userId: string): Promise<string> {
        return createSession(createDb(this.env.DB), userId);
    }

    deleteSession(token: string): Promise<void> {
        return deleteSession(createDb(this.env.DB), token);
    }

    findUserByUsername(username: string): Promise<UserRecord | null> {
        return findUserByUsername(createDb(this.env.DB), username);
    }

    getUserById(id: string): Promise<UserRecord | null> {
        return getUserById(createDb(this.env.DB), id);
    }
}

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
