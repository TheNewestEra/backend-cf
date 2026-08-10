// `guess` and `puzzle` are independent Workers with no runtime dependency on
// each other, but their create/join HTTP surface takes structurally
// identical input: an optional freeform theme, a capped anonymous-guest
// display name, and a host token proving lobby ownership for host-only
// actions (start/regenerate). Kept here, alongside `@game-worker/shared/
// lobby`'s countdown, so the two forms' limits can't quietly drift apart.

import {z} from "@hono/zod-openapi";

/** Cap on a session's freeform theme string (POST /games, POST /puzzles). */
export const MAX_THEME_LENGTH = 120;

/** Cap on an anonymous guest's chosen display name (POST .../join).
 * Logged-in players use their account username instead — see each
 * controller's join handler. */
export const MAX_PLAYER_LENGTH = 40;

/** Body shape for every host-only action (start/regenerate) — carries the
 * token handed back from session creation, proving the caller is the host. */
export const HostBodySchema = z.object({hostToken: z.string().optional()});
