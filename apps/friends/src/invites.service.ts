import type {z} from "@hono/zod-openapi";
import type {AccountsRpc} from "@game-worker/shared/rpc-types";
import {and, desc, eq} from "drizzle-orm";
import {err, ok, type ResultAsync} from "neverthrow";
import type {Db} from "./db/client";
import {query, requireFound} from "./db/result";
import {gameInvites} from "./db/schema";
import type {InviteSummarySchema} from "./friends.schema";

export type InviteSummary = z.infer<typeof InviteSummarySchema>;
export type InviteKind = InviteSummary["kind"];

/** Returns the created invite's public shape so the caller can push it over
 * the recipient's apps/notifications WebSocket (via `NOTIFICATIONS.push()`)
 * without a round-trip read back from D1. */
export const createInvite = (
    db: Db,
    inviterId: string,
    inviterUsername: string,
    inviterColor: string,
    kind: InviteKind,
    sessionId: string,
    recipientId: string,
): ResultAsync<InviteSummary, string> => {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    return query(
        db.insert(gameInvites).values({id, kind, sessionId, inviterId, recipientId, status: "pending", createdAt, respondedAt: null}),
    ).map(() => ({id, kind, sessionId, inviterUsername, inviterColor, createdAt}));
};

/** Batch-resolves each invite's `inviterId` to a display name/color via one
 * `AccountsRpc.getUsersByIds` call instead of a `users` JOIN — see
 * friends.service.ts's `getFriendsPageData` for the same pattern. An
 * invite whose inviter no longer resolves (shouldn't happen) is dropped
 * rather than shown with a blank name. */
export const listPendingInvites = (db: Db, accounts: AccountsRpc, recipientId: string): ResultAsync<InviteSummary[], string> =>
    query(
        db
            .select({
                id: gameInvites.id,
                kind: gameInvites.kind,
                sessionId: gameInvites.sessionId,
                inviterId: gameInvites.inviterId,
                createdAt: gameInvites.createdAt,
            })
            .from(gameInvites)
            .where(and(eq(gameInvites.recipientId, recipientId), eq(gameInvites.status, "pending")))
            .orderBy(desc(gameInvites.createdAt)),
    ).andThen((rows) =>
        query(accounts.getUsersByIds(rows.map((r) => r.inviterId))).map((users) => {
            const byId = new Map(users.map((u) => [u.id, u]));
            return rows.flatMap((row) => {
                const user = byId.get(row.inviterId);
                return user
                    ? [
                          {
                              id: row.id,
                              kind: row.kind,
                              sessionId: row.sessionId,
                              inviterUsername: user.username,
                              inviterColor: user.color,
                              createdAt: row.createdAt,
                          },
                      ]
                    : [];
            });
        }),
    );

export interface RespondedInvite {
    kind: InviteKind;
    sessionId: string;
}

export const respondToInvite = (
    db: Db,
    inviteId: string,
    recipientId: string,
    accept: boolean,
): ResultAsync<RespondedInvite, string> =>
    query(
        db
            .select({
                recipientId: gameInvites.recipientId,
                status: gameInvites.status,
                kind: gameInvites.kind,
                sessionId: gameInvites.sessionId,
            })
            .from(gameInvites)
            .where(eq(gameInvites.id, inviteId))
            .then((rows) => rows[0]),
    )
        .andThen((row) => requireFound(row, "Invite not found."))
        .andThen((row) => (row.recipientId === recipientId ? ok(row) : err("forbidden")))
        .andThen((row) => (row.status === "pending" ? ok(row) : err("Invite already handled.")))
        .andThen((row) =>
            query(
                db
                    .update(gameInvites)
                    .set({status: accept ? "accepted" : "declined", respondedAt: Date.now()})
                    .where(eq(gameInvites.id, inviteId)),
            ).map(() => ({kind: row.kind, sessionId: row.sessionId})),
        );
