// `npx drizzle-kit generate` reads src/db/schema.ts (the tables `GameDO`'s
// own Durable Object SQLite storage owns — see that file's header) and
// diffs it against `out`'s snapshot to produce SQL. Unlike the D1 apps'
// identically-shaped config, nothing here is ever applied anywhere — there
// is no `wrangler d1 migrations apply` equivalent for a Durable Object's
// storage. This exists purely so drizzle-kit has a baseline to diff future
// schema.ts changes against, and so a schema-drift check has something to
// compare against. See src/db/README.md.
import {defineConfig} from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
});
