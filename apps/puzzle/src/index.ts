import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {WorkerEntrypoint} from "cloudflare:workers";
import {puzzleRoutes} from "./puzzle.controller";
import {PuzzleDO, type PuzzleStatus} from "./puzzle.model";
import {PuzzleWsClientMessageSchema, PuzzleWsMessageSchema} from "./puzzle.schema";
import {processPuzzle, type PuzzleQueueMessage} from "./puzzle.queue";

export {PuzzleDO};

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", puzzleRoutes);

app.openAPIRegistry.register("PuzzleWsMessage", PuzzleWsMessageSchema);
app.openAPIRegistry.register("PuzzleWsClientMessage", PuzzleWsClientMessageSchema);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Piece Puzzle Service API",
        version: "1.0.0",
        description:
            "Piece Puzzle: one AI-generated image, sliding-tile gameplay over a Durable Object per puzzle. " +
            "The WebSocket upgrade endpoint (`/puzzles/{id}/ws`) isn't representable in OpenAPI 3 and is " +
            "omitted from this spec, though it's a real, functioning route — joining, moving, and selecting " +
            "a tile are all sent as messages over it (there's no POST for any of them), and both directions' " +
            "message payloads are still registered as the `PuzzleWsMessage` (server→client) and " +
            "`PuzzleWsClientMessage` (client→server) components below, so the generated client has typed " +
            "models for them.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

/** RPC surface for the `friends` service (bound via a `services` entry with
 * `entrypoint: "PuzzleService"`) — used to gate direct invites to a puzzle's
 * lobby without giving `friends` a binding to this Worker's Durable Object
 * namespace directly. */
export class PuzzleService extends WorkerEntrypoint<Env> {
    async getLobbyStatus(puzzleId: string): Promise<{ status: PuzzleStatus }> {
        const state = await this.env.PUZZLE_DO.getByName(puzzleId).getState();
        return {status: state.status};
    }
}

export default {
    fetch: app.fetch,

    async queue(batch: MessageBatch<PuzzleQueueMessage>, env: Env): Promise<void> {
        await Promise.all(
            batch.messages.map(async (message) => {
                try {
                    await processPuzzle(message.body, env);
                    message.ack();
                } catch (err) {
                    console.error("puzzle generation failed", message.body.puzzleId, err);
                    const stub = env.PUZZLE_DO.getByName(message.body.puzzleId);
                    const reason = err instanceof Error ? err.message : String(err);
                    await Promise.all([
                        stub.setError(reason).catch((e) => {
                            console.error("failed to record puzzle error", message.body.puzzleId, e);
                        }),
                        env.BROWSE.markCatalogError(message.body.puzzleId).catch((e) => {
                            console.error("failed to record catalog error", message.body.puzzleId, e);
                        }),
                    ]);
                    message.retry();
                }
            }),
        );
    },
} satisfies ExportedHandler<Env, PuzzleQueueMessage>;
