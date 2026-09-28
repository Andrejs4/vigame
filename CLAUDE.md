# Vigame: notes for Claude

A turn-based hex strategy prototype in plain JavaScript ES modules, with a
Colyseus game server in `server/`. See README.md for the game, layout, server
API and data model. This file covers what isn't obvious from the code.

The game server's design and the decisions behind it (Colyseus, SQLite,
saving each command before sharing it) are in docs/architecture.md. Read it
before working on networking or persistence.

## Commands

- `npm test`: unit tests (node:test), including a real game server
  (`test/server.test.js`). A few seconds; run after every change.
- `npm run server` / `npm run server:dev`: the game server on port 2567. Dev
  mode rebuilds the page on every load and serves `/playground`.
- `npm run build`: writes `dist/vigame.html` (standalone) and `dist/artifact.html`
  (the same page without the document skeleton, for publishing). `dist/` is
  gitignored; never commit it.
- `npm run smoke`: Playwright/Chromium check of the built page, including
  three-browser games through the fake Artifact runtime and through a real
  game server. Run it before publishing or pushing UI, net or server
  changes. In Claude Code cloud sessions, Chromium is preinstalled and found
  through `PLAYWRIGHT_BROWSERS_PATH`; don't run `playwright install` there.

## Bundler constraints (scripts/build.js)

The build concatenates every module into one IIFE, drops imports, and strips
`export`. So in `src/`:

- Imports must be single-line, named, and relative: `import { a, b } from './x.js';`.
  No aliases, default exports, or re-exports. The build fails loudly otherwise.
- Top-level names must be unique across all modules, because they share one
  scope. The build checks this.
- No source may contain `</script`.
- No npm packages. The page gets the Colyseus client as the global
  `Colyseus`, from a `<script>` the game server puts before the bundle
  (`build({ preamble })`).
- Only `src/main.js` may touch the DOM at load time. Keep hex, board and game
  pure: the game server imports them (and `net.js`) directly and runs them
  unchanged.

## Game server (server/)

- Colyseus 0.18 needs Node 22. Its API changed a lot from earlier versions;
  check the type definitions in `node_modules/@colyseus/*/build/*.d.ts`
  rather than memory.
- Colyseus keeps its matchmaker in module state, so one game server per
  process. `test/server.test.js` shares one server across its tests;
  node:test runs each test file in its own process.
- The room state (`server/schema.js`) and its reader, `adopt()` in
  `createServerNet`, must agree on field names. The page learns the schema
  from the server, so there is nothing else to update.
- Every change to a game goes through `applyCommand` in `src/game.js`, on the
  page and in `GameRoom.play`. Put new rules there, not in the room.
- Keep the order in `GameRoom.play`: check and apply on a copy, save, then
  adopt and sync. The tests check that a failed save changes nothing.
- Throw `ServerError` for refusals a client should see (unknown game, and so
  on); Colyseus logs other errors as server faults.
- The database schema version is `SCHEMA_VERSION` in `server/storage.js`.
  Change tables only by adding a step to `migrate()`. `games.state` has the
  page's state shape, so `sanitizeState` applies to it as well.

## The published artifact

The page is published as the claude.ai artifact titled **"Vigame Hex Board"**.
Find it with the Artifact tool's `list` action. Its declared capabilities are
`db`, `room` and `user`.

To republish:

1. `npm test && npm run smoke`.
2. `Artifact` `read` the live artifact first. The tool requires this, and it
   shows whether someone changed the page outside the repo.
3. Publish `dist/artifact.html` with that artifact's `url`, omitting
   `capabilities` so the stored declaration carries over. Then read it back:
   there should be exactly one `<!doctype`.

The db holds live games. Keep `game/state` and `game/seats` backward
compatible, or migrate them deliberately; `sanitizeState` is the place to
accept old shapes. Before publishing a build with a changed runtime version,
check the runtime contract version the artifact is pinned to.

## Online play in claude.ai

- `src/net.js` targets the Artifact runtime contract as read from its type
  definitions: `claude.use(name)`, db `doc().get/set/acquire/onSnapshot`,
  room `presence/peers/onPeers/onConnection/connected`, user `id/can`.
  `test/fake-runtime.js` mirrors that subset. When the contract changes,
  update both and add a test.
- Leases have no early release; they lapse after `ttlMs`. Seat claims wait
  out a busy lease and retry, so tests that seat several viewers use node:test
  mock timers (`setTimeout` and `Date`) and advance time.
- Snapshots can arrive from cache first (`metadata.fromCache`). Never treat an
  empty cached snapshot as "no document".
