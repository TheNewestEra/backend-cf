# Drizzle in apps/puzzle

`schema.ts` is the source of truth for the two tables `PuzzleDO` (this
Worker's only Durable Object class) creates in its own storage: `puzzle`
(single-row — exactly one puzzle per DO instance) and `participants`.

## This is NOT the D1 story

`apps/accounts`/`apps/browse`/`apps/friends`/`apps/leaderboard` all share one
physical D1 database, migrated through a linear, hand-numbered sequence in
the repo-root `migrations/` folder via `wrangler d1 migrations apply` (see
each of those apps' `src/db/README.md`). `PuzzleDO` has no D1 binding at all
(see wrangler.jsonc's comment on that) — it's backed by its own Durable
Object SQLite storage instead (`new_sqlite_classes: ["PuzzleDO"]`), and
**every instance of `PuzzleDO` (one per puzzle) has its own private
database.** There is no shared database to run a migration against, and no
`wrangler d1 migrations apply` equivalent that reaches into a specific DO
instance's storage — that CLI command doesn't exist.

## The actual bootstrap mechanism: `drizzle-orm/durable-sqlite/migrator`

Each `PuzzleDO` instance's constructor sets up `this.db` (see `./client.ts`)
and then calls `migrate()` (see `../puzzle.model.ts`) inside
`ctx.blockConcurrencyWhile()`, which runs
`drizzle-orm/durable-sqlite/migrator`'s `migrate(this.db, migrations)` — the
real Drizzle migrator, not hand-rolled SQL. This runs on **every**
constructor call, for every instance, for the lifetime of the class; the
migrator tracks what it's already applied in its own bookkeeping table
(`__drizzle_migrations`, inside that same instance's storage) and no-ops
once everything's caught up. Mirrors `apps/guess`'s `GameDO`, which moved to
this mechanism first — `puzzle` was still on an older, hand-rolled bootstrap
until this change (see git history for that version of this README).

A Durable Object can't read files off disk at runtime, so the generated SQL
under `./drizzle` (produced by `drizzle-kit generate`, same as every other
app) has to be wired in as real JS modules instead of read as files:
`./migrations.ts` is a **hand-written** index that imports each generated
`.sql` file (resolved to raw text via wrangler.jsonc's `rules` entry —
`type: "Text"`, `globs: ["**/*.sql"]`; see `../sql-module.d.ts` for the type
side of that) and `./drizzle/meta/_journal.json`, and default-exports the
`{journal, migrations}` shape the migrator expects. `drizzle-kit generate`
does **not** produce `migrations.ts` itself — it's kept in sync by hand
(see the workflow below).

### Known trade-off: pre-existing instances

Migration `0000` is `drizzle-kit`'s plain generated `CREATE TABLE` output —
deliberately **not** softened to `CREATE TABLE IF NOT EXISTS`. Any `PuzzleDO`
instance that already existed before this change (bootstrapped by the old
hand-rolled `migrate()`) will fail this migration — "table already
exists" — the next time it's touched, since the migrator's bookkeeping
table has no record of `0000` ever running against it. This was a
deliberate, accepted choice (see `puzzle.model.ts`'s `migrate()` doc
comment for the same note, and `apps/guess/src/db/README.md` for the
identical trade-off `GameDO` accepted first), not an oversight — there's no
baseline/backfill shim protecting already-provisioned instances.

### Known upstream quirk

`drizzle-orm/durable-sqlite/migrator`'s own bookkeeping table ends up with
`hash` always `""` and `id` always `NULL` —
[drizzle-team/drizzle-orm#4928](https://github.com/drizzle-team/drizzle-orm/issues/4928),
open upstream as of this writing. Traced through the migrator's own source:
the apply/skip decision only ever compares `created_at` timestamps, never
reads `hash`/`id` back, so this doesn't appear to affect correctness — just
cosmetically broken bookkeeping columns.

## What `schema.ts` is for

`puzzle.model.ts`'s `this.db.select()/.insert()/.update()/.delete()` chains
(via `drizzle-orm/durable-sqlite`, see `./client.ts`) need `schema.ts`'s
table definitions to type-check and to generate correct SQL. It's the same
file `drizzle-kit generate` reads to produce `./drizzle`'s migrations, so
it stays the single source of truth for both.

## Workflow for an actual future schema change

1. Edit `schema.ts`.
2. `cd apps/puzzle && npx drizzle-kit generate` — emits a new incremental
   `.sql` file under `./drizzle` (e.g. `0001_add_something.sql`).
3. Edit `./migrations.ts` by hand: add the new file's import and its
   `mXXXX` entry (zero-padded to match the journal's `idx`), alongside the
   existing `m0000`.
4. Deploy as usual — the next time each `PuzzleDO` instance is touched, its
   constructor's `migrate()` call picks up and applies the new migration.
