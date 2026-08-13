import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {WorkerEntrypoint} from "cloudflare:workers";
import {createDb} from "./db/client";
import {leaderboardRoutes} from "./leaderboard.controller";
import {recordScore, type RecordScoreInput} from "./leaderboard.service";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", leaderboardRoutes);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Leaderboard Service API",
        version: "1.0.0",
        description:
            "Top-10 + own-score leaderboard, filterable by game and time window. `guess` and `puzzle` log " +
            "scoring events through the `LeaderboardService` RPC entrypoint exported below.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

/** RPC surface for the `guess` and `puzzle` Workers (bound via a `services`
 * entry with `entrypoint: "LeaderboardService"`) — called directly from
 * their Durable Objects (GameDO.submitGuess, PuzzleDO.swapTiles) right
 * after computing a score. */
export class LeaderboardService extends WorkerEntrypoint<Env> {
    recordScore(input: RecordScoreInput): Promise<void> {
        return recordScore(createDb(this.env.DB), input);
    }
}

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
