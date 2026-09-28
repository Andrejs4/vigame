# Architecture

This covers how Vigame is built: the page, its three ways of playing, and the
game server with the decisions behind it. The README covers commands, the
module list and the data formats in more detail.

## The page

The modules in `src/` form layers, each depending only on the ones above it:

| Module | Role |
| --- | --- |
| `hex.js` | Hex-grid math. Pure. |
| `board.js` | Terrain generated from a seed, so every client builds the same map. Pure. |
| `game.js` | Rules: units, turns, movement, and `applyCommand`. Pure, with no DOM: the game server runs it unchanged. |
| `camera.js`, `render.js` | Pan and zoom, and canvas drawing. The renderer sits behind a small interface so PixiJS can replace it. |
| `net.js` | The networking seam: one interface, three transports. |
| `main.js` | Input, HUD, and the switch to online play. The only module that touches the page. |

`net.js` has three transports:

- **Local**: two players take turns in one browser.
- **Game server**: play through the Vigame server below. Used when that
  server served the page, which it signals by loading the Colyseus client
  first.
- **Artifact**: online play through the claude.ai Artifact runtime. The whole
  game lives in one shared document (`game/state`), seats in another
  (`game/seats`), and each viewer's picked hex is shared as presence.

Every change to a game in play is a command, `{ type: 'move', unit, q, r }`
or `{ type: 'endTurn' }`, applied with `applyCommand(board, game, player,
command)`. The page applies a command itself first so play feels instant,
then hands it to the transport with the state it produced. The Artifact
transport stores that state; the server transport sends only the command.

### Why the Artifact runtime isn't a real server

It stores shared documents and relays messages, but it runs no code of its
own. So:

- **No rule enforcement.** Anyone who can write can save any state. Every
  client validates what it reads (`sanitizeState`), but a cheater's own copy
  can still differ.
- **No hidden information.** Fog of war needs something that sees everything
  and shows each player only part of it.
- **No work without players.** Turn timers and AI opponents only run while
  someone has the page open.
- **Organization only.** Only signed-in members of the owner's claude.ai
  organization can write or join the live channel; anyone else can only watch.
- **Small limits.** At most 5,000 documents of 256 KB each, no transactions,
  last write wins.

It's fine for an in-organization prototype. Opening the game to the public
needs the game server.

## Game server

`server/`, started with `npm run server`.

### Shape

- **Server**: Node 22 running [Colyseus](https://colyseus.io/) 0.18, with one
  room per game (`GameRoom`). The room holds the real game in memory and
  checks every command with `game.js`.
- **Connection**: WebSocket. Clients send only what they want to do (`move`,
  `endTurn`, `claimSeat`, `releaseSeat`, `select`), as Colyseus requests
  that the room answers or refuses. Clients never send game state.
- **State**: the room state is Colyseus Schema (`server/schema.js`), a copy of
  the `game.js` objects that the room updates after each change. Colyseus
  sends clients only the fields that changed.
- **REST**: only around the game itself: starting a game, the game list (for
  a lobby) and each game's move history. Colyseus provides the HTTP
  endpoints for joining rooms.
- **Players**: anonymous. Each browser keeps a random token in
  `localStorage` and sends it when joining; the room knows the player by it
  and shows other viewers only a hash. Logins would replace the token.
- **Client**: `createServerNet` in `net.js`. The page loads the Colyseus
  browser client from the server (`vendor/colyseus.js`), so `src/` stays
  free of npm imports and the bundler stays simple. Every address the page
  uses is relative to its own folder, so a proxy such as nginx can serve the
  game under a subfolder.

### Storage

The server keeps each game in memory and uses the database as its durable
copy.

- **Database**: SQLite through better-sqlite3. Node 22's built-in
  `node:sqlite` would avoid the dependency, but it is still experimental.
- **Tables**: `games` holds each game's seed, current state (JSON, the same
  shape the page uses) and seats. `moves` is an append-only log of every
  accepted command, so any game can be replayed, checked and debugged.
- **Storage module**: all database access goes through `server/storage.js`
  (`createGame`, `loadGame`, `recordMove`, `saveSeats`, `listMoves`,
  `listGames`), so moving to Postgres later changes one file. The schema
  version lives in SQLite's `user_version`; the module creates or upgrades
  the tables when it opens the database.
- **Write-ahead logging** (`journal_mode=WAL`): on.
  - It isn't needed for crash safety: SQLite's default journal is equally safe.
  - It lets reads and writes run without blocking each other, and makes
    writes faster.
  - It is required for Litestream backups.
- **Backups**: not set up yet. Litestream would stream them continuously;
  SQLite's backup command on a timer would also do.
- **Hosting**: needs a persistent disk; many free tiers wipe the filesystem on
  restart. The database must not sit on a network drive.

### Handling an action

Moves are rare in a turn-based game, so each accepted command is saved at
once rather than in periodic snapshots. A crash can then never lose a move the
players already saw.

1. Check the command against a copy of the in-memory game with
   `applyCommand`.
2. Apply it to the copy.
3. Write it to the database in one transaction: a row in `moves`, plus the
   new state in `games`.
4. Adopt the copy and update the room state. Colyseus sends the change to
   every client with its next patch.

If step 3 fails, the request is refused and the live game is untouched, so no
client ever sees a move the database doesn't have. Seat changes are saved the
same way before they take effect.

### Room lifecycle

- **Joining**: the page joins with `joinOrCreate('game', { gameId, token })`.
  Colyseus sends everyone asking for one game to the same room; the room
  also refuses to open a game that already has a room in this process.
- **The first two players** take the seats. A seat belongs to the player,
  not the connection: it survives reloads, leaving, and the room closing,
  until the player releases it.
- **A dropped connection** keeps its place for 20 seconds, and the Colyseus
  client reconnects by itself. Closing or reloading the page leaves at once.
- **Nobody in the game**: the room shuts down and frees its memory; the game
  lives only in the database.
- **A player returns**: a new room loads the state from `games`, or rebuilds
  it by replaying `moves` if the saved state is unreadable.
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
  `npm run server` in a JavaScript Debug Terminal attaches the debugger
  automatically.
- **Colyseus tools**, each a separate npm package:
  - `@colyseus/playground`: a browser page for joining rooms as test clients,
    sending messages such as `move` by hand, and watching the state change.
    Served at `/playground` by `npm run server:dev` only.
  - `@colyseus/monitor`: a web panel listing live rooms, their clients, and
    each room's current state. Served at `/monitor` only when
    `MONITOR_PASSWORD` is set.
  - `@colyseus/testing` and `@colyseus/loadtest` are not used: the tests run
    a real server with the Colyseus client (`test/server.test.js`), and load
    hasn't mattered yet.
- **Rules without a server**: `game.js` is pure, so most rule bugs reproduce
  in a plain unit test.
- **Replays**: the `moves` log (`GET /api/games/:id/moves`) rebuilds any game
  command by command, up to the point where it went wrong; `replay()` in
  `server/room.js` does it.
- **Production**: the playground is for development only. The monitor shows
  every game's full state, and its API can call any method on a live room,
  so it only exists behind a password.

Stepping through code happens on a local machine. A Claude Code cloud session
can run the server, drive it with test clients and read its logs, but an editor
can't attach a debugger to it.

## Keeping real-time possible

The in-memory authoritative room carries over to real-time play unchanged, and
Colyseus is built for it. Four things would change:

- **Saving**: per-action writes don't work at 10–60 updates a second. Switch
  to periodic snapshots plus the final result, accepting a few seconds' loss
  on a crash. Player commands are small and can still be logged for replays.
- **Rules**: `game.js` works in discrete moves and movement points. Real-time
  needs a simulation that advances every tick (orders like "move to", travel
  over time, cooldowns). `hex.js` and `board.js` carry over.
- **Networking**: clients still send commands, never positions. The server
  broadcasts changes every tick; Colyseus sends only what changed. Clients
  smooth motion between server updates. Predicting your own moves locally is
  only needed if actions feel laggy. WebSocket suits strategy-paced play, not
  twitch action.
- **Scaling**: rooms across several processes means Postgres, as above.

Two choices already keep this open:

1. The room state is Colyseus Schema, so change-only updates need no
   rewrite.
2. The rules take commands (`applyCommand`). A real-time version adds
   `tick(state, dt)` beside it; turn-based play is then the case where the
   clock only advances on end turn.
