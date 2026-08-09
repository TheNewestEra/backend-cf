// Central type for a service's `DB` binding. Service modules import this
// alias rather than reaching for the ambient `D1Database` global directly,
// so a future swap of the underlying driver only touches call sites that
// actually need to change.
//
// Several services (accounts, browse, friends, leaderboard) bind the same
// physical D1 database (see each service's wrangler.jsonc) — each owns a
// subset of the tables and may read (but never write) tables it doesn't
// own for display-name joins. Schema/migrations live in the repo-root
// `migrations/`, applied via `wrangler d1 migrations apply`.
export type Database = D1Database;
