// Shared "lobby" concept: once a game's content is ready (Guess the
// Prompt's rounds, Piece Puzzle's image), it opens a waiting room for
// LOBBY_COUNTDOWN_SECONDS instead of jumping straight into play — giving
// players a moment to gather, see who else has joined (see each game's
// `participants` roster and `player_joined` broadcast), and optionally
// have the host start early. Both `apps/guess`'s `GameDO` and
// `apps/puzzle`'s `PuzzleDO` drive this off a single DO alarm (see each
// model's `alarm()`/`beginPlaying()`), and both read/write the countdown
// through the helpers below so the two games' timing math can't drift
// apart.

/** How long the waiting room lasts, in seconds, before a game auto-starts. */
export const LOBBY_COUNTDOWN_SECONDS = 30;

/** Absolute ms timestamp the lobby ends at, `countdownSeconds` from `now`. */
export function lobbyEndsAt(now: number, countdownSeconds: number = LOBBY_COUNTDOWN_SECONDS): number {
  return now + countdownSeconds * 1000;
}

/** ms remaining until `endsAt`, floored at 0 — `null` in, `null` out, so a
 * nullable `lobby_ends_at` column can be passed straight through whether or
 * not the lobby is actually open right now. */
export function lobbyRemainingMs(endsAt: number | null, now: number = Date.now()): number | null {
  return endsAt === null ? null : Math.max(0, endsAt - now);
}
