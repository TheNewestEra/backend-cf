// Read-only reference to `friendships` — owned and migrated by
// apps/friends, never written here (same pragmatic cross-app read this
// Worker already does against `users` — see ./users-ref.ts). Deliberately
// kept out of ./schema.ts and out of drizzle.config.ts's `schema` path, so
// `drizzle-kit generate` never tries to manage/migrate a table this app
// doesn't own — only the column leaderboard actually reads (friend_id,
// filtered by user_id) is modeled here, not the full table (created_at,
// composite PK etc. — see migrations/0002_accounts.sql for the real,
// complete definition).

import {sqliteTable, text} from "drizzle-orm/sqlite-core";

export const friendships = sqliteTable("friendships", {
    userId: text("user_id").notNull(),
    friendId: text("friend_id").notNull(),
});
