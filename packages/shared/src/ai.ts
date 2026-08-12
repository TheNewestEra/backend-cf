const PROMPT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const IMAGE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0" as const;
const IMAGE_STEPS = 8;

// Fallback used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with the flag's own
// default variation. Empty on purpose: an empty list is also what makes
// `pickPresetTheme` back off to the original "let the model invent it"
// behavior below, so an unset/misconfigured flag degrades to that instead
// of a hard failure.
const DEFAULT_PRESET_THEMES: string[] = [];

/** A curated pool of themes to draw from when a caller doesn't supply its
 * own, sourced from Cloudflare Flagship's "preset-themes" flag (shared by
 * both `guess` and `puzzle`, exact same flag key, read independently by
 * each). Leave it empty to keep the original behavior — an unthemed round
 * is left entirely up to the model. */
export async function presetThemes(flags: Flagship): Promise<string[]> {
    return flags.getObjectValue("preset-themes", DEFAULT_PRESET_THEMES);
}

async function pickPresetTheme(flags: Flagship): Promise<string | null> {
    const themes = await presetThemes(flags);
    if (themes.length === 0) return null;
    return themes[Math.floor(Math.random() * themes.length)] ?? null;
}

/**
 * Asks a text model for exactly `roundCount` short image-generation prompts
 * around a theme (or a theme of its own choosing). These prompts double as
 * the hidden "answers" players guess once they see the generated image.
 */
export async function generateRoundPrompts(
    ai: Ai,
    flags: Flagship,
    theme: string | null,
    roundCount: number,
): Promise<string[]> {
    const resolvedTheme = theme ?? await pickPresetTheme(flags);
    const themeInstruction = resolvedTheme
        ? `The theme is: "${resolvedTheme}".`
        : "Pick any fun, family-friendly theme yourself.";

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

    const result = await ai.run(PROMPT_MODEL, {
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

    const prompts = extractPrompts(result);
    if (prompts.length !== roundCount) {
        throw new Error(`expected ${roundCount} prompts, model returned ${prompts.length}`);
    }
    return prompts;
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

function extractPrompts(result: unknown): string[] {
    const response = unwrapResponse(result);
    const parsed = typeof response === "string" ? JSON.parse(response) : response;
    const prompts = (parsed as { prompts?: unknown } | undefined)?.prompts;
    if (!Array.isArray(prompts) || !prompts.every((p) => typeof p === "string")) {
        throw new Error("model did not return a `prompts` string array");
    }
    return prompts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Asks a text model for a single vivid image prompt — used by the puzzle
 * game when the player doesn't supply their own theme. Steers the model
 * toward a Flagship-configured preset theme when one's available, otherwise
 * leaves the theme entirely up to the model, same as before.
 */
export async function generateImagePrompt(ai: Ai, flags: Flagship): Promise<string> {
    const theme = await pickPresetTheme(flags);
    const themeInstruction = theme ? ` The theme is: "${theme}".` : "";

    const result = await ai.run(PROMPT_MODEL, {
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
    if (!text) throw new Error("model returned no prompt");
    return text;
}

export const generateImage =
    (ai: Ai, prompt: string): Promise<ReadableStream<Uint8Array>> =>
        ai.run(IMAGE_MODEL, {prompt, num_steps: IMAGE_STEPS});
