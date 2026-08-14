import {err, ok, type Result} from "neverthrow";

const DEFAULT_PROMPT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const DEFAULT_IMAGE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0" as const;
const DEFAULT_IMAGE_STEPS = 8;
const DEFAULT_PRESET_THEMES: string[] = [];

const promptModel = (flags: Flagship): Promise<string> => flags.getStringValue("prompt-model", DEFAULT_PROMPT_MODEL);
const imageModel = (flags: Flagship): Promise<string> => flags.getStringValue("image-model", DEFAULT_IMAGE_MODEL);
const imageSteps = (flags: Flagship): Promise<number> => flags.getNumberValue("image-steps", DEFAULT_IMAGE_STEPS);
const presetThemes = (flags: Flagship): Promise<string[]> => flags.getObjectValue("preset-themes", DEFAULT_PRESET_THEMES);

async function pickPresetTheme(flags: Flagship): Promise<string | null> {
    const themes = await presetThemes(flags);
    if (themes.length === 0) return null;
    return themes[Math.floor(Math.random() * themes.length)] ?? null;
}

/** What `generateRoundPrompts` resolves to: the theme it actually used
 * alongside the generated round prompts. `theme` is never empty — see that
 * function's own doc comment for how it's resolved. */
export interface RoundPromptsResult {
    theme: string;
    prompts: string[];
}

/**
 * Asks a text model for exactly `roundCount` short image-generation prompts
 * around a theme (or a theme of its own choosing). These prompts double as
 * the hidden "answers" players guess once they see the generated image.
 *
 * The model is always asked to hand back a `theme` alongside `prompts` —
 * when `theme` (or a Flagship preset — see `pickPresetTheme`) is already
 * known, `resolvedTheme` is used as-is and the model's own echo is
 * discarded; only when neither is available (the model was told to "pick
 * any fun theme yourself") does its returned theme become the answer,
 * since that's the only place that text exists at all — giving the caller
 * (guess.queue.ts) something concrete to persist and show players instead
 * of leaving a freeform game's theme forever unknown.
 *
 * `ai.run()` itself is left to throw on genuine infra failure (network,
 * binding misconfiguration) — only the two *expected* validation failures
 * (malformed/wrong-count model output) resolve to an `Err` rather than
 * throwing, since those are ordinary, anticipated outcomes of asking a
 * model for structured output, not something exceptional. Both queue
 * consumers that call this (guess.queue.ts/puzzle.queue.ts) already run
 * inside a `try/catch` that drives the message's retry, so either failure
 * mode ends up handled the same way there — see `webSocketMessage()`'s
 * analogous split in puzzle.model.ts for the same reasoning applied to a
 * request instead of a queue message. */
export async function generateRoundPrompts(
    ai: Ai,
    flags: Flagship,
    theme: string | null,
    roundCount: number,
): Promise<Result<RoundPromptsResult, string>> {
    const resolvedTheme = theme ?? await pickPresetTheme(flags);
    const themeInstruction = resolvedTheme
        ? `The theme is: "${resolvedTheme}".`
        : "Pick any fun, family-friendly theme yourself.";
    const model = await promptModel(flags);

    const promptsJsonSchema = {
        type: "object",
        properties: {
            theme: {
                type: "string",
                minLength: 1,
                maxLength: 100,
                description:
                    "The theme these prompts were written around — echo the given theme back verbatim, or name " +
                    "the one you picked.",
            },
            prompts: {
                type: "array",
                items: {type: "string", minLength: 3, maxLength: 200},
                minItems: roundCount,
                maxItems: roundCount,
            },
        },
        required: ["theme", "prompts"],
    } as const;

    const result = await ai.run(model as typeof DEFAULT_PROMPT_MODEL, {
        messages: [
            {
                role: "system",
                content:
                    "You write short, vivid text-to-image prompts for a 'guess the prompt' party game. " +
                    "Each prompt describes one concrete visual scene in 6-15 words, safe for all audiences, " +
                    `with no text or writing rendered in the image. All ${roundCount} prompts must be distinct from each other.`,
            },
            {
                role: "user",
                content: `${themeInstruction} Write exactly ${roundCount} image prompts.`,
            },
        ],
        response_format: {
            type: "json_schema",
            json_schema: promptsJsonSchema,
        },
    });

    return extractThemeAndPrompts(result).andThen(({theme: modelTheme, prompts}) =>
        prompts.length === roundCount
            ? ok({theme: resolvedTheme ?? modelTheme, prompts})
            : err(`expected ${roundCount} prompts, model returned ${prompts.length}`),
    );
}

// Text-generation output is a loose union across model variants — usually
// `{ response: string | object, ... }`, sometimes a bare string. Normalize
// once here rather than re-deriving this per call site.
function unwrapResponse(result: unknown): unknown {
    return (result as { response?: unknown } | undefined)?.response ?? result;
}

function extractThemeAndPrompts(result: unknown): Result<RoundPromptsResult, string> {
    const response = unwrapResponse(result);
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    const obj = parsed as { theme?: unknown; prompts?: unknown } | undefined;
    const theme = typeof obj?.theme === "string" ? obj.theme.trim() : "";
    if (!theme) return err("model did not return a `theme` string");
    const prompts = obj?.prompts;
    if (!Array.isArray(prompts) || !prompts.every((p) => typeof p === "string")) {
        return err("model did not return a `prompts` string array");
    }
    return ok({theme, prompts: prompts.map((p) => p.trim()).filter(Boolean)});
}

/** What `generateImagePrompt` resolves to: the theme it actually used
 * alongside the single generated image prompt — same shape/resolution
 * rules as `RoundPromptsResult`, just for Piece Puzzle's one image instead
 * of Guess the Prompt's several. */
export interface ImagePromptResult {
    theme: string;
    prompt: string;
}

/**
 * Asks a text model for a single vivid image prompt plus a short theme
 * label describing it — used by the puzzle game when the player doesn't
 * supply their own theme. Steers the model toward a Flagship-configured
 * preset theme when one's available (in which case `theme` on the result
 * is that same preset, not re-asked of the model — see
 * `generateRoundPrompts`'s doc comment for why); otherwise leaves the
 * theme entirely up to the model, whose own label becomes the answer.
 */
export async function generateImagePrompt(ai: Ai, flags: Flagship): Promise<Result<ImagePromptResult, string>> {
    const presetTheme = await pickPresetTheme(flags);
    const themeInstruction = presetTheme ? ` The theme is: "${presetTheme}".` : " Invent a fun theme yourself.";
    const model = await promptModel(flags);

    const promptJsonSchema = {
        type: "object",
        properties: {
            theme: {
                type: "string",
                minLength: 1,
                maxLength: 100,
                description:
                    "A short label (2-6 words) for the theme this prompt is about — echo the given theme back " +
                    "verbatim, or name the one you invented.",
            },
            prompt: {type: "string", minLength: 3, maxLength: 200},
        },
        required: ["theme", "prompt"],
    } as const;

    const result = await ai.run(model as typeof DEFAULT_PROMPT_MODEL, {
        messages: [
            {
                role: "system",
                content:
                    "You write one short, vivid text-to-image prompt (8-15 words) describing a single " +
                    "concrete visual scene, safe for all audiences, with no text or writing rendered in the image.",
            },
            {
                role: "user",
                content: `Write one fun image prompt, suitable for a sliding picture puzzle.${themeInstruction}`,
            },
        ],
        response_format: {
            type: "json_schema",
            json_schema: promptJsonSchema,
        },
    });

    return extractThemeAndPrompt(result).map(({theme: modelTheme, prompt}) => ({theme: presetTheme ?? modelTheme, prompt}));
}

function extractThemeAndPrompt(result: unknown): Result<ImagePromptResult, string> {
    const response = unwrapResponse(result);
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    const obj = parsed as { theme?: unknown; prompt?: unknown } | undefined;
    const theme = typeof obj?.theme === "string" ? obj.theme.trim() : "";
    const prompt = typeof obj?.prompt === "string" ? obj.prompt.trim() : "";
    if (!theme) return err("model did not return a `theme` string");
    if (!prompt) return err("model returned no prompt");
    return ok({theme, prompt});
}

export async function generateImage(
    ai: Ai,
    flags: Flagship,
    prompt: string,
): Promise<ReadableStream<Uint8Array>> {
    const [model, steps] = await Promise.all([imageModel(flags), imageSteps(flags)]);
    return ai.run(model as typeof DEFAULT_IMAGE_MODEL, {prompt, num_steps: steps});
}
