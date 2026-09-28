# Architecture

This covers how Vigame is built today and the plan for a real game server.
Nothing in the server section is built yet. The README covers the current
modules and online data model in more detail.

## Today: client only

All logic runs in the browser. The modules in `src/` form layers, each
depending only on the ones above it:

| Module | Role |
| --- | --- |
| `hex.js` | Hex-grid math. Pure. |
| `board.js` | Terrain generated from a seed, so every client builds the same map. Pure. |
| `game.js` | Rules: units, turns, movement. Pure, with no DOM, so it can run on a server unchanged. |
| `camera.js`, `render.js` | Pan and zoom, and canvas drawing. The renderer sits behind a small interface so PixiJS can replace it. |
| `net.js` | The networking seam: one interface, several transports. |
| `main.js` | Input, HUD, and the switch to online play. The only module that touches the page. |

`net.js` has two transports today:

- **Local**: two players take turns in one browser.
- **Artifact**: online play through the claude.ai Artifact runtime. The whole
  game lives in one shared document (`game/state`), seats in another
  (`game/seats`), and each viewer's picked hex is shared as presence.

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
needs the server below.

## Plan: authoritative game server

### Shape

- **Server**: Node running [Colyseus](https://colyseus.io/), with one room per
  game. The room holds the real game state in memory and checks every action
  with `game.js`.
- **Connection**: WebSocket. Clients send only what they want to do
  (`move { unit, q, r }`, `endTurn`). The server checks it, applies it, and
  sends every client what changed. Clients never send game state.
- **REST**: only around the game itself: login, the lobby and game list, and
  history. Colyseus provides the HTTP endpoints for creating and joining rooms.
- **Client**: unchanged apart from a third `net.js` transport for Colyseus,
  where `commit` becomes a room message and `onState` a state patch.

### Storage

The server keeps each game in memory and uses the database as its durable
copy.

- **Database**: SQLite through better-sqlite3 (decided for now). Node 22's
  built-in `node:sqlite` would avoid the dependency, but it is still
  experimental.
- **Tables**: `games` holds each game's current state as JSON. `moves` is an
  append-only log of every accepted action, so any game can be replayed,
  checked and debugged.
- **Storage module**: all database access goes through a small module
  (`loadGame`, `saveGame`, `appendMove`), so moving to Postgres later changes
  one file.
- **Write-ahead logging** (`PRAGMA journal_mode=WAL`): recommended, not
  required.
  - It isn't needed for crash safety: SQLite's default journal is equally safe.
  - It does let reads and writes run without blocking each other, and makes
    writes faster.
  - It is required for Litestream backups.
  - Turn it on if using Litestream. With another backup method, such as
    SQLite's backup command on a timer, the default mode is fine.
- **Backups**: continuous with Litestream, or scheduled.
- **Hosting**: needs a persistent disk; many free tiers wipe the filesystem on
  restart. The database must not sit on a network drive.

### Handling an action

Moves are rare in a turn-based game, so each accepted action is saved at
once rather than in periodic snapshots. A crash can then never lose a move the
players already saw.

1. Check the action against the in-memory state with `game.js`.
2. Apply it in memory.
3. Write it to the database: a row in `moves`, plus the new state in `games`.
4. Send the change to the players.

Step 3 comes before step 4, so no client ever sees a move the database
doesn't have.

### Room lifecycle

- **Nobody in the game**: the room shuts down and frees its memory; the game
  lives only in the database.
- **A player returns**: a new room loads the state from `games`, or rebuilds
  it by replaying `moves`.
- **Lobby and history**: read straight from the database, never from rooms.

### When to move off SQLite

SQLite allows one writing process. Once Colyseus runs on several processes or
machines (with Redis coordinating them), move to Postgres.

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

Two choices now keep this open without extra work:

1. Model the server's game state as Colyseus Schema from the start, so
   change-only updates need no rewrite.
2. Shape the rules as `applyCommand(state, cmd)` plus `tick(state, dt)`.
   Turn-based play is then the case where the clock only advances on end turn.
