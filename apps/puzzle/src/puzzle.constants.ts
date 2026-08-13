/** R2 key for a puzzle's single source image. */
export function puzzleImageKeyFor(puzzleId: string): string {
    return `puzzles/${puzzleId}/source.png`;
}

/** Sanity bounds the resolved Flagship time limit (see puzzleTimeLimitMs())
 * is clamped to, regardless of grid size — protects against a misconfigured
 * flag value (0, negative, absurdly large) producing an unplayable puzzle.
 * Deliberately kept as hardcoded constants rather than Flagship flags
 * themselves: their entire purpose is bounding a Flagship value that might
 * be wrong, so making them just another Flagship value would remove the
 * safety net they exist to provide. */
export const MIN_TIME_LIMIT_SECONDS = 60;
export const MAX_TIME_LIMIT_SECONDS = 600;

// Fallbacks used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with each flag's own
// default variation, set via `wrangler flagship flags create/update` (see
// the "timer" app referenced by env.FLAGS in wrangler.jsonc). No dev-mode
// branch any more: every knob below is just its own flag, so trying a
// different value for testing means changing that flag, not flipping
// dev-mode and hoping a second "-override-" flag happens to hold what you
// want.
const DEFAULT_GRID_SIZE = 4;
const DEFAULT_MIN_GRID_SIZE = 3;
const DEFAULT_MAX_GRID_SIZE = 6;
const DEFAULT_PUZZLE_MAX_SCORE = 1000;
const DEFAULT_PUZZLE_MIN_SOLVED_SCORE = 50;
const DEFAULT_PUZZLE_TIME_LIMIT_SECONDS = 180;

/** Resolves this puzzle's grid size: `requested` (POST /puzzles' optional
 * `gridSize` body field) clamped to [min, max] — both sourced from
 * Cloudflare Flagship's "grid-size-min"/"grid-size-max" flags — or, absent
 * a request, Flagship's "grid-size-default" flag. Bundles the fetch+clamp
 * in one place (rather than three separate exported numbers) since nothing
 * else ever needs min/max/default independently of this. */
export async function resolveGridSize(env: Env, requested: number | undefined): Promise<number> {
    if (!Number.isInteger(requested)) {
        return env.FLAGS.getNumberValue("grid-size-default", DEFAULT_GRID_SIZE);
    }
    const [min, max] = await Promise.all([
        env.FLAGS.getNumberValue("grid-size-min", DEFAULT_MIN_GRID_SIZE),
        env.FLAGS.getNumberValue("grid-size-max", DEFAULT_MAX_GRID_SIZE),
    ]);
    return Math.min(max, Math.max(min, requested as number));
}

/** The whole puzzle's point pool, split evenly across every cell
 * (`gridSize * gridSize`) and paid out per tile as it's correctly placed
 * rather than as one lump sum to whoever makes the final move — see
 * `scoreForMove()` in puzzle.model.ts. `puzzleMaxScore` is each tile's
 * share at the instant the puzzle starts (full pool if placed with zero
 * elapsed time); `puzzleMinSolvedScore` is the floor each tile's share
 * decays to once the time limit is reached — same linear-falloff shape
 * Guess the Prompt's own "guess-max-score"/"guess-min-score" flags drive
 * per round (see guess.constants.ts), just distributed over every correct
 * placement instead of every correct round. Sourced from Cloudflare
 * Flagship's "puzzle-max-score"/"puzzle-min-solved-score" flags. */
export async function puzzleMaxScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("puzzle-max-score", DEFAULT_PUZZLE_MAX_SCORE);
}

export async function puzzleMinSolvedScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("puzzle-min-solved-score", DEFAULT_PUZZLE_MIN_SOLVED_SCORE);
}

/** The puzzle solve countdown, in ms, sourced from Cloudflare Flagship's
 * "puzzle-time-seconds" flag — flip it in the Flagship dashboard/CLI to
 * test the countdown/timeout without a redeploy. Every puzzle gets the same
 * limit regardless of grid size; clamped to [MIN_TIME_LIMIT_SECONDS,
 * MAX_TIME_LIMIT_SECONDS] as a safety net. */
export async function puzzleTimeLimitMs(env: Env): Promise<number> {
    const seconds = await env.FLAGS.getNumberValue("puzzle-time-seconds", DEFAULT_PUZZLE_TIME_LIMIT_SECONDS);
    return Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(MIN_TIME_LIMIT_SECONDS, seconds)) * 1000;
}

/** How long the waiting room lasts before the puzzle auto-starts. Also the
 * window during which direct friend/group invites can be sent for a puzzle
 * — see POST /api/invites in the `friends` service, which checks lobby
 * status through the `PuzzleService` RPC entrypoint. `lobbyCountdownSeconds()`
 * is async (Flagship-backed), so puzzle.model.ts imports it directly from
 * `@game-worker/shared/lobby` instead of being re-exported here — Guess the
 * Prompt's own lobby (see guess.constants.ts) reads the exact same flag, so
 * the two games can't drift apart on "how long is the wait". */

/** Theme/player-name length caps and the host-token body shape, sourced
 * from `@game-worker/shared/game-session` — Guess the Prompt's create/join
 * forms (see guess.constants.ts) take the exact same shape/flags, so the
 * two can't drift apart on these limits. `maxThemeLength()`/
 * `maxPlayerLength()` are async (Flagship-backed) so they're imported
 * directly from there instead of being re-exported here; only the static
 * `HostBodySchema` shape makes sense to re-export as-is. */
export {HostBodySchema} from "@game-worker/shared/game-session";
