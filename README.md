# Vigame

A real-time hex strategy prototype. Each side has a castle that makes units
over time; players build towers and wagons, send units between their
buildings, and drive wagons across the map with units inside. There is no
combat yet: the structure is in place, and the rules are placeholders.

The game core is plain data and pure functions (`src/core/`), with no
screen, network or clock of its own. The game server runs it, and tests play
whole games with it and no players at all. The server is Node with
[Colyseus](https://colyseus.io/) and SQLite; it mirrors each game's state to
its players. The page (`src/client/`) is plain JavaScript ES modules with no
framework and no build step: the server serves them as they are. It shows
what the server sends and passes on the player's clicks as commands.

## Playing

Run `npm start` and open http://127.0.0.1:2567.

- **Log in** with a name and the answer to a small sum. A browser stays
  logged in across visits.
- **The lobby** lists your games and games waiting for a second player;
  **New game** starts one. A game's address (`?game=…`) is also the link to
  send someone. The first two players take Blue and Crimson; later visitors
  watch. **Release seat** frees a seat for a spectator to take.
- **The game clock** runs only while both players are here. (`npm run dev`
  runs it with one, for trying things alone.)
- **Your castle** covers seven cells and makes a unit every two seconds, up
  to what it holds. It is its side's life (nothing can attack it yet).
- **Send units**: click one of your buildings, then another of yours. Half of
  those inside go (**Send half** switches to all). They leave one after
  another and march a cell a second on open ground, two on scrub; water is
  impassable. Units heading for a full building wait at its door.
- **Build**: pick **Tower** or **Wagon**, then a highlighted cell: open,
  buildable ground within three cells of one of your standing buildings.
  Scrub can be crossed but not built on; water is neither. One building per
  cell.
- **Upgrade** the selected building: each grade holds as many units again.
- **Wagons** are buildings that move. Select one, then click a cell to drive
  it there, two seconds a cell; the units inside ride along. Wagons can't
  pass through other buildings, each other included: a blocked wagon waits,
  then looks for another way, and stops if there is none.
- Drag to pan, and use the wheel or the − / + buttons to zoom.
  **Coordinates** shows axial `q,r` labels. Escape cancels building and
  clears the selection.
- Every viewer's picked hex shows as a ring: solid for yours, dashed for
  others.

## Working on it

Node 22 or newer.

```sh
npm install        # the game server's packages, plus Playwright for the smoke check
npm start          # the game server and the page: http://127.0.0.1:2567, games saved in data/vigame.db
npm run dev        # the same, with the Colyseus playground, and game clocks that run with one player
npm test           # unit tests (node:test, no browser), including the game server
npm run smoke      # headless Chromium check of the page through the server; screenshots in smoke-output/
```

The game server reads these environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `2567` | Port to listen on. |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to let other machines connect. |
| `VIGAME_DB` | `data/vigame.db` | SQLite database file. It needs a persistent local disk, not a network drive. |
| `MONITOR_PASSWORD` | unset | Serves the Colyseus monitor (live rooms, players and state) at `/monitor`, user `admin`. It can also disconnect players and close rooms, so use a strong password. Without it there is no monitor. |
| `VIGAME_DEV=1` | unset | Same as `npm run dev`. |

`npm run smoke` needs a Chromium that Playwright can drive. If you don't
have one, install it with `npx playwright install chromium`.

### Layout

| Path | What it is |
| --- | --- |
| `src/core/` | Pure modules, shared by the server and the page, with no DOM, network or clock. |
| `src/core/hex.js` | Pointy-top axial hex math: neighbours, distance, lines, pixel conversion, board shapes. |
| `src/core/board.js` | Seeded terrain, with what each terrain allows, and the castle sites; same seed, same map everywhere. |
| `src/core/rules.js` | The numbers: tick rate, sides, building and unit types. |
| `src/core/game.js` | The game core: the state as plain JSON, `applyCommand`, `advance` (one tick), `occupancy`, `checkState`, `publicView`. Deterministic. |
| `src/core/player.js` | Player-name rules, checked on the page and on the server. |
| `src/client/` | The page, served as it is. |
| `src/client/index.html`, `style.css` | Markup and styles for the three views: login, lobby, game. |
| `src/client/main.js` | Entry point: picks the view. |
| `src/client/api.js` | The browser's token, and the HTTP calls. |
| `src/client/login.js`, `lobby.js` | The login page and the lobby. |
| `src/client/play.js` | The game view: input, HUD, controls. |
| `src/client/net.js` | The connection to a game on the server. |
| `src/client/camera.js`, `render.js` | Pan and zoom, and the canvas renderer: terrain, buildings, marching units between cells, picks, hover. |
| `server/app.js` | The game server: Colyseus, the HTTP API, the page's files, the monitor. |
| `server/room.js` | `GameRoom`, one per game: runs the core's clock, logs and applies commands, snapshots. |
| `server/schema.js` | The room state Colyseus syncs: a generic mirror of the core's view. |
| `server/storage.js` | All database access (SQLite). |
| `server/challenge.js` | The sign-in sums. |
| `server/main.js` | Command-line entry point (`npm start`, `npm run dev`). |
| `scripts/smoke.js` | Playwright check of the page through the game server: three browsers, a subfolder proxy, a phone. |
| `test/` | Unit tests, including whole games of random commands checked tick by tick. |
| `docs/architecture.md` | How the pieces fit, and the decisions behind them. |

### Behind nginx

The game server uses one port for everything: the page, the API and the
WebSocket connections. Keep it on `127.0.0.1` and let nginx forward to it;
only nginx's ports (80, 443) need to be open or forwarded on the router.
The page uses only relative addresses, so it works at a domain's root, on a
subdomain, or under a subfolder:

```nginx
location /vigame/ {
    proxy_pass http://127.0.0.1:2567/;         # the trailing slash strips /vigame
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;    # WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;                     # idle games keep their connection
}
```

Players open `https://example.com/vigame/`. The trailing slash matters:
nginx redirects `/vigame` to `/vigame/` for a location like this one, but
another proxy might not, and the page resolves its addresses against its
folder. For a subdomain, use `location /` and `proxy_pass
http://127.0.0.1:2567;` with the same headers.

## The game core

`src/core/game.js` holds the whole game as one plain JSON object:

```js
{
  version: 1, seed: 1337, tick: 420, rng: 123456789, nextId: 58,
  players: [{ id: 0 }, { id: 1 }],
  buildings: {
    b1: { id: 'b1', owner: 0, type: 'castle', grade: 1, q: 2, r: 5 },
    b9: { id: 'b9', owner: 0, type: 'wagon', grade: 1, q: 6, r: 4,
          path: [[7, 4], [8, 4]], since: 410, until: 430 },   // rolling to 7,4
  },
  units: {
    u3: { id: 'u3', owner: 0, type: 'militia', in: 'b1' },    // inside the castle
    u4: { id: 'u4', owner: 0, type: 'militia', q: 3, r: 5,    // marching to b9
          path: [[4, 5], [5, 4]], to: 'b9', since: 418, until: 428 },
  },
}
```

- The map isn't stored: every client builds it from `seed`.
- Time is ticks, ten a second. Movement is a route plus the ticks it set off
  and arrives at its next cell, so a unit's record changes once per cell,
  not every tick, and a screen draws it between cells by the clock.
- Each fact is stored once. What is on a cell and who is inside a building
  come from `occupancy(state)`.
- `applyCommand(board, state, side, command)` applies `send`, `build`,
  `upgrade` or `move`, or refuses with a reason and changes nothing.
  `advance(board, state)` runs one tick.
- The core never reads the clock or `Math.random`; dice come from `rng`. The
  same commands at the same ticks always give the same game, which the
  server's saves and a future simulation harness rely on.
- `checkState` lists everything wrong with a state. The tests play long
  games of random commands and check every tick.

The numbers (speeds, capacities, production, build range, the unit limit)
are placeholders in `src/core/rules.js`.

## The game server

The server runs each game's core in a Colyseus room, ten ticks a second
while both players are present, and mirrors the core's view into the room
state: each building and unit as its own JSON entry, which Colyseus sends
only when it changes. The page sends commands, never state:

| Message | Payload | Answer |
| --- | --- | --- |
| `command` | a core command, such as `{ type: 'send', from, to, count }` | the command's number, or the core's refusal, `not seated`, or `the game is paused` |
| `claimSeat` | none | the seat, or `no free seat` |
| `releaseSeat` | none | |
| `select` | `{ q, r }` or `null` | none; shows your picked hex to everyone |

Players have no accounts. Each browser makes a random token, keeps it in
`localStorage`, and sends it when joining; the server knows the player by
it, and shows other viewers only a hash of it. Clearing site data loses the
seat.

Before starting or joining a game, a browser signs its token in with a name
and the answer to a sum such as `3 + 4`. The sum keeps out scripts that
don't know about this server, not ones written for it. A name is 1 to 15
letters or digits in any script, with space, `-`, `_`, `.` and `'` allowed
between them; `src/core/player.js` checks it on the page and on the server.
Other viewers see it next to the seat. Signing in again renames.

HTTP API:

| Request | Result |
| --- | --- |
| `POST /api/me` | Who a token belongs to: `{ token }` gives `{ pid, name }`, or `null` if it hasn't signed in. |
| `GET /api/challenge` | A sum to answer when signing in: `{ id, question }`. Each one answers once and lasts 10 minutes. |
| `POST /api/players` | Signs in (or renames): `{ token, name, challenge, answer }` gives `{ pid, name }`. `400` for a bad token or name, `403` for a wrong answer. |
| `POST /api/games` | Starts a game with a random map: `{ token }` of a signed-in player gives `201 { id }`, otherwise `401`. |
| `GET /api/games` | The 50 most recently active games, for the lobby, with who holds each seat: `{ pid, name }` or `null`. |
| `GET /api/games/:id` | One game: its seed, latest snapshot and seats. |
| `GET /api/games/:id/commands` | Its command log, with each command's tick. |

The database has three tables: `games` (each game's seed, seats, and a
snapshot of its state, saved every ten seconds and when its room closes),
`commands` (every accepted command with its tick, in order, never changed)
and `players` (each signed-in player's public id and name; never the token).
A room reopening a game loads its snapshot and replays the commands logged
after it; if the snapshot is unreadable, it replays the whole log from the
opening position.

## Not done yet

[docs/architecture.md](docs/architecture.md) covers the design and what
comes next.

- No combat, capture or win condition: units only move between buildings.
- Building and upgrading cost nothing yet; there are no resources.
- A simulation harness: the core can already play games with no players (the
  tests do), but there are no bots or reports yet.
- Game server:
  - Players are browser tokens with a name. There are no accounts or
    passwords, and the sign-in sum stops only scripts not written for it.
  - Any signed-in player can start games; nothing limits how many. Add a
    rate limit before opening it to the internet.
  - A crash loses the game time since the last command or snapshot, up to
    ten seconds; commands themselves are never lost.
  - One process only: SQLite allows a single writer. Several processes would
    need Postgres (see the architecture doc).
  - Backups are not set up. The architecture doc suggests Litestream.
  - `npm audit` reports advisories in `@colyseus/auth`, which Colyseus
    installs alongside its core; this server switches it off (`auth: false`).
  - Upgrading the database to this version drops games saved by the earlier
    turn-based version; players keep their names.
- A seat is held until its player releases it, however long they are away,
  and the game waits for them.
- The lobby lists only the 50 most recently active games.
- On a phone, the 18 × 12 board is wider than the screen even at minimum
  zoom. Pinch-to-zoom and keyboard play are not wired up.

## License

GPL-2.0. See [LICENSE](LICENSE).
