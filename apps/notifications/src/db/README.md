# Drizzle in apps/notifications

`schema.ts` is the source of truth for the one table this app owns
(`notifications`).

## Why generated migrations don't land in the shared `migrations/` folder

The physical D1 database (`game-worker-catalog`) is shared across
`accounts`/`browse`/`friends`/`leaderboard`/`notifications`, each owning a
subset of tables, all migrated through one linear, hand-numbered sequence in
the repo-root `migrations/` folder via `wrangler d1 migrations apply` (see
each app's `wrangler.jsonc`). `wrangler d1 migrations apply` tracks what's
already run in a `d1_migrations` bookkeeping table inside that same physical
database — one ledger, shared by every app that points its `migrations_dir`
at that folder.

`drizzle.config.ts`'s `out` points at `./drizzle` — **this app's own
folder**, never the shared root — so this app's own migration count stays
independent of the numbering the other apps sharing that folder are already
using (same reasoning as `apps/friends/src/db/README.md`, though unlike that
app this one's very first `generate` really was a brand-new table with
nothing to baseline against).

## Workflow for an actual future schema change

1. Edit `schema.ts`.
2. `cd apps/notifications && npx drizzle-kit generate` — emits a new
   incremental SQL file into `./drizzle` (e.g. `0001_add_something.sql`),
   containing only the delta.
3. Copy that file's SQL into a new next-numbered file in the shared
   `migrations/` folder (e.g. `migrations/0009_add_something.sql`) —
   matching that folder's existing naming (`000N_description.sql`).
4. `wrangler d1 migrations apply` as usual (local, then remote once
   verified).
