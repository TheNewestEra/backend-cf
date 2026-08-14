import {generateImage, generateImagePrompt} from "@game-worker/shared/ai";
import {puzzleImageKeyFor} from "./puzzle.constants";

export interface PuzzleQueueMessage {
    puzzleId: string;
    theme: string | null;
    // Whether `theme` (once resolved) should be recorded as picked-for-this-
    // puzzle rather than typed in — always the enqueuing caller's own call,
    // never re-derived here from `theme === null`, since `theme` is
    // non-null on *both* a normal user-given creation and a regenerate
    // enqueue (which seeds a brand-new instance from a finished puzzle's
    // own theme, auto-generated or not — see puzzle.controller.ts's
    // `/regenerate`, which carries the source's `themeGenerated` straight
    // through rather than re-deriving it).
    themeGenerated: boolean;
}

export async function processPuzzle(message: PuzzleQueueMessage, env: Env): Promise<void> {
    const {puzzleId, theme, themeGenerated} = message;
    const stub = env.PUZZLE_DO.getByName(puzzleId);

    // Set the state of the DO and update the catalog (via the BROWSE
    // service binding, which owns that table).
    await Promise.all([
        stub.setGenerating(),
        env.BROWSE.markCatalogGenerating(puzzleId)
    ]);

    // If a theme is given, use it verbatim as both the resolved theme and
    // the image prompt (same as before); otherwise ask the model for both —
    // a short theme label alongside the fuller image prompt it's about (see
    // generateImagePrompt()'s own doc comment). Unwrapped via `.match()`
    // right here rather than propagated further — this queue consumer's
    // caller (index.ts's `queue()` handler) still drives its retry off a
    // thrown/rejected promise, same as before generateImagePrompt() started
    // returning a `Result`.
    const {theme: resolvedTheme, prompt} = theme
        ? {theme, prompt: theme}
        : (await generateImagePrompt(env.AI, env.FLAGS)).match(
              (value) => value,
              (error) => {
                  throw new Error(error);
              },
          );
    const key = puzzleImageKeyFor(puzzleId);

    const stream = await generateImage(env.AI, env.FLAGS, prompt);
    await env.IMAGES.put(key, stream, {httpMetadata: {contentType: "image/png"}});

    await Promise.all([
        stub.setReady(prompt, resolvedTheme, themeGenerated),
        env.BROWSE.markCatalogReady(puzzleId, key),
        env.BROWSE.updateCatalogTheme(puzzleId, resolvedTheme, themeGenerated),
    ]);
}
