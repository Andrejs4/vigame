# Architecture

This covers how Vigame is built: the game core, the page, and the game
server, with the decisions behind them. The README covers commands, the
module list and the data formats in more detail.

## The game core

The core is `src/core/game.js`, with its numbers in `src/core/rules.js` and the map in
`src/core/board.js`. It is the whole game as one plain JSON object, plus the
functions that change it:

- `newGame(board, { mode })`: the opening position: a castle per player
  with its first units, and in cooperation the Dark Lord's lair.
- `applyCommand(board, state, side, command)`: what a player does (build,
  choose a building's crew, upgrade, move a wagon). It checks everything
  first and either changes the state or refuses with a reason.
- `advance(board, state)`: one tick of time (fighting, food, work, wagons,
  walking).
- `occupancy(state)`, `crewOf(state, id)`: what is where, and who works
  where, worked out from the state.
- `checkState(board, state)`: every broken invariant, if any.
- `publicView(state)`: what players are shown.

### Decisions

- **Plain data, no framework.** The state has no classes, Maps or cycles, so
  it is saved, sent, copied and compared as it is. The core doesn't know
  about Colyseus, the database or the screen. Colyseus only carries a copy
  of it (see below). The same core runs in the page, in the server, and in
  tests or a simulation harness with no players at all.
- **Each fact stored once.** A unit records where it is: inside a building
  (`in`) or on a cell (`q`, `r`). A building records its anchor cell; the
  cells it covers follow from its type (a castle is a cell and its six
  neighbours). Who is inside a building and what stands on a cell are
  derived by `occupancy`, never stored, so they can't disagree with the
  facts. A wagon carries its units for free: they only say they are inside
  it. The derived lookups are rebuilt whenever needed, which takes
  microseconds for a few hundred units; they can become incremental later
  if a profile says so.
- **Deterministic.** The core never reads the clock or `Math.random`.
  Durations are whole ticks; dice come from a seeded generator whose state is
  part of the game (`random(state)`). The same seed and the same commands at
  the same ticks always give the same game. This is what makes saving cheap
  (log the commands, replay them) and simulations trustworthy.
- **Ten ticks a second.** One second per cell is the fastest movement, but
  the clock runs finer so commands take effect within a tenth of a second and
  speeds can be any number of tenths. This is the usual pattern for a
  server-run strategy game: a fixed simulation step, with clients drawing
  smooth motion between steps.
- **Movement as routes, not positions.** A moving unit stores its route, the
  tick it left its cell and the tick it reaches the next. Its record changes
  once per cell, not every tick, so a few hundred marching units cost little
  to send, and a screen draws each one between cells from the clock.
- **Players direct buildings, units follow.** A unit walks only when it is
  given to a building's crew or sent home to its castle. A crew is not a
  list the building keeps: it is the units inside the building or heading
  for it, so a unit is in one crew at most, by construction.
- **Units as individuals.** Each has a name, a level and six skills. Work
  adds to the building's progress (a unit's base work plus its skill) and
  earns the unit a point of experience a tick, for its level and for the
  skill it used. The level table is built by multiplication alone, and names
  come from the game's own dice, so replays match.
- **Experience stays out of the view.** It changes every tick a unit works,
  and the sync resends a whole unit when any of its fields changes, so
  `publicView` leaves it out: players see levels and skills, which change a
  few times a minute at most.
- **Wagons hold two cells while rolling**, the one they leave and the one
  they enter, and only roll into a cell no building holds. So no two
  buildings ever share a cell, and wagons can't pass each other.
- **Invariants are checked, not hoped for.** `checkState` knows the rules the
  state must keep. The tests play long games of random commands from both
  sides and check after every tick, and replay games through a JSON round
  trip to prove determinism.

### Simulations

A harness needs nothing new from the core: create a board and a state, then
call `applyCommand` and `advance` in a loop. `test/game.test.js` already does
this with random commands. What's missing is the harness itself: bots
(functions from a state to a command), a way to list a side's sensible
commands, and reports (win rates, game length, balance per building and skill).

## The page

The page is plain ES modules with no framework and no build step: the game
server serves `src/client/` and `src/core/` as they are. It runs no game
rules. It draws what the server sends and passes the player's clicks on as
commands.

| Path | Role |
| --- | --- |
| `src/core/` | The pure modules above, shared with the server: hex math, the board, the rules, the core, player names. |
| `client/main.js` | Picks the view: the login page while the browser isn't signed in, then a game (`?game=<id>`) or the lobby. Views switch with a page load, so leaving a game always leaves its room. |
| `client/api.js` | The browser's token and the HTTP calls, all by addresses relative to the page. |
| `client/login.js`, `lobby.js` | The login page and the lobby. |
| `client/play.js` | The game view: input, HUD, controls. |
| `client/net.js` | The connection to a game: commands out, the core's view in. |
| `client/camera.js`, `render.js` | Pan and zoom, and canvas drawing. The renderer sits behind a small interface so PixiJS can replace it. |
| `client/minimap.js` | The whole board at a few pixels a cell; pressing it moves the camera. |
| `client/effects.js` | Hits, falls and deaths, inferred by comparing each update with the one before: the server sends states, not events. |

- **No prediction.** A command takes effect on the server's next tick, a
  tenth of a second at most, which is normal for a strategy game.
- **Shared helpers, not copied logic.** The page gets a view with the shape
  of the core's state, and uses the core's own read-only helpers on it: the
  board from its seed and player count, `occupancy`, a building's `footprint`, where one may
  build. It imports them from `src/core/`, the same files the server runs,
  so nothing can drift apart.
- **No local play.** An earlier version could run the core in the page for
  play on one screen. It was dropped: everything goes through the server,
  and `npm run dev` lets a game's clock run with one player for trying things
  alone.

## Game server

`server/`, started with `npm start`.

### Shape

- **Server**: Node 22 running [Colyseus](https://colyseus.io/) 0.18, with one
  room per game (`GameRoom`). The room is an adapter: it holds the core's
  state in memory, runs `advance` on a fixed timestep
  (`setFixedTimestep`), and passes players' commands to `applyCommand`. It
  has no game rules of its own.
- **The clock** runs only while every seat is held by a player who is here
  (and stops for good once the game is over),
  so a game waits for an absent player instead of playing on without them.
- **Connection**: WebSocket. Clients send only what they want to do
  (`command`, `claimSeat`, `releaseSeat`, `select`), as Colyseus requests
  that the room answers or refuses. Clients never send game state.
- **Sync**: the room mirrors `publicView` into the Colyseus state
  (`server/schema.js`) after every tick and command. The mirror is generic:
  each building and unit is one JSON string keyed by its id, and each other
  field of the view one more. Colyseus sends only the entries that changed.
  A new field in the core needs no change to the server or the page. Typed
  Colyseus schemas would send a little less, at the cost of describing every
  field twice; that trade can be revisited if bandwidth ever matters.
- **Hidden information**: `publicView` is where fog of war would go, per
  side. Colyseus can then send each client its own view (`StateView`).
- **REST**: only around the game itself: signing in, starting a game, the
  game list (for a lobby) and each game's command log. Colyseus provides the
  HTTP endpoints for joining rooms.
- **Players**: no accounts. Each browser keeps a random token in
  `localStorage` and sends it when joining; the room knows the player by it
  and shows other viewers only a hash. Before a token may start or join a
  game, it is signed in with a name and the answer to a small sum
  (`server/challenge.js`), and the `players` table records the name. The
  room's `onAuth` refuses anyone else before a room is found or created.
  Logins would replace the token and the sum.
- **Client**: `createServerNet` in `src/client/net.js`. The page loads the
  Colyseus browser client from the server (`vendor/colyseus.js`), so `src/`
  stays free of npm imports and needs no build step. Every address the page
  uses is relative to its own folder, so a proxy such as nginx can serve the
  game under a subfolder.

### Storage

The server keeps each game in memory and uses the database to rebuild it.

- **Database**: SQLite through better-sqlite3. Node 22's built-in
  `node:sqlite` would avoid the dependency, but it is still experimental.
- **Commands, not states**: the state changes ten times a second, far too
  often to write. Because the core is deterministic, the server saves what
  it takes to rebuild the game instead: every accepted command with the tick
  it was applied at (`commands`), written before the command takes effect,
  and a snapshot of the state (`games.state`) every ten seconds and when the
  room closes, with the last command it includes (`games.seq`).
- **Rebuilding**: a room opening a game loads the snapshot and replays the
  commands after it, each at its tick. If the snapshot is unreadable (it
  fails `checkState`, say after the state's shape changed), it replays the
  whole log from the opening position. A crash can lose the game time since
  the last snapshot or command, never a command.
- **Storage module**: all database access goes through `server/storage.js`,
  so moving to Postgres later changes one file. The schema version lives in
  SQLite's `user_version`; the module creates or upgrades the tables when it
  opens the database.
- **Write-ahead logging** (`journal_mode=WAL`): on.
  - It isn't needed for crash safety: SQLite's default journal is equally safe.
  - It lets reads and writes run without blocking each other, and makes
    writes faster.
  - It is required for Litestream backups.
- **Backups**: not set up yet. Litestream would stream them continuously;
  SQLite's backup command on a timer would also do.
- **Hosting**: needs a persistent disk; many free tiers wipe the filesystem on
  restart. The database must not sit on a network drive.

### Handling a command

1. Apply it to a copy of the in-memory state with `applyCommand`. A refusal
   goes back to the player with the core's reason.
2. Log it, with the current tick, in one transaction.
3. Adopt the copy and mirror it. Colyseus sends the change with its next
   patch.

If step 2 fails, the command is refused and the live game is untouched, so
nothing happens that the log doesn't have. Seat changes are saved the same
way before they take effect.

### Room lifecycle

- **Joining**: the page joins with `joinOrCreate('game', { gameId, token })`.
  Colyseus sends everyone asking for one game to the same room; the room
  also refuses to open a game that already has a room in this process.
- **The first players to join** take the seats, as many as the game has. A seat belongs to the player,
  not the connection: it survives reloads, leaving, and the room closing,
  until the player releases it.
- **A dropped connection** keeps its place, and the clock keeps running, for
  20 seconds while the Colyseus client reconnects by itself. Closing or
  reloading the page leaves at once, which pauses the game.
- **Nobody in the game**: the room saves a snapshot, shuts down and frees its
  memory; the game lives only in the database.
- **A player returns**: a new room rebuilds the game from the snapshot and
  the log.
- **Lobby and history**: read straight from the database, never from rooms.

### When to move off SQLite

SQLite allows one writing process. Once Colyseus runs on several processes or
machines (with Redis coordinating them), move to Postgres. The "one room per
game" guard in `GameRoom` is per process too. Colyseus's matchmaking keeps
ordinary joins for one game together across processes, but the guard against
a client opening a second room directly would have to move into Redis or the
database.

### Debugging

- **Breakpoints**: run the server with `node --inspect server/main.js` and
  attach VS Code or Chrome DevTools (`chrome://inspect`). In VS Code, running
  `npm start` in a JavaScript Debug Terminal attaches the debugger
  automatically.
- **Colyseus tools**, each a separate npm package:
  - `@colyseus/playground`: a browser page for joining rooms as test clients,
    sending messages such as `command` by hand, and watching the state
    change. Served at `/playground` by `npm run dev` only.
  - `@colyseus/monitor`: a web panel listing live rooms, their clients, and
    each room's current state. Served at `/monitor` only when
    `MONITOR_PASSWORD` is set.
  - `@colyseus/testing` and `@colyseus/loadtest` are not used: the tests run
    a real server with the Colyseus client (`test/server.test.js`), and load
    hasn't mattered yet.
- **Rules without a server**: the core is pure, so most rule bugs reproduce
  in a plain unit test, and `checkState` says which invariant broke first.
- **Replays**: the command log (`GET /api/games/:id/commands`) rebuilds any
  game tick by tick, up to the point where it went wrong; `replay()` in
  `server/room.js` does it.
- **Production**: the playground is for development only. The monitor shows
  every game's full state, and its API can call any method on a live room,
  so it only exists behind a password.

Stepping through code happens on a local machine. A Claude Code cloud session
can run the server, drive it with test clients and read its logs, but an editor
can't attach a debugger to it.
