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

/**
 * Asks a text model for exactly `roundCount` short image-generation prompts
 * around a theme (or a theme of its own choosing). These prompts double as
 * the hidden "answers" players guess once they see the generated image.
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
): Promise<Result<string[], string>> {
    const resolvedTheme = theme ?? await pickPresetTheme(flags);
    const themeInstruction = resolvedTheme
        ? `The theme is: "${resolvedTheme}".`
        : "Pick any fun, family-friendly theme yourself.";
    const model = await promptModel(flags);

    const promptsJsonSchema = {
        type: "object",
        properties: {
            prompts: {
                type: "array",
                items: {type: "string", minLength: 3, maxLength: 200},
                minItems: roundCount,
                maxItems: roundCount,
            },
        },
        required: ["prompts"],
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

    return extractPrompts(result).andThen((prompts) =>
        prompts.length === roundCount
            ? ok(prompts)
            : err(`expected ${roundCount} prompts, model returned ${prompts.length}`),
    );
}

// Text-generation output is a loose union across model variants — usually
// `{ response: string | object, ... }`, sometimes a bare string. Normalize
// once here rather than re-deriving this per call site.
function unwrapResponse(result: unknown): unknown {
    return (result as { response?: unknown } | undefined)?.response ?? result;
}

function extractText(result: unknown): string | undefined {
    const response = unwrapResponse(result);
    return typeof response === "string" ? response : undefined;
}

function extractPrompts(result: unknown): Result<string[], string> {
    const response = unwrapResponse(result);
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    const prompts = (parsed as { prompts?: unknown } | undefined)?.prompts;
    if (!Array.isArray(prompts) || !prompts.every((p) => typeof p === "string")) {
        return err("model did not return a `prompts` string array");
    }
    return ok(prompts.map((p) => p.trim()).filter(Boolean));
}

/**
 * Asks a text model for a single vivid image prompt — used by the puzzle
 * game when the player doesn't supply their own theme. Steers the model
 * toward a Flagship-configured preset theme when one's available, otherwise
 * leaves the theme entirely up to the model, same as before.
 */
export async function generateImagePrompt(ai: Ai, flags: Flagship): Promise<Result<string, string>> {
    const theme = await pickPresetTheme(flags);
    const themeInstruction = theme ? ` The theme is: "${theme}".` : "";
    const model = await promptModel(flags);

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
    });

    const text = extractText(result)?.trim();
    return text ? ok(text) : err("model returned no prompt");
}

export async function generateImage(
    ai: Ai,
    flags: Flagship,
    prompt: string,
): Promise<ReadableStream<Uint8Array>> {
    const [model, steps] = await Promise.all([imageModel(flags), imageSteps(flags)]);
    return ai.run(model as typeof DEFAULT_IMAGE_MODEL, {prompt, num_steps: steps});
}
