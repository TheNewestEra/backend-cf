// Drizzle schema for the table this app owns (see wrangler.jsonc's comment
// on the `DB` binding). This is the source of truth for `notifications` —
// future changes go schema.ts -> `npx drizzle-kit generate` -> copy the
// emitted SQL into the next-numbered file in the shared `migrations/`
// folder -> `wrangler d1 migrations apply`, same as every other
// hand-written migration already in that folder. See this directory's
// README.

import {index, integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

/** One row per notification ever sent to a user via
 * `NotificationsService.send()` — see ../notifications.service.ts. Rows
 * created via `.push()` instead (no durable inbox entry, delivery-only —
 * see ../notification.model.ts) never land here at all.
 *
 * `type` is a free-form string (e.g. "invite", "friend_request", "system"),
 * not a closed enum — this is the whole point of this table being generic:
 * a brand-new kind of notification is just a new string a caller starts
 * sending, never a schema change here. `title`/`body` are plain optional
 * display text; `data` is opaque, caller-defined JSON for anything richer
 * a client-side handler for that `type` wants (e.g. an invite's
 * `sessionId`/`kind`). */
export const notifications = sqliteTable(
    "notifications",
    {
        id: text("id").primaryKey(),
        userId: text("user_id").notNull(),
        type: text("type").notNull(),
        title: text("title"),
        body: text("body"),
        data: text("data"), // JSON-encoded; see the table doc comment above
        createdAt: integer("created_at").notNull(),
        readAt: integer("read_at"),
    },
    (table) => [index("idx_notifications_user").on(table.userId, table.readAt)],
);
