# Vigame: notes for Claude

A turn-based hex strategy prototype in plain JavaScript ES modules. See
README.md for the game, layout and data model. This file covers what isn't
obvious from the code.

## Commands

- `npm test`: unit tests (node:test). Fast; run after every change.
- `npm run build`: writes `dist/vigame.html` (standalone) and `dist/artifact.html`
  (the same page without the document skeleton, for publishing). `dist/` is
  gitignored; never commit it.
- `npm run smoke`: Playwright/Chromium check of the built page, including a
  three-browser online game. Run it before publishing or pushing UI or net
  changes. In Claude Code cloud sessions, Chromium is preinstalled and found
  through `PLAYWRIGHT_BROWSERS_PATH`; don't run `playwright install` there.

## Bundler constraints (scripts/build.js)

The build concatenates every module into one IIFE, drops imports, and strips
`export`. So in `src/`:

- Imports must be single-line, named, and relative: `import { a, b } from './x.js';`.
  No aliases, default exports, or re-exports. The build fails loudly otherwise.
- Top-level names must be unique across all modules, because they share one
  scope. The build checks this.
- No source may contain `</script`.
- Only `src/main.js` may touch the DOM at load time. Keep hex, board and game
  pure; `game.js` is meant to run unchanged on a server one day.

## The published artifact

The page is published as the claude.ai artifact titled **"Vigame Hex Board"**.
Find it with the Artifact tool's `list` action. Its declared capabilities are
`db`, `room` and `user`.

To republish:

1. `npm test && npm run smoke`.
2. `Artifact` `read` the live artifact first. The tool requires this, and it
   shows whether someone changed the page outside the repo.
3. Publish `dist/artifact.html` with that artifact's `url`, omitting
   `capabilities` so the stored declaration carries over. Then read it back:
   there should be exactly one `<!doctype`.

The db holds live games. Keep `game/state` and `game/seats` backward
compatible, or migrate them deliberately; `sanitizeState` is the place to
accept old shapes. Before publishing a build with a changed runtime version,
check the runtime contract version the artifact is pinned to.

## Online play

- `src/net.js` targets the Artifact runtime contract as read from its type
  definitions: `claude.use(name)`, db `doc().get/set/acquire/onSnapshot`,
  room `presence/peers/onPeers/onConnection/connected`, user `id/can`.
  `test/fake-runtime.js` mirrors that subset. When the contract changes,
  update both and add a test.
- Leases have no early release; they lapse after `ttlMs`. Seat claims wait
  out a busy lease and retry, so tests that seat several viewers use node:test
  mock timers (`setTimeout` and `Date`) and advance time.
- Snapshots can arrive from cache first (`metadata.fromCache`). Never treat an
  empty cached snapshot as "no document".
