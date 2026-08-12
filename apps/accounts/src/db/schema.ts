// Drizzle schema for the tables `apps/accounts` owns: `users` and
// `sessions` (see account.service.ts's header comment — this is the only
// service that ever writes either table). This is now the source of truth
// for these two tables — future changes go schema.ts -> `npx drizzle-kit
// generate` -> copy the emitted SQL into the next-numbered file in the
// shared `migrations/` folder -> `wrangler d1 migrations apply`, same as
// every other hand-written migration already in that folder (`wrangler d1
// migrations apply` doesn't care who authored the SQL). See this
// directory's README for the one-time baselining story: these tables
// already exist (current shape landed via migrations/0004_simple_auth.sql,
// with `users.color` added on top by migrations/0006_user_color.sql, both
// already applied), so drizzle-kit was pointed at an app-local `./drizzle`
// output folder — never the shared one — for its first `generate`, so that
// initial CREATE-TABLE snapshot never gets handed to `wrangler d1
// migrations apply` and asked to recreate tables that are already live.
//
// `users` went through two drop-and-recreate migrations before landing
// here — migrations/0003_openauth.sql (external OpenAuth issuer, since
// abandoned) then migrations/0004_simple_auth.sql (current username +
// hashed-code scheme) — so don't trust migrations/0002_accounts.sql's
// original `CREATE TABLE users` (password_hash/password_salt, a UNIQUE
// constraint on `username` itself) as the current shape; it's stale.

import {index, integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

/** Local account credentials — a username plus a hashed 6-digit login code
 * (see account.service.ts's `hashCode()`/`generateCode()`). `username` has
 * no uniqueness constraint of its own; only the lowercased `usernameLower`
 * is enforced unique, so lookups and inserts normalize case through it
 * (see `findUserByUsername()`/`createAccount()`). `color` is generated
 * once at registration (`@game-worker/shared/color`) and stored forever
 * after so it stays stable everywhere it's shown — the DB-level default
 * here only backfills rows that predate the column
 * (migrations/0006_user_color.sql); every INSERT this app issues passes an
 * explicit generated color. */
export const users = sqliteTable("users", {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    usernameLower: text("username_lower").notNull().unique(),
    codeHash: text("code_hash").notNull(),
    codeSalt: text("code_salt").notNull(),
    createdAt: integer("created_at").notNull(),
    color: text("color").notNull().default("#888888"),
});

/** An opaque session token, one row per logged-in session — no JWTs, so a
 * logout (or an admin revoke) is just a row delete (see
 * `deleteSession()`). `userId` references `users(id)` at the DB level
 * (see migrations/0004_simple_auth.sql), modeled here via `.references()`
 * since, unlike apps/friends' read-only mirror of `users`, this app is the
 * one that owns and migrates both tables. */
export const sessions = sqliteTable(
    "sessions",
    {
        token: text("token").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id),
        createdAt: integer("created_at").notNull(),
        expiresAt: integer("expires_at").notNull(),
    },
    (table) => [index("idx_sessions_user").on(table.userId)],
);
