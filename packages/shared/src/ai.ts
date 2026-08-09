// Workers AI calls shared by both games: a text model invents prompts
// (one per round for "guess the prompt", one for a theme-less puzzle
// image), an image model renders each into a picture. Kept isolated here,
// with no dependency on any service, so it's shared source between the
// `guess` and `puzzle` Workers — each binds its own `AI` and passes it in,
// so this file itself has no binding of its own.

const PROMPT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

// SDXL-Lightning: distilled for a handful of steps, good quality/speed
// trade-off for generating several images per game. Swap to
// "@cf/stabilityai/stable-diffusion-xl-base-1.0" (and raise IMAGE_STEPS,
// e.g. 20) for higher fidelity at the cost of noticeably slower rounds.
const IMAGE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0" as const;
const IMAGE_STEPS = 8;

/**
 * Asks a text model for exactly `roundCount` short image-generation prompts
 * around a theme (or a theme of its own choosing). These prompts double as
 * the hidden "answers" players guess once they see the generated image.
 */
export async function generateRoundPrompts(ai: Ai, theme: string | null, roundCount: number): Promise<string[]> {
    const themeInstruction = theme
        ? `The theme is: "${theme}".`
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
 * game when the player doesn't supply their own theme.
 */
export async function generateImagePrompt(ai: Ai): Promise<string> {
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
                content: "Write one fun image prompt, suitable for a sliding picture puzzle.",
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
