import {createRoute, OpenAPIHono, z} from "@hono/zod-openapi";
import {ErrorSchema, OkSchema} from "@game-worker/shared/common.schema";
import {GameKindSchema, playUrlFor} from "@game-worker/shared/game";
import {GameSessionStatus} from "@game-worker/shared/game-session-status";
import {actionResponse} from "@game-worker/shared/http-exceptions";
import {ResultAsync} from "neverthrow";
import {currentUser} from "./auth.middleware";
import {createDb} from "./db/client";
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
import {createInvite, type InviteSummary, listPendingInvites, respondToInvite} from "./invites.service";

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

// A `500: {description: "Database error", ...}` entry is inlined directly
// into each route below that can now surface one (rather than shared via
// spread) — `createRoute()`'s response-type inference needs each status
// code as its own literal object-literal key to build the discriminated
// `TypedResponse` union correctly; spreading a shared `as const` object in
// confuses that inference (produces the wrong response-type match on
// `c.json()`) even though the emitted OpenAPI JSON would be identical
// either way.

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
            500: {description: "Database error", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const db = createDb(c.env.DB);
        // Both reads are independent — `ResultAsync.combine()` runs them
        // concurrently the way `Promise.all()` would, but (unlike
        // `Promise.all()`) folds either side's D1 failure into one `Result`
        // instead of leaving it to reject unhandled.
        const combined = await ResultAsync.combine([getFriendsPageData(db, c.env.ACCOUNTS, user.id), listPendingInvites(db, c.env.ACCOUNTS, user.id)]);
        if (combined.isErr()) return c.json({error: combined.error}, 500);

        const [pageData, invites] = combined.value;
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

        const result = await sendFriendRequest(createDb(c.env.DB), c.env.ACCOUNTS, user.id, username.trim());
        if (result.isErr()) return c.json({error: result.error}, 400);

        if (result.value.kind === "requested") {
            const {requestId, recipientId} = result.value;
            await c.env.NOTIFICATIONS.push(recipientId, {
                id: requestId,
                type: "friend_request",
                title: "New friend request",
                body: `${user.username} wants to be friends.`,
                data: {requestId, username: user.username, color: user.color},
            }).catch((err) => {
                console.error("failed to push friend request notification", recipientId, err);
            });
        } else {
            const {otherUserId} = result.value;
            await c.env.NOTIFICATIONS.push(otherUserId, {
                type: "message",
                title: "Friend request accepted",
                body: `${user.username} accepted your friend request.`,
                data: {friendId: user.id, username: user.username, color: user.color},
            }).catch((err) => {
                console.error("failed to push friend-request-accepted notification", otherUserId, err);
            });
        }

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

        const result = await acceptFriendRequest(createDb(c.env.DB), id, user.id);
        if (result.isOk()) {
            const {requesterId} = result.value;
            // Live notification for the original requester — best-effort,
            // see apps/notifications. A generic, non-interactive "message"
            // (there's nothing left to accept/decline), unlike the
            // "friend_request" notification that got them here.
            await c.env.NOTIFICATIONS.push(requesterId, {
                type: "message",
                title: "Friend request accepted",
                body: `${user.username} accepted your friend request.`,
                data: {friendId: user.id, username: user.username, color: user.color},
            }).catch((err) => {
                console.error("failed to push friend-request-accepted notification", requesterId, err);
            });
        }

        const {status, body} = actionResponse(result.map(() => undefined));
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
        const {status, body} = actionResponse(await declineFriendRequest(createDb(c.env.DB), id, user.id));
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
        const {status, body} = actionResponse(await cancelFriendRequest(createDb(c.env.DB), id, user.id));
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
            500: {description: "Database error", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);
        const {friendId} = c.req.valid("param");
        const result = await removeFriend(createDb(c.env.DB), user.id, friendId);
        if (result.isErr()) return c.json({error: result.error}, 500);
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
            500: {description: "Database error", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {name} = c.req.valid("json");
        if (!name.trim()) return c.json({error: "name is required"}, 400);

        const result = await createGroup(createDb(c.env.DB), user.id, name.trim());
        if (result.isErr()) return c.json({error: result.error}, 500);
        return c.json({group: result.value}, 200);
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
        const {status, body} = actionResponse(await deleteGroup(createDb(c.env.DB), user.id, id));
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

        const {status, body} = actionResponse(await addGroupMember(createDb(c.env.DB), user.id, id, friendId));
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
        const {status, body} = actionResponse(await removeGroupMember(createDb(c.env.DB), user.id, id, friendId));
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
        description: "New invites while connected arrive over apps/notifications' WebSocket instead (see POST /api/invites below); this is not polled. Returns an empty list for anonymous visitors rather than 401 so the fetch can run unconditionally.",
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

        // This endpoint is deliberately always-200 (an anonymous visitor
        // already gets `[]` above rather than a 401) — a D1 hiccup degrades
        // the same way, via `.unwrapOr([])`, rather than introducing the
        // one error case this endpoint's contract doesn't have.
        const invites = await listPendingInvites(createDb(c.env.DB), c.env.ACCOUNTS, user.id).unwrapOr([]);
        return c.json({invites}, 200);
    },
);

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
            500: {description: "Database error", content: {"application/json": {schema: ErrorSchema}}},
        },
    }),
    async (c) => {
        const user = await currentUser(c);
        if (!user) return c.json(notLoggedIn, 401);

        const {kind, sessionId, friendId, groupId} = c.req.valid("json");
        const db = createDb(c.env.DB);

        // Both games reject joining once they've started (see each
        // service's own `join()` RPC) — an invite sent after that point
        // would land someone on a page they can only spectate, not play,
        // so invites are gated to the same pre-start window here. Checked
        // via service bindings rather than direct Durable Object bindings,
        // since each game's DO namespace belongs to a different Worker.
        if (kind === "puzzle") {
            const {status} = await c.env.PUZZLE.getLobbyStatus(sessionId);
            if (
                status !== GameSessionStatus.Waiting &&
                status !== GameSessionStatus.Queued &&
                status !== GameSessionStatus.Generating
            ) {
                return c.json({error: "Invites are only open before the puzzle starts."}, 409);
            }
        } else {
            const {status} = await c.env.GUESS.getStatus(sessionId);
            if (
                status !== GameSessionStatus.Queued &&
                status !== GameSessionStatus.Generating &&
                status !== GameSessionStatus.Waiting
            ) {
                return c.json({error: "Invites are only open before the game starts."}, 409);
            }
        }

        let recipientIds: string[];
        if (friendId) {
            recipientIds = [friendId];
        } else if (groupId) {
            recipientIds = await groupMemberIds(db, user.id, groupId);
        } else {
            return c.json({error: "friendId or groupId is required"}, 400);
        }

        // Every recipient's invite is written independently — same
        // concurrency `Promise.all()` gave this, but `ResultAsync.combine()`
        // folds the first D1 failure into one `Result` instead of an
        // unhandled rejection (any invite that did successfully write
        // stays written either way, same as before).
        const invitesResult = await ResultAsync.combine(
            recipientIds.map((rid) => createInvite(db, user.id, user.username, user.color, kind, sessionId, rid)),
        );
        if (invitesResult.isErr()) return c.json({error: invitesResult.error}, 500);

        // D1 writes above are what actually matter — a dropped push just
        // means the recipient sees it on their next page load/reconnect
        // instead of instantly, via GET /api/invites/pending. Delivery-only
        // (`push`, not `send`): `game_invites` is already this invite's
        // source of truth, so a second, persisted copy in apps/notifications'
        // own inbox table would just be two copies of the same fact able to
        // drift — see @game-worker/shared/rpc-types' `NotificationsRpc`.
        // Reuses the invite's own id as the pushed notification's id.
        await Promise.all(
            invitesResult.value.map((invite: InviteSummary, i: number) =>
                c.env.NOTIFICATIONS.push(recipientIds[i]!, {
                    id: invite.id,
                    type: "invite",
                    data: invite
                }).catch((err) => {
                    console.error("failed to push invite notification", recipientIds[i], err);
                }),
            ),
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
        description:
            "Accepting auto-joins the session under the recipient's account — only a logged-in caller can ever " +
            "reach this endpoint, so unlike the games' own POST .../join-style flows there's no anonymous " +
            "name/color/token to supply here, just the account's own username/color. The join itself is best-" +
            "effort: if the session started in the gap between the invite being sent and accepted, the invite " +
            "is still marked accepted and `playUrl` is still returned — the recipient just lands there able to " +
            "spectate, not play, same as visiting an already-started session's page directly.",
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
        const result = await respondToInvite(createDb(c.env.DB), id, user.id, true);
        if (result.isErr()) return c.json({error: result.error}, result.error === "forbidden" ? 403 : 400);

        const {kind, sessionId} = result.value;
        const service = kind === "puzzle" ? c.env.PUZZLE : c.env.GUESS;
        // We are fine with this failing... the user will be able to join via button or be spectator.
        await service.joinAsUser(sessionId, user.id, user.username, user.color).catch((err) => {
            console.error("failed to auto-join accepted invite", id, err);
        });
        const playUrl = playUrlFor(kind, sessionId);
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
        const result = await respondToInvite(createDb(c.env.DB), id, user.id, false);
        const {status, body} = actionResponse(result.map(() => undefined));
        return c.json(body, status);
    },
);
