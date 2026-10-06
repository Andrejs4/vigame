# Vigame: notes for Claude

A real-time hex strategy prototype in plain JavaScript ES modules: a
deterministic game core (`src/core/`), a canvas page (`src/client/`), and a
Colyseus game server (`server/`). See README.md for the game, layout, server API and data model.
This file covers what isn't obvious from the code.

The design and the decisions behind it (a plain-data core that Colyseus only
mirrors, SQLite, logging commands and replaying them) are in
docs/architecture.md. Read it before working on the core, networking or
persistence.

docs/notes.md has the background: how the author works, how the pictures
were made (with the commands), tools that helped, and plans not yet built (a
"Painted" graphics mode, less drawing during play). Read it before art or
graphics work.

## Working with the author

- He plays the game and doesn't read the code. Report changes as a player
  sees them, send the smoke check's screenshots (`smoke-output/`), and say
  whether the deploy keeps saved games. He deploys with `git pull` and
  `sudo deploy/install.sh` on his server.
- Open a pull request only when he asks for one; he merges it himself.
  Its template (`.github/pull_request_template.md`) is for outside
  contributors (CONTRIBUTING.md): in his, put "The author's own session"
  under Model, Original prompt and Who you are.
- His raw pictures never go to GitHub (`art-src/` is ignored).

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
  `playwright install` there. About a minute and a half; it leaves
  screenshots in `smoke-output/` (`failed-*.png` when a check fails).
- A smoke check compares against what the page itself used, such as the game
  as a dialog found it (`__vigame.crewView`), or goes unit by unit, skipping
  any gone: never against a later view, as units move meanwhile. Two flaky
  checks came from that.

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
  sides whose palette isn't `npc` (`seatsOf`). A seat's palette is
  `SEAT_SIDES[seat]`: seats 9 to 16 came after the Dark Lord's (8) and the
  raiders' (9), so they have 10 to 17, and saved games keep their colours.
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
  keep new ones short, and don't add looping ones. Nothing moves while the
  game is paused (`moving && net.running()`): a paused board once redrew
  every frame, and the smoke check now counts its draws. The minimap is stricter: at most twice a second, only
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
  a file carries no colours, scripts or links of its own. The tab's icon
  (`art/favicon.png`) and the login page's banners (`art/banner.webp`,
  `art/banner-lord.webp`) were generated with Perplexity, for
  non-commercial use only, outside Vigame's licences. The heroes'
  portraits (`art/portraits-men.png`, `art/portraits-women.png`: 8 × 8
  sheets of 32 × 32 faces, colours in `art/portraits.hex`) are the
  author's own, CC BY-SA 4.0. A hero's face comes from its name
  (`portraitOf` in names.js): a new first name for a woman goes in its
  `WOMEN` list too, or she gets a man's face. Each file has its line in `art/CREDITS.md`
  too. Raw source art stays out of git (`art-src/` is ignored). The code is
  GPL-2.0-or-later.
- A dialog closed by a key keeps the focus until the next frame, so the
  same key also reaches the window's shortcuts: those check
  `e.defaultPrevented`, and each dialog's own key handler checks
  `dialog.open` first. Otherwise a key that shuts a dialog reopens it.
- The heroes list is also a `crew-list`, for its styles: a rule for the
  crew chooser alone goes through `.crew-list label`.
- The HUD's pictures are the art/ SVGs used as CSS masks: `--icon` set on
  an element or its parent, the mask on a `::before`. A mask rule reaching
  an element with no `--icon` paints a solid square.
- Views switch with a page load: `?game=<id>` is a game, `?settings` the
  player's name and language, anything else the lobby, and the login page
  comes first while the browser isn't signed in.
- Each player has a language (Auto, English, Russian, Latvian or Finnish:
  `LANGUAGES` in player.js, `LANGUAGE_NAMES` in language.js), kept on the
  server. The login page, the settings page, the lobby, and in a game the
  buttons, the status, stock and selection panels, and the crew, heroes
  and points dialogs are translated: their words are `WORDS` in words.js, which the
  tests keep complete and about as long as the English; a static text in
  index.html names its word with `data-word` (`-title`, `-label` for its
  tooltip and label), and the lobby's How to play and About are written
  out in each language. Messages, the renaming dialog and the heroes
  list's skill letters wait until the author asks. A building's,
  skill's or side's name on the page goes through its word (`typeName`,
  `skillName`, `sideName` in play.js), so every one needs a word: the tests
  check.
  docs/notes.md has his plan, what to watch for, the Russian names already
  used, and how the buttons' words were measured.
- A game button's key is a letter of its label, in bold (`keyLabel`),
  per language (`key…` in words.js); the English keys work in every
  language, so a Russian key may only sit on its own button's English key
  or a free one (the tests check, with `RUSSIAN_KEYS`, the ЙЦУКЕН layout).
  `keyCandidates` matches a press by the character typed, then by the
  Latin and Russian letters on the same key, so keys work in either
  layout. The smoke check holds the Russian buttons to their fit: no
  overflow, two lines at most and three rows on a phone, one line on a
  desktop.

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
- Keep the order in `GameRoom.commit`, which players' commands and the
  room's own go through: apply on a copy, log the command with its tick,
  then adopt the copy. The tests check that a failed write changes nothing.
- The clock runs only while every seat it waits for is held by a player who
  is here, and never again once the game is over (`over` in the state). It
  waits for no seat whose castle has fallen, nor for one marked away: the
  game's creator has it go on without the players missing (`startNow`),
  and a player who is here again is back. Who is away reaches the core
  (the Dark Lord leaves them alone) only as `away` and `back` commands that
  the room gives and logs (`ROOM_COMMANDS`), so replays agree; the room
  refuses them from players. While it is
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
