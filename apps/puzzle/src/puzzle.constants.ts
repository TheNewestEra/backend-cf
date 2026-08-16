/** R2 key for a puzzle's single source image. Kept in one place so the
 * writer (queue consumer) and reader (PuzzleDO.readPublicState(), which
 * turns this into a public `sourceImageUrl` via @game-worker/shared/images'
 * publicImageUrl()) can't drift apart. */
export function puzzleImageKeyFor(puzzleId: string): string {
    return `puzzles/${puzzleId}/source.png`;
}

const MIN_TIME_LIMIT_SECONDS = 30;
const MAX_TIME_LIMIT_SECONDS = 600;

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
    if (!Number.isInteger(requested))
        return env.FLAGS.getNumberValue("grid-size-default", DEFAULT_GRID_SIZE);
    const [min, max] = await Promise.all([
        env.FLAGS.getNumberValue("grid-size-min", DEFAULT_MIN_GRID_SIZE),
        env.FLAGS.getNumberValue("grid-size-max", DEFAULT_MAX_GRID_SIZE),
    ]);
    return Math.min(max, Math.max(min, requested as number));
}

export async function puzzleMaxScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("puzzle-max-score", DEFAULT_PUZZLE_MAX_SCORE);
}

export async function puzzleMinSolvedScore(env: Env): Promise<number> {
    return env.FLAGS.getNumberValue("puzzle-min-solved-score", DEFAULT_PUZZLE_MIN_SOLVED_SCORE);
}

/** Resolves this puzzle's time limit: `requestedSeconds` (POST /puzzles' optional
 * `timeLimitSeconds` body field) clamped to [MIN_TIME_LIMIT_SECONDS,
 * MAX_TIME_LIMIT_SECONDS] or, absent a request, Flagship's "puzzle-time-seconds"
 * flag — clamped the same way. Mirrors `resolveGridSize()`'s "clamp rather than
 * reject" shape one field over. */
export async function puzzleTimeLimitMs(env: Env, requestedSeconds?: number): Promise<number> {
    const seconds = Number.isInteger(requestedSeconds)
        ? (requestedSeconds as number)
        : await env.FLAGS.getNumberValue("puzzle-time-seconds", DEFAULT_PUZZLE_TIME_LIMIT_SECONDS);
    return Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(MIN_TIME_LIMIT_SECONDS, seconds)) * 1000;
}

export {HostBodySchema} from "@game-worker/shared/game-session";
