import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {guessRoutes} from "./guess.controller";
import {GameDO} from "./guess.model";
import {type GuessQueueMessage, processGuessGame} from "./guess.queue";

export {GameDO};

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", guessRoutes);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Guess the Prompt Service API",
        version: "1.0.0",
        description:
            "Guess the Prompt: 5 AI-generated image rounds per game, players guess the prompt behind each. The " +
            "WebSocket upgrade endpoint (`/games/{id}/ws`) and the raw image endpoint " +
            "(`/games/{id}/images/{index}`) aren't representable in OpenAPI 3 and are omitted from this spec, " +
            "though they're real, functioning routes.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

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
