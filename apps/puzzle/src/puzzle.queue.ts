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

    // If a theme is given use it else generate one for the user. Unwrapped
    // via `.match()` right here rather than propagated further — this
    // queue consumer's caller (index.ts's `queue()` handler) still drives
    // its retry off a thrown/rejected promise, same as before generateImagePrompt()
    // started returning a `Result` (see that function's own doc comment).
    const prompt =
        theme ??
        (await generateImagePrompt(env.AI, env.FLAGS)).match(
            (text) => text,
            (error) => {
                throw new Error(error);
            },
        );
    const key = puzzleImageKeyFor(puzzleId);

    // Gen the
    const stream = await generateImage(env.AI, env.FLAGS, prompt);
    await env.IMAGES.put(key, stream, {httpMetadata: {contentType: "image/png"}});

    await Promise.all([
        stub.setReady(prompt),
        env.BROWSE.markCatalogReady(puzzleId, key)
    ]);
}
