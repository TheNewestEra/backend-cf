import {DurableObject} from "cloudflare:workers";
import type {Notification} from "./notifications.service";

/** What actually goes out over the wire — see notifications.schema.ts's
 * `NotificationWsMessageSchema`. `persisted` distinguishes a
 * `send()`-created row (has a durable D1 id, recoverable via
 * `GET /api/notifications`, markable read) from a `push()`-only one
 * (delivery-only — the caller already owns its own source of truth). */
export type PushableNotification = Notification & { persisted: boolean };

/**
 * One instance per user (routed via `env.NOTIFICATION_DO.getByName(userId)`).
 * Holds that user's live WebSocket connections — one per open tab/device —
 * and pushes notifications the instant they're sent, instead of every page
 * having to poll for what's new.
 *
 * Purely a delivery channel: for `send()`-created notifications, the
 * `notifications` D1 table (see notifications.service.ts) remains the
 * source of truth, so a client that was offline (or never connected) still
 * picks up anything it missed via `GET /api/notifications` on page load —
 * `push()` here just saves everyone else from polling in the meantime. For
 * `push()`-only notifications (no D1 row at all — the caller already has
 * its own source of truth, e.g. apps/friends' `game_invites`), a dropped
 * push is only ever recovered via that caller's own equivalent of
 * `GET /api/invites/pending` — there is no fallback here.
 *
 * Generalizes what used to be apps/friends' invite-only `UserDO` — same
 * shape, but the pushed payload is now a generic, dynamically-typed
 * `Notification` instead of a hardcoded `InviteSummary`, so any service can
 * reuse this one delivery channel for any kind of user-facing message.
 */
export class NotificationDO extends DurableObject<Env> {
    override async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", {status: 426});
        }
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        return new Response(null, {status: 101, webSocket: pair[0]});
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        // Clients are push-only observers; the one exception is a keepalive ping.
        if (typeof message === "string" && message === "ping") {
            ws.send(JSON.stringify({type: "pong"}));
        }
    }

    async webSocketClose(): Promise<void> {
        // No per-connection state to clean up; hibernation handles the rest.
    }

    /** RPC: called by NotificationsService right after a notification is
     * created (`send`), or in place of ever creating one (`push`). */
    async push(notification: PushableNotification): Promise<void> {
        const message = JSON.stringify({type: "notification", notification});
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(message);
            } catch {
                // Dead socket — hibernation cleans it up on close, nothing to do here.
            }
        }
    }
}
