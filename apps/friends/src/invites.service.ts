import type {Database} from "@game-worker/shared/db";
import type {z} from "@hono/zod-openapi";
import type {InviteSummarySchema} from "./friends.schema";

export type InviteSummary = z.infer<typeof InviteSummarySchema>;
export type InviteKind = InviteSummary["kind"];

/** Returns the created invite's public shape so the caller can push it over
 * the recipient's notifications DO WebSocket without a round-trip read back
 * from D1. */
export async function createInvite(
    db: Database,
    inviterId: string,
    inviterUsername: string,
    inviterColor: string,
    kind: InviteKind,
    sessionId: string,
    recipientId: string,
): Promise<InviteSummary> {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    await db
        .prepare(
            `INSERT INTO game_invites (id, kind, session_id, inviter_id, recipient_id, status, created_at, responded_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
        )
        .bind(id, kind, sessionId, inviterId, recipientId, createdAt)
        .run();
    return {id, kind, sessionId, inviterUsername, inviterColor, createdAt};
}

interface InviteRow {
    id: string;
    kind: InviteKind;
    session_id: string;
    inviter_username: string;
    inviter_color: string;
    created_at: number;
}

export async function listPendingInvites(db: Database, recipientId: string): Promise<InviteSummary[]> {
    const {results} = await db
        .prepare(
            `SELECT gi.id, gi.kind, gi.session_id, u.username AS inviter_username, u.color AS inviter_color, gi.created_at
             FROM game_invites gi
                      JOIN users u ON u.id = gi.inviter_id
             WHERE gi.recipient_id = ?
               AND gi.status = 'pending'
             ORDER BY gi.created_at DESC`,
        )
        .bind(recipientId)
        .all<InviteRow>();

    return results.map((r) => ({
        id: r.id,
        kind: r.kind,
        sessionId: r.session_id,
        inviterUsername: r.inviter_username,
        inviterColor: r.inviter_color,
        createdAt: r.created_at,
    }));
}

export type RespondResult =
    | { ok: true; kind: InviteKind; sessionId: string }
    | { ok: false; error: string };

export async function respondToInvite(
    db: Database,
    inviteId: string,
    recipientId: string,
    accept: boolean,
): Promise<RespondResult> {
    const row = await db
        .prepare("SELECT recipient_id, status, kind, session_id FROM game_invites WHERE id = ?")
        .bind(inviteId)
        .first<{ recipient_id: string; status: string; kind: InviteKind; session_id: string }>();
    if (!row) return {ok: false, error: "Invite not found."};
    if (row.recipient_id !== recipientId) return {ok: false, error: "forbidden"};
    if (row.status !== "pending") return {ok: false, error: "Invite already handled."};

    await db
        .prepare("UPDATE game_invites SET status = ?, responded_at = ? WHERE id = ?")
        .bind(accept ? "accepted" : "declined", Date.now(), inviteId)
        .run();

    return {ok: true, kind: row.kind, sessionId: row.session_id};
}
