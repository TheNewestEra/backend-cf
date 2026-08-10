// The two game kinds this project supports, and the couple of things every
// service needs to agree on when referring to one — what to validate it as,
// what to call it in a URL. Before this existed, `"guess" | "puzzle"` unions
// and `z.enum(["guess", "puzzle"])` calls were redeclared per service
// (leaderboard, browse/catalog, friends' invites, ...); this is the one
// place that pairing is spelled out, so a third game type only ever needs
// adding here.

import {z} from "@hono/zod-openapi";

export const GAME_KINDS = ["guess", "puzzle"] as const;

export type GameKind = (typeof GAME_KINDS)[number];

export const GameKindSchema = z.enum(GAME_KINDS);

/** Where a catalog entry or accepted invite of this kind is actually played
 * — Guess the Prompt lives under `/games`, Piece Puzzle under `/puzzles`.
 * Shared by the browse catalog and friends' invites so the two routers
 * can't compute this path differently. */
export function playUrlFor(kind: GameKind, sessionId: string): string {
    return kind === "guess" ? `/games/${sessionId}/play` : `/puzzles/${sessionId}/play`;
}
