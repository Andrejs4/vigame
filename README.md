# Vigame

A turn-based hex strategy prototype. It has a seeded hex map, two sides of
scouts and infantry, and movement that costs more on rough ground. Two people
can play on one screen, from two browsers through the game server in
`server/`, or from two browsers when the page is published as a claude.ai
Artifact.

The page is plain JavaScript with no framework and no runtime dependencies: a
canvas renderer, a handful of ES modules, and a build step that inlines
them into one self-contained HTML file. The game server is Node with
[Colyseus](https://colyseus.io/) and SQLite, and runs the page's own rules
module to check every move.

## Playing

- Click one of your units, then a highlighted hex to move there. Scouts have
  4 movement points, infantry 2. Grass and meadow cost 1, scrub costs 2, and
  water is impassable. Other units block movement.
- **End turn** passes play to the other side, and a full round restores
  everyone's movement.
- Drag to pan, and use the wheel or the − / + buttons to zoom.
  **Coordinates** shows axial `q,r` labels.
- **Game server** is the mode when `npm run server` serves the page. A new
  browser first gives a name and answers a small sum, which the server
  checks. Opening the address then starts a new game, and the address ends
  in `?game=…`: that is the link to send the other player. A browser keeps
  its name and seat across reloads and later visits.
- **Artifact** is the mode inside claude.ai, where the page syncs through the
  Artifact runtime.
- **Hotseat** is the mode anywhere else: two players share one browser.
- In both online modes, the first two viewers take the Blue and Crimson
  seats, and later viewers watch. Every viewer's picked hex shows as a ring:
  solid for yours, dashed for others. **Release seat** frees a seat for a
  spectator to take.

## Working on it

Node 22 or newer.

```sh
npm install        # the game server's packages, plus Playwright for the smoke check
npm run server     # the game server: http://127.0.0.1:2567, games saved in data/vigame.db
npm run server:dev # the same, rebuilding the page on every load, with the Colyseus playground
npm start          # static server for hotseat work: http://127.0.0.1:8080, src/ as ES modules
npm test           # unit tests (node:test, no browser), including the game server
npm run build      # dist/vigame.html (self-contained; opens from file:// too) and dist/artifact.html
npm run smoke      # headless Chromium check of the built page; screenshots in smoke-output/
```

The game server reads these environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `2567` | Port to listen on. |
| `HOST` | `127.0.0.1` | Set `0.0.0.0` to let other machines connect. |
| `VIGAME_DB` | `data/vigame.db` | SQLite database file. It needs a persistent local disk, not a network drive. |
| `MONITOR_PASSWORD` | unset | Serves the Colyseus monitor (live rooms, players and state) at `/monitor`, user `admin`. It can also disconnect players and close rooms, so use a strong password. Without it there is no monitor. |
| `VIGAME_DEV=1` | unset | Same as `server:dev`. |

`npm run smoke` needs a Chromium that Playwright can drive. If you don't
have one, install it with `npx playwright install chromium`.

### Layout

| Path | What it is |
| --- | --- |
| `src/hex.js` | Pointy-top axial hex math: neighbours, distance, pixel conversion, board shapes. Pure. |
| `src/board.js` | Seeded value-noise terrain; same seed, same map on every client. Pure. |
| `src/game.js` | Units, turns, movement rules, Dijkstra reachability, and `applyCommand`, the one way a game changes in play. No rendering or input: the game server runs it unchanged. |
| `src/camera.js` | Screen ↔ world transforms, pan, and zoom about a point. |
| `src/render.js` | Canvas 2D renderer: terrain, grid, movement range, selection rings, hover, units. |
| `src/player.js` | Player-name rules, shared by the page and the server. Pure. |
| `src/net.js` | The networking seam: `createLocalNet` (hotseat), `createServerNet` (game server) and `createArtifactNet` (claude.ai runtime), which share one interface. |
| `src/main.js` | Wires it all together: input, HUD, and the switch to online play. |
| `index.html` | Page markup and styles; loads `src/main.js` as a module. |
| `server/app.js` | The game server: Colyseus, the HTTP API, the page, the monitor. |
| `server/room.js` | `GameRoom`, one per game: checks, saves and shares every command. Only signed-in players get in. |
| `server/challenge.js` | The sign-in sums. |
| `server/schema.js` | The room state Colyseus syncs to every client. |
| `server/storage.js` | All database access (SQLite). |
| `server/main.js` | Command-line entry point (`npm run server`). |
| `scripts/build.js` | Bundles `src/` into `index.html` as one inline script. |
| `scripts/serve.js` | Zero-dependency static server for development. |
| `scripts/smoke.js` | Playwright check of the built page, including three-browser games through the Artifact runtime and the game server. |
| `test/` | Unit tests, plus `fake-runtime.js`, an in-memory stand-in for the Artifact runtime. |
| `docs/architecture.md` | How the pieces fit, and the decisions behind the game server. |

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

### The game server

The server holds each game in memory in a Colyseus room and keeps the
database as its durable copy. The page sends only commands, over WebSocket:

| Message | Payload | Answer |
| --- | --- | --- |
| `move` | `{ unit, q, r }` | the move's number, or a refusal: `not seated`, `not your turn`, `illegal move` |
| `endTurn` | none | the move's number, or a refusal |
| `claimSeat` | none | the seat, or `no free seat` |
| `releaseSeat` | none | |
| `select` | `{ q, r }` or `null` | none; shows your picked hex to everyone |

The server checks each command with `applyCommand` from `src/game.js`, saves
it, and only then updates the room state that Colyseus sends to every
viewer. The page applies its own command straight away so play feels
instant, and puts the server's state back if the command is refused.

Players have no accounts. Each browser makes a random token, keeps it in
`localStorage`, and sends it when joining; the server knows the player by
it, and shows other viewers only a hash of it. Clearing site data loses the
seat.

Before starting or joining a game, a browser signs its token in with a name
and the answer to a sum such as `3 + 4`. The sum keeps out scripts that
don't know about this server, not ones written for it. A name is 1 to 15
letters or digits in any script, with space, `-`, `_`, `.` and `'` allowed
between them; `src/player.js` checks it on the page and on the server.
Other viewers see it next to the seat. Signing in again renames.

HTTP API:

| Request | Result |
| --- | --- |
| `GET /api/challenge` | A sum to answer when signing in: `{ id, question }`. Each one answers once and lasts 10 minutes. |
| `POST /api/players` | Signs in (or renames): `{ token, name, challenge, answer }` gives `{ pid, name }`. `400` for a bad token or name, `403` for a wrong answer. |
| `POST /api/games` | Starts a game with a random map: `{ token }` of a signed-in player gives `201 { id }`, otherwise `401`. |
| `GET /api/games` | The 50 most recently active games, for a lobby. |
| `GET /api/games/:id` | One game: its seed, state and seats. |
| `GET /api/games/:id/moves` | Its move log. |

The database has three tables: `games` (each game's seed, current state and
seats), `moves` (every accepted command, in order, never changed) and
`players` (each signed-in player's public id and name; never the token).
Replaying a game's moves from its seed rebuilds its state, and a room falls
back to that if the saved state is unreadable.

### Online play in claude.ai

Artifact play runs on three capabilities of the claude.ai Artifact runtime:
`db`, `room` and `user`.

- `game/state` (db) holds the authoritative game:
  `{ seed, turn, currentPlayer, units: [{ id, owner, q, r, move, moveMax, name }] }`.
  The map isn't stored, because every client regenerates it from the seed.
  The first viewer seeds the document with the opening position. Each move
  or end of turn writes the whole state, one write at a time.
- `game/seats` (db) maps each seat to its holder: `{ seats: { "0": <user id>, "1": <user id> } }`.
  Viewers claim seats under a short lease on the document, so two people
  can't take the same one.
- Presence (room) carries each viewer's `{ uid, seat, sel }`. `sel` is the
  hex they last picked.

Every client validates what it reads from the store (`sanitizeState`). Any
viewer who can write can put anything there, and a bad document must not
break every page.

### Publishing

Run `npm run build`, then publish `dist/artifact.html` as a claude.ai
Artifact with the capabilities `{ db: {}, room: {}, user: {} }`. That file is
the page without its document skeleton, which the Artifact tool adds itself.
Game state lives in the artifact's db, so it survives republishing as long as
the shape of `game/state` stays compatible.

## Not done yet

[docs/architecture.md](docs/architecture.md) covers the game server's design
and how it would stretch to real-time play.

- There is no combat, capture or win condition; units only move.
- Game server:
  - Players are browser tokens with a name. There are no accounts or
    passwords, and the sign-in sum stops only scripts not written for it.
  - There is no way to change your name from the page yet, though the
    server accepts a new one (`POST /api/players`).
  - There is no lobby page, although `GET /api/games` lists games for one.
  - Any signed-in player can start games; nothing limits how many. Add a
    rate limit before opening it to the internet.
  - One process only: SQLite allows a single writer. Several processes would
    need Postgres (see the architecture doc).
  - Backups are not set up. The architecture doc suggests Litestream.
  - `npm audit` reports advisories in `@colyseus/auth`, which Colyseus
    installs alongside its core; this server switches it off (`auth: false`).
- In claude.ai, turn order is enforced by each client, not by a server.
  Anyone who can write the artifact's db could write any state. There is also
  no way to start a new game from the page; deleting `game/state` and
  `game/seats` from the artifact's db resets it.
- A seat is held until its player releases it, however long they are away.
- On a phone, the 18 × 12 board is wider than the screen even at minimum
  zoom. Pinch-to-zoom and keyboard play are not wired up.

## License

GPL-2.0. See [LICENSE](LICENSE).
