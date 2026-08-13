import type {z} from "@hono/zod-openapi";
import {and, asc, desc, eq} from "drizzle-orm";
import {err, ok, ResultAsync} from "neverthrow";
import type {Db} from "./db/client";
import {query, requireFound} from "./db/result";
import {friendGroupMembers, friendGroups, friendRequests, friendships} from "./db/schema";
import {users} from "./db/users-ref";
import type {FriendRequestSummarySchema, FriendSummarySchema, GroupSummarySchema} from "./friends.schema";

export type FriendSummary = z.infer<typeof FriendSummarySchema>;
export type FriendRequestSummary = z.infer<typeof FriendRequestSummarySchema>;
export type GroupSummary = z.infer<typeof GroupSummarySchema>;

export interface FriendsPageData {
    friends: FriendSummary[];
    incomingRequests: FriendRequestSummary[];
    outgoingRequests: FriendRequestSummary[];
    groups: GroupSummary[];
}


const findUserByUsername = (db: Db, username: string): ResultAsync<{
    id: string;
    username: string;
    color: string
}, string> =>
    query(
        db
            .select({id: users.id, username: users.username, color: users.color})
            .from(users)
            .where(eq(users.usernameLower, username.trim().toLowerCase()))
            .get(),
    )
        .andThen((rows) => requireFound(rows, "No user with that username."));

// --- friend requests -------------------------------------------------------

export type SendFriendRequestResult =
    | { kind: "requested"; requestId: string; recipientId: string }
    | { kind: "auto_accepted"; otherUserId: string };

export const sendFriendRequest = (
    db: Db,
    requesterId: string,
    recipientUsername: string,
): ResultAsync<SendFriendRequestResult, string> =>
    findUserByUsername(db, recipientUsername)
        .andThen((req) => (req.id !== requesterId ? ok(req) : err("forbidden")))
        .andThen((recipient) =>
            query(
                db
                    .select({userId: friendships.userId})
                    .from(friendships)
                    .where(and(eq(friendships.userId, requesterId), eq(friendships.friendId, recipient.id)))
                    .get()
            )
                .andThen((friend) => friend ? err("You're already friends.") : ok())
                .map(() => recipient)
        )
        .andThen((recipient) =>
            query(
                db
                    .select({id: friendRequests.id})
                    .from(friendRequests)
                    .where(
                        and(
                            eq(friendRequests.requesterId, recipient.id),
                            eq(friendRequests.recipientId, requesterId),
                            eq(friendRequests.status, "pending")
                        )
                    )
                    .get()
            ).map((reverseRequest) => ({recipient, reverseRequest}))
        )
        .andThen(({recipient, reverseRequest}): ResultAsync<SendFriendRequestResult, string> => {
            if (reverseRequest) {
                return acceptFriendRequest(db, reverseRequest.id, requesterId).map(
                    ({requesterId: otherUserId}): SendFriendRequestResult => ({kind: "auto_accepted", otherUserId}),
                );
            }

            return query(
                db
                    .insert(friendRequests)
                    .values({
                        id: crypto.randomUUID(),
                        requesterId,
                        recipientId: recipient.id,
                        status: "pending",
                        createdAt: Date.now(),
                        respondedAt: null,
                    })
                    .onConflictDoUpdate({
                        target: [friendRequests.requesterId, friendRequests.recipientId],
                        set: {status: "pending", createdAt: Date.now(), respondedAt: null},
                    })
                    .returning({id: friendRequests.id})
            )
                .andThen((rows) => requireFound(rows[0], "Failed to create the friend request."))
                .map((row): SendFriendRequestResult => ({
                    kind: "requested",
                    requestId: row.id,
                    recipientId: recipient.id
                }));
        });

const executeAcceptBatch = (db: Db, requestId: string, requesterId: string, recipientId: string) => {
    const now = Date.now();
    return query(
        db.batch([
            db
                .update(friendRequests)
                .set({status: "accepted", respondedAt: now})
                .where(eq(friendRequests.id, requestId)),
            db
                .insert(friendships)
                .values({userId: requesterId, friendId: recipientId, createdAt: now})
                .onConflictDoNothing(),
            db
                .insert(friendships)
                .values({userId: recipientId, friendId: requesterId, createdAt: now})
                .onConflictDoNothing(),
        ])
    );
};

/** Returns the original requester's id so the caller (friends.controller.ts,
 * or sendFriendRequest's own auto-accept branch above) can push them a
 * live "accepted" notification — see NOTIFICATIONS.push() at each call
 * site. */
export const acceptFriendRequest = (
    db: Db,
    requestId: string,
    actingUserId: string,
): ResultAsync<{ requesterId: string }, string> =>
    query(
        db
            .select({
                requesterId: friendRequests.requesterId,
                recipientId: friendRequests.recipientId,
                status: friendRequests.status,
            })
            .from(friendRequests)
            .where(eq(friendRequests.id, requestId))
            .get()
    )
        .andThen((req) => requireFound(req, "Request not found."))
        .andThen((req) => req.recipientId === actingUserId ? ok(req) : err("forbidden"))
        .andThen((req) => req.status === "pending" ? ok(req) : err("Request already handled."))
        .andThen((req) =>
            executeAcceptBatch(db, requestId, req.requesterId, req.recipientId).map(() => ({
                requesterId: req.requesterId,
            })),
        );

export const declineFriendRequest = (db: Db, requestId: string, actingUserId: string): ResultAsync<void, string> =>
    query(
        db
            .select({recipientId: friendRequests.recipientId, status: friendRequests.status})
            .from(friendRequests)
            .where(eq(friendRequests.id, requestId))
            .get(),
    )
        .andThen((req) => requireFound(req, "Request not found."))
        .andThen((req) => (req.recipientId === actingUserId ? ok(req) : err("forbidden")))
        .andThen((req) => (req.status === "pending" ? ok(req) : err("Request already handled.")))
        .andThen(() =>
            query(
                db
                    .update(friendRequests)
                    .set({status: "declined", respondedAt: Date.now()})
                    .where(eq(friendRequests.id, requestId)),
            ),
        )
        .map(_ => undefined);

export const cancelFriendRequest = (db: Db, requestId: string, actingUserId: string): ResultAsync<void, string> =>
    query(
        db.select({requesterId: friendRequests.requesterId}).from(friendRequests).where(eq(friendRequests.id, requestId)).then((rows) => rows[0]),
    )
        .andThen((req) => requireFound(req, "Request not found."))
        .andThen((req) => (req.requesterId === actingUserId ? ok(req) : err("forbidden")))
        .andThen(() => query(db.delete(friendRequests).where(eq(friendRequests.id, requestId))))
        .map(() => undefined);

export const removeFriend = (db: Db, userId: string, friendId: string): ResultAsync<void, string> =>
    query(
        db.batch([
            db.delete(friendships).where(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId))),
            db.delete(friendships).where(and(eq(friendships.userId, friendId), eq(friendships.friendId, userId))),
        ]),
    ).map(_ => undefined);

// --- groups ------------------------------------------------------------

const MAX_GROUP_NAME_LENGTH = 60;

export const createGroup = (db: Db, ownerId: string, rawName: string): ResultAsync<GroupSummary, string> => {
    const name = rawName.trim().slice(0, MAX_GROUP_NAME_LENGTH);
    const id = crypto.randomUUID();
    return query(db.insert(friendGroups).values({id, ownerId, name, createdAt: Date.now()})).map(() => ({
        id,
        name,
        members: []
    }));
};

const requireOwnedGroup = (db: Db, ownerId: string, groupId: string): ResultAsync<{ ownerId: string }, string> =>
    query(
        db
            .select({ownerId: friendGroups.ownerId})
            .from(friendGroups)
            .where(eq(friendGroups.id, groupId))
            .get()
    )
        .andThen((group) => requireFound(group, "forbidden"))
        .andThen((group) => (group.ownerId === ownerId ? ok(group) : err("forbidden")));

export const deleteGroup = (db: Db, ownerId: string, groupId: string): ResultAsync<void, string> =>
    requireOwnedGroup(db, ownerId, groupId)
        .andThen(_ =>
            query(
                db.batch([
                    db.delete(friendGroupMembers).where(eq(friendGroupMembers.groupId, groupId)),
                    db.delete(friendGroups).where(eq(friendGroups.id, groupId)),
                ]),
            ),
        )
        .map(_ => undefined);

export const addGroupMember = (db: Db, ownerId: string, groupId: string, friendId: string): ResultAsync<void, string> =>
    requireOwnedGroup(db, ownerId, groupId)
        .andThen(_ => query(
            db
                .select({friendId: friendships.friendId})
                .from(friendships)
                .where(and(eq(friendships.userId, ownerId), eq(friendships.friendId, friendId)))
                .get()
        ))
        .andThen((friend) => requireFound(friend, "That's not one of your friends."))
        .map(friend => friend.friendId)
        .andThen((verifiedFriendId) =>
            query(
                db
                    .insert(friendGroupMembers)
                    .values({groupId, friendId: verifiedFriendId})
                    .onConflictDoNothing()
            )
        )
        .map(_ => undefined);


export const removeGroupMember = (db: Db, ownerId: string, groupId: string, friendId: string): ResultAsync<void, string> =>
    requireOwnedGroup(db, ownerId, groupId)
        .andThen(_ =>
            query(
                db
                    .delete(friendGroupMembers)
                    .where(and(eq(friendGroupMembers.groupId, groupId), eq(friendGroupMembers.friendId, friendId))),
            ),
        )
        .map(_ => undefined);

export const groupMemberIds = (db: Db, ownerId: string, groupId: string): Promise<string[]> =>
    requireOwnedGroup(db, ownerId, groupId)
        .andThen(_ => query(
            db
                .select({friendId: friendGroupMembers.friendId})
                .from(friendGroupMembers)
                .where(eq(friendGroupMembers.groupId, groupId))),
        )
        .map((rows) => rows.map((r) => r.friendId))
        .unwrapOr([]);

const listGroups = (db: Db, ownerId: string): ResultAsync<GroupSummary[], string> =>
    query(
        db.select({id: friendGroups.id, name: friendGroups.name})
            .from(friendGroups).where(eq(friendGroups.ownerId, ownerId))
            .orderBy(asc(friendGroups.name)),
    ).andThen((groups) =>
        ResultAsync.combine(
            groups.map((group) =>
                query(
                    db
                        .select({id: users.id, username: users.username, color: users.color})
                        .from(friendGroupMembers)
                        .innerJoin(users, eq(users.id, friendGroupMembers.friendId))
                        .where(eq(friendGroupMembers.groupId, group.id))
                        .orderBy(asc(users.username)),
                ).map((members) => ({id: group.id, name: group.name, members})),
            ),
        ),
    );

// --- combined view for the friends page -----------------------------------

/** `ResultAsync.combine()` over a fixed 4-tuple keeps each branch's own
 * type (unlike `listGroups()`'s homogeneous array case above) — the same
 * concurrency `Promise.all()` gave this, now folding the first D1 failure
 * into one `Result` instead of an unhandled rejection. */
export const getFriendsPageData = (db: Db, userId: string): ResultAsync<FriendsPageData, string> =>
    ResultAsync.combine([
        query(
            db
                .select({id: users.id, username: users.username, color: users.color})
                .from(friendships)
                .innerJoin(users, eq(users.id, friendships.friendId))
                .where(eq(friendships.userId, userId))
                .orderBy(asc(users.username)),
        ),
        query(
            db
                .select({
                    id: friendRequests.id,
                    username: users.username,
                    color: users.color,
                    created_at: friendRequests.createdAt,
                })
                .from(friendRequests)
                .innerJoin(users, eq(users.id, friendRequests.requesterId))
                .where(and(eq(friendRequests.recipientId, userId), eq(friendRequests.status, "pending")))
                .orderBy(desc(friendRequests.createdAt)),
        ),
        query(
            db
                .select({
                    id: friendRequests.id,
                    username: users.username,
                    color: users.color,
                    created_at: friendRequests.createdAt,
                })
                .from(friendRequests)
                .innerJoin(users, eq(users.id, friendRequests.recipientId))
                .where(and(eq(friendRequests.requesterId, userId), eq(friendRequests.status, "pending")))
                .orderBy(desc(friendRequests.createdAt)),
        ),
        listGroups(db, userId),
    ]).map(([friends, incoming, outgoing, groups]) => ({
        friends,
        incomingRequests: incoming,
        outgoingRequests: outgoing,
        groups,
    }));
