/** Theme/player-name length caps and the host-token body shape, sourced
 * from `@game-worker/shared/game-session` — Piece Puzzle's create/join
 * forms (see puzzle.constants.ts) take the exact same shape/flags, so the
 * two can't drift apart on these limits. `maxThemeLength()`/
 * `maxPlayerLength()` are async (Flagship-backed), so guess.controller.ts
 * imports them directly from there instead of being re-exported here; only
 * the static `HostBodySchema` shape makes sense to re-export as-is. */
export {HostBodySchema} from "@game-worker/shared/game-session";

// Fallbacks used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with each flag's own
// default variation, set via `wrangler flagship flags create/update` (see
// the "timer" app referenced by env.FLAGS in wrangler.jsonc). No dev-mode
// branch any more: every knob below is just its own flag, so trying a
// different value for testing means changing that flag, not flipping
// dev-mode and hoping a second "-override-" flag happens to hold what you
// want.
const DEFAULT_ROUND_COUNT = 5;
const DEFAULT_GUESS_MAX_SCORE = 100;
const DEFAULT_GUESS_MIN_SCORE = 10;
const DEFAULT_POST_ROUND_SECONDS = 5;
const DEFAULT_GUESS_MATCH_THRESHOLD = 0.35;
export const DEFAULT_GUESS_TIME_LIMIT_SECONDS = 60;

const MIN_ROUND_COUNT = 1;
const MAX_ROUND_COUNT = 8;
const MIN_GUESS_TIME_LIMIT_SECONDS = 30;
const MAX_GUESS_TIME_LIMIT_SECONDS = 120;

/** Resolves this game's round count: `requested` (POST /games' optional
 * `roundCount` body field) clamped to [MIN_ROUND_COUNT, MAX_ROUND_COUNT] or,
 * absent a request, Flagship's "round-count" flag — clamped the same way.
 * Mirrors Piece Puzzle's `resolveGridSize()`/`puzzleTimeLimitMs()` "clamp
 * rather than reject" shape. */
export async function roundCount(env: Env, requested?: number): Promise<number> {
    const count = Number.isInteger(requested)
        ? (requested as number)
        : await env.FLAGS.getNumberValue("round-count", DEFAULT_ROUND_COUNT);
    return Math.min(MAX_ROUND_COUNT, Math.max(MIN_ROUND_COUNT, count));
}

export async function guessMaxScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("guess-max-score", DEFAULT_GUESS_MAX_SCORE);
}

export async function guessMinScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("guess-min-score", DEFAULT_GUESS_MIN_SCORE);
}

export async function postRoundSeconds(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("post-round-seconds", DEFAULT_POST_ROUND_SECONDS);
}

/** Resolves this game's per-round time limit, in seconds: `requested`
 * (POST /games' optional `roundTimeLimitSeconds` body field) clamped to
 * [MIN_GUESS_TIME_LIMIT_SECONDS, MAX_GUESS_TIME_LIMIT_SECONDS] or, absent a
 * request, Flagship's "guess-time-seconds" flag — clamped the same way.
 * Resolved once, by `GameDO.init()`/`initFromSource()`, and persisted on the
 * game row (`round_time_limit_seconds`) rather than re-read per round — see
 * that column's doc comment on ./db/schema.ts's `game` table for why. */
export async function guessTimeLimitSeconds(env: Env, requested?: number): Promise<number> {
    const seconds = Number.isInteger(requested)
        ? (requested as number)
        : await env.FLAGS.getNumberValue("guess-time-seconds", DEFAULT_GUESS_TIME_LIMIT_SECONDS);
    return Math.min(MAX_GUESS_TIME_LIMIT_SECONDS, Math.max(MIN_GUESS_TIME_LIMIT_SECONDS, seconds));
}

export async function guessMatchThreshold(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("guess-match-threshold", DEFAULT_GUESS_MATCH_THRESHOLD);
}

/** R2 key for a guess-game round's image. Must match the image model's
 * output format (see IMAGE_MODEL in @game-worker/shared/ai) — kept in one
 * place so the writer (queue consumer) and reader (image route) can't
 * drift apart. */
export function imageKeyFor(gameId: string, index: number): string {
    return `games/${gameId}/${index}.png`;
}

/** Path of the image route a round's `imageUrl` (see guess.schema.ts's
 * `RoundPublicSchema`) resolves against — kept in one place so
 * `GameDO.readPublicState()` (the writer) and this file's own `GET
 * /games/{id}/images/{index}` route (the reader) can't drift apart, same
 * spirit as `imageKeyFor()` above. */
export function imageUrlPathFor(gameId: string, index: number): string {
    return `/games/${gameId}/images/${index}`;
}
