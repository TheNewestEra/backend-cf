import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {type GameKind} from "@game-worker/shared/game";
import {WorkerEntrypoint} from "cloudflare:workers";
import {browseRoutes} from "./catalog.controller";
import {type PlayStatus} from "./catalog.schema";
import {
    insertCatalogEntry,
    markCatalogError,
    markCatalogGenerating,
    markCatalogReady,
    updatePlayStatus,
} from "./catalog.service";
import {createDb} from "./db/client";
import {D1Response} from "@cloudflare/workers-types";

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

export class CatalogService extends WorkerEntrypoint<Env> {
    insertCatalogEntry(id: string, kind: GameKind, theme: string | null): Promise<D1Response> {
        return insertCatalogEntry(createDb(this.env.DB), id, kind, theme);
    }

    markCatalogGenerating(id: string): Promise<D1Response> {
        return markCatalogGenerating(createDb(this.env.DB), id);
    }

    markCatalogReady(id: string, thumbnailKey: string): Promise<D1Response> {
        return markCatalogReady(createDb(this.env.DB), id, thumbnailKey);
    }

    markCatalogError(id: string): Promise<D1Response> {
        return markCatalogError(createDb(this.env.DB), id);
    }

    updatePlayStatus(id: string, playStatus: PlayStatus): Promise<D1Response> {
        return updatePlayStatus(createDb(this.env.DB), id, playStatus);
    }
}

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
