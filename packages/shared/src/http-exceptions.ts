// Generic HTTP-facing error helpers. Domain services in this project
// compose their validation internally as a `neverthrow` `Result<T, string>`
// (see @game-worker/shared/rpc-result for how that crosses a Durable
// Object/service-binding RPC boundary intact) — the helpers below are the
// one place that translates a rejected `Result` into a status + JSON body,
// so controllers don't each reinvent the mapping. The exception classes are
// here for controllers/services that would rather throw than return a
// `Result`.

import type {Result} from "neverthrow";

export class HttpException extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export class BadRequestException extends HttpException {
    constructor(message: string) {
        super(400, message);
    }
}

export class UnauthorizedException extends HttpException {
    constructor(message = "not logged in") {
        super(401, message);
    }
}

export class ForbiddenException extends HttpException {
    constructor(message = "forbidden") {
        super(403, message);
    }
}

export class ConflictException extends HttpException {
    constructor(message: string) {
        super(409, message);
    }
}

/** Most friend/group actions share this shape: `{ok:true}` or a rejection
 * that's either a 403 (not yours to touch) or a 400 (bad state). Both the
 * OpenAPI response definitions (kept with each controller) and this
 * runtime status/body come from the same `error` string so the two can't
 * drift apart. Takes the `Result` directly (`.isOk()`/`.error` narrow it) —
 * callers that received a `RpcResult` across an RPC boundary rehydrate it
 * via `fromRpcResult()` first (see @game-worker/shared/rpc-result). */
export function actionResponse(result: Result<void, string>): {
    status: 200 | 400 | 403;
    body: {ok: true} | {error: string};
} {
    if (result.isOk()) return {status: 200, body: {ok: true}};
    return {status: result.error === "forbidden" ? 403 : 400, body: {error: result.error}};
}

/** Host-gated and participant-gated Durable Object RPCs (see
 * puzzle.model.ts's host token checks and guess.model.ts/puzzle.model.ts's
 * join-roster checks) resolve to `Err("forbidden: ...")` for a bad/missing
 * token or an unjoined participant, and a plain message for anything else
 * (wrong status, etc.) — translate that convention into the right HTTP
 * status. Accepts the failure message directly (the common case: a caller
 * already `.isErr()`-checked a rehydrated `Result` and is passing its
 * `.error`), or — for any caller not yet ported off throwing — the same
 * `unknown` a `catch` block hands you, so this stays a safe drop-in either
 * way. */
export function hostActionError(error: string): {status: 403 | 409; body: {error: string}};
export function hostActionError(err: unknown): {status: 403 | 409; body: {error: string}};
export function hostActionError(input: unknown): {status: 403 | 409; body: {error: string}} {
    const message =
        typeof input === "string"
            ? input
            : input instanceof Error
              ? input.message
              : "action rejected";
    const status = message.startsWith("forbidden") ? 403 : 409;
    return {status, body: {error: message}};
}
