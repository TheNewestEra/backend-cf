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
/** Also reused as guess.model.ts's fallback when a round's own
 * `time_limit_ms` column is null (an already-`active` round from before
 * that column existed) — unrelated to Flagship evaluation failing, just
 * "no per-round value was ever stamped, so assume today's default". */
export const DEFAULT_GUESS_TIME_LIMIT_SECONDS = 60;

/** How many image/prompt rounds a "guess the prompt" game has, sourced from
 * Cloudflare Flagship's "round-count" flag. Resolved exactly once, by
 * `GameDO.init()`, and persisted on the game row (see guess.model.ts's
 * `round_count` column) rather than re-read anywhere else in that game's
 * lifetime — the queue consumer (guess.queue.ts) learns the count it
 * already committed via `getState().rounds.length` instead of a second
 * Flagship read, so a flag flip mid-generation can't leave the DB row count
 * and the number of prompts/images actually generated disagreeing with each
 * other. */
export async function roundCount(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("round-count", DEFAULT_ROUND_COUNT);
}

/** Round scoring is time-weighted like the puzzle's solve score: full marks
 * for a correct guess submitted the instant the round's image is ready,
 * floor score for one that takes guessTimeLimitSeconds() or longer. An
 * incorrect guess always scores 0 (and isn't logged to the leaderboard).
 * Sourced from Cloudflare Flagship's "guess-max-score"/"guess-min-score"
 * flags — read once per guess by `submitGuess()` and handed to
 * `scoreForGuess()`, same "resolve once, use once" shape as the time limit
 * below. */
export async function guessMaxScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("guess-max-score", DEFAULT_GUESS_MAX_SCORE);
}

export async function guessMinScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("guess-min-score", DEFAULT_GUESS_MIN_SCORE);
}

/** How long the "post round" reveal pause lasts once a round resolves
 * (everyone's answered correctly or its timer ran out), before the next
 * round opens — or, on the last round, before the game finalizes. Long
 * enough for players to see the round's real prompt and whether they
 * personally got it right (see guess.model.ts's `resolveCurrentRound`/
 * `advanceAfterPostRound` and guess.schema.ts's `postRoundIndex`/
 * `postRoundRemainingMs`) before things move on. Sourced from Cloudflare
 * Flagship's "post-round-seconds" flag. */
export async function postRoundSeconds(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("post-round-seconds", DEFAULT_POST_ROUND_SECONDS);
}

/** The guess round time limit, in seconds, sourced from Cloudflare
 * Flagship's "guess-time-seconds" flag — flip it in the Flagship
 * dashboard/CLI to retime rounds (and their score falloff) without a
 * redeploy. */
export async function guessTimeLimitSeconds(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("guess-time-seconds", DEFAULT_GUESS_TIME_LIMIT_SECONDS);
}

/** R2 key for a guess-game round's image. Must match the image model's
 * output format (see IMAGE_MODEL in @game-worker/shared/ai) — kept in one
 * place so the writer (queue consumer) and reader (image route) can't
 * drift apart. */
export function imageKeyFor(gameId: string, index: number): string {
    return `games/${gameId}/${index}.png`;
}
