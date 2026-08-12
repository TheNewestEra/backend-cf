import {z} from "@hono/zod-openapi";

export const GameKind = {
    Guess: "guess",
    Puzzle: "puzzle",
} as const;

export type GameKind = (typeof GameKind)[keyof typeof GameKind];

export const GameKindSchema = z.nativeEnum(GameKind);

const GAME_ROUTES = {
    [GameKind.Guess]: (id: string) => `/games/guess-prompt/${id}`,
    [GameKind.Puzzle]: (id: string) => `/games/piece-puzzle/${id}`,
} as const satisfies Record<GameKind, (id: string) => `/games/${string}/${string}`>;

export const playUrlFor = (kind: GameKind, sessionId: string) =>
    GAME_ROUTES[kind](sessionId);
