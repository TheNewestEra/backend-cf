// Queue consumer for `game-generation`: generates a guess-the-prompt
// game's rounds (prompt + image each) off the request path. Enqueued by
// `POST /games` (see guess.controller.ts); dispatched here from the
// Worker's `queue()` handler in index.ts.

import {generateImage, generateRoundPrompts} from "@game-worker/shared/ai";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {imageKeyFor} from "./guess.constants";
import {RoundStatus} from "./guess.schema";

export interface GuessQueueMessage {
    gameId: string;
    theme: string | null;
    // Whether `theme` (once resolved) should be recorded as picked-for-this-
    // game rather than typed in — always the enqueuing caller's own call,
    // never re-derived here from `theme === null`, since `theme` is
    // non-null on *both* a normal user-given creation and a regenerate
    // enqueue (which seeds a brand-new instance from a finished game's own
    // theme, auto-generated or not — see guess.controller.ts's
    // `/regenerate`, which carries the source's `themeGenerated` straight
    // through rather than re-deriving it).
    themeGenerated: boolean;
}

export async function processGuessGame(message: GuessQueueMessage, env: Env): Promise<void> {
    const {gameId, theme, themeGenerated} = message;
    const stub = env.GAME_DO.getByName(gameId);

    await stub.setStatus(GameSessionStatus.Generating);
    await env.BROWSE.markCatalogGenerating(gameId);
    // How many rounds this particular game has was already resolved (from
    // Flagship's "round-count" flag) and committed by GameDO.init(), which
    // always runs before this message is even enqueued — read it back off
    // the game's own state rather than re-reading the flag here, so a flag
    // flip mid-generation can't leave the row count `init()` already
    // created and the number of prompts/images generated here disagreeing
    // with each other. See roundCount() in guess.constants.ts.
    const roundCount = (await stub.getState()).rounds.length;
    // Unwrapped right here rather than propagated further — this queue
    // consumer's caller (index.ts's `queue()` handler) still drives its
    // retry off a thrown/rejected promise, same as before
    // generateRoundPrompts() started returning a `Result` (see that
    // function's own doc comment in @game-worker/shared/ai). `resolvedTheme`
    // is `theme` itself when given, otherwise whatever the model settled on
    // (a Flagship preset, or its own idea) — see `setPrompts()`'s own doc
    // comment for why it's persisted right alongside the prompts it produced.
    const {theme: resolvedTheme, prompts} = (
        await generateRoundPrompts(env.AI, env.FLAGS, theme, roundCount)
    ).match(
        (value) => value,
        (error) => {
            throw new Error(error);
        },
    );
    await Promise.all([
        stub.setPrompts(prompts, resolvedTheme, themeGenerated),
        env.BROWSE.updateCatalogTheme(gameId, resolvedTheme, themeGenerated),
    ]);

    // Still `generating` — per-round progress from here on is visible via
    // each round's own pending/generating/ready/error status instead of a
    // second top-level phase (mirrors Piece Puzzle's single `generating`).
    const results = await Promise.allSettled(
        prompts.map((prompt, index) => generateAndStoreImage(env, gameId, index, prompt)),
    );

    const failures = results.filter((r) => r.status === "rejected").length;
    if (failures === 0) {
        // Opens the waiting room rather than starting instantly — see
        // guess.model.ts's `setReady()`. `playStatus` stays `joinable`
        // (its default since creation) until the lobby actually ends and
        // play begins; that transition to `active` now lives in
        // `GameDO.beginPlaying()` itself, same as Piece Puzzle, since it's
        // a live-gameplay transition (host "start now" or the lobby alarm)
        // rather than a generation one.
        await stub.setReady();
        // Round 0 always exists when there are no failures, so it's a safe thumbnail.
        await env.BROWSE.markCatalogReady(gameId, imageKeyFor(gameId, 0));
    } else {
        await stub.setStatus(
            GameSessionStatus.Error,
            `${failures} of ${roundCount} images failed to generate. Start a new game to try again.`,
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
    await stub.setRoundStatus(index, RoundStatus.Generating);
    try {
        const stream = await generateImage(env.AI, env.FLAGS, prompt);
        const key = imageKeyFor(gameId, index);
        await env.IMAGES.put(key, stream, {httpMetadata: {contentType: "image/png"}});
        await stub.setRoundImage(index, key);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await stub.setRoundStatus(index, RoundStatus.Error, message);
        throw err;
    }
}
