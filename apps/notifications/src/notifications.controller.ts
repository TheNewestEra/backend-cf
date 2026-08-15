import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {actionResponse} from "@game-worker/shared/http-exceptions";
import {currentUser} from "./auth.middleware";
import {createDb} from "./db/client";
import {listPending, markAllRead, markRead} from "./notifications.service";
import {NotificationSchema} from "./notifications.schema";

export const notificationsRoutes = new OpenAPIHono<{Bindings: Env}>();

const notLoggedIn = {error: "not logged in" as const};

// There is deliberately no `POST /api/notifications` here — a notification
// is only ever created server-to-server, via `NotificationsService.send()`/
// `.push()` (see index.ts), by a caller that has already applied its own
// business rules about who's allowed to notify whom. Letting any logged-in
// client hit an HTTP endpoint to notify an arbitrary other user would open
// this up to spam with no such gate. The routes below only ever act on the
// caller's own inbox.

notificationsRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/notifications",
        tags: ["Notifications"],
        summary: "List this user's unread notifications",
        description:
            "Covers anything sent via NotificationsService.send() while this client was offline or never " +
            "connected; new ones while connected also arrive over the WebSocket instead. push()-only " +
            "notifications (e.g. game invites, see apps/friends) aren't persisted here at all — each such " +
            "caller keeps its own pending-fetch equivalent. Returns an empty list for anonymous visitors " +
            "rather than 401 so the fetch can run unconditionally.",
        responses: {
            200: {
                description: "Unread notifications, newest first",
                content: {
                    "application/json": {
                        schema: z.object({notifications: z.array(NotificationSchema)}),
                    },
                },
            },
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json({notifications: []}, 200);

        // Deliberately always-200, same rationale as apps/friends' GET
        // /api/invites/pending — a D1 hiccup degrades to `[]` rather than
        // introducing an error case this endpoint's contract doesn't have.
        const notifications = await listPending(createDb(c.env.DB), user.id).unwrapOr([]);
        return c.json({notifications}, 200);
    },
);

notificationsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/notifications/{id}/read",
        tags: ["Notifications"],
        summary: "Mark one notification read",
        request: {params: z.object({id: z.string()})},
        responses: {
            200: {description: "Done", content: {"application/json": {schema: OkSchema}}},
            400: {description: "Not found", content: {"application/json": {schema: ErrorSchema}}},
            401: {
                description: "Not logged in",
                content: {"application/json": {schema: ErrorSchema}},
            },
            403: {description: "Not yours", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {id} = c.req.valid("param");
        const {status, body} = actionResponse(await markRead(createDb(c.env.DB), id, user.id));
        return c.json(body, status);
    },
);

notificationsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/notifications/read-all",
        tags: ["Notifications"],
        summary: "Mark every one of this user's unread notifications read",
        responses: {
            200: {description: "Done", content: {"application/json": {schema: OkSchema}}},
            401: {
                description: "Not logged in",
                content: {"application/json": {schema: ErrorSchema}},
            },
            500: {
                description: "Database error",
                content: {"application/json": {schema: ErrorSchema}},
            },
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const result = await markAllRead(createDb(c.env.DB), user.id);
        if (result.isErr()) return c.json({error: result.error}, 500);
        return c.json({ok: true as const}, 200);
    },
);

/** Real-time delivery channel for this user's notifications — see
 * notification.model.ts. One NotificationDO instance per user id, holding
 * a WebSocket per open tab. Not OpenAPI-documented: this is a WebSocket
 * upgrade. This is the direct replacement for apps/friends' old
 * invite-only `GET /api/notifications/ws` — every service pushes through
 * this one channel now instead of each owning its own. */
notificationsRoutes.get("/api/notifications/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
        return c.text("Expected WebSocket", 426);
    }
    const user = await currentUser(c);
    if (!user) return c.text("not logged in", 401);

    const stub = c.env.NOTIFICATION_DO.getByName(user.id);
    return stub.fetch(c.req.raw);
});
