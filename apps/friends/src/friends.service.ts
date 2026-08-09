import type {Database} from "@game-worker/shared/db";
import type {z} from "@hono/zod-openapi";
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

type ActionResult = { ok: true } | { ok: false; error: string };

/** `users` is owned by the accounts service — this is a direct read
 * against the shared physical database (never a write), the same
 * pragmatic pattern `leaderboard` uses for display-name joins. Kept local
 * rather than imported across the app boundary since apps/accounts is a
 * separately deployed Worker, not a shared package. */
async function findUserByUsername(db: Database, username: string): Promise<{ id: string; username: string; color: string } | null> {
    const row = await db
        .prepare("SELECT id, username, color FROM users WHERE username_lower = ?")
        .bind(username.trim().toLowerCase())
        .first<{ id: string; username: string; color: string }>();
    return row ?? null;
}

// --- friend requests -------------------------------------------------------

export async function sendFriendRequest(
    db: Database,
    requesterId: string,
    recipientUsername: string,
): Promise<ActionResult> {
    const recipient = await findUserByUsername(db, recipientUsername);
    if (!recipient) return {ok: false, error: "No user with that username."};
    if (recipient.id === requesterId) return {ok: false, error: "You can't friend yourself."};

    const alreadyFriends = await db
        .prepare("SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?")
        .bind(requesterId, recipient.id)
        .first();
    if (alreadyFriends) return {ok: false, error: "You're already friends."};

    // Mutual request: they already asked us — accept immediately rather than
    // leaving two pending rows pointing at each other.
    const reverseRequest = await db
        .prepare("SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'")
        .bind(recipient.id, requesterId)
        .first<{ id: string }>();
    if (reverseRequest) {
        return acceptFriendRequest(db, reverseRequest.id, requesterId);
    }

    const id = crypto.randomUUID();
    await db
        .prepare(
            `INSERT INTO friend_requests (id, requester_id, recipient_id, status, created_at, responded_at)
             VALUES (?, ?, ?, 'pending', ?, NULL) ON CONFLICT(requester_id, recipient_id)
       DO
            UPDATE SET status = 'pending', created_at = excluded.created_at, responded_at = NULL`,
        )
        .bind(id, requesterId, recipient.id, Date.now())
        .run();

    return {ok: true};
}

interface FriendRequestRow {
    requester_id: string;
    recipient_id: string;
    status: string;
}

export async function acceptFriendRequest(
    db: Database,
    requestId: string,
    actingUserId: string,
): Promise<ActionResult> {
    const req = await db
        .prepare("SELECT requester_id, recipient_id, status FROM friend_requests WHERE id = ?")
        .bind(requestId)
        .first<FriendRequestRow>();
    if (!req) return {ok: false, error: "Request not found."};
    if (req.recipient_id !== actingUserId) return {ok: false, error: "forbidden"};
    if (req.status !== "pending") return {ok: false, error: "Request already handled."};

    const now = Date.now();
    await db.batch([
        db.prepare("UPDATE friend_requests SET status = 'accepted', responded_at = ? WHERE id = ?").bind(now, requestId),
        db
            .prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)")
            .bind(req.requester_id, req.recipient_id, now),
        db
            .prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)")
            .bind(req.recipient_id, req.requester_id, now),
    ]);
    return {ok: true};
}

export async function declineFriendRequest(
    db: Database,
    requestId: string,
    actingUserId: string,
): Promise<ActionResult> {
    const req = await db
        .prepare("SELECT recipient_id, status FROM friend_requests WHERE id = ?")
        .bind(requestId)
        .first<{ recipient_id: string; status: string }>();
    if (!req) return {ok: false, error: "Request not found."};
    if (req.recipient_id !== actingUserId) return {ok: false, error: "forbidden"};
    if (req.status !== "pending") return {ok: false, error: "Request already handled."};

    await db
        .prepare("UPDATE friend_requests SET status = 'declined', responded_at = ? WHERE id = ?")
        .bind(Date.now(), requestId)
        .run();
    return {ok: true};
}

export async function cancelFriendRequest(
    db: Database,
    requestId: string,
    actingUserId: string,
): Promise<ActionResult> {
    const req = await db
        .prepare("SELECT requester_id FROM friend_requests WHERE id = ?")
        .bind(requestId)
        .first<{ requester_id: string }>();
    if (!req) return {ok: false, error: "Request not found."};
    if (req.requester_id !== actingUserId) return {ok: false, error: "forbidden"};

    await db.prepare("DELETE FROM friend_requests WHERE id = ?").bind(requestId).run();
    return {ok: true};
}

export async function removeFriend(db: Database, userId: string, friendId: string): Promise<void> {
    await db.batch([
        db.prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ?").bind(userId, friendId),
        db.prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ?").bind(friendId, userId),
    ]);
}

// --- groups ------------------------------------------------------------

const MAX_GROUP_NAME_LENGTH = 60;

export async function createGroup(db: Database, ownerId: string, rawName: string): Promise<GroupSummary> {
    const name = rawName.trim().slice(0, MAX_GROUP_NAME_LENGTH);
    const id = crypto.randomUUID();
    await db
        .prepare("INSERT INTO friend_groups (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)")
        .bind(id, ownerId, name, Date.now())
        .run();
    return {id, name, members: []};
}

export async function deleteGroup(db: Database, ownerId: string, groupId: string): Promise<ActionResult> {
    const group = await db
        .prepare("SELECT owner_id FROM friend_groups WHERE id = ?")
        .bind(groupId)
        .first<{ owner_id: string }>();
    if (!group || group.owner_id !== ownerId) return {ok: false, error: "forbidden"};

    await db.batch([
        db.prepare("DELETE FROM friend_group_members WHERE group_id = ?").bind(groupId),
        db.prepare("DELETE FROM friend_groups WHERE id = ?").bind(groupId),
    ]);
    return {ok: true};
}

export async function addGroupMember(
    db: Database,
    ownerId: string,
    groupId: string,
    friendId: string,
): Promise<ActionResult> {
    const group = await db
        .prepare("SELECT owner_id FROM friend_groups WHERE id = ?")
        .bind(groupId)
        .first<{ owner_id: string }>();
    if (!group || group.owner_id !== ownerId) return {ok: false, error: "forbidden"};

    const isFriend = await db
        .prepare("SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?")
        .bind(ownerId, friendId)
        .first();
    if (!isFriend) return {ok: false, error: "That's not one of your friends."};

    await db
        .prepare("INSERT OR IGNORE INTO friend_group_members (group_id, friend_id) VALUES (?, ?)")
        .bind(groupId, friendId)
        .run();
    return {ok: true};
}

export async function removeGroupMember(
    db: Database,
    ownerId: string,
    groupId: string,
    friendId: string,
): Promise<ActionResult> {
    const group = await db
        .prepare("SELECT owner_id FROM friend_groups WHERE id = ?")
        .bind(groupId)
        .first<{ owner_id: string }>();
    if (!group || group.owner_id !== ownerId) return {ok: false, error: "forbidden"};

    await db
        .prepare("DELETE FROM friend_group_members WHERE group_id = ? AND friend_id = ?")
        .bind(groupId, friendId)
        .run();
    return {ok: true};
}

/** Resolves a group to its member ids, only if `ownerId` actually owns it —
 * used when fanning out a group invite. Returns [] if not the owner. */
export async function groupMemberIds(db: Database, ownerId: string, groupId: string): Promise<string[]> {
    const group = await db
        .prepare("SELECT owner_id FROM friend_groups WHERE id = ?")
        .bind(groupId)
        .first<{ owner_id: string }>();
    if (!group || group.owner_id !== ownerId) return [];

    const {results} = await db
        .prepare("SELECT friend_id FROM friend_group_members WHERE group_id = ?")
        .bind(groupId)
        .all<{ friend_id: string }>();
    return results.map((r) => r.friend_id);
}

async function listGroups(db: Database, ownerId: string): Promise<GroupSummary[]> {
    const {results: groups} = await db
        .prepare("SELECT id, name FROM friend_groups WHERE owner_id = ? ORDER BY name")
        .bind(ownerId)
        .all<{ id: string; name: string }>();

    // Each group's members are an independent D1 read, so fetch them all
    // concurrently rather than one group at a time.
    return Promise.all(
        groups.map(async (group) => {
            const {results: members} = await db
                .prepare(
                    `SELECT u.id, u.username, u.color
                     FROM friend_group_members m
                              JOIN users u ON u.id = m.friend_id
                     WHERE m.group_id = ?
                     ORDER BY u.username`,
                )
                .bind(group.id)
                .all<FriendSummary>();
            return {id: group.id, name: group.name, members};
        }),
    );
}

// --- combined view for the friends page -----------------------------------

export async function getFriendsPageData(db: Database, userId: string): Promise<FriendsPageData> {
    const [friends, incoming, outgoing, groups] = await Promise.all([
        db
            .prepare(
                `SELECT u.id, u.username, u.color
                 FROM friendships f
                          JOIN users u ON u.id = f.friend_id
                 WHERE f.user_id = ?
                 ORDER BY u.username`,
            )
            .bind(userId)
            .all<FriendSummary>(),
        db
            .prepare(
                `SELECT r.id, u.username, u.color, r.created_at
                 FROM friend_requests r
                          JOIN users u ON u.id = r.requester_id
                 WHERE r.recipient_id = ?
                   AND r.status = 'pending'
                 ORDER BY r.created_at DESC`,
            )
            .bind(userId)
            .all<FriendRequestSummary>(),
        db
            .prepare(
                `SELECT r.id, u.username, u.color, r.created_at
                 FROM friend_requests r
                          JOIN users u ON u.id = r.recipient_id
                 WHERE r.requester_id = ?
                   AND r.status = 'pending'
                 ORDER BY r.created_at DESC`,
            )
            .bind(userId)
            .all<FriendRequestSummary>(),
        listGroups(db, userId),
    ]);

    return {
        friends: friends.results,
        incomingRequests: incoming.results,
        outgoingRequests: outgoing.results,
        groups,
    };
}
