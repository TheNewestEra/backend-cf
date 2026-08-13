// Lets ./db/migrations.ts import a `.sql` file's contents as plain text.
// What actually makes that resolve at bundle/runtime is wrangler.jsonc's
// `rules` entry (`type: "Text"`, `globs: ["**/*.sql"]`) — this declaration
// only satisfies the type checker, which has no other way to know what a
// `.sql` import's default export looks like.
declare module "*.sql" {
    const content: string;
    export default content;
}
