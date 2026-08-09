# AI Party Games

Two real-time party games, built on the same pattern: an HTTP request kicks
off AI generation on a Queue (so it returns immediately), and a Durable
Object owns the game's live state, pushing every update to connected
browsers over a WebSocket. A D1-backed catalog indexes every game/puzzle
ever created, across all users, for browsing and rating.

- **Guess the Prompt** — 5 AI images generate around a theme; players guess
  the prompt behind each one.
- **Piece Puzzle** — one AI image generates, scrambles into an N×N grid,
  and 2+ players collaboratively race a countdown to put it back together
  on the same shared board. Starts in a waiting room the host controls.

## Architecture: one Worker per service, connected by RPC

This is an npm-workspaces monorepo — six independently deployable Cloudflare
Workers under `apps/*`, sharing common code from `packages/shared` (not
itself deployed). Each service owns a slice of the single shared D1 database
(`game-worker-catalog`) and, where relevant, its own Durable Object class:

| Service (`apps/…`) | Owns | RPC it exposes | RPC it calls |
|---|---|---|---|
| `accounts` | `users`, `sessions` | `AccountsService`: session + user lookups | — |
| `browse` | `catalog`, `ratings` | `CatalogService`: catalog status writes | — |
| `leaderboard` | `leaderboard_entries` | `LeaderboardService`: `recordScore` | accounts |
| `friends` | friends/groups/invites tables, `UserDO` | — | accounts, puzzle |
| `guess` | `GameDO` | — | accounts, browse, leaderboard |
| `puzzle` | `PuzzleDO` | `PuzzleService`: `getLobbyStatus` | accounts, browse, leaderboard |

Two access patterns are both in play, deliberately:

- **Direct D1 reads across services, for display-name joins only.** Every
  service that binds the shared database may `SELECT` (never write) the
  `users` table it doesn't own — e.g. `friends` and `leaderboard` join it
  for usernames. D1 is one physical resource shared by several Workers, so
  this isn't a real isolation break, and it avoids N RPC round-trips per
  list endpoint.
- **Workers RPC (service bindings) for cross-service behavior.** Session
  validation/creation, catalog status transitions, and score recording are
  each owned by exactly one service and reached from the others via a
  `WorkerEntrypoint` RPC class + a `services` binding in `wrangler.jsonc` —
  e.g. `guess`'s `GameDO` calls `this.env.LEADERBOARD.recordScore(...)`
  instead of writing `leaderboard_entries` itself. `guess` and `puzzle` end
  up with **no D1 binding at all** as a result — every persistence op they
  need goes through an owning service's RPC.

Each service's RPC binding is typed against a small, dependency-free
interface in `packages/shared/src/rpc-types.ts` (see that file's header
comment for why — short version: typing it against the real
`WorkerEntrypoint` class via a cross-app import drags that app's whole
dependency graph, and its ambient `Env` type, into the caller's TypeScript
program).

```
POST /games or /puzzles  →  DO.init()  →  BROWSE.insertCatalogEntry()  →  queue.send({ id, theme, ... })
                                                                                  │
                                                                                  ▼
                                                        queue consumer (same Worker as the DO)
                                                        Workers AI (text + image) → R2.put() → DO.set*() → BROWSE.markCatalog*()

Browser  ──WebSocket──►  DO  (broadcasts every state change to all connected clients)
Browser  ──fetch────────►  each service's own /docs, /openapi.json, and routes
```

`guess` and `puzzle` share the `IMAGES` R2 bucket and `packages/shared/src/ai.ts`
(Workers AI calls) — each binds its own `AI` binding and passes it in, so
that file has no binding of its own.

### Guess the Prompt (`apps/guess`)

- **Prompts**: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with Workers AI's
  JSON mode, constrained to return exactly 5 strings.
- **Images**: one call per prompt, in parallel, stored at
  `games/<gameId>/<index>.png`.
- **Guessing** (`isGuessCorrect` in `guess-matching.ts`): correct on an exact
  normalized match, or if the guess covers ≥35% of the answer's
  significant (non-stopword) words after light stemming — so word order,
  articles, and typos on unrelated words don't fail an otherwise-right
  guess. A round only reveals its prompt to the guesser on a correct
  guess, or to anyone via "give up" (`POST /games/:id/reveal`).
- **Partial failures**: if some images fail, the game ends in `error`
  status (not stuck retrying); `POST /games/:id/regenerate` resets and
  re-enqueues the whole game.
- **Rating**: once every round has generated, the play page shows a 1-5
  star widget (`POST /api/catalog/:id/rate`, served by `browse`); one
  rating per browser (tracked in `localStorage`, not enforced server-side).
- **Scoring**: a correct guess is time-weighted (fast = more points) and
  recorded via `env.LEADERBOARD.recordScore(...)` from `GameDO.submitGuess`
  — only for logged-in players; anonymous guesses still count in-game but
  aren't leaderboard-eligible.

Routes: `POST /games`, `GET /games/:id`, `GET /games/:id/ws`,
`POST /games/:id/guess`, `POST /games/:id/reveal`,
`POST /games/:id/regenerate`, `GET /games/:id/images/:index`.

### Piece Puzzle (`apps/puzzle`)

- **Image**: one call — the theme is used directly as the prompt if given,
  otherwise the text model invents one (skips an AI call entirely when a
  theme is supplied). Stored at `puzzles/<puzzleId>/source.png`.
- **Board**: a client renders every tile as a `<div>` sharing the *same*
  background image, scaled up by `gridSize` with `background-position`
  offset per tile — no server-side image slicing. Grid size is 3×3 to 6×6
  (player-chosen at creation, default 4×4).
- **Waiting room**: once the image is ready, the puzzle enters a `waiting`
  status. The **host** — whoever created it, identified by a one-time
  `hostToken` returned at creation, never broadcast or exposed elsewhere —
  can regenerate the image (`POST /puzzles/:id/regenerate`) or start
  immediately (`POST /puzzles/:id/start`); otherwise a **DO alarm**
  auto-starts it after `LOBBY_COUNTDOWN_SECONDS` (30s). Direct friend/group
  invites (`POST /api/invites`, served by `friends`) are also only accepted
  while status is `waiting` — `friends` checks this through the
  `PuzzleService.getLobbyStatus` RPC call rather than a direct binding to
  this service's Durable Object namespace. A `replay` reopens a fresh
  lobby, so invites open back up for it too. Guess the Prompt has no lobby
  concept, so its invites aren't time-limited this way.
- **Moves**: click a tile, then another, to swap them — free swap, not a
  classic sliding-15-puzzle, so any arrangement is trivially solvable and
  two players can never block each other on an empty-slot constraint.
  Every move is server-authoritative: `PuzzleDO.swapTiles()` persists the
  swap and broadcasts it to *every* connected client (including the
  mover). Not host-gated — anyone with the link (including a stranger
  arriving via `/browse`) can play.
- **Timer**: same DO alarm mechanism as the lobby, just re-armed for
  `startedAt + timeLimitMs` once play begins. On solve, the alarm is
  cancelled; on expiry, the puzzle ends `timeout` with score 0.
- **Scoring**: `max(50, round(remainingMs / timeLimitMs × 1000))`, recorded
  via `env.LEADERBOARD.recordScore(...)` for the logged-in solver — full
  marks for an instant solve, a 50-point floor for finishing at the buzzer.
- **Replay**: once solved/timed out, the host can replay the *same* image
  (`POST /puzzles/:id/replay`) or generate a brand new one
  (`POST /puzzles/:id/regenerate`).
- **Presence**: the DO broadcasts a `connectedPlayers` count on every
  connect/disconnect.
- **Rating**: shown once solved/timed out, same star widget/mechanism as
  Guess the Prompt.

Routes: `POST /puzzles`, `GET /puzzles/:id`, `GET /puzzles/:id/ws`,
`POST /puzzles/:id/move`, `POST /puzzles/:id/start`,
`POST /puzzles/:id/replay`, `POST /puzzles/:id/regenerate`,
`GET /puzzles/:id/image`.

### Browse & ratings (`apps/browse`)

A Durable Object can't be listed or queried across instances, so "browse
everyone's games" needs a real index — that's the one thing in this project
backed by D1 rather than DO storage. The `catalog` table is a thin,
denormalized mirror of each game/puzzle (id, kind, theme, thumbnail key,
rating aggregate), kept in sync via `CatalogService`'s RPC methods, called
by `guess` and `puzzle` at the same points their own queue consumers update
their DOs: `insertCatalogEntry` at creation, then
`markCatalogGenerating`/`markCatalogReady`/`markCatalogError` alongside.
GameDO/PuzzleDO remain the sole source of truth for live gameplay — the
catalog only ever reflects "is there a viewable thumbnail," not
moves/scores/timers.

`GET /api/catalog` lists everything with `status = 'ready'`, filterable by
kind and sortable by recency or average rating; `POST
/api/catalog/:id/rate` records a 1-5 star rating (no auth — dedup is a
soft, client-side `localStorage` flag, consistent with this project's
trust level elsewhere).

### Leaderboard (`apps/leaderboard`)

Aggregates `leaderboard_entries` — one row per scoring event, written
exclusively through `LeaderboardService.recordScore` — into per-user
totals. Kept as an event log (rather than a running total) specifically so
time-windowed queries can filter on `created_at` directly.

`GET /api/leaderboard` returns the top 10 by summed score plus the calling
user's own standing (score + rank, even outside the top 10), filterable by
`kind` (`guess`/`puzzle`) and `period` (`day`/`week`/`month`/all-time).

### Accounts (`apps/accounts`)

Entirely optional — every game/puzzle above works fully anonymously.
Accounts are deliberately minimal: pick a username
(`POST /account/register`) and the server generates a one-time 6-digit
login code, hashed (SHA-256 + per-user salt) and stored in D1 — there's no
password, and no external issuer. Log back in later with username + code
(`POST /account/login`). Known limitation: no brute-force throttling on the
6-digit code yet — fine pre-launch, would need rate-limiting before real
accounts depend on it.

- **Sessions**: an opaque random token in an `httpOnly` cookie, looked up
  against a `sessions` table this service owns exclusively. Every other
  service's `auth.middleware.ts` resolves the current user through the
  `AccountsService` RPC entrypoint (`getUserBySession`/`createSession`/
  `deleteSession`) rather than querying `sessions` directly — see
  `packages/shared/src/session.ts` for the shared cookie-handling logic
  each service's middleware is built on.
- **Play identity**: both play pages' "Playing as" field is your real
  username (read-only) when logged in — `POST /games/:id/guess` and
  `POST /puzzles/:id/move` both resolve it from the session server-side,
  ignoring whatever the client sent, so it can't be spoofed. Anonymous
  players keep the old freeform, localStorage-remembered nickname.

### Friends & invites (`apps/friends`)

- **Friends** (`GET /api/friends`): request by username
  (`POST /api/friends/request`); a mutual request — the other side already
  asked you — auto-accepts instead of leaving two pending rows. Accept/
  decline/cancel and unfriend are all there too.
- **Groups**: create named groups of your own friends
  (`POST /api/groups`), add/remove members, delete. Owner-only, enforced
  server-side (not just hidden in the UI).
- **Invites**: `POST /api/invites` targets a single friend (`friendId`) or
  fans out to every member of a group (`groupId`) — one `game_invites` row
  per recipient either way. Accepting (`POST /api/invites/:id/accept`)
  returns a `playUrl` the client redirects to.
- **Live delivery** (`notifications.model.ts`): the recipient doesn't have
  to be on the friends page to see an invite — a client can open a
  WebSocket to `GET /api/notifications/ws`, backed by a `UserDO` (one
  instance per user id). `POST /api/invites` pushes to it right after the
  D1 write. D1 (`game_invites`) stays the source of truth — `GET
  /api/invites/pending` covers anything sent while a client was offline.
- Every mutating friends/groups/invites route requires a session and
  returns 401/403 on cross-user access (stealing someone else's group,
  accepting someone else's invite).

## One-time setup

```sh
npm install                                          # installs all six apps + the shared package

wrangler r2 bucket create game-guess-images           # shared by guess + puzzle
wrangler queues create game-generation
wrangler queues create game-generation-dlq
wrangler queues create puzzle-generation
wrangler queues create puzzle-generation-dlq
wrangler d1 create game-worker-catalog                # then paste database_id into every apps/*/wrangler.jsonc
wrangler d1 migrations apply game-worker-catalog --remote   # run from apps/accounts, or any D1-bound service
```

No secrets to set and nothing to register — accounts are a username plus
a hashed 6-digit code, both entirely in D1, and sessions are opaque tokens
looked up the same way, not signed cookies.

### Environments: dev / staging / production

Every `apps/*/wrangler.jsonc` defines three environments, each pointing at
its **own** physical resources — deploying to one never touches another's
data:

| Environment | Worker names | D1 database | R2 bucket | Queues |
|---|---|---|---|---|
| `dev` (unnamed/top-level config, no `--env` flag) | `game-<service>-worker` | `game-worker-catalog` | `game-guess-images` | `game-generation*`, `puzzle-generation*` |
| `staging` | `game-<service>-worker-staging` | `game-worker-catalog-staging` | `game-guess-images-staging` | `*-staging` |
| `production` | `game-<service>-worker-prod` | `game-worker-catalog-prod` | `game-guess-images-prod` | `*-prod` |

Service bindings (RPC) always target the sibling Worker in the *same*
environment (e.g. `friends`'s staging deploy binds `ACCOUNTS` to
`game-accounts-worker-staging`, not the dev one). Bootstrapping a fresh
staging or production environment means creating that environment's D1
database/R2 bucket/queues (same commands as above, with a `-staging`/
`-prod` suffix) and pasting the resulting IDs into each app's `env.staging`
/ `env.production` block, then running migrations for that database once
(`wrangler d1 migrations apply game-worker-catalog-staging --remote --env
staging`, from `apps/accounts`).

## Develop & deploy

Each service is deployed independently from its own directory. Local dev
always runs against `dev`'s config (the unnamed/top-level block); deploying
to `staging`/`production` requires `--env`:

```sh
cd apps/accounts && wrangler dev              # http://localhost:8787, dev config
cd apps/accounts && wrangler deploy           # deploys "dev" (game-accounts-worker)
cd apps/accounts && wrangler deploy --env staging     # game-accounts-worker-staging
cd apps/accounts && wrangler deploy --env production  # game-accounts-worker-prod
```

Service bindings resolve to sibling `wrangler dev` processes during local
development, so exercising a cross-service flow (e.g. `friends` calling
`accounts` or `puzzle`) means running `wrangler dev` in each service you
need, in separate terminals.

After changing a `wrangler.jsonc`'s bindings, regenerate that service's
types with `npm run cf-typegen -w apps/<service>` (or re-derive its
`worker-configuration.d.ts` by hand if it types any RPC service bindings —
see the header comment in any `apps/*/worker-configuration.d.ts` for why
those are hand-typed against `packages/shared/src/rpc-types.ts` rather than
wrangler's default output). After adding a migration, also run
`wrangler d1 migrations apply game-worker-catalog --local` (from
`apps/accounts`) for local dev.

Typecheck everything at once from the repo root:

```sh
npm run typecheck   # runs `tsc --noEmit` in every workspace
```

### CI/CD (`.github/workflows/deploy.yml` + `deploy-service.yml`)

The actual per-service deploy steps (checkout, `npm ci`, `wrangler deploy`)
live once in the reusable `.github/workflows/deploy-service.yml`
(`workflow_call`); `deploy.yml` just calls it once per service with three
`with:` values (`service`, `working_directory`, `environment`) instead of
repeating the same six-step block six times.

Two ways it runs:

- **Push to `master`**: always targets `dev`, and only deploys the services
  whose `apps/<service>/**` (or `packages/shared/**`) actually changed —
  path-filtered via `dorny/paths-filter`.
- **Manual `workflow_dispatch`**: pick the target **environment** (`dev` /
  `staging` / `production`) from a dropdown, and tick a checkbox per
  service you want deployed (`accounts`, `browse`, `leaderboard`,
  `friends`, `guess`, `puzzle`). This bypasses change-detection entirely —
  an unticked box doesn't deploy no matter what changed, so it's the way to
  redeploy something unchanged, deploy to staging/production (which the
  push trigger never touches), or deploy a subset on demand.

Either way, the whole monorepo typechecks first, and D1 migrations apply
(idempotent — safe every run) via `apps/accounts` against that run's target
environment's database, ahead of any D1-bound service's deploy — but only
when at least one of accounts/browse/leaderboard/friends is actually going
out.

Requires two repository secrets: `CLOUDFLARE_API_TOKEN` (Workers
Scripts:Edit, D1:Edit, Workers Routes:Edit) and `CLOUDFLARE_ACCOUNT_ID`.
One token/account covers all three environments here since they're all in
the same Cloudflare account, differentiated only by resource IDs and Worker
name suffixes — see [Environments](#environments-dev--staging--production)
above.

### Angular client packages (`.github/workflows/publish-client.yml`)

The separate frontend doesn't hand-write fetch calls against these
services — each one publishes a generated Angular client package instead.
Whenever a service is going out (same gating as its `deploy-*` job, above),
`deploy.yml` also runs `publish-client.yml` for it, in parallel with —
not after — the deploy:

1. boot that service locally with `wrangler dev` (a real workerd runtime;
   D1/R2/queues/Durable Objects are all simulated in-process, so this
   never touches, or waits on, any live deployment) and pull its spec off
   `GET /openapi.json`
2. feed that spec to `openapi-generator-cli`'s `typescript-angular`
   generator — a full ng-packagr-buildable Angular library: injectable
   services, models, and a `BASE_PATH` injection token the frontend
   supplies per environment
3. build it with `ng-packagr`
4. publish it to GitHub Packages under a dist-tag matching the
   environment

Nothing generated is committed (see `clients/` in `.gitignore`) — it's
regenerated from the live route/schema definitions on every publish, so it
can never drift from the actual API surface. The frontend installs
`@thenewestera/<service>-ng@dev`, `@staging`, or plain `@latest`
(production) depending on which environment it's pointed at; `dev` is a
rolling prerelease (`0.0.0-dev.<run number>`) republished on every push,
while `staging`/`production` each bump a real patch version off whatever
that channel last published.

Needs the same two Cloudflare secrets as the deploy jobs (to boot
`wrangler dev` non-interactively) plus `packages: write` on the workflow's
`GITHUB_TOKEN` (already granted in `deploy.yml`) to publish — no extra
repository secret required unless you'd rather publish with a dedicated
token (`NPM_PUBLISH_TOKEN`, optional).

### Workers AI always touches your real account

D1/R2/Queues/Durable Objects fully emulate locally, but Workers AI does
not — every `env.AI.run()` call in `wrangler dev` hits your real Cloudflare
account and incurs a (very small — fractions of a cent) real charge, per
[the docs](https://developers.cloudflare.com/pages/functions/bindings/#workers-ai).
Keep that in mind before repeatedly hitting `POST /games` or `POST /puzzles`
locally.

### A note for this NixOS shell

Use the nixpkgs-provided `wrangler` on `PATH` for `wrangler dev` (the
npm-installed one's `workerd` binary won't execute on NixOS). `npx wrangler`
(the pinned devDependency) works fine for commands that don't spawn a local
runtime — `r2 bucket create`, `queues create`, `d1 create`,
`d1 migrations apply`, `wrangler types --include-runtime=false`, `deploy`,
`deploy --dry-run`.
