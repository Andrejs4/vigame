# Vigame

A real-time hex strategy prototype. Players direct buildings, not units.
Each side has a castle, home to its units, who raise new ones. Players
build towers, wagons, pits and farms and choose each one's crew from their
named units, who walk there and get better at the work. Pits dig stone,
which pays for towers, farms and upgrades; castles and farms grow food.
There is no combat yet: the structure is in place, and the rules and
numbers are placeholders.

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
- **Your castle** covers seven cells and is its side's life (nothing can
  attack it yet). It is every unit's home, and starts with 12. The units at
  home raise new ones: the more of them, and the better they breed, the
  sooner. It takes in all its units, however many, but stops breeding
  while it holds more than its room.
- **Units** each have a medieval name, a level from 1 to 100, and six
  skills: breeding, ranged attack, close combat, building (which covers
  repairing and digging), farming and running. Work trains the skill it
  uses, and the unit's level with it: every skill at the same pace, the
  level faster the fiercer the work (breeding least, then running, farming,
  building, ranged and close combat, and a killing blow most). A skill
  can't pass the unit's level; it climbs faster than the level, then waits
  for it. Each level takes 1.1 times the work of the one before, so the
  last ones are all but out of reach. Only breeding, building, farming and
  running do anything yet.
- **Crews**: units walk only when they're given to a building's crew or sent
  home. Select one of your buildings and press **Crew…** for a list of your
  units: tick up to what it holds. Those you untick go home; those you tick
  come from wherever they are, one after another, two seconds a cell on open
  ground and four on scrub, less the better they run. Water is impassable.
  **Return** sends the whole crew home. A unit left with nowhere to go (its
  building collapsed, say) goes home by itself.
- **Stone and food** go straight into your side's stock (the HUD shows
  it); nothing carries them. Each side starts with 200 stone.
- **Build**: pick **Tower** (60 stone), **Wagon**, **Pit** or **Farm** (30
  stone), then a highlighted cell: open, buildable ground within three
  cells of one of your standing buildings. Scrub can be crossed but not
  built on; water is neither. One building per cell.
- **Pits**: placing one asks for its crew first, up to 8, with the best
  diggers at home ticked. They walk there and dig stone, faster the more of
  them and the better they build; every 20 stone the pit is a grade deeper.
  At depth 5 it is dug out and the crew goes home.
- **Food**: a unit eats 10 a minute. Every minute the castle yields enough
  for half the units it can hold, and each farm a little (20) even with
  nobody working it; a farm's crew (up to 6) grows more, faster the better
  they farm. A side stores at most 10 minutes' food for its castle's full
  house (6000 at grade 1); the rest spoils.
- **Hunger**: one number per side, 0 to 100%. At each meal, if there isn't
  enough, the food is shared evenly and what doesn't divide waits for the
  next meal. A share under 5 raises hunger by the shortfall; over 5 lowers
  it by the excess. At 100%, every unit may starve at each meal: about 5%
  at level 1, 0.6% at level 50, never at 100.
- **Upgrade** the selected building, for stone: the castle 200 × its grade,
  a tower 60 × its grade. Each grade holds as many units again and takes as
  many hits again.
- **Hit points**: every building has them, a castle 2000 and a pit 800. At
  none left it collapses at once, and whoever was inside is left standing
  there. While a building is damaged, the units inside mend it instead of
  their usual work, faster the better they build.
- **Fighting**: once a second, every unit inside a building or a band
  strikes the nearest enemy in reach: close combat at 1 cell if it can,
  else ranged at 3 cells, 4 from a castle, 5 from a tower. A strike takes 6
  (close) or 3 (ranged) plus the skill used off a building's hit points.
  Units inside a building are safe while it stands; units out in the open
  or in a band die to a strike with a 10% chance, plus the striker's skill,
  less their own level (a stand-in until units get their dice). The strike
  that brings a building down or kills a unit is a killing blow, worth 600
  experience.
- **Losing**: a side whose castle falls has lost, and can give no more
  commands.
- **Wagons** are buildings that move. Select one, then click a cell to drive
  it there, two seconds a cell; its crew rides along inside. Wagons can't
  pass through other buildings, each other included: a blocked wagon waits,
  then looks for another way, and stops if there is none.
- **Bands** are groups of up to 30 units that move like wagons, for free.
  Placing one asks who goes. A band holds no cell, so it passes anything of
  yours and blocks nothing; it has no hit points and gives no cover, and it
  breaks up as soon as it has nobody (its last unit left or died). It goes
  at the pace of its slowest walker.
- **Pits** don't stop units or bands: they cross any pit, yours or the
  enemy's. Wagons can't enter a pit and go around it.
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
| `src/core/rules.js` | The numbers: tick rate, sides, skills and experience, building types. |
| `src/core/names.js` | Medieval names for units. |
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
  players: [{ id: 0, stone: 140, food: 620, hunger: 0 }, { id: 1, stone: 200, food: 300, hunger: 5 }],
  buildings: {
    b1: { id: 'b1', owner: 0, type: 'castle', grade: 1, q: 2, r: 5, hp: 2000,
          work: 5200 },                                      // toward the next unit
    b30: { id: 'b30', owner: 0, type: 'pit', grade: 1, q: 5, r: 3, hp: 800,
           work: 1200, dug: 47 },                            // 47 stone so far: depth 2
    b31: { id: 'b31', owner: 0, type: 'wagon', grade: 1, q: 6, r: 4, hp: 300,
           path: [[7, 4], [8, 4]], since: 410, until: 430 }, // rolling to 7,4
  },
  units: {
    u3: { id: 'u3', owner: 0, name: 'Hawise Reeve', level: 4, xp: 120,
          skills: { breeding: 4, ranged: 0, melee: 0, build: 1, farming: 0, running: 2 },
          practice: { breeding: 0, ranged: 0, melee: 0, build: 35, farming: 0, running: 150 },
          in: 'b1' },                                        // at home in the castle
    u4: { id: 'u4', owner: 0, name: 'Odo Mason', /* level, xp, skills, practice */
          q: 3, r: 5, path: [[4, 5], [5, 4]], to: 'b30',     // walking to the pit
          since: 418, until: 438 },
  },
}
```

- The map isn't stored: every client builds it from `seed`.
- Time is ticks, ten a second. Movement is a route plus the ticks it set off
  and arrives at its next cell, so a unit's record changes once per cell,
  not every tick, and a screen draws it between cells by the clock.
- Each fact is stored once. What is on a cell and who is inside a building
  come from `occupancy(state)`; a building's crew (the units inside it or
  heading for it) from `crewOf(state, id)`.
- `applyCommand(board, state, side, command)` applies one of these, or
  refuses with a reason and changes nothing:
  - `{ type: 'build', kind, q, r, units? }`: a tower, wagon, pit, farm or band, with a crew if `units` lists one;
  - `{ type: 'crew', building, units }`: that building's whole crew (`[]` sends them all home);
  - `{ type: 'upgrade', building }`;
  - `{ type: 'move', building, q, r }`: a wagon.
- `advance(board, state)` runs one tick: collapses, every minute food and a
  meal, empty bands breaking up, work in castles, pits and farms, wagons
  and bands, walking.
- The core never reads the clock or `Math.random`; dice come from `rng`. The
  same commands at the same ticks always give the same game, which the
  server's saves and a future simulation harness rely on.
- `checkState` lists everything wrong with a state. The tests play long
  games of random commands and check every tick.

The numbers (speeds, capacities, work, experience, build range, the unit
limit) are placeholders in `src/core/rules.js`. Players are shown
`publicView(state)`: the state without the dice, the id counter and units'
experience points, which change every tick a unit works.

## The game server

The server runs each game's core in a Colyseus room, ten ticks a second
while both players are present, and mirrors the core's view into the room
state: each building and unit as its own JSON entry, which Colyseus sends
only when it changes. The page sends commands, never state:

| Message | Payload | Answer |
| --- | --- | --- |
| `command` | a core command, such as `{ type: 'crew', building, units: ['u3', 'u9'] }` | the command's number, or the core's refusal, `not seated`, or `the game is paused` |
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

- Combat is a first cut: units fight from wherever they are placed, with
  no orders to attack, and a unit dies to a single lucky strike until units
  get their dice. A fallen castle loses the game, but the other side's
  buildings and units stay on the map.
- There is no dark metal yet.
- Of the six skills, ranged attack and close combat do nothing yet; towers
  and wagons hold crews but give them nothing to do. Towers don't repair.
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
  - Upgrading the database to this version drops games saved by earlier
    versions, whose rules differ; players keep their names.
- A seat is held until its player releases it, however long they are away,
  and the game waits for them.
- The lobby lists only the 50 most recently active games.
- On a phone, the 18 × 12 board is wider than the screen even at minimum
  zoom. Pinch-to-zoom and keyboard play are not wired up.

## License

GPL-2.0. See [LICENSE](LICENSE).
