// Hand-written index feeding `drizzle-orm/durable-sqlite/migrator`'s
// `migrate()` (see puzzle.model.ts's constructor). `drizzle-kit generate`
// produces the actual SQL under ../../drizzle plus a `meta/_journal.json`
// describing their order, but a Durable Object can't read the filesystem
// at runtime, so this file imports each as a real JS module instead:
// `.sql` files resolve to their raw text via wrangler.jsonc's `rules`
// entry (`type: "Text"`, matching `**/*.sql`), and `_journal.json` via
// TypeScript's `resolveJsonModule` (see ../sql-module.d.ts for the `.sql`
// side of that). This file is NOT itself generated — whenever
// `drizzle-kit generate` (run from apps/puzzle) emits a new numbered
// migration, add its import and its `mXXXX` entry here by hand, keyed by
// the migration's zero-padded index (matching how the migrator itself
// looks entries up — see readMigrationFiles() in drizzle-orm's own
// durable-sqlite/migrator source). Mirrors apps/guess's own
// ./db/migrations.ts.
import journal from "../../drizzle/meta/_journal.json";
import m0000 from "../../drizzle/0000_zippy_deathbird.sql";

export default {
    journal,
    migrations: {
        m0000,
    },
};
