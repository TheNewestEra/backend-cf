// `npx drizzle-kit generate` reads src/db/schema.ts (the table this app
// owns — see that file's header) and diffs it against `out`'s snapshot to
// produce SQL. `out` is THIS APP'S OWN folder, not the shared root
// `migrations/` that `wrangler d1 migrations apply` actually runs — see
// src/db/README.md for why, and for the one-time step already done to
// baseline it against the table as it already exists.
import {defineConfig} from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
});
