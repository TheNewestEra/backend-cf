// Shared `neverthrow` glue for every D1/Drizzle query in this app — the one
// seam where a query "might reject" crosses into `Result`, so every service
// function composes purely via `.andThen()`/`.map()`/etc. from there on,
// with no bare `await` a DB hiccup could turn into an unhandled rejection.

import {err, ok, type Result, ResultAsync} from "neverthrow";

export function query<T>(promise: PromiseLike<T>): ResultAsync<T, string> {
    return ResultAsync.fromPromise(promise, (error) => `Database error: ${error}`);
}

export function requireFound<T>(row: T | null | undefined, error: string): Result<T, string> {
    return row ? ok(row) : err(error);
}
