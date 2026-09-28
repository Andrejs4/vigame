/**
 * Headless browser check of the real page: it boots without errors, draws the
 * board, and plays — hotseat on desktop and touch, online across three
 * browsers sharing a fake Artifact runtime, and through the real game server.
 *
 * The Artifact part runs test/fake-runtime.js in Node and bridges it into each
 * page as `window.claude`, so every page talks to one shared store, lease
 * table and room, the way viewers of the published artifact do.
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
import { createFakeRuntime } from '../test/fake-runtime.js';
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

const text = (page, selector) => page.locator(selector).textContent();

const waitText = (page, selector, value, timeout = 5000) => page.waitForFunction(
  ([s, v]) => document.querySelector(s)?.textContent === v,
  [selector, value],
  { timeout },
);

/** The current player's unit with this name. */
const ownUnit = (page, name) => page.evaluate((name) => {
  const v = /** @type {any} */ (window).__vigame;
  const u = [...v.game.units.values()].find((u) => u.owner === v.game.currentPlayer && u.name === name);
  return u && { ...u };
}, name);

/**
 * Select the current player's unit and move it to the most expensive
 * reachable hex that is not under a HUD panel.
 * @returns {Promise<{ id: string, q: number, r: number, cost: number, moveMax: number }>}
 */
async function selectAndMove(page, name, { touch = false } = {}) {
  const unit = await ownUnit(page, name);
  assert.ok(unit, `no ${name} for the current player`);
  await clickHex(page, unit.q, unit.r, { touch });
  await page.waitForFunction((id) => /** @type {any} */ (window).__vigame.game.selectedUnitId === id, unit.id);

  const target = await page.evaluate(() => {
    const v = /** @type {any} */ (window).__vigame;
    const canvas = document.getElementById('board');
    const rect = canvas.getBoundingClientRect();
    let best = null;
    for (const [k, cost] of v.reach) {
      const [q, r] = k.split(',').map(Number);
      const size = v.board.hexSize;
      const s = v.camera.toScreen(size * Math.sqrt(3) * (q + r / 2), size * 1.5 * r);
      if (document.elementFromPoint(rect.left + s.x, rect.top + s.y) !== canvas) continue;
      if (!best || cost > best.cost) best = { q, r, cost };
    }
    return best;
  });
  assert.ok(target, `${name} has nowhere to go`);

  await clickHex(page, target.q, target.r, { touch });
  await page.waitForFunction(([id, q, r]) => {
    const u = /** @type {any} */ (window).__vigame.game.units.get(id);
    return u && u.q === q && u.r === r;
  }, [unit.id, target.q, target.r]);
  return { id: unit.id, q: target.q, r: target.r, cost: target.cost, moveMax: unit.moveMax };
}

/** RGB of the canvas pixel under page point (x, y). */
const pixelAt = (page, x, y) => page.evaluate(([x, y]) => {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  const d = canvas.getContext('2d').getImageData(Math.round((x - rect.left) * dpr), Math.round((y - rect.top) * dpr), 1, 1).data;
  return [d[0], d[1], d[2]];
}, [x, y]);

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const close = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// --- scenarios -------------------------------------------------------------

async function hotseatDesktop(browser) {
  const page = await openPage(browser, 'hotseat');
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame);
  await frames(page);

  const game = await page.evaluate(() => {
    const g = /** @type {any} */ (window).__vigame.game;
    return { units: g.units.size, selected: g.selectedUnitId, turn: g.turn, player: g.currentPlayer };
  });
  assert.deepEqual(game, { units: 4, selected: null, turn: 1, player: 0 }, 'fresh page state');
  assert.equal(await text(page, '#turn'), '1');
  assert.equal(await text(page, '#player'), 'Blue');
  assert.equal(await page.locator('#seat-row').isHidden(), true, 'no seat row in hotseat');
  assert.equal(await page.locator('#seat-button').isHidden(), true);

  // The board is drawn: many distinct colours, and Blue's scout is blue.
  const colours = await page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 997) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });
  assert.ok(colours > 20, `board looks blank (${colours} colours)`);
  const scout = await ownUnit(page, 'Scout');
  const at = await hexPoint(page, scout.q, scout.r);
  const radius = await page.evaluate(() => {
    const v = /** @type {any} */ (window).__vigame;
    return v.board.hexSize * 0.52 * v.camera.zoom;
  });
  const px = await pixelAt(page, at.x + radius * 0.7, at.y);
  assert.ok(close(px, hex('#3d7fd8')), `scout pixel ${px} is not Blue`);
  await page.screenshot({ path: join(OUT, 'hotseat-start.png') });

  // Blue cannot pick up Crimson's units.
  const crimson = await page.evaluate(() => {
    const u = [.../** @type {any} */ (window).__vigame.game.units.values()].find((u) => u.owner === 1);
    return { ...u };
  });
  await clickHex(page, crimson.q, crimson.r);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__vigame.game.selectedUnitId), null);

  // Select and move the scout; movement is spent.
  const moved = await selectAndMove(page, 'Scout');
  assert.equal(await text(page, '#selection'), `Scout — ${moved.moveMax - moved.cost}/${moved.moveMax} MP`);
  await frames(page);
  await page.screenshot({ path: join(OUT, 'hotseat-moved.png') });

  // A drag pans rather than clicks.
  const camBefore = await page.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  await page.mouse.move(640, 420);
  await page.mouse.down();
  await page.mouse.move(700, 460, { steps: 5 });
  await page.mouse.up();
  const camAfter = await page.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  assert.ok(Math.abs(camAfter.x - camBefore.x) > 10, 'drag did not pan');
  await page.click('#recenter');

  // Two turn ends make a round; the scout's movement comes back.
  await page.click('#end-turn');
  assert.equal(await text(page, '#player'), 'Crimson');
  assert.equal(await text(page, '#turn'), '1');
  await page.click('#end-turn');
  assert.equal(await text(page, '#player'), 'Blue');
  assert.equal(await text(page, '#turn'), '2');
  assert.equal((await ownUnit(page, 'Scout')).move, moved.moveMax);

  await page.context().close();

  // The '#select' dev aid still works when asked for. (A fresh page: going to
  // the same URL plus a hash would not reload it.)
  const dev = await openPage(browser, 'select-hash');
  await dev.goto(pathToFileURL(BUNDLE).href + '#select');
  await dev.waitForFunction(() => /** @type {any} */ (window).__vigame);
  assert.notEqual(await dev.evaluate(() => /** @type {any} */ (window).__vigame.game.selectedUnitId), null);
  await frames(dev);
  await dev.screenshot({ path: join(OUT, 'hotseat-select-hash.png') });
  await dev.context().close();
}

async function hotseatTouch(browser) {
  const page = await openPage(browser, 'touch', {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame);
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

  await selectAndMove(page, 'Infantry', { touch: true });
  // With no hover on a touch screen, the last tapped hex is the tile readout.
  assert.notEqual(await text(page, '#tile'), '—', 'tile readout cleared after a tap');
  await frames(page);
  await page.screenshot({ path: join(OUT, 'touch.png') });
  await page.context().close();
}

async function modulesOverHttp(browser, url) {
  const page = await openPage(browser, 'modules');
  await page.goto(url);
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__vigame.game.units.size), 4);
  await selectAndMove(page, 'Scout');
  await page.context().close();
}

// --- online ----------------------------------------------------------------

/**
 * Runs in the page before its own scripts: `window.claude` backed by the
 * Node-side fake runtime through the `__fakeRuntime` binding.
 */
function runtimeShim({ uid }) {
  const w = /** @type {any} */ (window);
  const call = (op, ...args) => w.__fakeRuntime(op, ...args)
    .then((r) => (r && r.error ? Promise.reject(r.error) : r?.value));
  const toSnap = (s) => Object.freeze({
    id: s.id,
    exists: s.exists,
    data: () => (s.exists ? s.data : undefined),
    metadata: Object.freeze({ fromCache: s.fromCache, hasPendingWrites: false }),
  });

  const handlers = new Map();
  let seq = 0;
  w.__fakeDeliver = (id, s) => handlers.get(id)?.(toSnap(s));

  const db = Object.freeze({
    doc: (path) => Object.freeze({
      id: path.split('/').pop(),
      path,
      get: () => call('db.get', path).then(toSnap),
      set: (data) => call('db.set', path, data),
      acquire: (opts) => call('db.acquire', path, opts),
      onSnapshot(next) {
        const id = ++seq;
        handlers.set(id, next);
        call('db.subscribe', path, id);
        return () => { handlers.delete(id); call('db.unsubscribe', id); };
      },
    }),
  });

  let peers = Object.freeze([]);
  const peerHandlers = new Set();
  w.__fakePeers = (list) => {
    peers = Object.freeze(list);
    for (const fn of peerHandlers) fn({ peers, joined: [], left: [], updated: [] });
  };
  const room = Object.freeze({
    presence: (patch) => call('room.presence', patch),
    peers: () => peers,
    onPeers(fn) { peerHandlers.add(fn); return () => peerHandlers.delete(fn); },
    onConnection(fn) { setTimeout(() => fn(true), 0); return () => {}; },
    connected: () => true,
  });

  const user = Object.freeze({
    id: async () => uid,
    can: async () => true,
    canEdit: async () => false,
    isOwner: async () => false,
  });

  const caps = { db, room, user };
  let joined = false;
  w.claude = Object.freeze({
    use(name) {
      if (name === 'room' && !joined) { joined = true; call('room.join'); }
      // Namespaces arrive later than the page's first synchronous run.
      return new Promise((res) => setTimeout(() => res(caps[name] ?? null), 30));
    },
  });
}

/**
 * Open the bundle as one viewer of a shared fake artifact.
 * @param {import('playwright').Browser} browser
 * @param {ReturnType<typeof createFakeRuntime>} rt
 * @param {string} uid
 */
async function openOnline(browser, rt, uid) {
  const tab = rt.viewer({ uid });
  const page = await openPage(browser, uid);
  const unsubs = new Map();

  const wire = (snap) => ({
    id: snap.id, exists: snap.exists, data: snap.data() ?? null, fromCache: snap.metadata.fromCache,
  });
  const push = (fn, arg) => page.evaluate(fn, arg).catch(() => {});

  await page.exposeFunction('__fakeRuntime', async (op, ...args) => {
    try {
      switch (op) {
        case 'db.get': return { value: wire(await tab.db.doc(args[0]).get()) };
        case 'db.set': return { value: await tab.db.doc(args[0]).set(args[1]) };
        case 'db.acquire': return { value: await tab.db.doc(args[0]).acquire(args[1]) };
        case 'db.subscribe': {
          const [path, id] = args;
          unsubs.set(id, tab.db.doc(path).onSnapshot((snap) => push(
            ([id, s]) => /** @type {any} */ (window).__fakeDeliver(id, s), [id, wire(snap)],
          )));
          return { value: null };
        }
        case 'db.unsubscribe': unsubs.get(args[0])?.(); return { value: null };
        case 'room.join': {
          const send = () => push((list) => /** @type {any} */ (window).__fakePeers(list), tab.room.peers());
          tab.room.onPeers(send);
          send();
          return { value: null };
        }
        case 'room.presence': return { value: await tab.room.presence(args[0]) };
        default: return { error: { code: 'invalid_argument', message: `unknown op ${op}` } };
      }
    } catch (e) {
      return { error: { code: e?.code ?? 'unavailable', message: String(e?.message ?? e) } };
    }
  });
  await page.addInitScript(runtimeShim, { uid });
  await page.goto(pathToFileURL(BUNDLE).href);
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame?.net.mode === 'online');
  page.on('close', () => tab.leave());
  return page;
}

const endTurnEnabled = (page, timeout = 5000) => page.waitForFunction(
  () => !(/** @type {HTMLButtonElement} */ (document.getElementById('end-turn')).disabled), null, { timeout },
);

async function online(browser) {
  const rt = createFakeRuntime();

  const a = await openOnline(browser, rt, 'u_a');
  await waitText(a, '#seat', 'Blue');
  await endTurnEnabled(a);
  assert.equal(await a.locator('#seat-button').textContent(), 'Release seat');

  // B arrives while A's lease on the seat table may still be running, and
  // must wait it out rather than end up spectating.
  const b = await openOnline(browser, rt, 'u_b');
  await waitText(b, '#seat', 'Crimson', 15000);
  assert.equal(await b.locator('#end-turn').isDisabled(), true);
  assert.equal(await b.locator('#end-turn').getAttribute('title'), 'Waiting for Blue');

  // A's move reaches B, and so does the hex A picked.
  const moved = await selectAndMove(a, 'Scout');
  await b.waitForFunction(({ id, q, r }) => {
    const u = /** @type {any} */ (window).__vigame.game.units.get(id);
    return u && u.q === q && u.r === r;
  }, moved);
  await b.waitForFunction(({ q, r }) => /** @type {any} */ (window).__vigame.peers
    .some((p) => !p.isMe && p.sel && p.sel.q === q && p.sel.r === r), moved);

  // B cannot move A's units, and nothing B clicks changes the game.
  await clickHex(b, moved.q, moved.r);
  assert.equal(await b.evaluate(() => /** @type {any} */ (window).__vigame.game.selectedUnitId), null);

  // Turn passes to B.
  await a.click('#end-turn');
  await endTurnEnabled(b);
  await waitText(a, '#player', 'Crimson');
  assert.equal(await a.locator('#end-turn').isDisabled(), true);
  await frames(b);
  await b.screenshot({ path: join(OUT, 'online-crimson.png') });

  // A latecomer sees the game as it stands, not the opening position, and
  // spectates because both seats are taken.
  const c = await openOnline(browser, rt, 'u_c');
  await c.waitForFunction(({ id, q, r }) => {
    const v = /** @type {any} */ (window).__vigame;
    const u = v.game.units.get(id);
    return u && u.q === q && u.r === r && v.game.currentPlayer === 1;
  }, moved, { timeout: 15000 });
  await waitText(c, '#seat', 'Spectator');
  await waitText(a, '#viewers', '3');
  assert.equal(await c.locator('#seat-button').isHidden(), true);
  assert.equal(await c.locator('#end-turn').getAttribute('title'), 'Spectating — both seats are taken');
  assert.deepEqual(rt.docs.get('game/state').units.find((u) => u.id === moved.id),
    { ...(await ownUnitById(c, moved.id)) }, 'store and latecomer disagree');

  // A gives the seat up; C is offered it and takes it; A does not grab it back.
  await a.click('#seat-button');
  await waitText(a, '#seat', 'Spectator', 15000);
  await c.waitForSelector('#seat-button:not([hidden])');
  assert.equal(await c.locator('#seat-button').textContent(), 'Take seat');
  assert.equal(await c.locator('#end-turn').getAttribute('title'), 'Take a seat to play');
  await c.click('#seat-button');
  await waitText(c, '#seat', 'Blue', 15000);
  await a.waitForTimeout(1500);
  assert.equal(await text(a, '#seat'), 'Spectator');
  assert.equal(await text(b, '#seat'), 'Crimson');
  await frames(c);
  await c.screenshot({ path: join(OUT, 'online-latecomer.png') });

  // B moves for Crimson and ends the turn; C now plays Blue.
  await selectAndMove(b, 'Infantry');
  await b.click('#end-turn');
  await endTurnEnabled(c);
  await waitText(c, '#turn', '2');

  for (const p of [a, b, c]) await p.context().close();
}

const ownUnitById = (page, id) => page.evaluate((id) => ({
  .../** @type {any} */ (window).__vigame.game.units.get(id),
}), id);

// --- game server -------------------------------------------------------------

/**
 * Open a page from the game server as a new browser (its own storage, so its
 * own player token).
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {string} label
 */
async function openServerPage(browser, url, label) {
  const page = await openPage(browser, label);
  await page.goto(url);
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame?.net.mode === 'online', null, { timeout: 10000 });
  return page;
}

async function gameServer(browser, url) {
  // Opening the bare address starts a game, and the address becomes its link.
  const a = await openServerPage(browser, url, 'server-a');
  const link = a.url();
  assert.match(link, /\?game=[\w-]+$/);
  await waitText(a, '#seat', 'Blue');
  await endTurnEnabled(a);

  const b = await openServerPage(browser, link, 'server-b');
  await waitText(b, '#seat', 'Crimson');
  assert.equal(await b.locator('#end-turn').getAttribute('title'), 'Waiting for Blue');

  // Blue's move and pick reach Crimson through the server.
  const moved = await selectAndMove(a, 'Scout');
  const at = ({ id, q, r }) => {
    const u = /** @type {any} */ (window).__vigame.game.units.get(id);
    return u && u.q === q && u.r === r;
  };
  await b.waitForFunction(at, moved);
  await b.waitForFunction(({ q, r }) => /** @type {any} */ (window).__vigame.peers
    .some((p) => !p.isMe && p.sel && p.sel.q === q && p.sel.r === r), moved);

  await a.click('#end-turn');
  await endTurnEnabled(b);
  await waitText(a, '#player', 'Crimson');

  // Crimson reloads: same seat (the token is kept), same game (the server has it).
  await b.reload();
  await b.waitForFunction(() => /** @type {any} */ (window).__vigame?.net.mode === 'online');
  await waitText(b, '#seat', 'Crimson');
  await b.waitForFunction(at, moved);
  await endTurnEnabled(b);
  await frames(b);
  await b.screenshot({ path: join(OUT, 'server-crimson.png') });

  // A third browser watches.
  const c = await openServerPage(browser, link, 'server-c');
  await waitText(c, '#seat', 'Spectator');
  await waitText(a, '#viewers', '3');

  // A link to a game that doesn't exist says so, and the page still works.
  // (Chromium logs the refused join request itself as a console error.)
  const lost = await openPage(browser, 'server-lost', undefined, /^Failed to load resource: .* 521\b/);
  await lost.goto(`${url}?game=nope`);
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
  ['hotseat on desktop', () => hotseatDesktop(browser)],
  ['hotseat on a touch phone', () => hotseatTouch(browser)],
  ['ES modules over HTTP', () => modulesOverHttp(browser, server.url)],
  ['online, three browsers', () => online(browser)],
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
