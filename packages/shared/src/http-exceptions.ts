// Generic HTTP-facing error helpers. Domain services in this project
// return plain `{ok:true} | {ok:false, error}` results, or Durable Object
// RPCs throw `Error("forbidden: ...")` for an auth failure and a plain
// message otherwise — the helpers below are the one place that translates
// either convention into a status + JSON body, so controllers don't each
// reinvent the mapping. The exception classes are here for controllers/
// services that would rather throw than return a result union.

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
 * drift apart. */
export function actionResponse(result: { ok: true } | { ok: false; error: string }): {
    status: 200 | 400 | 403;
    body: { ok: true } | { error: string };
} {
    if (result.ok) return {status: 200, body: {ok: true}};
    return {status: result.error === "forbidden" ? 403 : 400, body: {error: result.error}};
}

/** Host-gated Durable Object RPCs (see puzzle.model.ts) throw
 * `Error("forbidden: ...")` for a bad/missing host token and a plain
 * message for anything else (wrong status, etc.) — translate that
 * convention into the right HTTP status. */
export function hostActionError(err: unknown): { status: 403 | 409; body: { error: string } } {
    const message = err instanceof Error ? err.message : "action rejected";
    const status = message.startsWith("forbidden") ? 403 : 409;
    return {status, body: {error: message}};
}
