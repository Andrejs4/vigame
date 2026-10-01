# Vigame

A real-time hex strategy prototype. Players direct buildings, not units.
Each side has a castle, home to its units, who raise new ones. Players
build towers, wagons, pits and farms and choose each one's crew from their
named units, who walk there and get better at the work. Pits dig stone,
which pays for towers, farms and upgrades; castles and farms grow food.
Units in buildings and bands fight whatever enemy comes in reach, either
together against the Dark Lord or each side for itself. The rules work
end to end; the numbers are placeholders.

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
- **The lobby** lists your games under way, games with a free seat, other
  people's under way with every seat taken (**Watch** opens one as an
  observer), and the finished ones (anyone's; **Scores** opens one at its
  table of points). Under the lists, **How to play** sums up the game, and
  **About** links the source code on GitHub and names the licences and
  credits. Each section folds away; the lists of others' games under way
  and finished, How to play and About start folded, and the browser keeps
  them as you leave them. **New game**
  starts one for 1 to 8 players (1 by default, against the Dark Lord), on a map that grows with
  them (29 × 20 cells for two, 59 × 39 for eight), castles in a ring
  around the middle, out of reach of the lair and of each other. A game's address (`?game=…`) is also the link to send
  someone. Players who join take the seats in order (Blue, Crimson, Green,
  Gold, Teal, Orange, Rose, Silver); once they are full, visitors watch.
  **Release seat** frees a seat for a spectator to take.
- **Too many games**: New game is refused while three games you started
  wait for a player, or while you hold a seat in three games under way;
  finished games, and games nobody has touched for three days, don't
  count. The lobby then lists those games, each with a button to go back
  to it and, where it can, one to clear it: **Delete** a game you started
  that nobody else plays (for good, room and all), or **Leave** one you
  hold a seat in, which frees the seat for the next to come.
- **Game names**: a new game gets a name from a list that sets its mood
  (Pit party, Last stand, Ogre ballet, …), which the lobby and the status
  panel show. Any player still in it may rename it with **✎** next to the
  name, even while the game waits for the others: up to 24 letters, digits
  and spaces, by the same rules as a player's name.
- A game is in one of four modes:
  - **Cooperation** (the default): all the players are one team against the
    Dark Lord, whose lair (36000 hit points) stands in the middle of the map
    and strikes the nearest enemy within 4 cells by itself, 40 hit points a
    second, and against units as a level-60 fighter. From the second minute it sends out his horde, a wave a minute,
    each bigger than the last (wave n: n/2 ghouls rounded up and n/3 ogres
    rounded down, at most 24 out at once). **Ghouls** are small and fast
    (1200 hit points, a cell a second, 12 a strike, level 10); **ogres** are
    slow and tougher (6000 hit points, 4 s a cell, 50 a strike, level 35). They need no units and
    cost him nothing. Each goes for the nearest farm, and for a castle once
    no farm is left; it turns on any building that strikes it, and on the
    nearest one when its way is blocked. Bringing one down yields 2 dark
    metal (a ghoul) or 6 (an ogre). With more than two players he grows:
    his lair's and his horde's hit points by players / 2 (four times at
    eight), and his waves and their cap by the square root of that (twice
    at eight). Whatever dark metal the Dark Lord collects he keeps, and
    does nothing with yet. Allies never strike each
    other and pass through each other's buildings. The players win when the lair falls, and lose when all
    their castles have. One player alone is a game too.
  - **Easy Lord**: cooperation against a weaker Dark Lord: his lair and his
    horde have half the hit points (the lair 18000, ghouls 600, ogres 3000,
    before growing with the players). Everything else is as in cooperation;
    the raiders are their own side, and as strong as ever.
  - **Shared Easy Lord**: Easy Lord where the team lives off one stock:
    stone, dark metal and food (so one hunger too), which any of them
    spends and all their pits, farms, castles and kills fill. It starts with
    every player's stone together (400 for two), and keeps food for all
    their castles. The HUD calls it Team stone, Team dark metal and Team
    food. Each player's points still count what their own units did.
  - **Free for all** (two players or more): each against the others; the
    middle of the map is left empty.
- **The game clock** runs only while every player is here. (`npm run dev`
  runs it with one, for trying things alone.)
- **Your castle** covers seven cells and is its side's life: when it falls,
  your side has lost. It is every unit's home, and starts with 12. The units at
  home raise new ones: the more of them, and the better they breed, the
  sooner. With nobody at home it still raises one every four minutes by
  itself, even while damaged or upgraded. It has room for 40 units, and 10
  more with each upgrade (40, 50, 60); it takes in all its units, however
  many, but stops breeding while it holds more than its room.
- **Units** each have a medieval name, a level from 1 to 100, and six
  skills: breeding, ranged attack, close combat, building (which covers
  repairing and digging), farming and running. Work trains the skill it
  uses, and the unit's level with it: every skill at the same pace (a
  strike trains ranged or close combat five times as much as a tick of
  other work, since units strike only once a second), the
  level faster the fiercer the work (breeding least, then running, farming,
  building, ranged and close combat, and a killing blow most). A skill
  can't pass the unit's level; it climbs faster than the level, then waits
  for it. Each level takes 1.1 times the work of the one before, so the
  last ones are all but out of reach. About one unit in ten, the first
  ones too, is born a **hero**: its levels start cheaper and grow gentler
  (390 at first, then 1.032 times as much each), so for the same work it
  stands about three times as high, 58 when an ordinary unit is 20, and
  reaches 100 about when an ordinary one would be 34. The crew chooser
  shows a hero's age in gold. Select your castle and press **Heroes…**
  (in Crew's place, as the castle has no crew) for yours alive now, highest
  level first, with where each is and every skill's level, as "Att Lv 15"
  (ranged attack; then close combat, building, farming, breeding and
  running), each level padded to line up ("Lv  8", "Lv100"). The status panel says when one of yours
  dies ("Hero Hugh Baker died in combat.", "3 heroes died from hunger."):
  of hunger if it went at a meal while your side was starving, else in
  combat. Every skill counts: breeding speeds
  the castle's births, building digging and mending, farming the harvest,
  running walking, and ranged attack and close combat the damage and kill
  chance of a unit's strikes.
- **Crews**: units walk only when they're given to a building's crew or sent
  home. Select one of your buildings and press **Crew…** for a list of your
  units, each with its level, skill and age in minutes ("12m"): tick up to
  what it holds (with a mouse, drag down the list to tick or untick a run
  of them). The skill shown is the one the building wants: building for
  a pit, farming for a farm, and ranged attack for a tower, wagon or band,
  with close combat beside it (a crew strikes at range, and in close
  combat only an enemy right next to it). The skill's button (**Attack**
  for the crews that fight), **Hero**, **Level** and **Nearest** reorder
  the list: best at that skill, heroes, highest level or closest to the
  building first. **Default** puts it back (those
  ticked, then those at home, the best at the work first); the ticks stay
  as they are. Those you untick go home; those you tick
  come from wherever they are, one after another, two seconds a cell on open
  ground and four on scrub, less the better they run. Water is impassable.
  **Return** sends the whole crew home. A unit left with nowhere to go (its
  building collapsed, say) goes home by itself.
- **Stone, dark metal and food** go straight into your side's stock (the
  HUD shows them, and hunger next to food); nothing carries them. Each side
  starts with 200 stone and no dark metal. The HUD shows stone in bold from
  60 (a tower), dark metal from 30 (a wagon's upgrade), and food when the
  store, with what the castle and farms give before the meal, won't give
  every unit a full one.
- **Build**: pick **Tower** (60 stone), **Pit**, **Farm** (30 stone),
  **Band** or **Wagon** (15 dark metal), then a highlighted cell: open,
  buildable ground within three cells of one of your standing buildings (a
  wagon: of your castle). Scrub can be crossed but not built on; water is
  neither. One building per cell. Placing one asks for its crew first, with
  the best at home for its work ticked, up to half of those at home. Short
  of its price, the button (or its key) says so at once, as does clicking
  a cell if the stock ran low meanwhile, so no crew is chosen for nothing.
- **Going up**: a new tower, wagon, pit or farm is only a site until its crew
  raises it. They start once they get there, faster the more of them and the
  better they build, and it trains their building skill as they go (one
  unskilled unit alone: a pit 15 s, a farm 30 s, a wagon 45 s, a tower 60 s).
  A site has half its hit points, gives its units no cover and a tower no
  extra reach, and doesn't work, move or take upgrades. It's drawn pale,
  with a dashed outline. **Abort** gives it up: its crew, inside or on the
  way, goes home, and what it cost is lost.
- **Pits**: the crew, up to 8, digs stone, faster the more of them and the
  better they build (an unskilled unit alone digs a stone in 48 s); every
  40 stone the pit is a grade deeper, and 150 hit points sturdier. At depth
  3, 120 stone in all, it is dug out and the crew goes home. Selected, it
  shows the stone left to its next grade.
- **Food**: a unit eats 10 a minute. Every minute the castle yields enough
  for half the units it can hold, and each farm a little (10) even with
  nobody working it; a farm's crew (up to 6) grows more, faster the better
  they farm. A side stores at most 10 minutes' food for its castle's full
  house (4000 at grade 1); the rest spoils.
- **Points**: each side keeps a tally of what it did, and when the game is
  over a table shows it as points, winners first: 10 an enemy unit killed,
  1 per 10 hit points taken off enemy buildings, 50 an enemy building
  brought down (500 a castle or the lair), 5 a unit born, 1 a stone dug,
  1 per 10 food grown by crews, 20 a building finished, 50 × the grade an
  upgrade reaches, and 500 for winning. Nobody sees any of it before the
  end. The table's **Leave the match** goes back to the lobby; **Keep
  watching** closes it, and **Scores** brings it back. Once a game is
  over, seats can't be given up, so the table keeps their holders' names.
- **Hunger**: one number per side, 0 to 100%. At each meal, if there isn't
  enough, the food is shared evenly and what doesn't divide waits for the
  next meal. Hunger follows how short the meals fall: each meal moves it a
  quarter of the way toward the shortfall, so full meals bring it down to
  0%, half rations to 50%, and nothing at all up to 100% (in about a
  quarter of an hour). At 100%, every unit may starve at each meal: about
  5% at level 1, 0.6% at level 50, never at 100.
- **Upgrade** the selected building: the castle for 200 stone × its grade,
  a tower for 60 × its grade, a wagon for 50 dark metal up to three
  times. Then its crew works on it, as on a new building,
  instead of their usual work, which trains their building skill: each grade
  takes as long again as the one before (a tower as long as raising it, a
  castle three times that). Once done, it holds as many units again (a
  castle 10 more) and takes as many hits again. An upgrade can't be called off. Meanwhile the
  crew still fights, and mends the building first when it's damaged (and
  out of the fight), but a
  castle's units don't breed (the castle's own slow breeding goes on).
- **Hit points**: every building has them, a castle 2000 and a pit 250 (150
  more for each grade of depth). At
  none left it collapses at once, and whoever was inside is left standing
  there. While a building is damaged, the units inside mend it instead of
  their usual work, faster the better they build: 0.4 hit points a second
  each, unskilled. But while they have an enemy in reach they fight it
  instead, so a building mends only out of the fight, or under fire from
  beyond its crew's reach.
- **Fighting**: once a second, every unit inside a building or a band
  strikes the nearest enemy in reach: close combat at 1 cell if it can,
  else ranged at 3 cells, 4 from a castle, 5 from a tower. A strike takes 6
  (close) or 3 (ranged) plus the skill used off a building's hit points.
  Some strikes on a building get through to a unit inside: half on a farm,
  a quarter on a pit, none on a castle, tower or wagon. Units out in the
  open or in a band take every strike. A strike kills a unit with a chance
  set by the striker's skill against the unit's level (the lair, raiders
  and the horde strike at a level of their own): 10% when they
  match, up to 50% at most, and under 1% once the unit is 50 levels ahead
  (a stand-in until units get their dice). The strike that brings a
  building down or kills a unit is a killing blow, worth 600 experience.
  Units walking in the open strike too, at their own reach, as they go:
  they never stop or turn aside for it.
- **Targets**: select one of your buildings, press **Attack…**, then click
  an enemy building or band (a band's units are struck first). A building that can't move strikes its target while it
  is in reach, and the nearest enemy otherwise; a wagon or band goes after
  it until it's close enough for close combat. Driving a wagon or band by
  hand drops its target.
- **Keys**: a button's bold letter presses it: **T**ower, **W**agon, **P**it,
  **F**arm and **B**and pick what to place (again to stop), **U**pgrade,
  **C**rew and **A**ttack act on the selected building, **H**eroes on your
  castle, and Escape lets go.
  Choosing a crew, Enter sends it, as does the letter that opened the
  chooser again (C, or the letter of the building being placed); H closes
  the heroes list.
- **Losing and winning**: a side whose castle falls has lost, and can give
  no more commands; its units stay and still fight. Once only one team has
  a castle (or lair) standing, it has won and the game is over: the clock
  stops, commands are refused, the page says who won, and the lobby lists
  the game as finished.
- **Raiders** turn up in every game: wandering hostile wagons, against
  everyone, with 500 hit points, that strike whatever comes within 2
  cells (20 a strike, level 20). Every minute and a half one may appear
  on open ground away from the castles, up to 2 per player. The side that brings one down gets 10 dark metal: the
  only way to get it, and what wagons are built with.
- **Wagons** are buildings that move. Select one, then click a cell to drive
  it there, two seconds a cell; its crew, up to 15, rides along inside. Wagons can't
  pass through other buildings, each other included: a blocked wagon waits,
  then looks for another way, and stops if there is none. Whoever brings a
  wagon down (another player, the Dark Lord, raiders) gets half its price in
  dark metal, 7 for 15. An upgrade armours a wagon: each of three adds 500
  hit points to its 300 (800, 1300, 1800), but no room.
- **Bands** are groups of up to 30 units that move like wagons, for free.
  Placing one asks who goes. A band holds no cell, so it passes anything of
  yours and blocks nothing; it has no hit points and gives no cover, and it
  breaks up as soon as it has nobody (its last unit left or died). It goes
  at the pace of its slowest walker.
- **Pits** don't stop units or bands: they cross any pit, yours or the
  enemy's. Wagons can't enter a pit and go around it.
- **Players** in the status panel shows the seated players who are here,
  of the game's seats (such as 1/2), and blinks while the game waits for
  the rest; **Observers** counts those watching without a seat.
  **Recenter** looks at your own castle, close enough to read how many
  are in each building (a spectator sees the whole map).
- Drag to pan, and use the wheel or the − / + buttons to zoom. The minimap
  in the corner shows the whole board and a frame around what you see;
  press or drag on it to look there.
  **Coordinates** shows axial `q,r` labels. Escape cancels building and
  clears the selection; **A** is Attack.
- Every viewer's picked hex shows as a ring: solid for yours, dashed for
  others.
- Buildings and units are round tokens in their side's colour, with a
  picture on each (from [game-icons.net](https://game-icons.net), CC BY
  3.0; see `src/client/art/CREDITS.md`). A building going up shows faint,
  and firms up as it rises. A moving one faces the way it last went, left
  or right (the pictures face right, and turn over going left). Pips under
  a building count its upgrades (a pit's: how deep it is dug); a new one
  has none. Zoomed far out, units are dots.
- A building shows its hit points in a bar over it while it is hurt or
  selected. A hit flashes it red and floats up the points lost; a building
  that falls crumbles, and a unit that dies leaves a cross (with how many,
  when several die inside a building). The page works these out by comparing
  each update from the server with the one before, so they are its best
  guess: the server doesn't say who struck whom.
- Gentle sounds, made on the spot like an old MIDI synth (no sound files):
  a blip when a command is taken and a low buzz when it's refused, a tick
  on selecting, a thud when your building is hit and a click when a unit
  dies (both only on screen), a falling run of notes when your building
  falls and a chord when an enemy's does on screen, a fanfare when yours
  is finished or upgraded, a chime for a new unit, a horn when the horde
  comes out, and a jingle when the game is won or lost. They start at your
  first click or key in a game, as browsers require. **Mute** silences
  them; this browser remembers it.
- When the building you have selected, are aiming with or are choosing a
  crew for is destroyed or given up, the page lets go of it (closing the
  crew chooser) and says so. A command that still names it is refused with
  "that building is gone".

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
| `src/core/board.js` | Seeded terrain, with what each terrain allows, and the castle and lair sites; same seed and player count, same map everywhere. |
| `src/core/rules.js` | The numbers: tick rate, sides and modes, skills and experience, food and hunger, fighting, raiders, the Dark Lord's horde, building types. |
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
| `src/client/minimap.js` | The minimap: a few pixels a cell, repainted at most twice a second and only when a pixel changes. |
| `src/client/effects.js` | Hits, falls and deaths, worked out from each update and the one before, for the renderer to play. |
| `src/client/sounds.js` | Sounds: which ones an update calls for, and a small synthesizer that plays them. |
| `src/client/tokens.js`, `art/` | The pictures (SVG, credited in `art/CREDITS.md`) and the tokens made of them, painted once per colour and size. |
| `server/app.js` | The game server: Colyseus, the HTTP API, the page's files, the monitor. |
| `server/room.js` | `GameRoom`, one per game: runs the core's clock, logs and applies commands, snapshots. |
| `server/schema.js` | The room state Colyseus syncs: a generic mirror of the core's view. |
| `server/storage.js` | All database access (SQLite). |
| `server/challenge.js` | The sign-in sums. |
| `server/main.js` | Command-line entry point (`npm start`, `npm run dev`). |
| `deploy/` | Running it on a Debian server: a systemd unit, an install script, an nginx block. |
| `scripts/smoke.js` | Playwright check of the page through the game server: three browsers, a subfolder proxy, a phone. |
| `test/` | Unit tests, including whole games of random commands checked tick by tick. |
| `docs/architecture.md` | How the pieces fit, and the decisions behind them. |

### On a server

[deploy/README.md](deploy/README.md) installs the game on a Debian server
as a sandboxed systemd service with its own Node.js, in one script, and
covers updates, backups and removing it again.

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
  version: 11, mode: 'coop', name: 'Pit party', seed: 1337, tick: 420, rng: 123456789, nextId: 58,
  players: [                                                // by owner number
    { id: 0, side: 0, team: 0, stone: 140, metal: 10, food: 620, hunger: 0 },
    { id: 1, side: 1, team: 0, stone: 200, metal: 0, food: 300, hunger: 5 },
    { id: 2, side: 8, team: 1, stone: 0, metal: 0, food: 0, hunger: 0 },  // the Dark Lord
    { id: 3, side: 9, team: -1, stone: 0, metal: 0, food: 0, hunger: 0 }, // the raiders
  ],
  buildings: {
    b1: { id: 'b1', owner: 0, type: 'castle', grade: 1, q: 2, r: 5, hp: 2000,
          work: 5200,                                        // toward the next unit
          upgrading: 9000 },                                 // toward grade 2, a quarter done
    b30: { id: 'b30', owner: 0, type: 'pit', grade: 1, q: 5, r: 3, hp: 550,
           work: 1200, dug: 87 },                            // 87 stone so far: depth 2
    b31: { id: 'b31', owner: 0, type: 'wagon', grade: 1, q: 6, r: 4, hp: 280,
           path: [[7, 4], [8, 4]], since: 410, until: 430,  // rolling to 7,4
           target: 'b27', mend: 40 },                       // after b27; being mended
    b32: { id: 'b32', owner: 0, type: 'tower', grade: 1, q: 3, r: 2, hp: 250,
           raised: 4000 },                                   // going up: a third done
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

- The map isn't stored: every client builds it from `seed` and the number
  of players.
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
  - `{ type: 'upgrade', building }`: paid now, then worked on by its crew;
  - `{ type: 'abort', building }`: gives up a building still going up;
  - `{ type: 'move', building, q, r }`: a wagon or band;
  - `{ type: 'target', building, target }`: an enemy building or band to go for (`''` clears it);
  - `{ type: 'rename', name }`: the game's name (the room takes this one while the game is paused too).
- `advance(board, state)` runs one tick: every second a round of fighting,
  collapses, every minute food and a meal, empty bands breaking up, mending,
  raising and upgrading, work in castles, pits and farms, wagons and bands,
  walking.
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
while every player is present, and mirrors the core's view into the room
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
| `POST /api/games` | Starts a game with a random map: `{ token, mode?, players? }` of a signed-in player (`mode` `coop`, `easy`, `shared` or `ffa`, `players` 1 to 8; by default a cooperation game for one) gives `201 { id }`; `401` if not signed in, `400` for a bad mode or number; `409 { error, games }` while the player has too many games on the go (three of theirs waiting for a player, or seats in three under way), with those games as `GET /api/games` lists them, each with `clear`: `'delete'`, `'leave'` or `null`. |
| `POST /api/games/:id/delete` | `{ token }`: deletes a game under way that the player started and nobody else holds a seat in, closing its room if open; `403` if they didn't start it, `409` if someone else plays it or it is over. |
| `POST /api/games/:id/leave` | `{ token }`: gives up the player's seat in a game under way, through its room if open; `409` if they hold none or it is over. |
| `GET /api/games` | The 50 most recently active games, for the lobby, with their name, mode and who holds each seat: `{ pid, name }` or `null`. |
| `GET /api/games/:id` | One game: its seed, latest snapshot and seats. |
| `GET /api/games/:id/commands` | Its command log, with each command's tick. |
| `GET /api/games/:id/seats` | Who holds each seat: `{ pid, name }`, or `null` for a free one. |

The database has three tables: `games` (each game's seed, seats, who
started it and when (neither shown to players), and a snapshot of its
state, saved every ten seconds and when its room closes),
`commands` (every accepted command with its tick, in order, never changed)
and `players` (each signed-in player's public id and name; never the token).
A room reopening a game loads its snapshot and replays the commands logged
after it; if the snapshot is unreadable, it replays the whole log from the
opening position.

## Not done yet

[docs/architecture.md](docs/architecture.md) covers the design and what
comes next.

- Combat is a first cut: a unit dies to a single lucky strike until units
  get their dice, and single units can't be picked as targets.
- The Dark Lord's horde only hunts farms and castles, by the simplest
  rules; he builds nothing, raises no units and spends no dark metal.
  Raiders only wander.
- Food has no use beyond keeping hunger down; dark metal only buys wagons.
- Graphics are tokens on flat hexes: nothing faces a way or moves but by
  sliding, the ground has no texture, and combat shows hits but not who
  struck them.
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
  - Backups aren't automatic: [deploy/README.md](deploy/README.md#backups)
    shows how to take one; the architecture doc suggests Litestream for
    continuous ones.
  - `npm audit` reports advisories in `@colyseus/auth`, which Colyseus
    installs alongside its core; this server switches it off (`auth: false`).
  - Upgrading the database to this version drops games saved by earlier
    versions, whose rules differ; players keep their names.
- A seat is held until its player releases it, however long they are away,
  and the game waits for them.
- The lobby lists only the 50 most recently active games.
- Games of 5 to 8 players are untested at scale: up to 2400 units on a
  59 × 39 map make route-finding and fighting costlier, and nobody has
  measured how much.
- On a phone, the 29 × 20 board is wider than the screen even at minimum
  zoom. Pinch-to-zoom is not wired up, and the keys are for a keyboard.

## License

Copyright (C) 2026 Andrejs Petrovs.

Vigame is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 2 of the License, or (at your option) any later
version (GPL-2.0-or-later). See [LICENSE](LICENSE).

Pictures (`src/client/art/`, listed in its `CREDITS.md`): the icons from
[game-icons.net](https://game-icons.net) are under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), and pictures made
for Vigame by its author, Andrejs Petrovs, are under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The page
names them in the lobby's **About**, with the fonts (IBM Plex, SIL Open Font
License), which the browser loads from Google Fonts.
