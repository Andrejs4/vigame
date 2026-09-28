/**
 * Headless browser check of the real page: it boots without errors, draws the
 * board, and plays: on one screen (desktop and touch), and through the real
 * game server with three browsers, directly and under a subfolder behind a
 * proxy.
 *
 * Usage: node scripts/smoke.js   (screenshots land in smoke-output/)
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { startGameServer } from '../server/app.js';
import { build } from './build.js';
import { startServer } from './serve.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'smoke-output');
const BUNDLE = join(ROOT, 'dist', 'vigame.html');

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
 * Page coordinates of the centre of hex (q, r), and whether the canvas is
 * what is actually there (rather than a HUD panel on top of it).
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
    return { x, y, open: document.elementFromPoint(x, y) === canvas };
  }, [q, r]);
}

async function clickHex(page, q, r, { touch = false } = {}) {
  const p = await hexPoint(page, q, r);
  assert.ok(p.open, `hex ${q},${r} is covered by the HUD`);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

/** Click or tap a button. */
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
 * The first of these cells that the HUD doesn't cover.
 * @param {Array<[number, number]>} cells
 */
async function openCell(page, cells) {
  for (const [q, r] of cells) if ((await hexPoint(page, q, r)).open) return { q, r };
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

const waitGame = (page) => page.waitForFunction(() => /** @type {any} */ (window).__vigame?.view, null, { timeout: 10000 });

// --- one screen ----------------------------------------------------------------

async function localDesktop(browser) {
  const page = await openPage(browser, 'local');
  await page.goto(pathToFileURL(BUNDLE).href);
  await waitGame(page);
  await frames(page);

  const blue = await castleOf(page, 0);
  const crimson = await castleOf(page, 1);
  assert.ok(blue && crimson, 'a castle per side');
  assert.equal(await text(page, '#seat'), 'Blue');
  assert.equal(await text(page, '#seat-button'), 'Play Crimson');
  assert.equal(await page.locator('#viewers-row').isHidden(), true);
  await waitMatch(page, '#time', /^0:0[1-9]$/);

  // The board is drawn, and each castle in its side's colour: the cell below
  // and left of its centre is the castle's, and clear of its labels.
  const colours = await page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 997) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });
  assert.ok(colours > 20, `board looks blank (${colours} colours)`);
  const tint = async (b) => {
    const p = await hexPoint(page, b.q - 1, b.r + 1);
    return pixelAt(page, p.x, p.y);
  };
  const [br, , bb] = await tint(blue);
  const [cr, , cb] = await tint(crimson);
  assert.ok(bb > br + 25, `Blue's castle is not blue (${br}, ${bb})`);
  assert.ok(cr > cb + 25, `Crimson's castle is not red (${cr}, ${cb})`);
  await page.screenshot({ path: join(OUT, 'local-start.png') });

  // A drag pans rather than clicks.
  const camBefore = await page.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  await page.mouse.move(640, 420);
  await page.mouse.down();
  await page.mouse.move(700, 460, { steps: 5 });
  await page.mouse.up();
  const camAfter = await page.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  assert.ok(Math.abs(camAfter.x - camBefore.x) > 10, 'drag did not pan');
  await page.click('#recenter');

  // Build a tower, and send units to it once the castle has made some.
  const tower = await buildWith(page, 'tower');
  assert.deepEqual([tower.owner, tower.grade], [0, 1]);
  await waitInside(page, blue.id, 2);
  await sendUnits(page, blue, tower);
  await waitMatch(page, '#selection', /^Castle \(grade 1\) · \d+\/60$/);
  await frames(page);
  await page.screenshot({ path: join(OUT, 'local-marching.png') });
  await waitInside(page, tower.id, 1);

  // Upgrade the tower.
  await page.keyboard.press('Escape');
  await selectBuilding(page, tower);
  await waitMatch(page, '#selection', /^Tower \(grade 1\)/);
  await page.click('#upgrade');
  await waitMatch(page, '#selection', /^Tower \(grade 2\)/);

  // Building far from your own buildings is refused, and the page says why.
  await page.keyboard.press('Escape');
  await page.click('#build-tower');
  const far = await openCell(page, [[crimson.q, crimson.r + 2], [crimson.q, crimson.r - 2], [crimson.q + 2, crimson.r - 2]]);
  await clickHex(page, far.q, far.r);
  await waitText(page, '#message', "Can't build there: too far from your buildings.");
  assert.equal(await page.locator('#build-tower').getAttribute('aria-pressed'), 'true', 'still placing');
  await page.keyboard.press('Escape');

  // Play Crimson: build a wagon, load it, and drive it; its units ride along.
  await page.click('#seat-button');
  await waitText(page, '#seat', 'Crimson');
  await waitInside(page, crimson.id, 1);
  const wagon = await buildWith(page, 'wagon');
  await sendUnits(page, crimson, wagon);
  await waitInside(page, wagon.id, 1);
  const riders = await insideOf(page, wagon.id);
  await page.keyboard.press('Escape');
  await selectBuilding(page, wagon);
  const goal = await page.evaluate(({ id }) => {
    const v = /** @type {any} */ (window).__vigame;
    const w = v.view.buildings[id];
    const d = (t) => (Math.abs(t.q - w.q) + Math.abs(t.r - w.r) + Math.abs(t.q + t.r - w.q - w.r)) / 2;
    return v.board.list
      .filter((t) => t.passable && !v.occ.buildingAt.has(`${t.q},${t.r}`) && d(t) === 2)
      .map((t) => [t.q, t.r]);
  }, wagon);
  const dest = await openCell(page, goal);
  await clickHex(page, dest.q, dest.r);
  await page.waitForFunction(({ id, q, r }) => {
    const w = /** @type {any} */ (window).__vigame.view.buildings[id];
    return w.q !== q || w.r !== r;
  }, wagon, { timeout: 6000 });
  assert.equal(await insideOf(page, wagon.id), riders, 'the units rode along');
  await frames(page);
  await page.screenshot({ path: join(OUT, 'local-wagon.png') });
  await page.context().close();
}

async function localTouch(browser) {
  const page = await openPage(browser, 'touch', {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await page.goto(pathToFileURL(BUNDLE).href);
  await waitGame(page);
  await frames(page);

  const layout = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      innerHeight,
      status: box('status'),
      controls: box('controls'),
      legendShown: getComputedStyle(document.getElementById('legend')).display !== 'none',
    };
  });
  assert.ok(layout.scrollWidth <= layout.innerWidth, 'page scrolls sideways on a phone');
  assert.ok(layout.controls.bottom <= layout.innerHeight && layout.controls.left >= 0
    && layout.controls.right <= layout.innerWidth, 'controls are off-screen');
  assert.ok(layout.controls.top > layout.status.bottom, 'controls overlap the status panel');
  assert.equal(layout.legendShown, false);

  const blue = await castleOf(page, 0);
  await selectBuilding(page, blue, { touch: true });
  // With no hover on a touch screen, the last tapped hex is the tile readout.
  assert.notEqual(await text(page, '#tile'), '—', 'tile readout cleared after a tap');
  await page.evaluate(() => { /** @type {any} */ (window).__vigame.forceDraw(); });
  await buildWith(page, 'tower', { touch: true });
  await frames(page);
  await page.screenshot({ path: join(OUT, 'touch.png') });
  await page.context().close();
}

async function modulesOverHttp(browser, url) {
  const page = await openPage(browser, 'modules');
  await page.goto(url);
  await waitGame(page);
  assert.equal((await buildings(page)).length, 2);
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame.view.tick > 3);
  await page.context().close();
}

// --- game server -------------------------------------------------------------

/**
 * Answer the sign-in form with this name.
 * @param {import('playwright').Page} page
 * @param {string} name
 */
async function signIn(page, name) {
  await page.waitForSelector('#signin[open]');
  const question = await page.waitForFunction(() => {
    const m = /What is (\d+) \+ (\d+)\?/.exec(document.getElementById('signin-question')?.textContent ?? '');
    return m && Number(m[1]) + Number(m[2]);
  });
  await page.fill('#signin-name', name);
  await page.fill('#signin-answer', String(await question.jsonValue()));
  await page.click('#signin-submit');
  await page.waitForSelector('#signin', { state: 'hidden' });
}

const online = (page) => page.waitForFunction(() => /** @type {any} */ (window).__vigame?.net.mode === 'online'
  && /** @type {any} */ (window).__vigame.view, null, { timeout: 10000 });

/**
 * Open a page from the game server as a new browser (its own storage, so its
 * own player token), and sign in.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {string} label
 * @param {string} name
 */
async function openServerPage(browser, url, label, name) {
  const page = await openPage(browser, label);
  await page.goto(url);
  await signIn(page, name);
  await online(page);
  return page;
}

async function gameServer(browser, url) {
  // A new browser is asked for a name and a sum before anything else. The
  // form checks the name itself; the server checks the sum, and a wrong
  // answer gets a new one. (Chromium logs the refused request as an error.)
  const a = await openPage(browser, 'server-a', undefined, /^Failed to load resource: .* 403\b/);
  await a.goto(url);
  await a.waitForSelector('#signin[open]');
  await a.waitForFunction(() => /What is/.test(document.getElementById('signin-question')?.textContent ?? ''));
  await frames(a);
  await a.screenshot({ path: join(OUT, 'server-sign-in.png') });
  await a.fill('#signin-name', 'Ann \u{1F642}');
  await a.fill('#signin-answer', '1');
  await a.click('#signin-submit');
  await a.waitForFunction(() => /letters or digits/.test(document.getElementById('signin-error')?.textContent ?? ''));
  const first = await text(a, '#signin-question');
  await a.fill('#signin-name', 'Ann');
  await a.fill('#signin-answer', '99');
  await a.click('#signin-submit');
  await a.waitForFunction(() => /not it/.test(document.getElementById('signin-error')?.textContent ?? ''));
  await a.waitForFunction((q) => /What is/.test(document.getElementById('signin-question')?.textContent ?? '')
    && document.getElementById('signin-question')?.textContent !== q, first);
  assert.equal(await a.locator('#signin[open]').count(), 1, 'still asking');
  await signIn(a, 'Ann');

  // Opening the bare address starts a game, and the address becomes its link.
  // Alone, Blue waits: the clock runs only while both players are here.
  await online(a);
  const link = a.url();
  assert.match(link, /\?game=[\w-]+$/);
  await waitText(a, '#seat', 'Ann · Blue');
  await waitText(a, '#time', '0:00 · paused');
  assert.equal(await a.locator('#build-tower').isDisabled(), true);

  const b = await openServerPage(browser, link, 'server-b', 'Bēla');
  await waitText(b, '#seat', 'Bēla · Crimson');
  await waitMatch(a, '#time', /^0:0[1-9]$/);
  assert.equal(await a.locator('#build-tower').isDisabled(), false);

  // Blue builds and sends units; Crimson sees them march, and Blue's pick.
  const blue = await castleOf(a, 0);
  const tower = await buildWith(a, 'tower');
  await b.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id], tower.id);
  await waitInside(a, blue.id, 2);
  await sendUnits(a, blue, tower);
  await b.waitForFunction((id) => Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id && u.path?.length === 1), tower.id);
  await b.waitForFunction(({ q, r }) => /** @type {any} */ (window).__vigame.peers
    .some((p) => !p.isMe && p.sel && p.sel.q === q && p.sel.r === r), tower);
  await frames(b);
  await b.screenshot({ path: join(OUT, 'server-crimson.png') });
  await waitInside(b, tower.id, 1);

  // Crimson reloads: same seat (the token is kept), same game (the server
  // has it), and no sign-in (the server knows the token).
  await b.reload();
  await online(b);
  assert.equal(await b.locator('#signin[open]').count(), 0);
  await waitText(b, '#seat', 'Bēla · Crimson');
  await b.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id], tower.id);

  // A third browser watches, and can't give commands.
  const c = await openServerPage(browser, link, 'server-c', 'Cai');
  await waitText(c, '#seat', 'Cai · Spectator');
  await waitText(a, '#viewers', '3');
  assert.equal(await c.locator('#build-tower').isDisabled(), true);

  // A link to a game that doesn't exist says so, and the page still works.
  // (Chromium logs the refused join request itself as a console error.)
  const lost = await openPage(browser, 'server-lost', undefined, /^Failed to load resource: .* 521\b/);
  await lost.goto(`${url}?game=nope`);
  await signIn(lost, 'Lou');
  await lost.waitForSelector('#notice:not([hidden])');
  assert.match(await text(lost, '#notice'), /There is no game at this address/);
  assert.equal(await lost.locator('#notice a').getAttribute('href'), new URL(url).pathname);
  assert.equal(await lost.evaluate(() => /** @type {any} */ (window).__vigame.net.mode), 'local');
  await frames(lost);
  await lost.screenshot({ path: join(OUT, 'server-no-game.png') });

  for (const p of [a, b, c, lost]) await p.context().close();
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
mkdirSync(dirname(BUNDLE), { recursive: true });
writeFileSync(BUNDLE, build());

const server = await startServer();
const games = await startGameServer({ port: 0 });
const proxied = /** @type {{ url: string, close: () => Promise<unknown> }} */ (await startPrefixProxy(games.url, '/vigame'));
const browser = await chromium.launch();
const scenarios = [
  ['one screen, desktop', () => localDesktop(browser)],
  ['one screen, touch phone', () => localTouch(browser)],
  ['ES modules over HTTP', () => modulesOverHttp(browser, server.url)],
  ['game server, three browsers', () => gameServer(browser, games.url)],
  ['game server under a subfolder, behind a proxy', () => gameServer(browser, proxied.url)],
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
  await server.close();
  await proxied.close();
  await games.close();
}

console.log(`\n${scenarios.length - failed}/${scenarios.length} passed; screenshots in ${OUT}`);
process.exitCode = failed ? 1 : 0;
