/**
 * Headless browser check of the real page, served by a real game server:
 * login, lobby, and games between three browsers, directly and under a
 * subfolder behind a proxy, plus the game on a phone.
 *
 * Usage: node scripts/smoke.js   (screenshots land in smoke-output/)
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { startGameServer } from '../server/app.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'smoke-output');
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** @type {string[]} */
const problems = [];

// --- page helpers ------------------------------------------------------------

/**
 * Open a page with error collection, and web fonts stubbed so the run does
 * not depend on the network.
 * @param {import('playwright').Browser} browser
 * @param {string} label
 * @param {import('playwright').BrowserContextOptions} [options]
 * @param {RegExp} [expectedError] A console error this page is meant to cause.
 */
async function openPage(browser, label, options = { viewport: { width: 1280, height: 800 } }, expectedError) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => (
    route.fulfill({ status: 200, contentType: 'text/css', body: '' })
  ));
  page.on('pageerror', (e) => problems.push(`${label}: uncaught ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !expectedError?.test(m.text())) problems.push(`${label}: console.error ${m.text()}`);
  });
  return page;
}

/** Wait for two animation frames, so the latest state has been drawn. */
const frames = (page) => page.evaluate(() => new Promise((res) => {
  requestAnimationFrame(() => requestAnimationFrame(() => res(undefined)));
}));

/**
 * Page coordinates of the centre of hex (q, r); whether the canvas is what
 * is actually there (rather than a HUD panel on top of it); and whether it
 * is clear of the panels by a margin, since they widen as their text grows.
 */
function hexPoint(page, q, r) {
  return page.evaluate(([q, r]) => {
    const v = /** @type {any} */ (window).__vigame;
    const size = v.board.hexSize;
    const s = v.camera.toScreen(size * Math.sqrt(3) * (q + r / 2), size * 1.5 * r);
    const canvas = document.getElementById('board');
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + s.x;
    const y = rect.top + s.y;
    const canvasAt = (/** @type {number} */ dx, /** @type {number} */ dy) => document.elementFromPoint(x + dx, y + dy) === canvas;
    return {
      x, y,
      open: canvasAt(0, 0),
      clear: [[0, 0], [-80, 0], [80, 0], [0, -40], [0, 40]].every(([dx, dy]) => canvasAt(dx, dy)),
    };
  }, [q, r]);
}

async function clickHex(page, q, r, { touch = false } = {}) {
  const p = await hexPoint(page, q, r);
  assert.ok(p.open, `hex ${q},${r} is covered by the HUD`);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

/** Click or tap. */
const press = (page, selector, { touch = false } = {}) => (touch ? page.tap(selector) : page.click(selector));

const text = (page, selector) => page.locator(selector).textContent();

const waitText = (page, selector, value, timeout = 5000) => page.waitForFunction(
  ([s, v]) => document.querySelector(s)?.textContent === v,
  [selector, value],
  { timeout },
);

const waitMatch = (page, selector, pattern, timeout = 5000) => page.waitForFunction(
  ([s, source]) => new RegExp(source).test(document.querySelector(s)?.textContent ?? ''),
  [selector, pattern.source],
  { timeout },
);

/** The page's game: buildings as a list. */
const buildings = (page) => page.evaluate(() => Object.values(/** @type {any} */ (window).__vigame.view?.buildings ?? {}));

/** @param {number} owner */
const castleOf = async (page, owner) => (await buildings(page)).find((b) => b.type === 'castle' && b.owner === owner);

/** How many units are inside a building, as the page sees it. */
const insideOf = (page, id) => page.evaluate((id) => /** @type {any} */ (window).__vigame.occ?.inside.get(id)?.length ?? 0, id);

const waitInside = (page, id, n, timeout = 15000) => page.waitForFunction(
  ([id, n]) => (/** @type {any} */ (window).__vigame.occ?.inside.get(id)?.length ?? 0) >= n, [id, n], { timeout },
);

/**
 * The first of these cells well clear of the HUD, or failing that, the first
 * one it doesn't cover.
 * @param {Array<[number, number]>} cells
 */
async function openCell(page, cells) {
  let fallback = null;
  for (const [q, r] of cells) {
    const p = await hexPoint(page, q, r);
    if (p.clear) return { q, r };
    if (p.open) fallback ??= { q, r };
  }
  if (fallback) return fallback;
  throw new Error('every cell is under the HUD');
}

/**
 * Build with the Build buttons: pick the kind, then a highlighted cell.
 * @returns {Promise<any>} The new building.
 */
async function buildWith(page, kind, { touch = false } = {}) {
  const before = (await buildings(page)).length;
  await press(page, `#build-${kind}`, { touch });
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame.highlights.length > 0);
  const keys = await page.evaluate(() => /** @type {any} */ (window).__vigame.highlights);
  const spot = await openCell(page, keys.map((k) => k.split(',').map(Number)));
  await clickHex(page, spot.q, spot.r, { touch });
  await page.waitForFunction((n) => Object.keys(/** @type {any} */ (window).__vigame.view.buildings).length === n, before + 1);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__vigame.placing), null, 'out of build mode');
  return (await buildings(page)).find((b) => b.q === spot.q && b.r === spot.r);
}

/** Select a building by clicking it, unless it already is. */
async function selectBuilding(page, b, { touch = false } = {}) {
  if (await page.evaluate(() => /** @type {any} */ (window).__vigame.selected) === b.id) return;
  await clickHex(page, b.q, b.r, { touch });
  await page.waitForFunction((id) => /** @type {any} */ (window).__vigame.selected === id, b.id);
}

/** Send units from one building to another: select the first, click the second. */
async function sendUnits(page, from, to, { touch = false } = {}) {
  await selectBuilding(page, from, { touch });
  await clickHex(page, to.q, to.r, { touch });
  await page.waitForFunction((id) => Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id), to.id);
}

/** RGB of the canvas pixel under page point (x, y). */
const pixelAt = (page, x, y) => page.evaluate(([x, y]) => {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  const d = canvas.getContext('2d').getImageData(Math.round((x - rect.left) * dpr), Math.round((y - rect.top) * dpr), 1, 1).data;
  return [d[0], d[1], d[2]];
}, [x, y]);

/** Wait until the page shows a game. */
const inGame = (page) => page.waitForFunction(() => /** @type {any} */ (window).__vigame?.view, null, { timeout: 10000 });

// --- login and lobby ---------------------------------------------------------

/**
 * Answer the login page with this name.
 * @param {import('playwright').Page} page
 * @param {string} name
 */
async function logIn(page, name, { touch = false } = {}) {
  await page.waitForSelector('#login:not([hidden])');
  const question = await page.waitForFunction(() => {
    const m = /What is (\d+) \+ (\d+)\?/.exec(document.getElementById('login-question')?.textContent ?? '');
    return m && Number(m[1]) + Number(m[2]);
  });
  await page.fill('#login-name', name);
  await page.fill('#login-answer', String(await question.jsonValue()));
  await press(page, '#login-submit', { touch });
  await page.waitForSelector('#login', { state: 'hidden' });
}

/** Wait for the lobby, and for its lists to have loaded. */
const inLobby = (page) => page.waitForFunction(() => {
  const lobby = document.getElementById('lobby');
  return lobby && !lobby.hidden && document.getElementById('lobby-name')?.textContent;
}, null, { timeout: 10000 });

/**
 * Open a game from the lobby: the row naming these players.
 * @param {string} list 'mine' or 'open'
 * @param {string} who The row's text, such as "Ann vs —".
 */
async function openFromLobby(page, list, who, { touch = false } = {}) {
  const row = page.locator(`#lobby-${list} li`, { hasText: who });
  await row.first().waitFor({ timeout: 10000 });
  await press(page, `#lobby-${list} li:has-text("${who}") a`, { touch });
  await inGame(page);
}

/**
 * A new browser (its own storage, so its own token) logs in at the lobby.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {string} label
 * @param {string} name
 */
async function newPlayer(browser, url, label, name, options, expectedError) {
  const page = await openPage(browser, label, options, expectedError);
  await page.goto(url);
  await logIn(page, name);
  return page;
}

// --- scenarios ---------------------------------------------------------------

/**
 * Three browsers through the game server: login, lobby, a game, and the
 * game's commands. With `full`, everything; without, the path from login to
 * two players seeing each other's moves.
 * @param {import('playwright').Browser} browser
 * @param {string} url The server's address (the lobby).
 * @param {{ full: boolean, label: string }} options
 */
async function threeBrowsers(browser, url, { full, label }) {
  // Ann logs in. The form checks the name itself; the server checks the sum,
  // and a wrong answer gets a new one. (Chromium logs the refused request as
  // an error.)
  const a = await openPage(browser, `${label}-a`, undefined, /^Failed to load resource: .* 403\b/);
  await a.goto(url);
  await a.waitForSelector('#login:not([hidden])');
  await a.waitForFunction(() => /What is/.test(document.getElementById('login-question')?.textContent ?? ''));
  if (full) await a.screenshot({ path: join(OUT, 'login.png') });
  await a.fill('#login-name', 'Ann \u{1F642}');
  await a.fill('#login-answer', '1');
  await a.click('#login-submit');
  await a.waitForFunction(() => /letters or digits/.test(document.getElementById('login-error')?.textContent ?? ''));
  const first = await text(a, '#login-question');
  await a.fill('#login-name', 'Ann');
  await a.fill('#login-answer', '99');
  await a.click('#login-submit');
  await a.waitForFunction(() => /not it/.test(document.getElementById('login-error')?.textContent ?? ''));
  await a.waitForFunction((q) => /What is/.test(document.getElementById('login-question')?.textContent ?? '')
    && document.getElementById('login-question')?.textContent !== q, first);
  await logIn(a, 'Ann');

  // The lobby: nothing of Ann's yet. She starts a game, which opens it, and
  // its address is the invitation. Alone, she waits for a second player.
  await inLobby(a);
  assert.equal(await text(a, '#lobby-name'), 'Ann');
  await a.waitForSelector('#lobby-mine-empty:not([hidden])');
  if (full) await a.screenshot({ path: join(OUT, 'lobby.png') });
  await a.click('#lobby-new');
  await inGame(a);
  const link = a.url();
  assert.match(link, /\?game=[\w-]+$/);
  await waitText(a, '#seat', 'Ann · Blue');
  await waitText(a, '#time', '0:00 · paused');
  assert.equal(await a.locator('#build-tower').isDisabled(), true);

  // Bēla logs in and finds the game in the lobby, waiting for her.
  const b = await newPlayer(browser, url, `${label}-b`, 'Bēla');
  await inLobby(b);
  await openFromLobby(b, 'open', 'Ann vs —');
  await waitText(b, '#seat', 'Bēla · Crimson');
  await waitMatch(a, '#time', /^0:0[1-9]$/);

  // Ann builds and sends units; Bēla sees them march, and Ann's pick.
  const blue = await castleOf(a, 0);
  const tower = await buildWith(a, 'tower');
  await b.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id], tower.id);
  await waitInside(a, blue.id, 2);
  await sendUnits(a, blue, tower);
  await b.waitForFunction((id) => Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id && u.path?.length === 1), tower.id);
  await b.waitForFunction(({ q, r }) => /** @type {any} */ (window).__vigame.peers
    .some((p) => !p.isMe && p.sel && p.sel.q === q && p.sel.r === r), tower);
  if (full) {
    await frames(b);
    await b.screenshot({ path: join(OUT, 'game-crimson.png') });
  }
  await waitInside(b, tower.id, 1);
  if (!full) {
    for (const p of [a, b]) await p.context().close();
    return;
  }

  // Each castle is drawn in its side's colour: the cell below and left of its
  // centre is the castle's, and clear of its labels.
  const crimson = await castleOf(a, 1);
  const tint = async (c) => {
    const p = await hexPoint(a, c.q - 1, c.r + 1);
    return pixelAt(a, p.x, p.y);
  };
  const [br, , bb] = await tint(blue);
  const [cr, , cb] = await tint(crimson);
  assert.ok(bb > br + 25, `Blue's castle is not blue (${br}, ${bb})`);
  assert.ok(cr > cb + 25, `Crimson's castle is not red (${cr}, ${cb})`);

  // A drag pans rather than clicks.
  const camBefore = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  await a.mouse.move(640, 420);
  await a.mouse.down();
  await a.mouse.move(700, 460, { steps: 5 });
  await a.mouse.up();
  const camAfter = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  assert.ok(Math.abs(camAfter.x - camBefore.x) > 10, 'drag did not pan');
  await a.click('#recenter');

  // Ann upgrades her tower; Bēla sees it.
  await a.keyboard.press('Escape');
  await selectBuilding(a, tower);
  await waitMatch(a, '#selection', /^Tower \(grade 1\)/);
  await a.click('#upgrade');
  await waitMatch(a, '#selection', /^Tower \(grade 2\)/);
  await b.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id].grade === 2, tower.id);

  // Building far from your own buildings is refused, and the page says why.
  await a.keyboard.press('Escape');
  await a.click('#build-tower');
  const far = await openCell(a, [[crimson.q, crimson.r + 2], [crimson.q, crimson.r - 2], [crimson.q + 2, crimson.r - 2]]);
  await clickHex(a, far.q, far.r);
  await waitText(a, '#message', "Can't build there: too far from your buildings.");
  assert.equal(await a.locator('#build-tower').getAttribute('aria-pressed'), 'true', 'still placing');
  await a.keyboard.press('Escape');

  // Bēla builds a wagon, loads it, and drives it; its units ride along.
  await waitInside(b, crimson.id, 1);
  const wagon = await buildWith(b, 'wagon');
  await sendUnits(b, crimson, wagon);
  await b.waitForFunction((id) => !Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id), wagon.id, { timeout: 15000 });
  const riders = await insideOf(b, wagon.id);
  assert.ok(riders >= 1, 'units got in');
  await b.keyboard.press('Escape');
  await selectBuilding(b, wagon);
  const goal = await b.evaluate(({ id }) => {
    const v = /** @type {any} */ (window).__vigame;
    const w = v.view.buildings[id];
    const d = (t) => (Math.abs(t.q - w.q) + Math.abs(t.r - w.r) + Math.abs(t.q + t.r - w.q - w.r)) / 2;
    return v.board.list
      .filter((t) => t.passable && !v.occ.buildingAt.has(`${t.q},${t.r}`) && d(t) === 2)
      .map((t) => [t.q, t.r]);
  }, wagon);
  const dest = await openCell(b, goal);
  await clickHex(b, dest.q, dest.r);
  await a.waitForFunction(({ id, q, r }) => {
    const w = /** @type {any} */ (window).__vigame.view.buildings[id];
    return w.q !== q || w.r !== r;
  }, wagon, { timeout: 6000 });
  assert.equal(await insideOf(a, wagon.id), riders, 'the units rode along');
  await frames(a);
  await a.screenshot({ path: join(OUT, 'game-blue.png') });

  // Bēla reloads: same seat, same game, no login. Then she goes to the lobby,
  // finds the game among hers, and opens it again.
  await b.reload();
  await inGame(b);
  assert.equal(await b.locator('#login').isHidden(), true);
  await waitText(b, '#seat', 'Bēla · Crimson');
  await b.click('#to-lobby');
  await inLobby(b);
  await openFromLobby(b, 'mine', 'Ann vs Bēla');
  await waitText(b, '#seat', 'Bēla · Crimson');

  // Cai follows the invitation link, logs in, and watches.
  const c = await openPage(browser, `${label}-c`);
  await c.goto(link);
  await logIn(c, 'Cai');
  await inGame(c);
  await waitText(c, '#seat', 'Cai · Spectator');
  await waitText(a, '#viewers', '3');
  assert.equal(await c.locator('#build-tower').isDisabled(), true);

  // A link to a game that doesn't exist lands in the lobby, which says so.
  // (Chromium logs the refused join request itself as a console error.)
  const lost = await newPlayer(browser, `${url}?game=nope`, `${label}-lost`, 'Lou', undefined, /^Failed to load resource: .* 521\b/);
  await inLobby(lost);
  await waitText(lost, '#lobby-notice', 'There is no game at that address.');
  assert.equal(new URL(lost.url()).search, '', 'the address is the lobby again');

  for (const p of [a, b, c, lost]) await p.context().close();
}

/** The login page, the lobby and a game on a phone, with a desktop opponent. */
async function phone(browser, url) {
  const page = await newPlayer(browser, url, 'phone', 'Pia', PHONE);
  await inLobby(page);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert.ok(await fits(), 'the lobby scrolls sideways on a phone');
  await page.tap('#lobby-new');
  await inGame(page);
  const other = await newPlayer(browser, page.url(), 'phone-opponent', 'Oli');
  await inGame(other);
  await waitMatch(page, '#time', /^0:0[1-9]$/);

  const layout = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
    return {
      innerWidth,
      innerHeight,
      status: box('status'),
      controls: box('controls'),
      legendShown: getComputedStyle(document.getElementById('legend')).display !== 'none',
    };
  });
  assert.ok(await fits(), 'the game scrolls sideways on a phone');
  assert.ok(layout.controls.bottom <= layout.innerHeight && layout.controls.left >= 0
    && layout.controls.right <= layout.innerWidth, 'controls are off-screen');
  assert.ok(layout.controls.top > layout.status.bottom, 'controls overlap the status panel');
  assert.equal(layout.legendShown, false);

  const castle = await castleOf(page, 0);
  await selectBuilding(page, castle, { touch: true });
  // With no hover on a touch screen, the last tapped hex is the tile readout.
  assert.notEqual(await text(page, '#tile'), '—', 'tile readout cleared after a tap');
  await buildWith(page, 'tower', { touch: true });
  await frames(page);
  await page.screenshot({ path: join(OUT, 'phone.png') });
  for (const p of [page, other]) await p.context().close();
}

/**
 * A stand-in for nginx serving the game under a subfolder: requests under
 * `prefix` go to the game server with the prefix stripped, WebSocket upgrades
 * included, and anything else is a 404, so a page that reaches for the root
 * fails the scenario.
 * @param {string} target The game server's URL.
 * @param {string} prefix e.g. '/vigame'
 */
function startPrefixProxy(target, prefix) {
  const { hostname, port } = new URL(target);
  /** @param {string | undefined} url */
  const strip = (url = '') => (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)
    ? url.slice(prefix.length) || '/'
    : null);

  const proxy = createServer((req, res) => {
    const path = strip(req.url);
    if (path === null) return void res.writeHead(404).end('outside the game folder');
    const upstream = request({ hostname, port, path, method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });

  proxy.on('upgrade', (req, socket, head) => {
    const path = strip(req.url);
    if (path === null) return void socket.destroy();
    const upstream = connect(Number(port), hostname, () => {
      const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((res) => {
    proxy.listen(0, '127.0.0.1', () => {
      const { port: own } = /** @type {import('node:net').AddressInfo} */ (proxy.address());
      res({
        url: `http://127.0.0.1:${own}${prefix}/`,
        close: () => new Promise((done) => { proxy.closeAllConnections(); proxy.close(() => done(undefined)); }),
      });
    });
  });
}

// --- main ------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const games = await startGameServer({ port: 0 });
const proxied = /** @type {{ url: string, close: () => Promise<unknown> }} */ (await startPrefixProxy(games.url, '/vigame'));
const browser = await chromium.launch();
const scenarios = [
  ['login, lobby and a game, three browsers', () => threeBrowsers(browser, games.url, { full: true, label: 'direct' })],
  ['the same under a subfolder, behind a proxy', () => threeBrowsers(browser, proxied.url, { full: false, label: 'proxied' })],
  ['on a phone', () => phone(browser, games.url)],
];

let failed = 0;
try {
  for (const [name, run] of scenarios) {
    const before = problems.length;
    try {
      await run();
      if (problems.length > before) throw new Error(problems.slice(before).join('\n'));
      console.log(`ok - ${name}`);
    } catch (e) {
      failed++;
      console.log(`not ok - ${name}\n  ${String(e?.stack ?? e).split('\n').join('\n  ')}`);
    }
  }
} finally {
  await browser.close();
  await proxied.close();
  await games.close();
}

console.log(`\n${scenarios.length - failed}/${scenarios.length} passed; screenshots in ${OUT}`);
process.exitCode = failed ? 1 : 0;
