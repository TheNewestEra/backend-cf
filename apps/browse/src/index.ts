import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {WorkerEntrypoint} from "cloudflare:workers";
import {browseRoutes} from "./catalog.controller";
import {
    type CatalogKind,
    insertCatalogEntry,
    markCatalogError,
    markCatalogGenerating,
    markCatalogReady,
} from "./catalog.service";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", browseRoutes);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Browse Service API",
        version: "1.0.0",
        description:
            "Cross-game catalog for the /browse page and post-session ratings. `guess` and `puzzle` write " +
            "generation progress through the `CatalogService` RPC entrypoint exported below.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

/** RPC surface for the `guess` and `puzzle` Workers (bound via a `services`
 * entry with `entrypoint: "CatalogService"`) — called once when a game/
 * puzzle is created, then again as its background generation progresses. */
export class CatalogService extends WorkerEntrypoint<Env> {
    insertCatalogEntry(id: string, kind: CatalogKind, theme: string | null): Promise<void> {
        return insertCatalogEntry(this.env.DB, id, kind, theme);
    }

    markCatalogGenerating(id: string): Promise<void> {
        return markCatalogGenerating(this.env.DB, id);
    }

    markCatalogReady(id: string, thumbnailKey: string): Promise<void> {
        return markCatalogReady(this.env.DB, id, thumbnailKey);
    }

    markCatalogError(id: string): Promise<void> {
        return markCatalogError(this.env.DB, id);
    }
}

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
