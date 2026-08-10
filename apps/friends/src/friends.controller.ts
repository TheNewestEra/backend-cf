import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {GameKindSchema, playUrlFor} from "@game-worker/shared/game";
import {actionResponse} from "@game-worker/shared/http-exceptions";
import {currentUser} from "./auth.middleware";
import {
    acceptFriendRequest,
    addGroupMember,
    cancelFriendRequest,
    createGroup,
    declineFriendRequest,
    deleteGroup,
    getFriendsPageData,
    groupMemberIds,
    removeFriend,
    removeGroupMember,
    sendFriendRequest,
} from "./friends.service";
import {
    FriendRequestSummarySchema,
    FriendSummarySchema,
    GroupSummarySchema,
    InviteSummarySchema,
} from "./friends.schema";
import {createInvite, listPendingInvites, respondToInvite} from "./invites.service";

export const friendsRoutes = new OpenAPIHono<{ Bindings: Env }>();

const notLoggedIn = {error: "not logged in" as const};

/** Most friend/group actions share this shape: `{ok:true}` or a rejection
 * that's either a 403 (not yours to touch) or a 400 (bad state) — these are
 * the OpenAPI response *definitions*; the runtime status/body comes from
 * `actionResponse()` in @game-worker/shared/http-exceptions, so the two
 * can't drift apart. */
const actionResponses = {
    200: {description: "Done", content: {"application/json": {schema: OkSchema}}},
    400: {description: "Not found / already handled", content: {"application/json": {schema: ErrorSchema}}},
    401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
    403: {description: "Not yours to touch", content: {"application/json": {schema: ErrorSchema}}},
} as const;

friendsRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/friends",
        tags: ["Friends"],
        summary: "Get this user's friends, pending requests, groups, and invites",
        responses: {
            200: {
                description: "Friends page data",
                content: {
                    "application/json": {
                        schema: z.object({
                            friends: z.array(FriendSummarySchema),
                            incomingRequests: z.array(FriendRequestSummarySchema),
                            outgoingRequests: z.array(FriendRequestSummarySchema),
                            groups: z.array(GroupSummarySchema),
                            invites: z.array(InviteSummarySchema),
                        }),
                    },
                },
            },
            401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const [pageData, invites] = await Promise.all([
            getFriendsPageData(c.env.DB, user.id),
            listPendingInvites(c.env.DB, user.id),
        ]);
        return c.json({...pageData, invites}, 200);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/friends/request",
        tags: ["Friends"],
        summary: "Send a friend request by username",
        description: "If that user already sent us a pending request, this accepts it immediately instead of creating a second one.",
        request: {
            body: {content: {"application/json": {schema: z.object({username: z.string()})}}},
        },
        responses: {
            200: {
                description: "Request sent (or mutual request accepted)",
                content: {"application/json": {schema: OkSchema}}
            },
            400: {description: "No such user / already friends", content: {"application/json": {schema: ErrorSchema}}},
            401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {username} = c.req.valid("json");
        if (!username.trim()) return c.json({error: "username is required"}, 400);

        const result = await sendFriendRequest(c.env.DB, user.id, username.trim());
        if (!result.ok) return c.json({error: result.error}, 400);
        return c.json({ok: true as const}, 200);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/friends/requests/{id}/accept",
        tags: ["Friends"],
        summary: "Accept an incoming friend request",
        request: {params: z.object({id: z.string()})},
        responses: actionResponses,
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {id} = c.req.valid("param");
        const {status, body} = actionResponse(await acceptFriendRequest(c.env.DB, id, user.id));
        return c.json(body, status);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/friends/requests/{id}/decline",
        tags: ["Friends"],
        summary: "Decline an incoming friend request",
        request: {params: z.object({id: z.string()})},
        responses: actionResponses,
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {id} = c.req.valid("param");
        const {status, body} = actionResponse(await declineFriendRequest(c.env.DB, id, user.id));
        return c.json(body, status);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/friends/requests/{id}/cancel",
        tags: ["Friends"],
        summary: "Cancel an outgoing friend request",
        request: {params: z.object({id: z.string()})},
        responses: actionResponses,
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {id} = c.req.valid("param");
        const {status, body} = actionResponse(await cancelFriendRequest(c.env.DB, id, user.id));
        return c.json(body, status);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "delete",
        path: "/api/friends/{friendId}",
        tags: ["Friends"],
        summary: "Remove a friend",
        request: {params: z.object({friendId: z.string()})},
        responses: {
            200: {description: "Removed", content: {"application/json": {schema: OkSchema}}},
            401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {friendId} = c.req.valid("param");
        await removeFriend(c.env.DB, user.id, friendId);
        return c.json({ok: true as const}, 200);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/groups",
        tags: ["Friends"],
        summary: "Create a friend group",
        request: {
            body: {content: {"application/json": {schema: z.object({name: z.string()})}}},
        },
        responses: {
            200: {
                description: "Created group",
                content: {"application/json": {schema: z.object({group: GroupSummarySchema})}}
            },
            400: {description: "Name is required", content: {"application/json": {schema: ErrorSchema}}},
            401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {name} = c.req.valid("json");
        if (!name.trim()) return c.json({error: "name is required"}, 400);

        return c.json({group: await createGroup(c.env.DB, user.id, name.trim())}, 200);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "delete",
        path: "/api/groups/{id}",
        tags: ["Friends"],
        summary: "Delete a group you own",
        request: {params: z.object({id: z.string()})},
        responses: actionResponses,
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {id} = c.req.valid("param");
        const {status, body} = actionResponse(await deleteGroup(c.env.DB, user.id, id));
        return c.json(body, status);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/groups/{id}/members",
        tags: ["Friends"],
        summary: "Add a friend to a group you own",
        request: {
            params: z.object({id: z.string()}),
            body: {content: {"application/json": {schema: z.object({friendId: z.string()})}}},
        },
        responses: {
            200: {description: "Added", content: {"application/json": {schema: OkSchema}}},
            400: {
                description: "friendId is required, or forbidden/not-a-friend rejection",
                content: {"application/json": {schema: ErrorSchema}}
            },
            401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
            403: {description: "Not your group", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {id} = c.req.valid("param");
        const {friendId} = c.req.valid("json");
        if (!friendId) return c.json({error: "friendId is required"}, 400);

        const {status, body} = actionResponse(await addGroupMember(c.env.DB, user.id, id, friendId));
        return c.json(body, status);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "delete",
        path: "/api/groups/{id}/members/{friendId}",
        tags: ["Friends"],
        summary: "Remove a friend from a group you own",
        request: {params: z.object({id: z.string(), friendId: z.string()})},
        responses: actionResponses,
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {id, friendId} = c.req.valid("param");
        const {status, body} = actionResponse(await removeGroupMember(c.env.DB, user.id, id, friendId));
        return c.json(body, status);
    },
);

// --- game invites: created from a play page, accepted from the friends page

friendsRoutes.openapi(
    createRoute({
        method: "get",
        path: "/api/invites/pending",
        tags: ["Invites"],
        summary: "List invites sent to this user while they were offline",
        description: "New invites while connected arrive over the notifications WebSocket instead; this is not polled. Returns an empty list for anonymous visitors rather than 401 so the fetch can run unconditionally.",
        responses: {
            200: {
                description: "Pending invites",
                content: {"application/json": {schema: z.object({invites: z.array(InviteSummarySchema)})}}
            },
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json({invites: []}, 200);
        return c.json({invites: await listPendingInvites(c.env.DB, user.id)}, 200);
    },
);

/** Real-time delivery channel for this user's invites — see
 * notifications.model.ts. One UserDO instance per user id, holding a
 * WebSocket per open tab. Not OpenAPI-documented: this is a WebSocket
 * upgrade. */
friendsRoutes.get("/api/notifications/ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") {
        return c.text("Expected WebSocket", 426);
    }
    const user = await currentUser(c);
    if (!user) return c.text("not logged in", 401);

    const stub = c.env.USER_DO.getByName(user.id);
    return stub.fetch(c.req.raw);
});

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/invites",
        tags: ["Invites"],
        summary: "Invite a friend, or every member of a group, to a session",
        description: "Invites are only accepted before the session has started — both games reject joining once they have (see each game's own POST .../join) — so an invite sent after that point would 409 instead of landing the recipient on a game they can only spectate.",
        request: {
            body: {
                content: {
                    "application/json": {
                        schema: z.object({
                            kind: GameKindSchema,
                            sessionId: z.string(),
                            friendId: z.string().optional(),
                            groupId: z.string().optional(),
                        }),
                    },
                },
            },
        },
        responses: {
            200: {
                description: "Invited",
                content: {"application/json": {schema: z.object({ok: z.literal(true), invited: z.number()})}}
            },
            400: {description: "Missing fields", content: {"application/json": {schema: ErrorSchema}}},
            401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
            409: {
                description: "The session has already started",
                content: {"application/json": {schema: ErrorSchema}}
            },
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {kind, sessionId, friendId, groupId} = c.req.valid("json");

        // Both games reject joining once they've started (see each
        // service's own `join()` RPC) — an invite sent after that point
        // would land someone on a page they can only spectate, not play,
        // so invites are gated to the same pre-start window here. Checked
        // via service bindings rather than direct Durable Object bindings,
        // since each game's DO namespace belongs to a different Worker.
        if (kind === "puzzle") {
            const {status} = await c.env.PUZZLE.getLobbyStatus(sessionId);
            if (status !== "waiting" && status !== "queued" && status !== "generating") {
                return c.json({error: "Invites are only open before the puzzle starts."}, 409);
            }
        } else {
            const {status} = await c.env.GUESS.getStatus(sessionId);
            if (
                status !== "queued" &&
                status !== "generating_prompts" &&
                status !== "generating_images" &&
                status !== "waiting"
            ) {
                return c.json({error: "Invites are only open before the game starts."}, 409);
            }
        }

        let recipientIds: string[];
        if (friendId) {
            recipientIds = [friendId];
        } else if (groupId) {
            recipientIds = await groupMemberIds(c.env.DB, user.id, groupId);
        } else {
            return c.json({error: "friendId or groupId is required"}, 400);
        }

        await Promise.all(
            recipientIds.map(async (rid) => {
                const invite = await createInvite(c.env.DB, user.id, user.username, user.color, kind, sessionId, rid);
                // D1 write above is what actually matters — a dropped push just means
                // the recipient sees it on their next page load/reconnect instead of
                // instantly, via GET /api/invites/pending.
                await c.env.USER_DO.getByName(rid)
                    .notifyInvite(invite)
                    .catch((err) => {
                        console.error("failed to push invite notification", rid, err);
                    });
            }),
        );
        return c.json({ok: true as const, invited: recipientIds.length}, 200);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/invites/{id}/accept",
        tags: ["Invites"],
        summary: "Accept an invite",
        request: {params: z.object({id: z.string()})},
        responses: {
            200: {
                description: "Accepted",
                content: {"application/json": {schema: z.object({ok: z.literal(true), playUrl: z.string()})}}
            },
            400: {description: "Not found / already handled", content: {"application/json": {schema: ErrorSchema}}},
            401: {description: "Not logged in", content: {"application/json": {schema: ErrorSchema}}},
            403: {description: "Not your invite", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {id} = c.req.valid("param");
        const result = await respondToInvite(c.env.DB, id, user.id, true);
        if (!result.ok) return c.json({error: result.error}, result.error === "forbidden" ? 403 : 400);

        const playUrl = playUrlFor(result.kind, result.sessionId);
        return c.json({ok: true as const, playUrl}, 200);
    },
);

friendsRoutes.openapi(
    createRoute({
        method: "post",
        path: "/api/invites/{id}/decline",
        tags: ["Invites"],
        summary: "Decline an invite",
        request: {params: z.object({id: z.string()})},
        responses: actionResponses,
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {id} = c.req.valid("param");
        const result = await respondToInvite(c.env.DB, id, user.id, false);
        if (!result.ok) return c.json({error: result.error}, result.error === "forbidden" ? 403 : 400);
        return c.json({ok: true as const}, 200);
    },
);
