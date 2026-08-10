import {z} from "@hono/zod-openapi";
import {GameKindSchema} from "@game-worker/shared/game";

export const FriendSummarySchema = z
    .object({id: z.string(), username: z.string(), color: z.string()})
    .openapi("FriendSummary");

export const FriendRequestSummarySchema = z
    .object({id: z.string(), username: z.string(), color: z.string(), created_at: z.number()})
    .openapi("FriendRequestSummary");

export const GroupSummarySchema = z
    .object({id: z.string(), name: z.string(), members: z.array(FriendSummarySchema)})
    .openapi("GroupSummary");

export const InviteSummarySchema = z
    .object({
        id: z.string(),
        kind: GameKindSchema,
        sessionId: z.string(),
        inviterUsername: z.string(),
        inviterColor: z.string(),
        createdAt: z.number(),
    })
    .openapi("InviteSummary");
