// Drizzle schema for the tables `apps/friends` owns (see wrangler.jsonc's
// comment on the `DB` binding). This is now the source of truth for these
// five tables — future changes go schema.ts -> `npx drizzle-kit generate`
// -> copy the emitted SQL into the next-numbered file in the shared
// `migrations/` folder -> `wrangler d1 migrations apply`, same as every
// other hand-written migration already in that folder (`wrangler d1
// migrations apply` doesn't care who authored the SQL). See this
// directory's README for the one-time baselining story: these tables
// already exist (applied via migrations/0002_accounts.sql), so drizzle-kit
// was pointed at an app-local `./drizzle` output folder — never the shared
// one — for its first `generate`, so that initial CREATE-TABLE snapshot
// never gets handed to `wrangler d1 migrations apply` and asked to recreate
// tables that are already live.
//
// `users` is deliberately NOT here, and this directory has no read-only ref
// file for it at all — it's owned and migrated by apps/accounts, and
// display-name/color lookups go through its `AccountsRpc.getUsersByIds`/
// `findUserByUsername` instead of a direct table read — see
// friends.service.ts.

import {index, integer, primaryKey, sqliteTable, text, unique} from "drizzle-orm/sqlite-core";

/** Shared by both `friend_requests.status` and `game_invites.status` — kept
 * as one alias so the two columns' `.$type<>()` can't quietly drift apart. */
export type RequestStatus = "pending" | "accepted" | "declined";

/** One row per direction. A mutual request (B already asked A) is detected
 * and auto-accepted in application code rather than modeled here — see
 * friends.service.ts's `sendFriendRequest()`. `requesterId`/`recipientId`
 * reference `users(id)` at the DB level (see migrations/0002_accounts.sql)
 * but that FK isn't modeled via `.references()` here, since `users` isn't
 * part of this schema for migration-management purposes (see the header
 * comment above). */
export const friendRequests = sqliteTable(
    "friend_requests",
    {
        id: text("id").primaryKey(),
        requesterId: text("requester_id").notNull(),
        recipientId: text("recipient_id").notNull(),
        status: text("status").notNull().default("pending").$type<RequestStatus>(),
        createdAt: integer("created_at").notNull(),
        respondedAt: integer("responded_at"),
    },
    (table) => [
        unique().on(table.requesterId, table.recipientId),
        index("idx_friend_requests_recipient").on(table.recipientId, table.status),
        index("idx_friend_requests_requester").on(table.requesterId, table.status),
    ],
);

/** Accepted friendships, written both directions on accept for an O(1) "my
 * friends" lookup — see friends.service.ts's `acceptFriendRequest()`. */
export const friendships = sqliteTable(
    "friendships",
    {
        userId: text("user_id").notNull(),
        friendId: text("friend_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        primaryKey({columns: [table.userId, table.friendId]}),
        index("idx_friendships_user").on(table.userId),
    ],
);

export const friendGroups = sqliteTable(
    "friend_groups",
    {
        id: text("id").primaryKey(),
        ownerId: text("owner_id").notNull(),
        name: text("name").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [index("idx_friend_groups_owner").on(table.ownerId)],
);

export const friendGroupMembers = sqliteTable(
    "friend_group_members",
    {
        groupId: text("group_id").notNull(),
        friendId: text("friend_id").notNull(),
    },
    (table) => [primaryKey({columns: [table.groupId, table.friendId]})],
);

/** A game/puzzle invite. Inviting a group fans out to one row per member —
 * there's no separate "group invite" concept at the data layer. `kind`
 * mirrors `GameKind` (@game-worker/shared/game) but isn't typed against it
 * directly — that'd pull a shared-package import into a column definition
 * for a two-member union that's exceedingly unlikely to drift. */
export const gameInvites = sqliteTable(
    "game_invites",
    {
        id: text("id").primaryKey(),
        kind: text("kind").notNull().$type<"guess" | "puzzle">(),
        sessionId: text("session_id").notNull(), // gameId or puzzleId
        inviterId: text("inviter_id").notNull(),
        recipientId: text("recipient_id").notNull(),
        status: text("status").notNull().default("pending").$type<RequestStatus>(),
        createdAt: integer("created_at").notNull(),
        respondedAt: integer("responded_at"),
    },
    (table) => [index("idx_game_invites_recipient").on(table.recipientId, table.status)],
);
