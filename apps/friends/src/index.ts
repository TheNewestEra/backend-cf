import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {WorkerEntrypoint} from "cloudflare:workers";
import {createDb} from "./db/client";
import {friendsRoutes} from "./friends.controller";
import {friendIds} from "./friends.service";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", friendsRoutes);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Friends Service API",
        version: "1.0.0",
        description:
            "Friends, groups, and game invites. Real-time invite delivery is not a route here at all — see " +
            "apps/notifications, which every service (this one included) pushes user-facing messages through.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

/** RPC surface for other Workers that need a user's friend list without
 * reading `friendships` directly — `leaderboard` (scope=friends) and
 * `browse` (created-by-friends filter) both call this instead of the
 * cross-app table read they used before it existed. */
export class FriendsService extends WorkerEntrypoint<Env> {
    getFriendIds(userId: string): Promise<string[]> {
        return friendIds(createDb(this.env.DB), userId);
    }
}

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
