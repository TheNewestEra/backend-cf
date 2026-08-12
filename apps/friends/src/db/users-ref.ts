// Read-only reference to `users` — owned and migrated by apps/accounts,
// never written here (same pragmatic pattern `leaderboard` uses for
// display-name joins, now typed instead of a hand-written `first<{...}>()`
// row shape). Deliberately kept out of ./schema.ts and out of
// drizzle.config.ts's `schema` path, so `drizzle-kit generate` never tries
// to manage/migrate a table this app doesn't own — only the columns friends
// actually reads (id/username/usernameLower/color) are modeled here, not
// the full table (password_hash/password_salt/created_at etc. — see
// migrations/0002_accounts.sql for the real, complete definition).

import {sqliteTable, text} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    usernameLower: text("username_lower").notNull(),
    color: text("color").notNull(),
});
