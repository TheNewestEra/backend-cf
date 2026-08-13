// Drizzle schema for the table `apps/leaderboard` owns (see wrangler.jsonc's
// comment on the `DB` binding). This is now the source of truth for
// `leaderboard_entries` — future changes go schema.ts -> `npx drizzle-kit
// generate` -> copy the emitted SQL into the next-numbered file in the
// shared `migrations/` folder -> `wrangler d1 migrations apply`, same as
// every other hand-written migration already in that folder (`wrangler d1
// migrations apply` doesn't care who authored the SQL). See this
// directory's README for the one-time baselining story: this table already
// exists (applied via migrations/0005_leaderboard.sql), so drizzle-kit was
// pointed at an app-local `./drizzle` output folder — never the shared
// one — for its first `generate`, so that initial CREATE-TABLE snapshot
// never gets handed to `wrangler d1 migrations apply` and asked to recreate
// a table that's already live.
//
// `users` (joined for display-name/color lookups) and `friendships` (read
// for friend-scoped queries) are deliberately NOT here — they're owned and
// migrated by apps/accounts and apps/friends respectively. See
// ./users-ref.ts and ./friendships-ref.ts.

import {index, integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

/** One row per scoring event (a solved puzzle, a correctly guessed round) —
 * kept as an event log rather than a running total specifically so
 * time-windowed queries ("top scores this week") can filter on created_at
 * directly instead of reconstructing history. Written exclusively through
 * `recordScore` — see leaderboard.service.ts. `userId` references
 * `users(id)` at the DB level (see migrations/0002_accounts.sql) but that
 * FK isn't modeled via `.references()` here, since `users` isn't part of
 * this schema for migration-management purposes (see the header comment
 * above). */
export const leaderboardEntries = sqliteTable(
    "leaderboard_entries",
    {
        id: text("id").primaryKey(),
        userId: text("user_id").notNull(),
        kind: text("kind").notNull().$type<"guess" | "puzzle">(),
        sessionId: text("session_id").notNull(), // gameId or puzzleId this score came from
        score: integer("score").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        index("idx_leaderboard_kind_created").on(table.kind, table.createdAt),
        index("idx_leaderboard_user").on(table.userId),
    ],
);
