/** R2 key for a puzzle's single source image. */
export function puzzleImageKeyFor(puzzleId: string): string {
    return `puzzles/${puzzleId}/source.png`;
}

export const DEFAULT_GRID_SIZE = 4;
export const MIN_GRID_SIZE = 3;
export const MAX_GRID_SIZE = 6;

/** Countdown length scales with difficulty (more tiles = more time), within
 * these bounds. */
export const SECONDS_PER_TILE = 12;
export const MIN_TIME_LIMIT_SECONDS = 60;
export const MAX_TIME_LIMIT_SECONDS = 600;

/** Score awarded for solving with no time left; full marks (PUZZLE_MAX_SCORE)
 * for solving instantly. Linear in between. */
export const PUZZLE_MAX_SCORE = 1000;
export const PUZZLE_MIN_SOLVED_SCORE = 50;

/** How long the waiting room lasts before the puzzle auto-starts. Also the
 * window during which direct friend/group invites can be sent for a puzzle
 * — see POST /api/invites in the `friends` service, which checks lobby
 * status through the `PuzzleService` RPC entrypoint. */
export const LOBBY_COUNTDOWN_SECONDS = 30;
