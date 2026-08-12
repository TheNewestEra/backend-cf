# Drizzle in apps/guess

`schema.ts` is the source of truth for the four tables `GameDO` (this
Worker's only Durable Object class) creates in its own storage: `game`,
`rounds`, `guesses`, `participants`.

## This is NOT the D1 story

`apps/accounts`/`apps/browse`/`apps/friends`/`apps/leaderboard` all share one
physical D1 database, migrated through a linear, hand-numbered sequence in
the repo-root `migrations/` folder via `wrangler d1 migrations apply` (see
each of those apps' `src/db/README.md`). `GameDO` has no D1 binding at all
(see wrangler.jsonc's comment on that) — it's backed by its own Durable
Object SQLite storage instead (`new_sqlite_classes: ["GameDO"]`), and
**every instance of `GameDO` (one per game) has its own private database.**
There is no shared database to run a migration against, and no
`wrangler d1 migrations apply` equivalent that reaches into a specific DO
instance's storage — that CLI command doesn't exist.

## The actual bootstrap mechanism: `migrate()`

Instead, each `GameDO` instance evolves its own schema at first-touch: its
constructor calls `migrate()` (see `guess.model.ts`) inside
`ctx.blockConcurrencyWhile()`, which runs a `CREATE TABLE IF NOT EXISTS`
block for all four tables followed by a loop of idempotent
`ALTER TABLE ... ADD COLUMN` statements (each wrapped in its own try/catch,
since SQLite has no `ADD COLUMN IF NOT EXISTS` — a "duplicate column"
failure just means this instance already has it). This runs on **every**
constructor call, for every instance, for the lifetime of the class — it's
the only migration mechanism this table set has ever had or will have.

`schema.ts` describes these four tables **as `migrate()` actually leaves
them today** — after its `CREATE TABLE` block *and* every `ALTER TABLE` that
has since been added to the loop — same "describes what already exists"
spirit as `apps/friends/src/db/README.md`, just with no automated apply
step anywhere in this version of the story: `migrate()` itself is hand-written
raw SQL and stays that way. Drizzle/drizzle-kit never drives it.

## What `schema.ts` and `./drizzle` are actually for

Since nothing here is ever applied via drizzle-kit, the schema and its
generated baseline exist purely for:

- **Query building** — `guess.model.ts`'s `this.db.select()/.insert()/
  .update()/.delete()` chains (via `drizzle-orm/durable-sqlite`, see
  `./client.ts`) need `schema.ts`'s table definitions to type-check and to
  generate correct SQL.
- **Tooling/CI drift-check parity** — `drizzle.config.ts`'s `out: "./drizzle"`
  points at this app's own folder (never a shared one, since there's no
  shared migrations folder to point at here in the first place) so
  `drizzle-kit generate` has a baseline snapshot to diff future `schema.ts`
  edits against, and so a schema-drift check has something to compare
  `schema.ts` against, same as every other app's Drizzle baseline.

## Workflow for an actual future schema change

There is no step where drizzle-kit applies anything — this is three manual
edits, kept in sync by hand:

1. Edit `guess.model.ts`'s `migrate()` — add the new `CREATE TABLE`/
   idempotent-`ALTER TABLE`-in-try/catch statement, exactly like the
   existing precedents in that loop.
2. Edit `schema.ts` to match what `migrate()` now produces.
3. `cd apps/guess && npx drizzle-kit generate` — refreshes the local
   baseline snapshot in `./drizzle` for tooling/CI-drift-check purposes.
   Nothing from this step is ever applied anywhere; it's bookkeeping only.
