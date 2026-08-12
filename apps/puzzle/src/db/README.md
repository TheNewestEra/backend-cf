# Drizzle in apps/puzzle

`schema.ts` describes the two tables `PuzzleDO` (a Durable Object) keeps in
its own built-in SQLite storage: `puzzle` (single-row — exactly one puzzle
per DO instance) and `participants`. This is a fundamentally different
story from `apps/accounts`/`apps/browse`/`apps/friends`/`apps/leaderboard`,
all of which are D1-backed — read on before assuming the same workflow
applies here.

## There is no shared `migrations/` folder, and no `wrangler d1 migrations apply`

Each of those four apps' tables live in a physical D1 database, migrated
through one linear, hand-numbered sequence of SQL files that `wrangler d1
migrations apply` runs and tracks in a `d1_migrations` bookkeeping table.

`PuzzleDO` doesn't use D1 at all — see `../puzzle.model.ts`'s constructor
and `wrangler.jsonc`'s `new_sqlite_classes` entry. Every Durable Object
instance owns its *own*, separate SQLite database (`ctx.storage.sql`), with
no shared physical database, no `d1_migrations` ledger, and — critically —
**no external "apply my migrations" command that could reach every existing
instance**. A `PuzzleDO` instance that was created a year ago and hasn't
been touched since won't have its schema updated until the next time
something actually calls into it.

## The actual bootstrap mechanism: `migrate()`

Instead, `PuzzleDO`'s constructor runs `this.migrate()` (inside
`ctx.blockConcurrencyWhile`, before anything else touches storage) on
*every* instantiation. `migrate()` is hand-written, idempotent raw SQL:

- `CREATE TABLE IF NOT EXISTS` for both tables — a no-op on an instance that
  already has them, and creates them fresh on a brand-new instance.
- For a column added after some instances already existed (`participants.color`,
  `participants.selected_cell`), an `ALTER TABLE ... ADD COLUMN` wrapped in a
  `try`/`catch` — SQLite has no `ADD COLUMN IF NOT EXISTS`, so a "duplicate
  column" failure (meaning this instance already has it) is just swallowed.

This is why `migrate()` is deliberately **not** converted to Drizzle/`this.db`
like every other storage call in `puzzle.model.ts` — there's no Drizzle-driven
apply step it could plug into anyway, so it stays raw SQL against
`ctx.storage.sql.exec()` directly.

## What `schema.ts` is actually for, then

Purely descriptive — and kept in sync **by hand**, not generated from
`migrate()` or vice versa:

1. It gives `drizzle-orm/durable-sqlite`'s typed query builder (`./client.ts`,
   threaded through `PuzzleDO` as `this.db`) table/column definitions to
   build `.select()`/`.insert()`/`.update()`/`.delete()` chains against, the
   same way `apps/browse`'s `schema.ts` does for `drizzle-orm/d1`.
2. It gives `drizzle-kit generate` something to diff a local baseline
   snapshot (`./drizzle`, this app's own folder) against — that baseline is
   **never applied anywhere**; there's no D1/`wrangler d1 migrations apply`
   involved for a Durable Object at all. It exists purely for tooling/CI
   drift-check parity with the other four apps (a future drift-check compares
   `schema.ts` against `migrate()`'s SQL, using this snapshot).

## Workflow for an actual future schema change

Three manual edits — nothing here is applied automatically:

1. Edit `../puzzle.model.ts`'s `migrate()` to add the new `CREATE TABLE`
   column, or (for an existing table) a new idempotent
   `ALTER TABLE ... ADD COLUMN` wrapped in `try`/`catch`, exactly like the
   existing `color`/`selected_cell` precedent.
2. Edit `schema.ts` to match what `migrate()` now produces.
3. `cd apps/puzzle && npx drizzle-kit generate` to refresh the local
   `./drizzle` baseline snapshot, so tooling (and the CI drift-check) can
   see the change.

There's no step 4 — no file gets copied anywhere, and nothing gets
"applied": every live `PuzzleDO` instance picks up the new column itself,
lazily, the next time something calls into it and its constructor's
`migrate()` runs.
