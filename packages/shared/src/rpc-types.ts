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
import type {GameKind} from "./game";
import type {RpcResult} from "./rpc-result";

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
    /** Batch counterpart to `getUserById` — one round trip for a whole set
     * of ids that each need a display name/color (a leaderboard page, a
     * friends list), instead of N. Rows for an id that doesn't resolve are
     * simply omitted, not padded with null, and the result order doesn't
     * necessarily match `ids`. */
    getUsersByIds(ids: string[]): Promise<AccountRecord[]>;
}

/** Subset of AccountsRpc needed to resolve/create/destroy a session — used
 * by @game-worker/shared/session, which every non-accounts service's
 * `auth.middleware.ts` is built on. */
export type AccountsSessionRpc = Pick<
    AccountsRpc,
    "getUserBySession" | "createSession" | "deleteSession"
>;

/** RPC surface exposed by `apps/browse`'s `CatalogService`. */
export interface CatalogRpc {
    /** `creator` is null for an anonymous host (no account to attribute the
     * entry to); `name`/`color` are the host's resolved display name/color
     * at creation time (an account's, or an anonymous host's chosen/
     * generated one) — see catalog.service.ts's `insertCatalogEntry` for
     * why these are stored as a snapshot rather than joined live. `replayOf`
     * is the source catalog id when this entry was created by a /replay or
     * /regenerate endpoint (guess/puzzle both pass it through for either);
     * omitted/null for a freshly created game/puzzle. `replayKind` says
     * which of the two created it — required whenever `replayOf` is given.
     * Only a `"replay"` (the exact same image/rounds copied verbatim) makes
     * browse group it into its source's existing card; a `"regenerate"`
     * (fresh AI call off the same theme, which can land on a different
     * image) always starts a card of its own instead — folding it into the
     * source's card would hide a genuinely different thumbnail. See
     * catalog.service.ts's `listCatalog`/`insertCatalogEntry`.
     * `themeGenerated` says whether `theme` was picked for this entry rather
     * than typed in by its creator — for a fresh game/puzzle this is just
     * `theme === null` at creation time (the real theme, if one gets
     * auto-picked, isn't known until generation resolves it — see
     * `updateCatalogTheme` below); for a replay/regenerate it's carried
     * over from the source entry as-is, since that's a property of the
     * theme itself. */
    insertCatalogEntry(
        id: string,
        kind: GameKind,
        theme: string | null,
        creator: {id: string | null; name: string; color: string},
        replayOf?: string | null,
        themeGenerated?: boolean,
        replayKind?: "replay" | "regenerate" | null,
    ): Promise<void>;
    /** Backfills `theme`/`themeGenerated` once generation actually resolves
     * a theme for an entry that started with none — called alongside
     * GameDO/PuzzleDO's own `setPrompts()`/`setReady()` (see guess.queue.ts/
     * puzzle.queue.ts), never on its own. A no-op for an entry that already
     * had a user-given theme (the call still happens, just re-writes the
     * same value — see those queue consumers' own doc comments for why they
     * don't bother branching on it). */
    updateCatalogTheme(id: string, theme: string, themeGenerated: boolean): Promise<void>;
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
    recordScore(input: {
        userId: string;
        kind: GameKind;
        sessionId: string;
        score: number;
    }): Promise<void>;
}

/** RPC surface exposed by `apps/friends`' `FriendsService`. */
export interface FriendsRpc {
    /** IDs of `userId`'s friends (not including `userId` itself). */
    getFriendIds(userId: string): Promise<string[]>;
}

/** RPC surface exposed by `apps/puzzle`'s `PuzzleService`. */
export interface PuzzleRpc {
    getLobbyStatus(puzzleId: string): Promise<{status: string}>;

    joinAsUser(
        puzzleId: string,
        userId: string,
        username: string,
        color: string,
    ): Promise<RpcResult<{participantId: string; token: string | null; color: string}>>;
}

/** RPC surface exposed by `apps/guess`'s `GuessService`. */
export interface GuessRpc {
    getStatus(gameId: string): Promise<{status: string}>;
    joinAsUser(
        gameId: string,
        userId: string,
        username: string,
        color: string,
    ): Promise<RpcResult<{participantId: string; token: string | null; color: string}>>;
}

/** Input shared by every `NotificationsRpc` write below — `type` is a
 * free-form string (e.g. "invite", "friend_request", "system"), not a
 * closed enum, so a brand-new kind of notification never needs a change
 * here. `data` is opaque, caller-defined JSON. */
export interface NotificationInput {
    type: string;
    title?: string;
    body?: string;
    data?: unknown;
}

/** A persisted notification, as returned by `NotificationsRpc.send()`. */
export interface NotificationRecord {
    id: string;
    type: string;
    title: string | null;
    body: string | null;
    data: unknown;
    createdAt: number;
    readAt: number | null;
}

/** RPC surface exposed by `apps/notifications`' `NotificationsService` —
 * the main way any service pushes a user-facing message. `send`/`sendMany`
 * persist a durable inbox row (recoverable via that service's own
 * `GET /api/notifications`) and push it live; `push`/`pushMany` skip
 * persistence and only push live, for a caller (e.g. `apps/friends`) that
 * already owns its own source of truth for "what's pending". See
 * apps/notifications/src/index.ts for the full rationale. */
export interface NotificationsRpc {
    send(userId: string, input: NotificationInput): Promise<RpcResult<NotificationRecord>>;
    sendMany(userIds: string[], input: NotificationInput): Promise<void>;
    push(userId: string, input: NotificationInput & {id?: string}): Promise<void>;
    pushMany(userIds: string[], input: NotificationInput & {id?: string}): Promise<void>;
}
