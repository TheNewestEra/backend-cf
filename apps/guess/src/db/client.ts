// Wraps `GameDO`'s own Durable Object SQLite storage (`ctx.storage`, a
// `DurableObjectStorage` — see @cloudflare/workers-types) in a Drizzle
// client. Unlike the D1-backed apps' `createDb(db: Database)` (a module-
// level function taking `db` as a parameter), `GameDO` threads this through
// as a class field (`this.db`, set in its constructor) since every method
// already has `this.ctx` available — see guess.model.ts.
//
// `schema` isn't passed to `drizzle()` — every query in this app is an
// explicit `.select()`/`.insert()`/`.update()`/`.delete()` chain (mirroring
// the `ctx.storage.sql.exec()` calls this replaced) rather than Drizzle's
// higher-level relational query API, which is the only thing that needs
// `schema` wired in up front. Same reasoning as apps/friends and
// apps/browse's `db/client.ts`.
//
// Crucially, `drizzle-orm/durable-sqlite` stays SYNCHRONOUS — its
// `.get()`/`.all()`/`.run()`/`.values()` return values directly, not
// Promises — same as the raw `ctx.storage.sql.exec()` it replaces. This
// matters: several methods in guess.model.ts rely on there being no
// `await` between a synchronous read-check and a synchronous write (see
// `resolveCurrentRound()`'s doc comment), so callers must not accidentally
// `await` a `this.db...` call.

import {drizzle} from "drizzle-orm/durable-sqlite";

export function createDb(storage: DurableObjectStorage) {
    return drizzle(storage);
}

export type Db = ReturnType<typeof createDb>;
