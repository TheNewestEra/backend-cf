// Read-only reference to `users` — owned and migrated by apps/accounts,
// never written here (same pragmatic pattern `friends` uses for
// display-name joins, now typed instead of a hand-written `first<{...}>()`
// row shape). Deliberately kept out of ./schema.ts and out of
// drizzle.config.ts's `schema` path, so `drizzle-kit generate` never tries
// to manage/migrate a table this app doesn't own — only the columns
// leaderboard actually reads (id/username/color) are modeled here, not the
// full table (username_lower/code_hash/code_salt/created_at etc. — see
// migrations/0004_simple_auth.sql and migrations/0006_user_color.sql for
// the real, complete definition).

import {sqliteTable, text} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    color: text("color").notNull(),
});
