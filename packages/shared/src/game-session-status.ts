// Both `apps/guess`'s `GameDO` and `apps/puzzle`'s `PuzzleDO` drive an
// identical lobby/play/finish state machine (see `@game-worker/shared/lobby`
// for the shared lobby countdown they also both use) — kept here so the two
// games' status values can't quietly drift apart. Each service still builds
// its own named `.openapi(...)` schema off this object (see guess.schema.ts's
// `GameStatusSchema` / puzzle.schema.ts's `PuzzleStatusSchema`, both
// `z.nativeEnum(GameSessionStatus)`), since a single zod schema instance
// can't carry two different component names across two independent OpenAPI
// specs. Mirrors the `GameKind` (game.ts) / `CatalogStatus` (browse's
// catalog.schema.ts) const-object-as-enum pattern used throughout this repo.

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
