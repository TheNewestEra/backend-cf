// Queue consumer for `game-generation`: generates a guess-the-prompt
// game's rounds (prompt + image each) off the request path. Enqueued by
// `POST /games` (see guess.controller.ts); dispatched here from the
// Worker's `queue()` handler in index.ts.

import {generateImage, generateRoundPrompts} from "@game-worker/shared/ai";
import {imageKeyFor, ROUND_COUNT} from "./guess.constants";

export interface GuessQueueMessage {
    gameId: string;
    theme: string | null;
}

export async function processGuessGame(message: GuessQueueMessage, env: Env): Promise<void> {
    const {gameId, theme} = message;
    const stub = env.GAME_DO.getByName(gameId);

    await stub.setStatus("generating_prompts");
    await env.BROWSE.markCatalogGenerating(gameId);
    const prompts = await generateRoundPrompts(env.AI, theme, ROUND_COUNT);
    await stub.setPrompts(prompts);

    await stub.setStatus("generating_images");
    const results = await Promise.allSettled(
        prompts.map((prompt, index) => generateAndStoreImage(env, gameId, index, prompt)),
    );

    const failures = results.filter((r) => r.status === "rejected").length;
    if (failures === 0) {
        await stub.setStatus("ready");
        // Round 0 always exists when there are no failures, so it's a safe thumbnail.
        await env.BROWSE.markCatalogReady(gameId, imageKeyFor(gameId, 0));
        // Distinct write from markCatalogReady — see updatePlayStatus's own
        // doc comment. Guess the Prompt has no further transition after
        // this: it's `active` (spectate-only, join() now rejects) for good.
        // `.catch()`'d so a transient BROWSE hiccup never turns into a
        // pointless retry of AI generation that already succeeded.
        await env.BROWSE.updatePlayStatus(gameId, "active").catch((err) => {
            console.error("failed to update catalog play status", gameId, err);
        });
    } else {
        await stub.setStatus(
            "error",
            `${failures} of ${ROUND_COUNT} images failed to generate. Start a new game to try again.`,
        );
        await env.BROWSE.markCatalogError(gameId);
    }
}

async function generateAndStoreImage(
    env: Env,
    gameId: string,
    index: number,
    prompt: string,
): Promise<void> {
    const stub = env.GAME_DO.getByName(gameId);
    await stub.setRoundStatus(index, "generating");
    try {
        const stream = await generateImage(env.AI, prompt);
        const key = imageKeyFor(gameId, index);
        await env.IMAGES.put(key, stream, {httpMetadata: {contentType: "image/png"}});
        await stub.setRoundImage(index, key);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stub.setRoundStatus(index, "error", message);
        throw err;
    }
}
