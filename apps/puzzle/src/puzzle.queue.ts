import {generateImage, generateImagePrompt} from "@game-worker/shared/ai";
import {puzzleImageKeyFor} from "./puzzle.constants";

export interface PuzzleQueueMessage {
    puzzleId: string;
    theme: string | null;
}

export async function processPuzzle(message: PuzzleQueueMessage, env: Env): Promise<void> {
    const {puzzleId, theme} = message;
    const stub = env.PUZZLE_DO.getByName(puzzleId);

    // Set the state of the DO and update the catalog (via the BROWSE
    // service binding, which owns that table).
    await Promise.all([
        stub.setGenerating(),
        env.BROWSE.markCatalogGenerating(puzzleId)
    ]);

    // If a theme is given use it else generate one for the user
    const prompt = theme ?? await generateImagePrompt(env.AI, env.FLAGS);
    const key = puzzleImageKeyFor(puzzleId);

    // Gen the
    const stream = await generateImage(env.AI, env.FLAGS, prompt);
    await env.IMAGES.put(key, stream, {httpMetadata: {contentType: "image/png"}});

    await Promise.all([
        stub.setReady(prompt),
        env.BROWSE.markCatalogReady(puzzleId, key)
    ]);
}
