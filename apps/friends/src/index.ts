import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {friendsRoutes} from "./friends.controller";
import {UserDO} from "./notifications.model";

export {UserDO};

const app = new OpenAPIHono<{ Bindings: Env }>();

app.route("/", friendsRoutes);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Friends Service API",
        version: "1.0.0",
        description:
            "Friends, groups, and game invites. The notifications WebSocket upgrade endpoint " +
            "(`/api/notifications/ws`) isn't representable in OpenAPI 3 and is omitted from this spec, though " +
            "it's a real, functioning route.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
