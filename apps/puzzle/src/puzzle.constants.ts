/** R2 key for a puzzle's single source image. */
export function puzzleImageKeyFor(puzzleId: string): string {
    return `puzzles/${puzzleId}/source.png`;
}

export const DEFAULT_GRID_SIZE = 4;
export const MIN_GRID_SIZE = 3;
export const MAX_GRID_SIZE = 6;

/** Sanity bounds the resolved Flagship time limit (see puzzleTimeLimitMs())
 * is clamped to, regardless of grid size — protects against a misconfigured
 * flag value (0, negative, absurdly large) producing an unplayable puzzle. */
export const MIN_TIME_LIMIT_SECONDS = 60;
export const MAX_TIME_LIMIT_SECONDS = 600;

/** Score awarded for solving with no time left; full marks (PUZZLE_MAX_SCORE)
 * for solving instantly. Linear in between. */
export const PUZZLE_MAX_SCORE = 1000;
export const PUZZLE_MIN_SOLVED_SCORE = 50;

// Fallbacks used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with the flags' own
// default variation, set via `wrangler flagship flags create/update` (see
// the "timer" app referenced by env.FLAGS in wrangler.jsonc).
const DEFAULT_PUZZLE_TIME_LIMIT_SECONDS = 180;
const DEFAULT_PUZZLE_TIME_OVERRIDE_SECONDS = 20;

/** The puzzle solve countdown, in ms, sourced from Cloudflare Flagship:
 * normally the "puzzle-time-seconds" flag, or "puzzle-time-override-seconds"
 * instead whenever the "dev-mode" flag is on — flip dev-mode in the
 * Flagship dashboard/CLI to test the countdown/timeout quickly without
 * waiting out the real limit. No redeploy needed for either flag to take
 * effect. Every puzzle gets the same limit regardless of grid size; clamped
 * to [MIN_TIME_LIMIT_SECONDS, MAX_TIME_LIMIT_SECONDS] as a safety net. */
export async function puzzleTimeLimitMs(env: Env): Promise<number> {
    const devMode = await env.FLAGS.getBooleanValue("dev-mode", false);
    const seconds = await (devMode
        ? env.FLAGS.getNumberValue("puzzle-time-override-seconds", DEFAULT_PUZZLE_TIME_OVERRIDE_SECONDS)
        : env.FLAGS.getNumberValue("puzzle-time-seconds", DEFAULT_PUZZLE_TIME_LIMIT_SECONDS));
    return Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(MIN_TIME_LIMIT_SECONDS, seconds)) * 1000;
}

/** How long the waiting room lasts before the puzzle auto-starts. Also the
 * window during which direct friend/group invites can be sent for a puzzle
 * — see POST /api/invites in the `friends` service, which checks lobby
 * status through the `PuzzleService` RPC entrypoint. */
export const LOBBY_COUNTDOWN_SECONDS = 30;
