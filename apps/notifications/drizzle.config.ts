// `npx drizzle-kit generate` reads src/db/schema.ts (the table this app
// owns — see that file's header) and diffs it against `out`'s snapshot to
// produce SQL. `out` is THIS APP'S OWN folder, not the shared root
// `migrations/` that `wrangler d1 migrations apply` actually runs — see
// src/db/README.md.
import {defineConfig} from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
});
