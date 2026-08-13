import {swaggerUI} from "@hono/swagger-ui";
import {OpenAPIHono} from "@hono/zod-openapi";
import {corsMiddleware} from "@game-worker/shared/cors";
import {toRpcResult, type RpcResult} from "@game-worker/shared/rpc-result";
import {WorkerEntrypoint} from "cloudflare:workers";
import {createDb} from "./db/client";
import {NotificationDO} from "./notification.model";
import {notificationsRoutes} from "./notifications.controller";
import {NotificationWsMessageSchema, NotificationWsPongMessageSchema, type NotificationInput} from "./notifications.schema";
import {createNotification, type Notification} from "./notifications.service";

export {NotificationDO};

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", corsMiddleware);
app.route("/", notificationsRoutes);

app.openAPIRegistry.register("NotificationWsMessage", NotificationWsMessageSchema);
app.openAPIRegistry.register("NotificationWsPong", NotificationWsPongMessageSchema);

app.doc("/openapi.json", {
    openapi: "3.0.0",
    info: {
        title: "Notifications Service API",
        version: "1.0.0",
        description:
            "Generic per-user notification delivery — the main channel every other service pushes a " +
            "user-facing message through, and the direct successor to apps/friends' old invite-only " +
            "notifications WebSocket. Notifications are only ever created server-to-server, via the " +
            "NotificationsService RPC entrypoint (see index.ts) — there is no HTTP endpoint to send one, " +
            "only to read/manage your own inbox. The WebSocket upgrade endpoint " +
            "(`/api/notifications/ws`) isn't representable in OpenAPI 3 and is omitted from this spec, " +
            "though it's a real, functioning route.",
    },
});
app.get("/docs", swaggerUI({url: "/openapi.json"}));

/** Fresh delivery-only notification for `push()`/`pushMany()` — never
 * touches D1 (see the class doc comment below). `id` defaults to a random
 * one; a caller that already has its own identifier for this notification
 * (e.g. apps/friends' own `game_invites.id`) can pass it explicitly so the
 * pushed payload's `id` lines up with that caller's own record. */
function pushableFrom(input: NotificationInput & { id?: string }): Notification & { persisted: boolean } {
    return {
        id: input.id ?? crypto.randomUUID(),
        type: input.type,
        title: input.title ?? null,
        body: input.body ?? null,
        data: input.data ?? null,
        createdAt: Date.now(),
        readAt: null,
        persisted: false,
    };
}

/** RPC surface for every other Worker (bound via a `services` entry with
 * `entrypoint: "NotificationsService"`). Two independent axes:
 *
 * - `send`/`sendMany` persist a `notifications` row (so it survives an
 *   offline/never-connected client, recoverable via
 *   `GET /api/notifications`) *and* push it live over the recipient's
 *   NotificationDO WebSocket if connected. Use this for anything that
 *   doesn't already have its own durable inbox — the general case.
 * - `push`/`pushMany` skip D1 entirely and only push live. Use this when
 *   the caller already owns its own source of truth for "what's pending"
 *   (e.g. apps/friends' `game_invites` + `GET /api/invites/pending`) —
 *   duplicating that into this service's `notifications` table would just
 *   be two copies of the same fact able to drift apart.
 *
 * Both accept a free-form `type` string plus optional `title`/`body`/`data`
 * (see notifications.schema.ts's `NotificationInputSchema`) — this service
 * never needs to know ahead of time what kinds of notifications exist; a
 * brand-new one is just a new `type` string a caller starts sending, no
 * change needed here. Delivery is always best-effort past the D1 write (if
 * any): a dropped WebSocket push only ever costs the recipient an instant
 * update, not the notification itself. */
export class NotificationsService extends WorkerEntrypoint<Env> {
    async send(userId: string, input: NotificationInput): Promise<RpcResult<Notification>> {
        const result = await createNotification(createDb(this.env.DB), userId, input);
        if (result.isOk()) {
            await this.env.NOTIFICATION_DO.getByName(userId)
                .push({...result.value, persisted: true})
                .catch((err) => {
                    console.error("failed to push notification", userId, err);
                });
        }
        return toRpcResult(result);
    }

    async sendMany(userIds: string[], input: NotificationInput): Promise<void> {
        await Promise.all(userIds.map((userId) => this.send(userId, input)));
    }

    /** Push-only — see the class doc comment above. */
    async push(userId: string, input: NotificationInput & { id?: string }): Promise<void> {
        await this.env.NOTIFICATION_DO.getByName(userId)
            .push(pushableFrom(input))
            .catch((err) => {
                console.error("failed to push notification", userId, err);
            });
    }

    async pushMany(userIds: string[], input: NotificationInput & { id?: string }): Promise<void> {
        await Promise.all(userIds.map((userId) => this.push(userId, input)));
    }
}

export default {
    fetch: app.fetch,
} satisfies ExportedHandler<Env>;
