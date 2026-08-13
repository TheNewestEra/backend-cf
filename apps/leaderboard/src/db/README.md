# Drizzle in apps/leaderboard

`schema.ts` is the source of truth for the one table this app owns
(`leaderboard_entries`). There's no read-only ref file for `users` (owned by
`apps/accounts`) or `friendships` (owned by `apps/friends`) at all: display-
name/color lookups go through `AccountsRpc.getUsersByIds` and friend-scoped
queries go through `FriendsRpc.getFriendIds`, both service bindings instead
of a direct table read — see leaderboard.service.ts.

## Why generated migrations don't land in the shared `migrations/` folder

The physical D1 database (`game-worker-catalog`) is shared across
`accounts`/`browse`/`friends`/`leaderboard`, each owning a subset of tables,
all migrated through one linear, hand-numbered sequence in the repo-root
`migrations/` folder via `wrangler d1 migrations apply` (see each app's
`wrangler.jsonc`). `wrangler d1 migrations apply` tracks what's already run
in a `d1_migrations` bookkeeping table inside that same physical database —
one ledger, shared by every app that points its `migrations_dir` at that
folder.

`schema.ts` above was hand-written to match the table **as it already
exists** (created by `migrations/0005_leaderboard.sql`, already applied).
The very first `drizzle-kit generate` against a brand-new schema has
nothing to diff against, so it emits a full `CREATE TABLE ...` statement —
which would fail outright if handed to `wrangler d1 migrations apply`
against any database that already has this table (dev or prod).

So: `drizzle.config.ts`'s `out` points at `./drizzle` — **this app's own
folder**, never the shared root — specifically so that first baseline
snapshot never becomes a real, applied migration. It exists purely as
drizzle-kit's own bookkeeping (its `meta/_journal.json` + baseline SQL),
giving future `drizzle-kit generate` calls something to diff *against*.

## Workflow for an actual future schema change

1. Edit `schema.ts`.
2. `cd apps/leaderboard && npx drizzle-kit generate` — emits a new
   incremental SQL file into `./drizzle` (e.g. `0001_add_something.sql`),
   containing only the delta (a real `ALTER TABLE`/`CREATE TABLE`/etc.),
   not a fresh baseline.
3. Copy that file's SQL into a new next-numbered file in the shared
   `migrations/` folder (e.g. `migrations/0008_add_something.sql`) —
   matching that folder's existing naming (`000N_description.sql`), so it's
   just another entry in the one shared ledger every app already applies
   through.
4. `wrangler d1 migrations apply` as usual (local, then remote once
   verified).

Steps 2 and 3 stay separate on purpose: `drizzle-kit`'s own `./drizzle`
snapshot needs every generated file to see accurate diffs going forward,
but the *shared* `migrations/` folder needs one flat, hand-numbered
sequence — copying the SQL over (rather than pointing `out` straight at the
shared folder) keeps those two folders' numbering independent, so
`leaderboard`'s own migration count doesn't collide with the numbering the
other three apps are already using in that same folder.
