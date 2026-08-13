import {z} from "@hono/zod-openapi";

/** A persisted notification — created via `NotificationsService.send()`
 * (see index.ts), listed via `GET /api/notifications`, and eventually
 * marked read. `type` is a free-form string (e.g. "invite",
 * "friend_request", "system") rather than a closed enum — a brand-new kind
 * of notification is just a new string a caller starts sending, never a
 * schema change here. `data` carries whatever shape that `type` implies,
 * as opaque JSON this service never inspects. */
export const NotificationSchema = z
    .object({
        id: z.string(),
        type: z.string(),
        title: z.string().nullable(),
        body: z.string().nullable(),
        data: z.unknown().nullable(),
        createdAt: z.number(),
        readAt: z.number().nullable(),
    })
    .openapi("Notification");

/** Input shape for both `NotificationsService.send()` (persisted) and
 * `.push()` (delivery-only, no D1 row) — see index.ts. Not itself exposed
 * over HTTP: notifications are only ever created server-to-server, by a
 * service that has already applied its own business rules about who's
 * allowed to notify whom (see index.ts's class doc comment). */
export const NotificationInputSchema = z.object({
    type: z.string(),
    title: z.string().optional(),
    body: z.string().optional(),
    data: z.unknown().optional(),
});
export type NotificationInput = z.infer<typeof NotificationInputSchema>;

/** Server -> client WS envelope, pushed by NotificationDO (see
 * notification.model.ts). `persisted: true` means this notification has a
 * durable `id` in D1 and can be marked read via
 * `POST /api/notifications/{id}/read`; `persisted: false` (from a
 * `push()`-only call — e.g. apps/friends' game invites, which already have
 * their own source of truth in `game_invites`) means it's delivery-only —
 * the `id` is only good for client-side de-duping, nothing else. */
export const NotificationWsMessageSchema = z
    .object({
        type: z.literal("notification"),
        notification: NotificationSchema.extend({persisted: z.boolean()}),
    })
    .openapi("NotificationWsMessage");

/** Reply to a client's `"ping"` keepalive — sent directly to the asking
 * socket, never broadcast. */
export const NotificationWsPongMessageSchema = z
    .object({type: z.literal("pong")})
    .openapi("NotificationWsPongMessage");
