# Vigame: notes for Claude

A real-time hex strategy prototype in plain JavaScript ES modules: a
deterministic game core, a canvas page, and a Colyseus game server in
`server/`. See README.md for the game, layout, server API and data model.
This file covers what isn't obvious from the code.

The design and the decisions behind it (a plain-data core that Colyseus only
mirrors, SQLite, logging commands and replaying them) are in
docs/architecture.md. Read it before working on the core, networking or
persistence.

## Commands

- `npm test`: unit tests (node:test), including a real game server
  (`test/server.test.js`). A few seconds; run after every change.
- `npm run server` / `npm run server:dev`: the game server on port 2567. Dev
  mode rebuilds the page on every load and serves `/playground`.
- `npm start`: static server for the page as ES modules, playing on one screen.
- `npm run build`: writes `dist/vigame.html`, the standalone page. `dist/` is
  gitignored; never commit it.
- `npm run smoke`: Playwright/Chromium check of the built page, on one screen
  and with three browsers through a real game server. Run it before pushing
  UI, net or server changes. In Claude Code cloud sessions, Chromium is
  preinstalled and found through `PLAYWRIGHT_BROWSERS_PATH`; don't run
  `playwright install` there.

## The game core (src/game.js, src/rules.js)

- The state is plain JSON (`GameState` in game.js). Keep it that way: no
  Maps, classes, `undefined` values or cycles. Remove a field with `delete`,
  never by setting it to `undefined`, so a state equals its JSON round trip.
- Store each fact once. A unit records where it is (`in` a building, or on a
  cell); a building records its anchor cell. Who is inside a building and what
  is on a cell come from `occupancy()`, never from stored lists.
- Deterministic: nothing in the core may read the clock, `Math.random`, the
  DOM or the network. Use `random(state)` for dice. Durations are whole ticks.
  Iterate `Object.values` of the state's records (insertion order), never a
  `Set` of something unordered. The tests replay games and compare states
  exactly, so a slip here fails `npm test`.
- Every change a player makes goes through `applyCommand`, which checks
  everything before it changes anything; time goes through `advance`. Put new
  rules there, not in the room or the page. Numbers go in `rules.js`.
- `checkState` lists every broken invariant. When you add a rule, teach it the
  invariant too: the random-game test runs it after every tick.
- A new state field or entity field needs no change to the server or the
  sync: the room mirrors `publicView` generically. Change `publicView` only
  to hide something from players.
- Changing the state's shape: bump `STATE_VERSION`. Saved snapshots of the old
  shape then fail `checkState`, and the room rebuilds those games from their
  command logs, which only works if old commands still replay.

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
- Only `src/main.js` may touch the DOM at load time. Keep hex, board, rules,
  game and player pure: the game server imports them directly and runs them
  unchanged.

## Game server (server/)

- Colyseus 0.18 needs Node 22. Its API changed a lot from earlier versions;
  check the type definitions in `node_modules/@colyseus/*/build/*.d.ts`
  rather than memory.
- Colyseus keeps its matchmaker in module state, so one game server per
  process. `test/server.test.js` shares one server across its tests, with the
  clock sped up (`tickRate`); node:test runs each test file in its own process.
- The room is an adapter: it feeds commands to the core, runs `advance` on a
  fixed timestep (`setFixedTimestep`), and mirrors `publicView` into the room
  state (`server/schema.js`). It holds no game rules.
- Keep the order in `GameRoom.play`: apply on a copy, log the command with its
  tick, then adopt the copy. The tests check that a failed write changes
  nothing.
- The clock runs only while every seat is held by a player who is here.
- Commands are flat objects of short strings and numbers; the room rejects
  anything else before the core sees it (`flatCommand`).
- Only signed-in players join: `gameRoom(storage)` in `server/room.js` makes
  the room class whose static `onAuth` checks the `players` table. Colyseus
  calls `onAuth` on the class before any room exists, with only the client's
  options, which is why the class carries the storage. Name rules live in
  `src/player.js` so the page and the server agree.
- The page may be served under a subfolder by a proxy that strips it
  (README, "Behind nginx"). So the page never uses a root-relative address:
  resolve against `serverBase()` in main.js, and keep the server's preamble
  `src` relative. The smoke check plays one game through such a proxy.
- Throw `ServerError` for refusals a client should see (unknown game, and so
  on); Colyseus logs other errors as server faults.
- The database schema version is `SCHEMA_VERSION` in `server/storage.js`.
  Change tables only by adding a step to `migrate()`.

## The old claude.ai version

An earlier, turn-based version was published as the claude.ai artifact
"Vigame Hex Board". It is no longer built or maintained from this repository;
leave the published artifact alone unless asked.
