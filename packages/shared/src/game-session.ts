import {z} from "@hono/zod-openapi";

const DEFAULT_MAX_THEME_LENGTH = 120;
const DEFAULT_MAX_PLAYER_LENGTH = 40;

export async function maxThemeLength(flags: Flagship): Promise<number> {
    return flags.getNumberValue("max-theme-length", DEFAULT_MAX_THEME_LENGTH);
}

export async function maxPlayerLength(flags: Flagship): Promise<number> {
    return flags.getNumberValue("max-player-length", DEFAULT_MAX_PLAYER_LENGTH);
}

export const HostBodySchema = z.object({hostToken: z.string().optional()});
