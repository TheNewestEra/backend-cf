// Wraps the Durable Object's own SQLite storage (`ctx.storage`, from
// `@cloudflare/workers-types` — a `DurableObjectStorage`, NOT a
// `D1Database`) in a Drizzle client. `drizzle-orm/durable-sqlite` — unlike
// `drizzle-orm/d1` used by the other, D1-backed apps — stays synchronous
// under the hood (it wraps `ctx.storage.sql` directly), same as the raw
// `ctx.storage.sql.exec()` calls it replaces: `.get()`/`.all()`/`.run()`/
// `.values()` all return their results directly rather than a `Promise`.
// This matters — see puzzle.model.ts's methods that rely on there being no
// `await` between a synchronous read-check and its corresponding write.
//
// `schema` isn't passed to `drizzle()` — every query in this app is an
// explicit `.select()`/`.insert()`/`.update()`/`.delete()` chain (mirroring
// the `ctx.storage.sql.exec()` prepared-statement style this replaced)
// rather than Drizzle's higher-level relational query API, which is the
// only thing that needs `schema` wired in up front (same reasoning as the
// D1 apps' client.ts).

import {drizzle} from "drizzle-orm/durable-sqlite";

export function createDb(storage: DurableObjectStorage) {
    return drizzle(storage);
}

export type Db = ReturnType<typeof createDb>;
