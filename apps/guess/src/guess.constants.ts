/** Every "guess the prompt" game has exactly this many image/prompt rounds. */
export const ROUND_COUNT = 5;

/** Round scoring is time-weighted like the puzzle's solve score: full marks
 * for a correct guess submitted the instant the round's image is ready,
 * floor score for one that takes GUESS_TIME_LIMIT_SECONDS or longer. An
 * incorrect guess always scores 0 (and isn't logged to the leaderboard). */
export const GUESS_TIME_LIMIT_SECONDS = 60;
export const GUESS_MAX_SCORE = 100;
export const GUESS_MIN_SCORE = 10;

/** R2 key for a guess-game round's image. Must match the image model's
 * output format (see IMAGE_MODEL in @game-worker/shared/ai) — kept in one
 * place so the writer (queue consumer) and reader (image route) can't
 * drift apart. */
export function imageKeyFor(gameId: string, index: number): string {
  return `games/${gameId}/${index}.png`;
}
