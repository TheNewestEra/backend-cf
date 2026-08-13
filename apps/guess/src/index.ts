import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {WorkerEntrypoint} from "cloudflare:workers";
import {guessRoutes} from "./guess.controller";
import GameDO, {type GameStatus} from "./guess.model";
import {GameWsClientMessageSchema, GameWsMessageSchema} from "./guess.schema";
import {type GuessQueueMessage, processGuessGame} from "./guess.queue";

export {GameDO};

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", guessRoutes);

app.openAPIRegistry.register("GameWsMessage", GameWsMessageSchema);
app.openAPIRegistry.register("GameWsClientMessage", GameWsClientMessageSchema);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Guess the Prompt Service API",
        version: "1.0.0",
        description:
            "Guess the Prompt: 5 AI-generated image rounds per game, players guess the prompt behind each. The " +
            "WebSocket upgrade endpoint (`/games/{id}/ws`) isn't representable in OpenAPI 3 and is omitted from " +
            "this spec, though it's a real, functioning route — joining, guessing, and revealing are all sent as " +
            "messages over it (there's no POST for any of them), and both directions' message payloads are still " +
            "registered as the `GameWsMessage` (server→client) and `GameWsClientMessage` (client→server) " +
            "components below, so the generated client has typed models for them.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

/** RPC surface for the `friends` service (bound via a `services` entry with
 * `entrypoint: "GuessService"`) — used to gate direct invites to a game
 * once its rounds are no longer joinable, without giving `friends` a
 * binding to this Worker's Durable Object namespace directly. Mirrors
 * `apps/puzzle`'s `PuzzleService.getLobbyStatus`. */
export class GuessService extends WorkerEntrypoint<Env> {
    async getStatus(gameId: string): Promise<{ status: GameStatus }> {
        const state = await this.env.GAME_DO.getByName(gameId).getState();
        return {status: state.status};
    }

    async joinAsUser(
        gameId: string,
        userId: string,
        username: string,
        color: string,
    ): ReturnType<GameDO["join"]> {
        return this.env.GAME_DO.getByName(gameId).join(userId, username, color, null);
    }
}

export default {
    fetch: app.fetch,

    async queue(batch: MessageBatch<GuessQueueMessage>, env: Env): Promise<void> {
        // Each message is an independent game, so let them generate
        // concurrently rather than one at a time.
        await Promise.all(
            batch.messages.map(async (message) => {
                try {
                    await processGuessGame(message.body, env);
                    message.ack();
                } catch (err) {
                    console.error("guess game generation failed", message.body.gameId, err);
                    const stub = env.GAME_DO.getByName(message.body.gameId);
                    const reason = err instanceof Error ? err.message : String(err);
                    await Promise.all([
                        stub.setStatus("error", reason).catch((e) => {
                            console.error("failed to record game error", message.body.gameId, e);
                        }),
                        env.BROWSE.markCatalogError(message.body.gameId).catch((e) => {
                            console.error("failed to record catalog error", message.body.gameId, e);
                        }),
                    ]);
                    message.retry();
                }
            }),
        );
    },
} satisfies ExportedHandler<Env, GuessQueueMessage>;
