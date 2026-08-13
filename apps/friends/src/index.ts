import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {friendsRoutes} from "./friends.controller";

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

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
