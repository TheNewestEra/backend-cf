// Structural shapes for every service's RPC surface — used to type each
// consumer's service binding in its `worker-configuration.d.ts`.
//
// These are plain interfaces rather than `Service<typeof SomeEntrypoint>`
// (the officially-documented way to type a service binding) on purpose:
// `Service<T>` needs `T` to be the real `WorkerEntrypoint` subclass, which
// means a type-only cross-app import of that class from its owning app's
// `src/index.ts`. In this monorepo that drags the owning app's whole
// dependency graph into the *consumer's* TypeScript program just to check
// types — and since every app's `worker-configuration.d.ts` declares the
// same bare ambient `Env` name, whichever program pulls in another app's
// source ends up merging that app's `Env` shape into its own (TypeScript's
// global declaration merging is whole-program, not per-directory), which
// corrupts both. Depending only on these dependency-free interfaces avoids
// that entirely — the real RPC stub still satisfies them structurally.
export interface AccountRecord {
    id: string;
    username: string;
    color: string;
}

/** Full RPC surface exposed by `apps/accounts`' `AccountsService`. */
export interface AccountsRpc {
    getUserBySession(token: string): Promise<AccountRecord | null>;
    createSession(userId: string): Promise<string>;
    deleteSession(token: string): Promise<void>;
    findUserByUsername(username: string): Promise<AccountRecord | null>;
    getUserById(id: string): Promise<AccountRecord | null>;
}

/** Subset of AccountsRpc needed to resolve/create/destroy a session — used
 * by @game-worker/shared/session, which every non-accounts service's
 * `auth.middleware.ts` is built on. */
export type AccountsSessionRpc = Pick<AccountsRpc, "getUserBySession" | "createSession" | "deleteSession">;

/** RPC surface exposed by `apps/browse`'s `CatalogService`. */
export interface CatalogRpc {
    insertCatalogEntry(id: string, kind: "guess" | "puzzle", theme: string | null): Promise<void>;
    markCatalogGenerating(id: string): Promise<void>;
    markCatalogReady(id: string, thumbnailKey: string): Promise<void>;
    markCatalogError(id: string): Promise<void>;
    /** Distinct from the status above — see catalog.service.ts's
     * `updatePlayStatus` for why a Piece Puzzle entering `ready` (has a
     * thumbnail) doesn't necessarily mean `active` (started). */
    updatePlayStatus(id: string, playStatus: "joinable" | "active" | "finished"): Promise<void>;
}

/** RPC surface exposed by `apps/leaderboard`'s `LeaderboardService`. */
export interface LeaderboardRpc {
    recordScore(input: { userId: string; kind: "guess" | "puzzle"; sessionId: string; score: number }): Promise<void>;
}

/** RPC surface exposed by `apps/puzzle`'s `PuzzleService`. */
export interface PuzzleRpc {
    getLobbyStatus(puzzleId: string): Promise<{ status: string }>;
}

/** RPC surface exposed by `apps/guess`'s `GuessService`. */
export interface GuessRpc {
    getStatus(gameId: string): Promise<{ status: string }>;
}
