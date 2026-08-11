// `guess` and `puzzle` are independent Workers with no runtime dependency on
// each other, but their create/join HTTP surface takes structurally
// identical input: an optional freeform theme, a capped anonymous-guest
// display name, and a host token proving lobby ownership for host-only
// actions (start/regenerate). Kept here, alongside `@game-worker/shared/
// lobby`'s countdown, so the two forms' limits can't quietly drift apart.

import {z} from "@hono/zod-openapi";

// Fallbacks used only if Flagship evaluation itself fails (network hiccup,
// binding misconfigured, etc.) — kept in sync by hand with each flag's own
// default variation. Both games bind the exact same Flagship app (see each's
// wrangler.jsonc) and read these exact flag keys, so there's nothing to
// drift apart on even though the read itself happens independently in each
// service.
const DEFAULT_MAX_THEME_LENGTH = 120;
const DEFAULT_MAX_PLAYER_LENGTH = 40;

/** Cap on a session's freeform theme string (POST /games, POST /puzzles),
 * sourced from Cloudflare Flagship's "max-theme-length" flag. Over-length
 * input is truncated to this rather than rejected — see each controller's
 * create handler. */
export async function maxThemeLength(flags: Flagship): Promise<number> {
  return flags.getNumberValue("max-theme-length", DEFAULT_MAX_THEME_LENGTH);
}

/** Cap on an anonymous guest's chosen display name (POST/WS .../join),
 * sourced from Cloudflare Flagship's "max-player-length" flag. Logged-in
 * players use their account username instead — see each controller/model's
 * join handler. Over-length input is truncated to this rather than
 * rejected. */
export async function maxPlayerLength(flags: Flagship): Promise<number> {
  return flags.getNumberValue("max-player-length", DEFAULT_MAX_PLAYER_LENGTH);
}

/** Body shape for every host-only action (start/regenerate) — carries the
 * token handed back from session creation, proving the caller is the host.
 * Just a shape, not a tunable value, so it stays a plain schema rather than
 * anything Flagship-backed. */
export const HostBodySchema = z.object({hostToken: z.string().optional()});
