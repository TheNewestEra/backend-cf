// Wraps the raw `D1Database` binding (see @game-worker/shared/db's
// `Database` alias) in a Drizzle client. `schema` isn't passed to
// `drizzle()` — every query in this app is an explicit `.select()`/
// `.insert()`/`.update()` chain rather than Drizzle's higher-level
// relational query API, which is the only thing that needs `schema` wired
// in up front.

import type {Database} from "@game-worker/shared/db";
import {drizzle} from "drizzle-orm/d1";

export function createDb(db: Database) {
    return drizzle(db);
}

export type Db = ReturnType<typeof createDb>;
