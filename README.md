# The Newest Era Backend

Two real-time party games, built on the same pattern: an HTTP request kicks
off AI generation on a Queue (so it returns immediately), and a Durable
Object owns the game's live state, pushing every update to connected
browsers over a WebSocket. A D1-backed catalog indexes every game/puzzle
ever created, across all users, for browsing and rating.

- **Guess the Prompt** — a configurable 1-8 AI images generate around a
  theme; players guess the prompt behind each one during timed rounds. It
  starts in a waiting room the host controls and ends when all rounds are
  solved or a round times out.
- **Piece Puzzle** — one AI image generates, scrambles into an N×N grid,
  and 2+ players collaboratively race a countdown to put it back together
  on the same shared board. Starts in a waiting room the host controls.

Both games share the exact same **lobby** shape (see `packages/shared/src/
lobby.ts`): once content is ready, play doesn't start instantly — a
`waiting` room opens for `LOBBY_COUNTDOWN_SECONDS` so players can join and
see who else showed up, ending either on a DO alarm or the host calling
"start now" early. They also share **participant colors** (`packages/
shared/src/color.ts`, the same generator `accounts` uses for a real
account's color) and a `player_joined` broadcast, so every connected client
can render a live roster of who's in the lobby and in what color.

---

## Architecture: one Worker per service, connected by RPC

This is an npm-workspaces monorepo — seven independently deployable
Cloudflare Workers under `apps/*`, sharing common code from `packages/shared`
(not itself deployed). Each service owns a slice of the single shared D1
database (`game-worker-catalog`) and, where relevant, its own Durable Object
class:

| Service (`apps/…`) | Owns                              | RPC it exposes                                              | RPC it calls                           |
| ------------------ | --------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| `accounts`         | `users`, `sessions`               | `AccountsService`: session + user lookups                   | —                                      |
| `browse`           | `catalog`, `ratings`              | `CatalogService`: catalog status writes                     | —                                      |
| `leaderboard`      | `leaderboard_entries`             | `LeaderboardService`: `recordScore`                         | accounts                               |
| `notifications`    | `notifications`, `NotificationDO` | `NotificationsService`: `send`/`sendMany`/`push`/`pushMany` | accounts                               |
| `friends`          | friends/groups/invites tables     | —                                                           | accounts, puzzle, guess, notifications |
| `guess`            | `GameDO`                          | `GuessService`: `getStatus`                                 | accounts, browse, leaderboard          |
| `puzzle`           | `PuzzleDO`                        | `PuzzleService`: `getLobbyStatus`                           | accounts, browse, leaderboard          |

`notifications` is the one shared, general-purpose channel every other
service pushes a user-facing message through — see "Notifications" below.
It's the direct successor to what used to be `friends`' own invite-only
`UserDO`.

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

Browser  ◄─WebSocket──►  DO  (broadcasts every state change out; Piece Puzzle
                              also takes join/move/select in — see below)
Browser  ──fetch────────►  each service's own /docs, /openapi.json, and routes
```

`guess` and `puzzle` share the `IMAGES` R2 bucket and `packages/shared/src/ai.ts`
(Workers AI calls) — each binds its own `AI` binding and passes it in, so
that file has no binding of its own.

### Guess the Prompt (`apps/guess`)

- **Prompts**: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with Workers AI's
  JSON mode. The requested round count is configurable from 1-8 and defaults
  to the Flagship `round-count` value (5 if flag evaluation fails).
- **Images**: one call per prompt, in parallel, stored at
  `games/<gameId>/<index>.png`.
- **Guessing** (`isGuessCorrect` in `guess-matching.ts`): correct on an exact
  normalized match, or if the guess covers ≥35% of the answer's
  significant (non-stopword) words after light stemming — so word order,
  articles, and typos on unrelated words don't fail an otherwise-right
  guess. A round only reveals its prompt to the guesser on a correct
  guess, or to anyone via "give up" (`POST /games/:id/reveal`).
- **Partial failures**: if some images fail, the game ends in `error`
  status instead of remaining stuck in generation. Replay and regenerate
  always create fresh instances rather than mutating the failed game.
- **Waiting room**: once every round's image is ready, the game enters a
  `waiting` status — same lobby shape as Piece Puzzle (see the intro
  above). The **host** — whoever created it, identified by a one-time
  `hostToken` returned at creation, never broadcast or exposed elsewhere —
  can start immediately (`POST /games/:id/start`); otherwise a **DO alarm**
  auto-starts it after `LOBBY_COUNTDOWN_SECONDS` (30s), same alarm
  mechanism as `PuzzleDO`. Direct friend/group invites (`POST
/api/invites`, served by `friends`) are only accepted pre-start
  (`queued`/`generating`/`waiting`) — `friends`
  checks this through the `GuessService.getStatus` RPC call rather than a
  direct binding to this service's Durable Object namespace.
- **Joining and play use the WebSocket**: a client sends `join`, `guess`,
  `reveal`, and `typing` messages over `GET /games/:id/ws`. Joining is only
  possible during `queued`/`generating`/`waiting`; late arrivals can still
  spectate. Logged-in players are identified by the session captured at the
  WebSocket upgrade and use their account id/color. Anonymous guests receive
  a private `join_result` containing a participant id, token, and color and
  resend those credentials with later actions. Rejected actions return a
  private `GameWsErrorMessage`.
- **Interactivity**: the DO broadcasts connection counts, participant state,
  joins, round changes, guesses, reveals, typing cues, live scores, terminal
  results, and errors. Incorrect guess broadcasts include the guessed text;
  correct guesses announce the player and awarded score without leaking the
  answer to everyone else.
- **Replay and regenerate**: once finished, `POST /games/:id/replay` creates
  an independent game by copying the source rounds/images, while
  `POST /games/:id/regenerate` creates an independent game with fresh AI
  prompts/images. Both return a new id and host token and leave the source
  untouched.
- **Scoring and completion**: every correct answer receives a time-weighted
  score and updates the in-game standings immediately. When the game becomes
  `solved` or `timeout`, final per-participant totals are broadcast and each
  logged-in player's aggregate game score is recorded once through the
  Leaderboard RPC. Guest scores remain visible in-game but are not persisted
  to the global leaderboard.

Routes: `POST /games`, `GET /games/:id`, `GET /games/:id/ws`,
`POST /games/:id/start`, `POST /games/:id/replay`,
`POST /games/:id/regenerate`, `GET /games/:id/images/:index`.

### Piece Puzzle (`apps/puzzle`)

- **Image**: one call — the theme is used directly as the prompt if given,
  otherwise the text model invents one (skips an AI call entirely when a
  theme is supplied). Stored at `puzzles/<puzzleId>/source.png`.
- **Board**: a client renders every tile as a `<div>` sharing the _same_
  background image, scaled up by `gridSize` with `background-position`
  offset per tile — no server-side image slicing. Grid size is 3×3 to 6×6
  (player-chosen at creation, default 4×4).
- **Waiting room**: once the image is ready, the puzzle enters a `waiting`
  status (see the shared lobby shape in the intro above). The **host** —
  whoever created it, identified by a one-time `hostToken` returned at
  creation, never broadcast or exposed elsewhere — can regenerate the
  image (`POST /puzzles/:id/regenerate`, only while still pre-start) or
  start immediately (`POST /puzzles/:id/start`); otherwise a **DO alarm**
  auto-starts it after `LOBBY_COUNTDOWN_SECONDS` (30s). Direct friend/group
  invites (`POST /api/invites`, served by `friends`) are also only
  accepted pre-start (`queued`/`generating`/`waiting`) — `friends` checks
  this through the `PuzzleService.getLobbyStatus` RPC call rather than a
  direct binding to this service's Durable Object namespace. Guess the
  Prompt is gated the same way now, via its own `GuessService.getStatus`.
- **Joining, moving, selecting — all over the WebSocket.** Unlike Guess the
  Prompt, Piece Puzzle's `join`/`move`/`select` aren't HTTP calls at all —
  they're JSON messages sent over the same `GET /puzzles/:id/ws` connection
  used for broadcasts (see `PuzzleDO.webSocketMessage()` and puzzle.schema.ts's
  `PuzzleWsClientMessageSchema`), since a player is already holding that
  connection open for the whole time they'd otherwise be polling/mutating
  over HTTP. Identity is resolved once, from the session cookie present at
  the WebSocket _upgrade_ request (individual WS messages don't carry
  cookies), and kept on the connection via `serializeAttachment` for its
  lifetime.
    - **Joining**: send `{type: "join", player}` — required before any `move`,
      and only possible pre-start (`queued`/`generating`/`waiting`). Once the
      puzzle is `playing` this errors back (`PuzzleWsErrorMessage`), so late
      arrivals can still spectate but can't join in. Logged-in players are
      identified by the session resolved at connect time and keep their
      account color; anonymous guests get back a one-time `token` (in a
      `PuzzleWsJoinResultMessage`, addressed only to them) they must resend
      with every `move`/`select` message (since a free-text name alone isn't
      a real identity, and a fresh WebSocket connection has no memory of a
      previous one's identity) plus a freshly generated color.
    - **Moves**: click a tile, then another, to send `{type: "move", cellA,
cellB, participantId, token}` — free swap, not a classic sliding-15-
      puzzle, so any arrangement is trivially solvable and two players can
      never block each other on an empty-slot constraint. Every move is
      server-authoritative: `PuzzleDO.swapTiles()` checks the caller joined
      before start, then persists the swap and broadcasts it to _every_
      connected client (including the mover, who observes their own move
      through that same broadcast rather than a direct reply), tagged with
      the mover's name and color. A rejected move comes back as a
      `PuzzleWsErrorMessage` to the sender only.
    - **Block selection**: `{type: "select", cell, participantId, token}`
      broadcasts a `tile_selected` event (`cell`, `player`, `color`) the
      instant a joined player picks a block, _before_ they've picked its swap
      partner — a pure UX cue, not persisted anywhere and not itself a move
      (see `PuzzleDO.selectTile()`), so every other connected client can
      highlight what's about to move and in whose color.
- **Timer**: same DO alarm mechanism as the lobby, just re-armed for
  `startedAt + timeLimitMs` once play begins. On solve, the alarm is
  cancelled; on expiry, the puzzle ends `timeout` with score 0.
- **Scoring**: points are awarded per move when one or two tiles are placed
  correctly for the first time. A tile can score only once, preventing
  repeated swaps from farming points. Each `move` event contains the score
  for that move (or `null`) and the player's running total; `state`,
  `solved`, and `timeout` expose sorted per-player results. Final logged-in
  totals are persisted through the Leaderboard RPC, including partial scores
  when the puzzle times out.
- **Replay and regenerate**: once solved/timed out,
  `POST /puzzles/:id/replay` creates an independent puzzle that copies the
  source image, while `POST /puzzles/:id/regenerate` creates an independent
  puzzle with a freshly generated image. The caller becomes the new host;
  neither operation mutates the source puzzle.
- **Presence**: the DO broadcasts a `connectedPlayers` count on every
  connect/disconnect and a `player_joined` (name + color) event on every
  join; `getState()`/every `state` broadcast includes the full
  `participants` roster.
- **Rating**: shown once solved/timed out, same star widget/mechanism as
  Guess the Prompt.

Routes: `POST /puzzles`, `GET /puzzles/:id`, `GET /puzzles/:id/ws` (also
carries the `join`/`move`/`select`/`deselect` client messages — see above),
`POST /puzzles/:id/start`, `POST /puzzles/:id/replay`,
`POST /puzzles/:id/regenerate`, `GET /puzzles/:id/image`.

### Browse & ratings (`apps/browse`)

A Durable Object can't be listed or queried across instances, so "browse
everyone's games" needs a real index — that's the one thing in this project
backed by D1 rather than DO storage. The `catalog` table is a thin,
denormalized mirror of each game/puzzle (id, kind, theme, thumbnail key,
rating aggregate, live play status), kept in sync via `CatalogService`'s
RPC methods, called by `guess` and `puzzle`: `insertCatalogEntry` at
creation, then `markCatalogGenerating`/`markCatalogReady`/`markCatalogError`
from their queue consumers as generation progresses, and `updatePlayStatus`
whenever a game/puzzle's own join window opens or closes. GameDO/PuzzleDO
remain the sole source of truth for live gameplay — the catalog only ever
mirrors a coarse `playStatus`, not moves/scores/timers.

- **`playStatus`** (`joinable` | `active` | `finished`) tracks each entry's
  live join/spectate window, independently of `status` (which only reflects
  generation progress / thumbnail availability) — the two don't move in
  lockstep: both games become `ready` (have a thumbnail) the instant they
  enter their waiting-room lobby, which is still `joinable`, not `active`.
  `joinable` covers still-generating entries too (no thumbnail yet), since
  both games' own join window is open right from creation, not just once a
  lobby exists. Since both games now share the exact same lobby shape (see
  the intro above), both flip to `"active"` the same way: from inside their
  own DO (`GameDO`/`PuzzleDO`), not their queue consumer, since it's a
  live-gameplay transition (host "start now" or the lobby alarm) rather
  than a generation one — see `GameDO.beginPlaying()` / `PuzzleDO.
beginPlaying()`. Both games call `"finished"` when they become `solved`
  or `timeout`. Every call is `.catch()`'d and
  wrapped in `ctx.waitUntil()` (fired from a DO method that doesn't
  otherwise await them) so a `browse` hiccup can never break a live move,
  a lobby auto-start, or (for generation-phase writes) trigger a spurious
  retry of AI generation that already succeeded.
- `GET /api/catalog` without `playStatus` is the plain browse gallery:
  everything with `status = 'ready'`, filterable by kind, ownership scope,
  and live play status, sortable by recency or average rating, and paginated.
  Results include the creator, whether the theme was generated, rating
  aggregate, and replay metadata. Pass `playStatus=joinable` for
  open lobbies/still-generating games you can join as a player, or
  `playStatus=active` for started games/puzzles you can only spectate —
  either widens the `status` gate to `!= 'error'` so not-yet-thumbnailed
  entries show up too.
- Replay chains are collapsed to their newest relevant catalog card. Replays
  retain their source relationship and chain rating; regenerations begin a
  fresh visual chain while recording their origin.
- `POST /api/catalog/:id/rate` records a 1-5 star rating. The catalog returns
  the chain-wide average rounded to the nearest half star.

### Leaderboard (`apps/leaderboard`)

Aggregates `leaderboard_entries` — one row per scoring event, written
exclusively through `LeaderboardService.recordScore` — into per-user
totals. Kept as an event log (rather than a running total) specifically so
time-windowed queries can filter on `created_at` directly.

`GET /api/leaderboard` returns a paginated ranking by summed score plus the
calling user's own standing (score + rank, even outside the current page).
It is filterable by `kind` (`guess`/`puzzle`/all), `period`
(`day`/`week`/`month`/all-time), and `scope` (`global`/`friends`). The
friends scope requires authentication; global page size is Flagship-backed.
When kind is omitted, each row intentionally has `kind: null` because its
score combines all supported game types.

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
- **Play identity**: both games establish identity through their WebSocket
  join flow. Logged-in players are upserted by session `userId` (which is
  also their participant id), cannot spoof a nickname, and retain their
  account color. Anonymous guests submit a nickname and receive a private
  bearer token plus generated color. Later actions are checked against the
  join roster rather than trusting a resent display name.

### Notifications (`apps/notifications`)

The one shared, general-purpose channel every service uses to push a
user-facing message — the direct successor to what used to be `friends`'
own invite-only `UserDO`. Nothing here is hardcoded to invites, or to any
other specific kind of message: a notification's `type` is a free-form
string (`"invite"`, `"friend_request"`, `"system"`, whatever a future
feature needs) carrying opaque, caller-defined `data`, so a brand-new kind
of notification is just a new `type` string a caller starts sending — never
a schema or API change in this service.

- **Creating a notification is server-to-server only**, via the
  `NotificationsService` RPC entrypoint (`services` binding +
  `entrypoint: "NotificationsService"`) — there is no HTTP endpoint to
  notify an arbitrary user, only to manage your own inbox. Two independent
  choices a caller makes per call:
    - **`send`/`sendMany`** persist a row in this service's own
      `notifications` table (recoverable via `GET /api/notifications` if the
      recipient was offline) _and_ push it live. Use this for anything that
      doesn't already have its own durable "what's pending" store.
    - **`push`/`pushMany`** skip persistence and only push live — for a
      caller that already owns its own source of truth (e.g. `friends`'
      `game_invites` + `GET /api/invites/pending`), so the same fact isn't
      kept in two places able to drift apart.
- **Live delivery**: `NotificationDO` (one instance per user id, routed via
  `getByName(userId)`) holds that user's open WebSocket connections and
  broadcasts to all of them the instant `send`/`push` runs. A client opens
  one via `GET /api/notifications/ws` — same shape as every game DO's
  WebSocket, just for account-wide messages instead of one game's state.
- **Inbox**: `GET /api/notifications` lists this user's unread, persisted
  notifications; `POST /api/notifications/:id/read` and
  `POST /api/notifications/read-all` clear them.

### Friends & invites (`apps/friends`)

- **Friends** (`GET /api/friends`): request by username
  (`POST /api/friends/request`); a mutual request — the other side already
  asked you — auto-accepts instead of leaving two pending rows. Accept/
  decline/cancel and unfriend are all there too.
- **Groups**: create named groups of your own friends
  (`POST /api/groups`), add/remove members, delete. Owner-only, enforced
  server-side (not just hidden in the UI).
- **Invites**: `POST /api/invites` targets a single friend (`friendId`) or
  fans out to every eligible member of a group (`groupId`) — one
  `game_invites` row per recipient either way. Existing participants are
  excluded. Accepting (`POST /api/invites/:id/accept`) validates that the
  game is still joinable, automatically adds the authenticated recipient to
  its participant roster, and returns the `playUrl` the client redirects to.
- **Live delivery**: the recipient doesn't have to be on the friends page to
  see an invite — `POST /api/invites` calls `NOTIFICATIONS.push()` (see
  "Notifications" below) right after the D1 write, so a connected client
  gets it instantly over `apps/notifications`' shared WebSocket instead of
  `friends` owning a delivery channel of its own. D1 (`game_invites`) stays
  the source of truth either way — `GET /api/invites/pending` covers
  anything sent while a client was offline, same as before.
- Every mutating friends/groups/invites route requires a session and
  returns 401/403 on cross-user access (stealing someone else's group,
  accepting someone else's invite).

---

## Installation and infrastructure

```sh
npm install                                           # installs all seven apps + shared packages

wrangler r2 bucket create game-guess-images           # shared by guess + puzzle
wrangler queues create game-generation
wrangler queues create game-generation-dlq
wrangler queues create puzzle-generation
wrangler queues create puzzle-generation-dlq
wrangler d1 create game-worker-catalog                # then paste database_id into every apps/*/wrangler.jsonc
wrangler d1 migrations apply game-worker-catalog --remote   # run from apps/accounts, or any D1-bound service
```

Also configure the Cloudflare Flagship app referenced by each
`wrangler.jsonc`. It owns runtime settings such as lobby and round timers,
round/grid limits, score bounds, matching threshold, player/theme length,
leaderboard page size, and preset themes. Every setting has a code fallback
so transient flag evaluation failures do not stop gameplay.

No secrets to set and nothing to register — accounts are a username plus
a hashed 6-digit code, both entirely in D1, and sessions are opaque tokens
looked up the same way, not signed cookies.

### Environments: dev / staging / production

Every `apps/*/wrangler.jsonc` defines three environments, each pointing at
its **own** physical resources — deploying to one never touches another's
data:

| Environment                                       | Worker names                    | D1 database                   | R2 bucket                   | Queues                                   |
| ------------------------------------------------- | ------------------------------- | ----------------------------- | --------------------------- | ---------------------------------------- |
| `dev` (unnamed/top-level config, no `--env` flag) | `game-<service>-worker`         | `game-worker-catalog`         | `game-guess-images`         | `game-generation*`, `puzzle-generation*` |
| `staging`                                         | `game-<service>-worker-staging` | `game-worker-catalog-staging` | `game-guess-images-staging` | `*-staging`                              |
| `production`                                      | `game-<service>-worker-prod`    | `game-worker-catalog-prod`    | `game-guess-images-prod`    | `*-prod`                                 |

Service bindings (RPC) always target the sibling Worker in the _same_
environment (e.g. `friends`'s staging deploy binds `ACCOUNTS` to
`game-accounts-worker-staging`, not the dev one). Bootstrapping a fresh
staging or production environment means creating that environment's D1
database/R2 bucket/queues (same commands as above, with a `-staging`/
`-prod` suffix) and pasting the resulting IDs into each app's `env.staging`
/ `env.production` block, then running migrations for that database once
(`wrangler d1 migrations apply game-worker-catalog-staging --remote --env
staging`, from `apps/accounts`).

---

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

The service registry in `.github/services.json` is the single source of
truth for all seven Workers and which five use D1. The deploy workflow
typechecks the monorepo, applies shared migrations when required, and fans
the selected services out through the reusable `deploy-service.yml` matrix.

Two ways it runs:

- **Push to `main`**: deploys all registered services to production.
- **Manual `workflow_dispatch`**: choose `dev`, `staging`, or `production`
  and provide a comma-separated service list or `all`.

Either way, D1 migrations apply idempotently through `apps/accounts` before
any selected D1-backed service deploys. Selected Workers deploy in parallel
once an environment has been bootstrapped; a new environment needs the
dependency-ordered first deployment documented in `deploy.yml`.

Requires two repository secrets: `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.
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
