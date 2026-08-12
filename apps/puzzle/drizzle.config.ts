// `npx drizzle-kit generate` reads src/db/schema.ts and diffs it against
// `out`'s snapshot to produce SQL. Unlike the D1 apps' identically-shaped
// config, this one is NEVER pointed at anything `wrangler d1 migrations
// apply` runs — `PuzzleDO`'s SQLite storage has no such external
// apply-migrations mechanism at all (see src/db/README.md). This baseline
// exists purely so drizzle-kit has something to diff a future schema.ts
// change against, and so a CI drift-check has something to compare
// schema.ts to `migrate()`'s actual SQL against.
import {defineConfig} from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
});
