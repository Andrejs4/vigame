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
  `crew.png`, `heroes.png`, `phone.png`, `effects.png`, `lobby*.png`,
  `login*.png`, `settings*.png`, `scores.png`, and `failed-*.png` when a check
  fails.
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
  ticks up to 30. A band is drawn over the buildings it passes, yours over
  another side's. Another side's band can't be selected, only aimed at with
  Attack.
- The author has looked at hunger's rules and the score table and chose to
  keep them as they are: change them only when he asks.
- No need to fit windows under about 800 px tall: there the minimap may
  cover the Lobby button.

## Plans not built yet

### Graphics: a "Painted" look beside today's

Agreed in outline; nothing built yet.

- **Switch:** a Graphics button in the View panel, Classic (today's look,
  the default) or Painted, remembered by each browser like Mute. The Classic
  code stays as it is, and a picture that fails to load falls back to its
  flat colour. The minimap keeps flat colours.
- **Painted:** a seamless texture for each terrain, pinned to the map rather
  than to each hex, so a field flows across cells. Small decorations are
  scattered on cells by the map's seed, the same for every player, and
  hidden under buildings. Shorelines and a softer grid are drawn in code.
- **Pictures from the author,** up to 16 in all, two of them spare:

  | # | What | Size | Notes |
  | --- | --- | --- | --- |
  | 4 | Ground: grass, meadow, scrub, water | Paint at 1024 × 1024; ship 512 unless 1024 looks clearly better | Seamless both ways, opaque |
  | 9 | Decorations: grass 2 (tuft, stone), meadow 2 (flower patches), scrub 3 (bush, small tree, thorn bush), water 2 (reeds, lily pad) | 128 × 128 (paint at 256 if easier) | Transparent, seen from above, the object in the middle 60% |
  | 1 | What lies around the board | 512 × 512, seamless | Optional |

- **Scale:** a hex is 34 px from centre to corner (`hexSize`), so a 512 tile
  covers about 4 hexes across and 5 rows down. The first thing to make is a
  guide image: a 512 tile with true-size hexes drawn on it.
- **Readability:** keep each terrain's colour family: mid green grass,
  yellow-green meadow, dark olive scrub, blue water. At the furthest zoom a
  hex is 24 px wide, and colour is what tells where one can build or walk.
  Keep textures low in contrast and mid in tone, with no standout feature
  that would repeat every few hexes.
- **Order:** first the switch and Painted mode with stand-in textures made
  from noise, to check the approach and the speed; then his four ground
  textures; then the decorations.

### Russian for the lobby and the game's controls

Built so far: each player has a language, Auto (the default), English or
Russian, chosen on the login page and the settings page and kept on the
server (`language` in the players table, `/api/me`). Its Auto option says
which language Auto picked (src/client/language.js):

- On the login page the browser comes first (the author's choice): the
  first of its languages that the page has, else Russian for a name typed
  in Cyrillic letters, else English (`loginLanguage`).
- Once signed in, the name comes first: Russian for Cyrillic letters, else
  the browser's, else English (`autoLanguage`).

The login and settings pages are translated. Their words are `WORDS` in
src/client/words.js, one table per language with `{…}` filled in (`say`).
Each page draws all its texts in one `show()`, which runs again when the
language chosen or the name changes, so the page turns at once. The tests
check every language has every word with the same `{…}`, at most half
again as long as the English (five letters more for a short word: "Save",
"Сохранить"). The settings page lost its two hints at the author's word:
the name field says "Visible name (15)" when empty, as on the login page.
The lobby and the game wait until the author asks.
His plan: translate only the lobby and the game's controls, each text about
as long as the English so the layout holds, and take care with short texts
and texts built up as the game goes. Things to watch there:

- A button's bold letter is its key (**T**ower, **U**pgrade): a Russian
  word either marks its own letter, or the keys stay Latin.
- Short labels padded to line up, such as "Att Lv 15" in the Heroes list.
- Counts with a noun ("3 heroes died"): Russian has three plural forms.
- Texts the server sends in English (refusals, why New game is refused),
  which the page would have to put in its own words.
- Every view switch is a page load, so the page can read its language once,
  as it loads.

### Less drawing during play

While anything moves, which is nearly always, the board redraws at the
screen's refresh rate (60 or 144 times a second). The author put these off
("not now"):

1. Cap redraws for movement at about 30 a second: a unit takes 2 s to cross
   a cell. Panning, hovering and clicks would still redraw at once.
2. Redraw for movement only when something moving is on screen.
3. Keep the terrain drawn in a buffer, redrawn only on a pan or zoom. This
   fits the Painted graphics best, as textures make each redraw dearer.

### Further off

Units' dice in place of a single kill chance; bots and balance ("much
later", in the author's words); a simulation harness, as the core can
already play games with no players. README, "Not done yet", lists the rest.
