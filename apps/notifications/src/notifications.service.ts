import type {z} from "@hono/zod-openapi";
import {and, desc, eq, isNull} from "drizzle-orm";
import {err, ok, type ResultAsync} from "neverthrow";
import type {Db} from "./db/client";
import {query, requireFound} from "./db/result";
import {notifications} from "./db/schema";
import type {NotificationInput, NotificationSchema} from "./notifications.schema";

export type Notification = z.infer<typeof NotificationSchema>;

const toNotification = (row: typeof notifications.$inferSelect): Notification => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data === null ? null : (JSON.parse(row.data) as unknown),
    createdAt: row.createdAt,
    readAt: row.readAt,
});

/** Returns the created row's public shape so the caller (NotificationsService)
 * can push it over the recipient's NotificationDO WebSocket without a
 * round-trip read back from D1. */
export const createNotification = (
    db: Db,
    userId: string,
    input: NotificationInput,
): ResultAsync<Notification, string> => {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const title = input.title ?? null;
    const body = input.body ?? null;
    const data = input.data === undefined ? null : JSON.stringify(input.data);
    return query(
        db
            .insert(notifications)
            .values({id, userId, type: input.type, title, body, data, createdAt, readAt: null}),
    ).map(() => ({
        id,
        type: input.type,
        title,
        body,
        data: input.data ?? null,
        createdAt,
        readAt: null,
    }));
};

/** Unread notifications for `userId`, newest first — covers anything sent
 * while a client was offline or never connected; new ones while connected
 * also arrive over the WebSocket (see notification.model.ts). */
export const listPending = (db: Db, userId: string): ResultAsync<Notification[], string> =>
    query(
        db
            .select()
            .from(notifications)
            .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
            .orderBy(desc(notifications.createdAt)),
    ).map((rows) => rows.map(toNotification));

export const markRead = (db: Db, id: string, userId: string): ResultAsync<void, string> =>
    query(
        db
            .select({userId: notifications.userId})
            .from(notifications)
            .where(eq(notifications.id, id))
            .then((rows) => rows[0]),
    )
        .andThen((row) => requireFound(row, "Notification not found."))
        .andThen((row) => (row.userId === userId ? ok(row) : err("forbidden")))
        .andThen(() =>
            query(
                db.update(notifications).set({readAt: Date.now()}).where(eq(notifications.id, id)),
            ),
        )
        .map(() => undefined);

export const markAllRead = (db: Db, userId: string): ResultAsync<void, string> =>
    query(
        db
            .update(notifications)
            .set({readAt: Date.now()})
            .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    ).map(() => undefined);
