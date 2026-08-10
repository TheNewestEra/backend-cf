/** Every "guess the prompt" game has exactly this many image/prompt rounds. */
export const ROUND_COUNT = 5;

/** How long the waiting room lasts once every round's image is ready,
 * before the game auto-starts. Sourced from `@game-worker/shared/lobby` —
 * Piece Puzzle's own lobby (see puzzle.constants.ts) uses the exact same
 * countdown, so the two games can't drift apart on "how long is the wait". */
export {LOBBY_COUNTDOWN_SECONDS} from "@game-worker/shared/lobby";

/** Theme/player-name length caps and the host-token body shape, sourced
 * from `@game-worker/shared/game-session` — Piece Puzzle's create/join
 * forms (see puzzle.constants.ts) take the exact same shape, so the two
 * can't drift apart on these limits. */
export {HostBodySchema, MAX_PLAYER_LENGTH, MAX_THEME_LENGTH} from "@game-worker/shared/game-session";

/** Round scoring is time-weighted like the puzzle's solve score: full marks
 * for a correct guess submitted the instant the round's image is ready,
 * floor score for one that takes guessTimeLimitSeconds() or longer. An
 * incorrect guess always scores 0 (and isn't logged to the leaderboard). */
export const GUESS_MAX_SCORE = 100;
export const GUESS_MIN_SCORE = 10;

// Fallbacks used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with the flags'
// own default variation, set via `wrangler flagship flags create/update`
// (see the "timer" app referenced by env.FLAGS in wrangler.jsonc).
const DEFAULT_GUESS_TIME_LIMIT_SECONDS = 60;
const DEFAULT_GUESS_TIME_OVERRIDE_SECONDS = 15;

/** The guess round time limit, in seconds, sourced from Cloudflare
 * Flagship: normally the "guess-time-seconds" flag, or
 * "guess-time-override-seconds" instead whenever the "dev-mode" flag is on
 * — flip dev-mode in the Flagship dashboard/CLI to test round timing (and
 * its score falloff) quickly without waiting out the real limit. No
 * redeploy needed for either flag to take effect. */
export async function guessTimeLimitSeconds(env: Env): Promise<number> {
  const devMode = await env.FLAGS.getBooleanValue("dev-mode", false);
  return devMode
    ? env.FLAGS.getNumberValue("guess-time-override-seconds", DEFAULT_GUESS_TIME_OVERRIDE_SECONDS)
    : env.FLAGS.getNumberValue("guess-time-seconds", DEFAULT_GUESS_TIME_LIMIT_SECONDS);
}

/** R2 key for a guess-game round's image. Must match the image model's
 * output format (see IMAGE_MODEL in @game-worker/shared/ai) — kept in one
 * place so the writer (queue consumer) and reader (image route) can't
 * drift apart. */
export function imageKeyFor(gameId: string, index: number): string {
  return `games/${gameId}/${index}.png`;
}
