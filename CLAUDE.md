# Vigame: notes for Claude

A real-time hex strategy prototype in plain JavaScript ES modules: a
deterministic game core (`src/core/`), a canvas page (`src/client/`), and a
Colyseus game server (`server/`). See README.md for the game, layout, server API and data model.
This file covers what isn't obvious from the code.

The design and the decisions behind it (a plain-data core that Colyseus only
mirrors, SQLite, logging commands and replaying them) are in
docs/architecture.md. Read it before working on the core, networking or
persistence.

## Commands

- `npm test`: unit tests (node:test), including a real game server
  (`test/server.test.js`). A few seconds; run after every change.
- `npm start` / `npm run dev`: the game server, which also serves the page, on
  port 2567. Dev mode serves `/playground` and runs a game's clock with one
  player (`soloClock`), for trying things alone.
- `npm run smoke`: Playwright/Chromium check of the page through a real game
  server: login, lobby and games between three browsers, a subfolder proxy,
  and a phone. Run it before pushing UI, net or server changes. In Claude Code cloud sessions, Chromium is
  preinstalled and found through `PLAYWRIGHT_BROWSERS_PATH`; don't run
  `playwright install` there.

## The game core (src/core/game.js, src/core/rules.js)

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
  to hide something from players, or to keep a counter that changes every
  tick out of it (units' experience is hidden for that, and sides' tallies
  until the game is over): a changed field resends its whole unit or
  building to every player.
- Sides: `state.players` has one record per owner number: the players,
  then in cooperation the Dark Lord, then always the raiders. A record's
  `side` picks its name and colours in `SIDES` (use `sideOf`, never
  `SIDES[owner]`), its `team` who fights whom (use `allied`). Seats are the
  sides whose palette isn't `npc` (`seatsOf`).
- The map depends on the seed and the number of players. Castle sites come
  from a table in board.js, not from sines and cosines, so the browser and
  the server build exactly the same map; keep it that way.
- Changing the state's shape: bump `STATE_VERSION`. Saved snapshots of the old
  shape then fail `checkState`, and the room rebuilds those games from their
  command logs, which only works if old commands still replay.

## The page (src/client/)

- There is no build step: the server serves `src/client/` and `src/core/` as
  they are, and the browser loads them as ES modules. So `src/` may not
  import npm packages (a browser can't resolve them); the page gets the
  Colyseus client as the global `Colyseus`, from `vendor/colyseus.js`.
- `src/core/` is shared with the server: keep it pure, with no DOM, network
  or clock. `src/client/` is the browser's alone.
- The page runs no game rules. It draws what the server sends, using the
  core's read-only helpers (`occupancy`, `footprint`, `nearStanding`, the
  board from its seed and player count), and sends commands.
- The board redraws only when something changed or moves (`needsDraw`,
  `moving` in play.js), or while an effect plays (`effects.js`: hits,
  falls, deaths). Effects are short, so the page is still once they end;
  keep new ones short, and don't add looping ones. The minimap is stricter: at most twice a second, only
  after a server update, and only if a pixel differs; its view frame is an
  element, so panning never repaints it. Keep it that way as it grows.
- Sounds are synthesized (`sounds.js`, Web Audio): a sound is a few notes
  in `SOUNDS`, and `soundsFor` picks them from each update, as a pure
  function the tests run in Node. Keep them gentle and short (the tests
  check the gain, the wave and the length), hear fighting only on screen,
  and don't add looping ones.
- Pictures are one-colour SVGs in `src/client/art/`, from game-icons.net
  under CC BY 3.0: a new or replaced one needs its line in
  `art/CREDITS.md` (`test/tokens.test.js` checks), and the lobby's About
  must still name its authors (checked too). The page colours them, so
  a file carries no colours, scripts or links of its own. Pictures made
  for Vigame by its author, such as the tab's icon (`art/favicon.png`) and the login page's banner
  (`art/banner.webp`), are
  CC BY-SA 4.0, each with its line in `art/CREDITS.md` too; the code is
  GPL-2.0-or-later.
- Views switch with a page load: `?game=<id>` is a game, anything else the
  lobby, and the login page comes first while the browser isn't signed in.

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
- The clock runs only while every seat is held by a player who is here, and
  never again once the game is over (`over` in the state). While it is
  paused the room refuses commands, except `rename`, which needs no clock;
  after a rename it saves a snapshot at once, since the lobby reads a game's
  name from its snapshot and a paused game takes none.
- Commands are flat objects of short strings, numbers and short lists of
  short strings (such as a crew's unit ids); the room rejects
  anything else before the core sees it (`flatCommand`).
- Only signed-in players join: `gameRoom(storage)` in `server/room.js` makes
  the room class whose static `onAuth` checks the `players` table. Colyseus
  calls `onAuth` on the class before any room exists, with only the client's
  options, which is why the class carries the storage. Name rules (players'
  and games') live in `src/core/player.js` so the page and the server agree.
- The page may be served under a subfolder by a proxy that strips it
  (README, "Behind nginx"). So the page never uses a root-relative address:
  resolve against `serverBase()` in `src/client/api.js`, and keep every
  address in `index.html` relative. The smoke check plays one game through such a proxy.
- Throw `ServerError` for refusals a client should see (unknown game, and so
  on); Colyseus logs other errors as server faults.
- The database schema version is `SCHEMA_VERSION` in `server/storage.js`.
  Change tables only by adding a step to `migrate()`.

## The old claude.ai version

An earlier, turn-based version was published as the claude.ai artifact
"Vigame Hex Board". It is no longer built or maintained from this repository;
leave the published artifact alone unless asked.
