# Notes from building Vigame

What making Vigame taught that the code doesn't show: how it is made, how
its pictures were made, tools that helped, and plans not yet built.
CLAUDE.md has the rules for working on the code; this is the background.

## How it is made

- Vigame is its author's first project built purely by talking to Claude:
  Andrejs Petrovs (Andrejs4 on GitHub) says what he wants and plays the
  result on his server; he doesn't read the code. So say what changed as a
  player sees it, show screenshots, and say whether a deploy keeps saved
  games. `npm run smoke` leaves screenshots in `smoke-output/`: `game-blue.png`,
  `crew.png`, `heroes.png`, `phone*.png`, `game-*.png`, `effects.png`, `lobby*.png`,
  `login*.png`, `settings*.png`, `scores.png`, and `failed-*.png` when a check
  fails.
- Outside pull requests are considered only as CONTRIBUTING.md says: a
  few lines, or the model's name and the original prompt, from someone he
  knows or with references for their reputation. His own aren't bound by it.
- The work happens in Claude Code cloud sessions, on a `claude/…` branch.
  Each batch of requests becomes one pull request, opened when he asks for
  it. He merges it on GitHub, then deploys on his Debian server with
  `git pull` and `sudo deploy/install.sh` (deploy/README.md). After a merge,
  the next work starts from a fresh `main`.
- A deploy keeps saved games unless it bumps `STATE_VERSION` (games are then
  rebuilt from their command logs) or adds a database step that drops them
  (`migrate()` in server/storage.js says what each step does; adding a
  column, such as players' language, keeps them). A rule change that keeps the state's
  shape applies to games under way from then on.
- It began as a turn-based claude.ai artifact ("Vigame Hex Board"), was
  recovered from it into this repository, and was rebuilt as a real-time
  game on Colyseus. The artifact is left alone.
- No release tags yet (`package.json` says 0.1.0). The advice given: tag a
  milestone every few pull requests (GitHub, Releases, Draft a new release,
  a tag such as `v0.2.0` on `main`, Generate release notes). The server can
  then go back with `git checkout <tag>` and `sudo deploy/install.sh`, but
  going back past a database change needs the backup taken before it.

## Pictures

Licences and credits are in `src/client/art/CREDITS.md`; the tests check
that every file there is credited and that the lobby's About names every
icon author. The author's raw pictures never go to GitHub (`art-src/` is
ignored): he keeps the originals, and a cloud container forgets them when
its session ends.

### Icons from game-icons.net

- They come from the public repository `github.com/game-icons/icons`, over
  4000 icons. A cloud session's git proxy serves public GitHub repositories
  without credentials, so fetch only the list of files, then only the files
  wanted:

  ```
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --filter=blob:none --no-checkout https://github.com/game-icons/icons icons
  git -C icons ls-tree -r --name-only HEAD > names.txt    # author/name.svg
  git -C icons checkout HEAD -- lorc/metal-bar.svg delapouite/stone-pile.svg
  ```

- To choose, put the candidates on one HTML page, each on the colour it
  will sit on, and screenshot it with Playwright: one look compares thirty.
- Each source file holds a black square (`<path d="M0 0h512v512H0z"/>`) and
  a white path. Keep the white path's `d` alone, with no `fill`, as
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><path d="…"/></svg>`.
  Firefox draws an SVG on a canvas only when it has a size.
- All icons so far are by Lorc or Delapouite; staying with them means About
  needs no new names. File names are lowercase letters only: the test that
  reads the authors from the credits table matches `[a-z]+.svg`.
- A file saved by Inkscape carries an XML header, its own tags and a
  `style`, and the tests refuse it: keep only the path's `d`, in the form
  above.
- The meeples (the unit's, and the band's four) are narrowed, as the
  author did the unit's in Inkscape, so they look less like asterisks and
  more like people, with the heads less narrowed and the whole a little
  taller. Each figure (a subpath, from M to z) is changed around its own
  middle (mx, my), on every point of the original path made absolute:
  x' = mx + (x − mx) · k, with k 0.9 over the top 21% of the figure's
  height easing to 0.693 below 36%, and y' = my + (y − my) · 1.1. The
  band's figures then move to 0.8 of their distance from the icon's middle,
  side to side, so the four stand together.
- One file serves everywhere. The board paints it on tokens (`tokens.js`);
  the page uses it as a CSS mask over a colour: the text's own in the
  buttons and the stock, light ink in the selection's picture.

### Hero portraits

- 128 faces, 64 men and 64 women, that the author generated with Stable
  Diffusion and uploaded in chat, five pictures a message at most. They were
  saved numbered as they came: `m01`…`m64`, `w01`…`w64`.
- Made with the `web-pixel-images` skill from
  [Andrejs4/my-claude-skills](https://github.com/Andrejs4/my-claude-skills),
  in one run over both folders:

  ```
  pixelate.py men women --out heroes-px --frame face --background '#6e6e6e' \
      --grid 32 --colors 14 --shared-palette --save-palette heroes-px/palette.hex
  ```

  `--frame face` (the YuNet face detector) crops a square around each face,
  so close-ups and torso shots come out alike. `--background` (rembg's
  isnet-general-use model: the small ones cut away bodies and hoods) puts
  every face on the same grey. One shared palette of 14 colours keeps the
  set coherent. Two pale paintings, `m02` and `w50`, came out badly cut, so
  they were redone without `--background`, with the same boxes and palette
  (`--crops heroes-px/crops.json --palette heroes-px/palette.hex`), before
  the sheets were packed.
- Each sheet is packed in number order, row by row (the skill's `atlas()`, 8
  × 8): face n on the men's sheet, counting from 0, is `m(n+1)`. The palette went in as
  `portraits.hex`; to match it, a new face is made with
  `--palette src/client/art/portraits.hex`.
- Which face a hero gets comes from its name (`portraitOf` in names.js): the
  first name picks the sheet and the column, the surname the row. Nothing is
  stored, so heroes already in games got faces at once. But changing the
  name lists moves some heroes to other faces, and a woman's name missing
  from `WOMEN` gets a man's face.
- They show at 32 px in the crew chooser, exactly their size, and at 48 px
  in the Heroes list: 1.5 times, a little uneven on ordinary screens and
  exactly 3 times on high-density ones.
- To use the skill in a Vigame session, attach the repository (`add_repo`,
  clone it, `register_repo_root`: its `.claude/skills/` then loads), or run
  `plugins/web-pixel-images/skills/web-pixel-images/scripts/pixelate.py` from
  a clone. It needs Pillow, OpenCV (`opencv-python-headless`) for faces, and
  rembg (`rembg[cpu]`) for backgrounds. rembg downloads a 180 MB model on
  first use: point `U2NET_HOME` at a scratch folder.

### Tab icon and login banners

The author made these with Perplexity: personal, non-commercial use only,
outside Vigame's licences (CREDITS.md says so). The banners are 1040 × 400
WebP, about 30 KB each at quality 65, shown at most 520 px wide, so they
stay sharp on high-density screens. The icon is a 32 × 32 PNG.

## Tools that helped

- Playwright and Chromium come with cloud sessions. The smoke check doubles
  as the screenshot maker, and a few lines render any HTML page to a PNG,
  for comparing pictures side by side.
- `window.__vigame` (end of play.js) shows the page's state to the smoke
  check and the browser console: the view, the selection, the highlights,
  the draw count, the fallen heroes, the game as the crew chooser found it.
- Python with Pillow is in the container; OpenCV and rembg install with pip.
- Files kept in Git LFS, such as a face model, download from
  `media.githubusercontent.com/media/<owner>/<repo>/<ref>/<path>`. The raw
  file address and the git proxy give only a small pointer file.
- `gh api` works in cloud sessions when the GitHub tools drop out.

## Decisions worth remembering

- A pit costs 1% hunger instead of stone, so pits can't be put down by the
  dozen for nothing. At 100% hunger it is free.
- Bands hold 80, more than a tower at its last grade (60); the crew chooser
  ticks up to 30.
- The crew chooser ticks no more than three for a new building while the
  castle holds 20 or fewer (`FEW_AT_HOME` in play.js), the author's choice.
  The more at home, the faster a castle breeds. A band is drawn over the buildings it passes, yours over
  another side's. Another side's band can't be selected, only aimed at with
  Attack.
- The author has looked at hunger's rules and the score table and chose to
  keep them as they are: change them only when he asks.
- No need to fit windows under about 800 px tall: there the minimap may
  cover the Lobby button.
- The status panel folds to its header (the arrow on its right), and the
  minimap hides by M or the arrow in the stock panel's top right corner,
  where the author asked for it: on a phone the minimap sits just above
  that corner, and the arrow stays to bring it back. Both choices are kept
  per browser (`vigame.folded`); a hidden minimap doesn't repaint.

## Plans not built yet

### Graphics: pictures at the closest zooms

Agreed in outline. Built: the ground's pictures (src/client/ground.js),
from the author's first set: grass 2 versions, meadow 1, scrub 1 (trees
on bare ground), water 2 (lighter and darker). Next: more versions of
each, then buildings and units when he has their pictures. This replaces
an earlier plan of one big texture per terrain pinned to the map, with
decorations scattered over it.

How the ground's pictures were made: the author generated them with Stable
Diffusion on his machine, 512 × 512, straight down (LĢIA's orthophotos
weren't usable as they were). His originals go in `art-src/ground/` as
`<terrain>-<n>.png` (kept out of git), and `python3 scripts/ground.py`
(Pillow and numpy) makes each one's `src/client/art/ground-<terrain>-<n>.webp`:
shrunk to a hex 256 px from corner to corner, recoloured to the terrain's
colour on the board keeping its detail (a little lighter or darker per
version, `LIFT`), and cut to a hex with clear corners, which also cuts off
the stripes some generated pictures have down an edge. A new version is
its original in that folder, a run of the script, and its count in
`GROUND_VERSIONS` (ground.js). Seen in previews: a strong feature (a pale
ring in the meadow's middle, a dark streak in the grass) shows in every
cell, turned; more versions hide it, and cutting the hex leaves anything
in the middle. Pictures of one scale only: a cell of tree tops beside one
of a single big tree looks wrong.

- **Where:** at the closest zooms only: in full at the closest zoom and
  two presses of − out (four wheel notches), gone at the third press (the
  camera goes from 0.4× to 2.5×; − divides it by 1.25, a notch by 1.12). Further out, the flat colours stay: they
  read better far out and cost nothing. The minimap keeps flat colours,
  and a picture that fails to load leaves its cells flat. Not built yet: a
  Graphics switch (remembered by each browser, like Mute) to turn them off
  on a weak phone; the View panel has no room on a phone, so perhaps on
  the settings page.
- **Ground, a picture per cell:** each terrain (grass, meadow, scrub,
  water) has 2 to 4 pictures of one hex. A cell takes one, turned by a
  sixth of a turn and maybe mirrored, picked from the map's seed so every
  player sees the same map; that hides the repeats. Each version is cut to
  a hex once and kept, so drawing a cell is one image copy, and at the
  closest zooms only a few dozen cells are on screen. The grid lines hide
  most joins, so keep each picture's edges plain, with no strong feature
  near them.
- **Buildings and units:** a picture each in place of today's icon token,
  with the parts that take a side's colour painted in shades of one key
  colour (say magenta) in the same file. The page swaps it for each side's
  colour, keeping the shading, the first time a side needs it, and keeps
  the result. Memory is the limit (17 sides, many pictures, several frames
  each), so sizes stay moderate. Units inside a building aren't drawn one
  by one (the building shows how many), so a unit's picture is for those
  out on the map and for bands.
- **Animation:** an action's frames side by side in one strip (idle,
  attack, hit). Today the board redraws only when something changes, and
  effects are short, so a still screen costs nothing. Triggered animations
  (an attack, a hit, a fall) stop by themselves and cost little. A looping
  idle animation means redrawing all the time, which drains a phone's
  battery: if wanted, only at the closest zoom, at about 10 frames a
  second, and never while the game is paused. That changes the rule in
  CLAUDE.md, so it is the author's call.
- **What the page knows of the fighting:**
  - A building that loses hit points was hit, and by how much: today's hit
    effects already work it out by comparing each update with the last
    (effects.js).
  - Units have no hit points: a strike kills or misses, and a miss leaves
    no trace. So a unit can't look hurt, only die, and a death is already
    seen. A hurt look would need units to have hit points, a bigger change
    to the rules.
  - Who is fighting isn't sent. The easy way, on the page alone: every
    unit and building strikes the nearest enemy in its reach each second,
    so one with an enemy in reach is fighting, near enough exactly; the
    page can work that out for what is on screen, with no change to the
    server and nothing more sent. It can't tell which way a blow went,
    though a building's chosen target is known. The exact way, more work:
    the server sends each round's blows (who hit whom, kill or miss) as a
    message of its own, outside the game's state, for aimed swings and
    arrows. In a big battle that is thousands of blows a second to every
    player, unless trimmed to what each one sees. Start with the easy way.
- **Pictures from the author:**

  | What | How many | Paint at | Ship | Notes |
  | --- | --- | --- | --- | --- |
  | Ground: grass, meadow, scrub, water | 2 to 4 each | 512 × 512, one hex filling it | 256 (more if soft on a phone) | Opaque, plain at the hex's edges |
  | Buildings: castle, tower, wagon, pit, farm, band; lair, ghoul, ogre, raider | 1 each, plus frames if animated | 512 (a castle covers 7 cells) | 256 to 512 | Transparent; the side's colour in shades of the key colour |
  | Units, out on the map | 1, plus frames | 256 | 128 | As above |

  WebP is much smaller than PNG for the same picture. A cell at the
  closest zoom is about 150 × 170 px on screen (a hex is 34 px from centre
  to corner, `hexSize`, times 2.5), and about twice that on a phone's
  sharper screen. The first thing to make is a guide image: a 512 square
  with a true-size hex on it.
- **Readability:** keep each terrain's colour family: mid green grass,
  yellow-green meadow, dark olive scrub, blue water. Colour is what tells
  where one can build or walk. Keep the ground low in contrast and mid in
  tone, so units and buildings stand out on it.
- **Order:** the ground pictures (nothing animated); then buildings and
  units in the sides' colours; then attack and hit animations, from the
  easy way above; idle animations last, if the battery cost is fine.
  Before his pictures arrive, stand-ins made from noise can check the
  approach and the speed.

### Translations: Russian, Latvian, Finnish

Built so far: each player has a language, Auto (the default), English or
Russian, chosen on the login page and the settings page and kept on the
server (`language` in the players table, `/api/me`). Its Auto option says
which language Auto picked (src/client/language.js):

- On the login page the browser comes first (the author's choice): the
  first of its languages that the page has, else Russian for a name typed
  in Cyrillic letters, else English (`loginLanguage`).
- Once signed in, the name comes first: Russian for Cyrillic letters, else
  the browser's, else English (`autoLanguage`).

The login page, the settings page and the lobby are translated. Their words
are `WORDS` in src/client/words.js, one table per language with `{…}`
filled in (`say`); a word that goes with a count has a form per plural kind
(`Intl.PluralRules`), picked by `{n}`. A static text in index.html names its
word with `data-word` (`translate`); the lobby's How to play and About are
written out in each language there, as they hold links, and the page shows
the reader's. The login and settings pages draw their texts in one
`show()`, which runs again when the language chosen or the name changes,
so they turn at once; the lobby reads its language once. The tests check
every language has every word with the same `{…}`, at most half again as
long as the English (five letters more for a short word: "Save",
"Сохранить"), every plural form, and that index.html's English matches the
table. The settings page lost its two hints at the author's word: the name
field says "Visible name (15)" when empty, as on the login page. Why New
game is refused comes from the server as counts (`waiting`, `seated`) for
the page to word.

The game's buttons are translated too (the author asked for special care
that they fit). Russian names in use (the author said to estimate the
game's terms), which the rest of the game should match: юниты (units),
бригада (crew; the button «Бригада…»), «Вернуть» (Return), «Бросить»
(Abort), «Герои…» (Heroes), «Атака…» (Attack), «Апгрейд» (Upgrade, the
author's word), яма (pit), воз (wagon), отряд (band), башня, ферма,
прочность (a building's hit points), кустарник (scrub), Тёмный Лорд (the
Dark Lord), modes Кооператив, Лёгкий Лорд, Общий Лёгкий Лорд, Очень Лёгкий Лорд, Все против
всех, sides Синие, Багровые, Зелёные, Золотые, Бирюзовые, Оранжевые,
Розовые, Серебряные (plural, as teams: "победили Синие"), and for seats 9
to 16 Лазурные, Салатовые, Индиго, Вишнёвые, Оливковые, Коралловые, Белые,
Мятные (Azure, Lime, Indigo, Cherry, Olive, Coral, White, Mint; Latvian
Debeszilie, Laima, Indigo, Ķiršu, Olīvu, Koraļļu, Baltie, Mētru; Finnish
Asuurit, Limetit, Indigot, Kirsikat, Oliivit, Korallit, Valkoiset,
Mintut), and on the
buttons Строить, Выбрано, Вид, Центр, Тихо, Координаты, Отпусти (the
author's, for fun; Release in English), Занять место, Новая база (New
base, in the seat button's place once your castle has fallen; it fits a
phone's rows, which the smoke check measures), Итоги, Лобби. In the status
panel the creator's Старт / Дальше (Start, or Go on once the game has
begun). How to play names the buttons the same way.

The author's fallback words for buttons too long: Народ (crew), яма, бить
(attack), воз, назад (return), стоп (abort). How the choice was made: a
page with the real stylesheet and IBM Plex Sans served locally (the cloud
browser can't reach Google Fonts; fetch the font files with curl), each
label's narrowest width measured, on a 390 px and a 360 px phone and a
desktop. A phone's buttons wrap into rows by their narrowest widths
(flex 1, basis 0), and a row is as tall as its tallest label. In English
the first row holds the five build buttons and Upgrade. In Russian, only
Воз and Яма with Апгрейд keep it so (Повозка, Карьер or Улучшить push
Upgrade to the second row, which then wraps), giving exactly the
English heights at 390 px. Бригада, Вернуть, Бросить and Атака fit as they
are. On the phone a price goes on its own line without the dot, in
English too, or "Воз · 15◆" wrapped onto three lines. The phone's gap
between buttons is 6 px, as on a desktop: at 8 the Russian first row had
2 px to spare and a bold Я pushed Upgrade down; at 6 it has 11. Отпусти
and Release (for "Уступить место" and "Release seat") keep the seat button
on one line, which saved a line at 360 px. Now both languages are exactly
as tall everywhere measured: 217 px at 390, 234 at 360, and the desktop
panel 165 and 166 px wide.

The Russian keys: the bold letter, typed in the Russian layout. Where the
word has the Cyrillic letter that sits on the English key, it is that one
(Ап**г**рейд on U, Ге**р**ои on H, Ферм**а** on F), so the key is the
same in both languages; else the first letter (**Б**ашня on the comma key,
**В**оз on D, **Я**ма on Z, **О**тряд on J); Брига**д**а (L) and А**т**ака
(N) because Б and А were taken. The English keys work in Russian too, so
no Russian letter may sit on another button's English key (Бригада's И
would be B, Band's), and the tests check it. A phone shows no bold letters
(the author: no keys there), which also leaves its labels a little more
room.

Latvian and Finnish followed, with every word Russian has. Their buttons
were measured the same way, and fit as English does on both phones (more
room than Russian in the first row: Latvian 30 px, Finnish 14); the
longer words (Vezums, Karjers, Pulks; Louhos, Maatila, Paranna) push
Upgrade off the first row. Keys by the same rule, and the author chose
words that keep the English key over nicer ones ("slightly lame, to buy
consistent keys"): Atakot (A) over Uzbrukt, Farmi (F) over Tila. Their
keyboards have the English letters where English ones do, so no layout
table is needed; no key is a letter with a diacritic (ā, ņ, ä, ö).
Latvian has three plural kinds (zero, one, other), Finnish two. A browser
listing Latvian before Russian now gets Latvian for Auto (a Cyrillic name
still picks Russian once signed in).

His plan: translate only the lobby and the game's controls, each text about
as long as the English so the layout holds, and take care with short texts
and texts built up as the game goes. Things to watch there:

- A button's bold letter is its key (**T**ower, **U**pgrade): done for the
  buttons, as above; the crew chooser's Enter-or-key and the Heroes list's
  H take the opening button's keys, in either layout (`keyCandidates`).
- Short labels padded to line up, such as "Att Lv 15" in the Heroes list.
- Counts with a noun ("3 heroes died"): Russian has three plural forms.
- Texts the server sends in English, such as the core's refusals, which
  the page would have to put in its own words (why New game is refused
  already comes as counts).
- Every view switch is a page load, so the page can read its language once,
  as it loads.

The game's panels and the crew and heroes dialogs followed. What was
decided there:

- Building names change form after a preposition in all three languages
  (в башне, к башне; tornī; tornissa), so where a unit is reads as just
  the name, or "→" and the name for one on its way («башня», «→ башня»),
  and a target as «цель: башня». English keeps "in a tower".
- The team's stock labels are short (Общ. камень, Kop. akmens, Yht. kivi,
  and Team metal in English): measured with the real fonts, the longer
  ones were cut off on a desktop and a 360 px phone, and "Team dark metal"
  was already cut in English once the stock reached four figures. Without
  IBM Plex (the cloud's browser can't fetch it, so the smoke screenshots
  show this) the fallback font is wider: «Общий камень» fit with Plex but
  not without; the short forms nearly fit either way.
- The dialogs' top lines are one short sentence each now, the heroes
  list's with what each skill's three letters stand for.

The heroes list's skill letters (Att, Mel, Bld, Frm, Brd, Run) can be
translated without moving anything: they are set in IBM Plex Mono, where
every letter, Cyrillic, Latvian and Finnish ones included, is as wide as
any other. Measured: each "Att Lv 15" is 63 px in every language, two
lines of three on a 390 or 360 px phone, one line on a desktop, with "Lv"
translated too or not. Candidates, in the order ranged, close combat,
building, farming, breeding, running: Атк, Бли, Стр, Зем, Плд, Бег (and Ур
for Lv); Uzb, Tuv, Būv, Zem, Vai, Skr (Lī); Hyö, Läh, Rak, Vil, Lis, Juo
(Ta). The top line already explains them. Three letters exactly, and two
for Lv, is what keeps the columns: a test could hold them to that.

### Less drawing during play

While anything moves, which is nearly always, the board redraws at the
screen's refresh rate (60 or 144 times a second). The author put these off
("not now"):

1. Cap redraws for movement at about 30 a second: a unit takes 2 s to cross
   a cell. Panning, hovering and clicks would still redraw at once.
2. Redraw for movement only when something moving is on screen.
3. Keep the terrain drawn in a buffer, redrawn only on a pan or zoom. This
   fits pictured ground best (above), as pictures make each redraw dearer.

### Faster fighting for big games

Measured for 16 players (a scratch benchmark, 100 ms a tick to spend):
before the band fix, a big battle on an 8-player map took 28 ms a tick on
average, and on a 16-player map (83 × 55, 8 sides of 600 units, 48 bands)
127 ms. Most of it (two thirds) was each band asking which units were its
crew. That fix is in (`advance`: one pass over the units for all bands),
giving 7 ms and 23 ms, with the same results, so saved games replay.

Left for later: once a second (`COMBAT_PERIOD`), each unit out walking
looks through every enemy for the nearest one in reach, so the work grows
with the square of the units out. With about 2,900 units walking out at
once, one round took up to 2.9 s and froze the game for that long. The fix:
in `fight`, sort the targets once into a lookup by cell (or by a coarse
grid of cells), and have a walker look only at the cells within its reach.
It must pick exactly the same target as now, including which of two at the
same distance comes first (the targets' order in the list), or old games
replay differently. Check it as the band fix was: a recorded big battle
must end in the same state, tick for tick.

### Further off

Units' dice in place of a single kill chance; bots and balance ("much
later", in the author's words); a simulation harness, as the core can
already play games with no players. README, "Not done yet", lists the rest.
