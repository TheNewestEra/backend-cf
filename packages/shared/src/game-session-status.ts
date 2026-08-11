export const GameSessionStatus = {
    Queued: "queued",
    Generating: "generating",
    Waiting: "waiting",
    Playing: "playing",
    Solved: "solved",
    Timeout: "timeout",
    Error: "error",
} as const;

export type GameSessionStatus = (typeof GameSessionStatus)[keyof typeof GameSessionStatus];
