# Vigame

A turn-based hex strategy prototype. It has a seeded hex map, two sides of
scouts and infantry, and movement that costs more on rough ground. Two people
can play on one screen or, when published as a claude.ai Artifact, from two
browsers.

It is plain JavaScript with no framework and no runtime dependencies: a
canvas renderer, a handful of ES modules, and a build step that inlines
them into one self-contained HTML file.

## Playing

- Click one of your units, then a highlighted hex to move there. Scouts have
  4 movement points, infantry 2. Grass and meadow cost 1, scrub costs 2, and
  water is impassable. Other units block movement.
- **End turn** passes play to the other side, and a full round restores
  everyone's movement.
- Drag to pan, and use the wheel or the − / + buttons to zoom.
  **Coordinates** shows axial `q,r` labels.
- **Hotseat** is the mode whenever the page runs outside claude.ai: two
  players share one browser.
- **Online** is the mode inside claude.ai. The first two viewers take the
  Blue and Crimson seats, and later viewers watch. Every viewer's picked hex
  shows as a ring: solid for yours, dashed for others. **Release seat** frees
  a seat for a spectator to take.

## Working on it

Node 20.11 or newer.

```sh
npm install        # dev dependency only: Playwright, for the smoke check
npm start          # http://127.0.0.1:8080, serving index.html and src/ as ES modules
npm test           # unit tests (node:test, no browser)
npm run build      # dist/vigame.html (self-contained; opens from file:// too) and dist/artifact.html
npm run smoke      # headless Chromium check of the built page; screenshots in smoke-output/
```

`npm run smoke` needs a Chromium that Playwright can drive. If you don't
have one, install it with `npx playwright install chromium`.

### Layout

| Path | What it is |
| --- | --- |
| `src/hex.js` | Pointy-top axial hex math: neighbours, distance, pixel conversion, board shapes. Pure. |
| `src/board.js` | Seeded value-noise terrain; same seed, same map on every client. Pure. |
| `src/game.js` | Units, turns, movement rules, Dijkstra reachability. No rendering or input, so it can later run on a server unchanged. |
| `src/camera.js` | Screen ↔ world transforms, pan, and zoom about a point. |
| `src/render.js` | Canvas 2D renderer: terrain, grid, movement range, selection rings, hover, units. |
| `src/net.js` | The networking seam: `createLocalNet` (hotseat) and `createArtifactNet` (claude.ai runtime), which share one interface. |
| `src/main.js` | Wires it all together: input, HUD, and the switch to online play. |
| `index.html` | Page markup and styles; loads `src/main.js` as a module. |
| `scripts/build.js` | Bundles `src/` into `index.html` as one inline script. |
| `scripts/serve.js` | Zero-dependency static server for development. |
| `scripts/smoke.js` | Playwright check of the built page, including a three-browser online game. |
| `test/` | Unit tests, plus `fake-runtime.js`, an in-memory stand-in for the Artifact runtime. |

### Online play

Online play runs on three capabilities of the claude.ai Artifact runtime:
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

[docs/architecture.md](docs/architecture.md) has the plan for a real game
server (Colyseus with SQLite) and how it would stretch to real-time play.

- There is no combat, capture or win condition; units only move.
- Turn order is enforced by each client, not by a server. Anyone who can
  write the db could write any state. The `net.js` seam exists so that an
  authoritative server (Colyseus was the plan) can replace this without
  touching the rest.
- There is no way to start a new online game from the page. Deleting
  `game/state` and `game/seats` from the artifact's db resets it.
- A seat is held until its player releases it, however long they are away.
- On a phone, the 18 × 12 board is wider than the screen even at minimum
  zoom. Pinch-to-zoom and keyboard play are not wired up.

## License

GPL-2.0. See [LICENSE](LICENSE).
