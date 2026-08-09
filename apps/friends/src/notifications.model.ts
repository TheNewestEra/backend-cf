import {DurableObject} from "cloudflare:workers";
import type {InviteSummary} from "./invites.service";

/**
 * One instance per user (routed via `env.USER_DO.getByName(userId)`).
 * Holds that user's live WebSocket connections — one per open tab/device —
 * and pushes newly created game invites the instant they're sent, instead
 * of every page having to poll D1 for pending invites.
 *
 * Purely a delivery channel, same division of labor as the game DOs:
 * `game_invites` in D1 (see invites.service.ts) remains the source of
 * truth, so a client that was offline (or never connected) still picks up
 * anything it missed via the initial `GET /api/invites/pending` fetch on
 * page load. `notifyInvite` just saves everyone else from polling in the
 * meantime.
 */
export class UserDO extends DurableObject<Env> {
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

    /** RPC: called by the Worker right after an invite row is written to D1. */
    async notifyInvite(invite: InviteSummary): Promise<void> {
        const message = JSON.stringify({type: "invite", invite});
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(message);
            } catch {
                // Dead socket — hibernation cleans it up on close, nothing to do here.
            }
        }
    }
}
