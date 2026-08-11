// Shared "lobby" concept: once a game's content is ready (Guess the
// Prompt's rounds, Piece Puzzle's image), it opens a waiting room for
// lobbyCountdownSeconds() instead of jumping straight into play — giving
// players a moment to gather, see who else has joined (see each game's
// `participants` roster and `player_joined` broadcast), and optionally
// have the host start early. Both `apps/guess`'s `GameDO` and
// `apps/puzzle`'s `PuzzleDO` drive this off a single DO alarm (see each
// model's `alarm()`/`beginPlaying()`), and both read/write the countdown
// through the helpers below so the two games' timing math can't drift
// apart.

// Fallback used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with the flag's own
// default variation, set via `wrangler flagship flags create/update`. Both
// games bind the exact same Flagship app (see each's wrangler.jsonc) and
// read this exact flag key, so there's nothing to drift apart on even
// though the read itself happens independently in each DO.
const DEFAULT_LOBBY_COUNTDOWN_SECONDS = 30;

/** How long the waiting room lasts, in seconds, before a game auto-starts —
 * sourced from Cloudflare Flagship's "lobby-countdown-seconds" flag, so both
 * games can be retimed without a redeploy. */
export async function lobbyCountdownSeconds(flags: Flagship): Promise<number> {
  return flags.getNumberValue("lobby-countdown-seconds", DEFAULT_LOBBY_COUNTDOWN_SECONDS);
}

/** Absolute ms timestamp the lobby ends at, `countdownSeconds` from `now` —
 * pass the value resolved by `lobbyCountdownSeconds()`. */
export function lobbyEndsAt(now: number, countdownSeconds: number): number {
  return now + countdownSeconds * 1000;
}

/** ms remaining until `endsAt`, floored at 0 — `null` in, `null` out, so a
 * nullable `lobby_ends_at` column can be passed straight through whether or
 * not the lobby is actually open right now. */
export function lobbyRemainingMs(endsAt: number | null, now: number = Date.now()): number | null {
  return endsAt === null ? null : Math.max(0, endsAt - now);
}
