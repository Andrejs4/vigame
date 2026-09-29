/**
 * Headless browser check of the real page, served by a real game server:
 * login, lobby, and games between three browsers, directly and under a
 * subfolder behind a proxy, plus the game on a phone.
 *
 * Usage: node scripts/smoke.js [word]   (screenshots land in smoke-output/)
 * With a word, only the scenarios whose names contain it run.
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { startGameServer } from '../server/app.js';
import { axialToPixel, distance } from '../src/core/hex.js';
import { BUILDING_TYPES } from '../src/core/rules.js';
import { PICTURES } from '../src/client/tokens.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'smoke-output');
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** @type {string[]} */
const problems = [];

/** Pages still open, by label, for the report when a scenario fails. */
/** @type {Map<string, import('playwright').Page>} */
const openPages = new Map();

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
  openPages.set(label, page);
  page.on('close', () => openPages.delete(label));
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

const waitInside = (page, id, n, timeout = 30000) => page.waitForFunction(
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
 * Centre the view on a cell, at the same zoom.
 * @param {any} page
 * @param {{ q: number, r: number }} cell
 */
async function lookAt(page, cell) {
  const size = await page.evaluate(() => /** @type {any} */ (window).__vigame.board.hexSize);
  await page.evaluate(({ x, y }) => {
    const v = /** @type {any} */ (window).__vigame;
    const rect = document.getElementById('board').getBoundingClientRect();
    v.camera.centreOn(x, y, rect.width, rect.height);
    v.forceDraw();
  }, axialToPixel(cell.q, cell.r, size));
}

/**
 * Highlighted cells, as [q, r], nearest `home` first, with the view centred
 * there so they are clear of the HUD (a castle on the map's edge is under
 * it otherwise). Only cells out of the Dark Lord's lair's reach, if any: a
 * new building has half its hit points until it stands, and mending comes
 * before raising it, so under the lair's fire a small crew never finishes.
 * @param {any} page
 * @param {{ q: number, r: number }} home
 */
async function spotsNear(page, home) {
  await page.waitForFunction(() => /** @type {any} */ (window).__vigame.highlights.length > 0);
  await lookAt(page, home);
  const keys = await page.evaluate(() => /** @type {any} */ (window).__vigame.highlights);
  const cells = keys.map((k) => k.split(',').map(Number))
    .sort(([q1, r1], [q2, r2]) => distance({ q: q1, r: r1 }, home) - distance({ q: q2, r: r2 }, home));
  const lair = (await buildings(page)).find((b) => b.type === 'lair');
  // Its reach counts from the edge of its seven cells.
  const reach = /** @type {{ reach: number }} */ (BUILDING_TYPES.lair.attack).reach + 1;
  const safe = lair ? cells.filter(([q, r]) => distance({ q, r }, lair) > reach) : cells;
  return safe.length ? safe : cells;
}

/**
 * Build with the Build buttons: pick the kind, then a highlighted cell near
 * `home`, then confirm its crew: the ones ticked, or the first `crew`.
 * @returns {Promise<any>} The new building.
 */
async function buildWith(page, kind, home, { touch = false, crew = undefined } = {}) {
  const before = (await buildings(page)).length;
  await press(page, `#build-${kind}`, { touch });
  const spot = await openCell(page, await spotsNear(page, home));
  await clickHex(page, spot.q, spot.r, { touch });
  await confirmCrew(page, { only: crew });
  await page.waitForFunction((n) => Object.keys(/** @type {any} */ (window).__vigame.view.buildings).length === n, before + 1);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__vigame.placing), null, 'out of build mode');
  return (await buildings(page)).find((b) => b.q === spot.q && b.r === spot.r);
}

/** Select a building by clicking it, in the middle of the view, unless it already is. */
async function selectBuilding(page, b, { touch = false } = {}) {
  if (await page.evaluate(() => /** @type {any} */ (window).__vigame.selected) === b.id) return;
  await lookAt(page, b);
  await clickHex(page, b.q, b.r, { touch });
  await page.waitForFunction((id) => /** @type {any} */ (window).__vigame.selected === id, b.id);
}

/**
 * Confirm the crew dialog, after ticking `add` more units than it came with,
 * or only the first `only`.
 * @returns {Promise<string>} The dialog's count, such as "3 of 20", when it opened.
 */
async function confirmCrew(page, { add = 0, only = undefined, shot = '' } = {}) {
  await page.waitForSelector('#crew[open]');
  const count = await text(page, '#crew-count');
  if (only !== undefined) {
    // The locator matches only ticked boxes, so untick the first until none are.
    const ticked = page.locator('#crew-list input:checked');
    while (await ticked.count()) await ticked.first().uncheck();
    add = only;
  }
  for (let i = 0; i < add; i++) await page.locator('#crew-list input:not(:checked):not(:disabled)').first().check();
  if (shot) await page.screenshot({ path: join(OUT, shot) });
  await page.click('#crew-ok');
  await page.waitForSelector('#crew', { state: 'hidden' });
  return count ?? '';
}

/** Give a building a crew of `n` units with the Crew button; they set off. */
async function crewWith(page, b, n) {
  await selectBuilding(page, b);
  await page.click('#crew-button');
  await confirmCrew(page, { add: n });
  await page.waitForFunction((id) => Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id || u.in === id), b.id);
}

/** RGB of the canvas pixel under page point (x, y). */
const pixelAt = (page, x, y) => page.evaluate(([x, y]) => {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  const d = canvas.getContext('2d').getImageData(Math.round((x - rect.left) * dpr), Math.round((y - rect.top) * dpr), 1, 1).data;
  return [d[0], d[1], d[2]];
}, [x, y]);

/**
 * What each open page shows, with a screenshot of it, so a failure on CI
 * says what the scenario was waiting for.
 */
async function report() {
  const lines = [];
  for (const [label, page] of openPages) {
    await page.screenshot({ path: join(OUT, `failed-${label}.png`) }).catch(() => {});
    const seen = await page.evaluate(() => {
      const v = /** @type {any} */ (window).__vigame;
      const text = (/** @type {string} */ id) => document.getElementById(id)?.textContent ?? '';
      return {
        time: text('time'),
        seat: text('seat'),
        viewers: text('viewers'),
        connected: v?.net?.connected(),
        tick: v?.view?.tick,
        marching: Object.values(v?.view?.units ?? {}).filter((u) => u.in === undefined),
        // Buildings going up or being upgraded, and how they're doing.
        works: Object.values(v?.view?.buildings ?? {}).filter((b) => b.raised !== undefined || b.upgrading !== undefined)
          .map(({ id, type, q, r, hp, raised, upgrading }) => ({ id, type, q, r, hp, raised, upgrading })),
      };
    }).catch((e) => String(e));
    lines.push(`${label} ${page.url()}\n    ${JSON.stringify(seen)}`);
  }
  return lines.join('\n');
}

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
 * @param {string} who The row's text, such as "Ann & —".
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
  await a.fill('#login-name', 'Ann');
  await a.fill('#login-answer', '99');
  await a.click('#login-submit');
  // The page swaps the used sum for "Loading…" as it says "not it", so the
  // next sum on screen is the new one, even when it reads the same.
  await a.waitForFunction(() => /not it/.test(document.getElementById('login-error')?.textContent ?? ''));
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
  await openFromLobby(b, 'open', 'Ann & —');
  await waitText(b, '#seat', 'Bēla · Crimson');
  await waitMatch(a, '#time', /^0:0[1-9]$/);

  // Ann builds a tower with a crew of six, who go to raise it; Bēla sees
  // them march, and Ann's pick. The rest stay home, for the pit below.
  const blue = await castleOf(a, 0);
  const tower = await buildWith(a, 'tower', blue, { crew: 6 });
  await b.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id], tower.id);
  await b.waitForFunction((id) => Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id && u.path?.length === 1), tower.id);
  await b.waitForFunction(({ q, r }) => /** @type {any} */ (window).__vigame.peers
    .some((p) => !p.isMe && p.sel && p.sel.q === q && p.sel.r === r), tower);
  if (full) {
    await frames(b);
    await b.screenshot({ path: join(OUT, 'game-crimson.png') });
  }
  await waitInside(b, tower.id, 1);
  // Every picture arrived, here and behind the proxy alike.
  await a.waitForFunction((n) => /** @type {any} */ (window).__vigame.tokens.images.size === n, PICTURES.length);
  if (!full) {
    for (const p of [a, b]) await p.context().close();
    return;
  }

  // Each castle is drawn in its side's colour: the cell below and left of its
  // centre is the castle's, and clear of its labels. The whole board first,
  // drawn: the canvas catches up on the next frame.
  await a.click('#recenter');
  await frames(a);
  const crimson = await castleOf(a, 1);
  const tint = async (c) => {
    const p = await hexPoint(a, c.q - 1, c.r + 1);
    return pixelAt(a, p.x, p.y);
  };
  const [br, , bb] = await tint(blue);
  const [cr, , cb] = await tint(crimson);
  assert.ok(bb > br + 25, `Blue's castle is not blue (${br}, ${bb})`);
  assert.ok(cr > cb + 25, `Crimson's castle is not red (${cr}, ${cb})`);

  // Effects, made up from the last update as if Crimson's castle was hit, a
  // tower fell and a unit died: they draw, then stop.
  const played = await a.evaluate(async () => {
    const g = /** @type {any} */ (window).__vigame;
    const view = g.view;
    const castle = Object.values(view.buildings).find((b) => b.type === 'castle' && b.owner === 1);
    const prev = {
      ...view,
      buildings: { ...view.buildings, ghost: { id: 'ghost', type: 'tower', owner: 1, grade: 1, hp: 0, q: castle.q - 3, r: castle.r + 2 } },
      units: { ...view.units, ghost: { id: 'ghost', owner: 0, name: 'Ghost', level: 1, q: castle.q - 3, r: castle.r } },
    };
    const next = { ...view, buildings: { ...view.buildings, [castle.id]: { ...castle, hp: castle.hp - 40 } } };
    g.effects.update(prev, next, performance.now());
    return g.effects.list.map((e) => e.kind).sort();
  });
  assert.deepEqual(played, ['death', 'fall', 'hit']);
  await a.waitForTimeout(100);
  await a.screenshot({ path: join(OUT, 'effects.png') });
  await a.waitForTimeout(1200);
  await frames(a);
  assert.equal(await a.evaluate(() => /** @type {any} */ (window).__vigame.effects.list.length), 0, 'effects did not stop');

  // Sounds: Ann's accepted build was heard, and Mute toggles them.
  const log = await a.evaluate(() => /** @type {any} */ (window).__vigame.sounds.log);
  assert.ok(log.includes('ok'), `no sound for an accepted command (heard: ${log.join(', ')})`);
  for (const muted of [true, false]) {
    await a.click('#mute-button');
    assert.equal(await a.evaluate(() => /** @type {any} */ (window).__vigame.sounds.muted), muted);
    assert.equal(await a.getAttribute('#mute-button', 'aria-pressed'), String(muted));
  }

  // A drag pans rather than clicks.
  const camBefore = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  await a.mouse.move(640, 420);
  await a.mouse.down();
  await a.mouse.move(700, 460, { steps: 5 });
  await a.mouse.up();
  const camAfter = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  assert.ok(Math.abs(camAfter.x - camBefore.x) > 10, 'drag did not pan');

  // Pressing the minimap's top left corner looks there. It repaints at most
  // twice a second.
  const map = /** @type {{ x: number, y: number }} */ (await a.locator('#minimap-canvas').boundingBox());
  await a.mouse.click(map.x + 4, map.y + 4);
  const camMap = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  assert.ok(camMap.x < camAfter.x - 10 && camMap.y < camAfter.y - 10, 'the minimap did not move the view');
  const { paints, seconds } = await a.evaluate(() => ({
    paints: /** @type {any} */ (window).__vigame.minimap.paints,
    seconds: performance.now() / 1000,
  }));
  assert.ok(paints >= 1 && paints <= seconds * 2 + 1, `the minimap repainted ${paints} times in ${seconds.toFixed(1)} s`);
  await a.click('#recenter');

  // Once her tower stands, Ann looks at its crew and upgrades it; Bēla sees it.
  await a.keyboard.press('Escape');
  await selectBuilding(a, tower);
  await waitMatch(a, '#selection', /^Tower \(grade 1\) · crew \d+\/\d+ · going up \d+%/);
  await a.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id].raised === undefined, tower.id, { timeout: 60000 });
  await crewWith(a, tower, 0);
  await waitMatch(a, '#selection', /^Tower \(grade 1\) · crew \d+\/\d+ · HP/);
  // The upgrade is work for the crew too.
  await a.click('#upgrade');
  await waitMatch(a, '#selection', /^Tower \(grade 1\) · crew \d+\/\d+ · upgrading \d+%/);
  await waitMatch(a, '#selection', /^Tower \(grade 2\)/, 60000);
  await b.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id].grade === 2, tower.id);

  // Building far from your own buildings is refused, and the page says why.
  await a.keyboard.press('Escape');
  await a.click('#recenter');
  await a.click('#build-tower');
  const far = await openCell(a, [[crimson.q, crimson.r + 2], [crimson.q, crimson.r - 2], [crimson.q + 2, crimson.r - 2]]);
  await clickHex(a, far.q, far.r);
  await waitText(a, '#message', "Can't build there: too far from your buildings.");
  assert.equal(await a.locator('#build-tower').getAttribute('aria-pressed'), 'true', 'still placing');
  await a.keyboard.press('Escape');

  // Ann digs a pit. Its crew is chosen as it goes down, with the best at
  // home ticked; they walk there and dig. Return sends them home.
  const count = (await buildings(a)).length;
  await a.click('#build-pit');
  // Near the castle: the crew walks two seconds a cell, four on scrub.
  const pitSpot = await openCell(a, await spotsNear(a, blue));
  await clickHex(a, pitSpot.q, pitSpot.r);
  assert.match(await confirmCrew(a, { shot: 'crew.png' }), /^[1-8] of 8$/, 'up to half of those at home are ticked');
  await a.waitForFunction((n) => Object.keys(/** @type {any} */ (window).__vigame.view.buildings).length === n, count + 1);
  const pit = (await buildings(a)).find((x) => x.type === 'pit');
  await a.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id].work > 0, pit.id, { timeout: 30000 });
  await selectBuilding(a, pit);
  await waitMatch(a, '#selection', /^Pit · crew \d+\/\d+ · depth 0\/\d+, \d+ stone · HP \d+\/\d+$/);
  await a.click('#return-button');
  await a.waitForFunction((id) => !Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id || u.in === id), pit.id);
  await a.keyboard.press('Escape');

  // A building gone while the page holds it: Ann starts another pit, aims
  // it, opens its crew chooser, and meanwhile (as from another tab) gives it
  // up. The page lets go of it all and says so.
  const site = await buildWith(a, 'pit', blue, { crew: 1 });
  await selectBuilding(a, site);
  await a.click('#attack-button');
  await a.click('#crew-button');
  await a.waitForSelector('#crew[open]');
  assert.deepEqual(await a.evaluate(() => /** @type {any} */ (window).__vigame.net.send({ type: 'abort', building: /** @type {any} */ (window).__vigame.crewTarget })), { ok: true });
  await a.waitForSelector('#crew', { state: 'hidden' });
  await waitText(a, '#message', 'Your pit is gone.');
  assert.deepEqual(await a.evaluate(() => {
    const v = /** @type {any} */ (window).__vigame;
    return [v.selected, v.aiming, v.crewTarget];
  }), [null, null, null], 'the page let go of the pit');

  // Bēla forms a band next to her castle (who goes is chosen as it forms),
  // then leads it; its members go along inside.
  const before = (await buildings(b)).length;
  await b.click('#build-band');
  await b.waitForFunction(() => /** @type {any} */ (window).__vigame.highlights.length > 0);
  const bandCells = await b.evaluate(() => /** @type {any} */ (window).__vigame.highlights);
  const bandSpot = await openCell(b, bandCells.map((k) => k.split(',').map(Number))
    .sort(([q1, r1], [q2, r2]) => distance({ q: q1, r: r1 }, crimson) - distance({ q: q2, r: r2 }, crimson)));
  await clickHex(b, bandSpot.q, bandSpot.r);
  await confirmCrew(b);
  await b.waitForFunction((n) => Object.keys(/** @type {any} */ (window).__vigame.view.buildings).length === n, before + 1);
  const wagon = (await buildings(b)).find((x) => x.type === 'band');
  await b.waitForFunction((id) => !Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id), wagon.id, { timeout: 30000 });
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
  await openFromLobby(b, 'mine', 'Ann & Bēla');
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
      minimap: box('minimap'),
      legendShown: getComputedStyle(document.getElementById('legend')).display !== 'none',
    };
  });
  assert.ok(await fits(), 'the game scrolls sideways on a phone');
  assert.ok(layout.controls.bottom <= layout.innerHeight && layout.controls.left >= 0
    && layout.controls.right <= layout.innerWidth, 'controls are off-screen');
  assert.ok(layout.controls.top > layout.status.bottom, 'controls overlap the status panel');
  assert.ok(layout.minimap.top > layout.status.bottom && layout.minimap.bottom < layout.controls.top
    && layout.minimap.right <= layout.innerWidth, 'the minimap overlaps the panels or the screen edge');
  assert.equal(layout.legendShown, false);

  const castle = await castleOf(page, 0);
  await selectBuilding(page, castle, { touch: true });
  // With no hover on a touch screen, the last tapped hex is the tile readout.
  assert.notEqual(await text(page, '#tile'), '—', 'tile readout cleared after a tap');
  await buildWith(page, 'tower', castle, { touch: true });
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
const only = process.argv[2] ?? '';
const scenarios = /** @type {Array<[string, () => Promise<void>]>} */ ([
  ['login, lobby and a game, three browsers', () => threeBrowsers(browser, games.url, { full: true, label: 'direct' })],
  ['the same under a subfolder, behind a proxy', () => threeBrowsers(browser, proxied.url, { full: false, label: 'proxied' })],
  ['on a phone', () => phone(browser, games.url)],
]).filter(([name]) => name.includes(only));

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
      console.log(`  ${(await report()).split('\n').join('\n  ')}`);
      for (const page of [...openPages.values()]) await page.context().close();
    }
  }
} finally {
  await browser.close();
  await proxied.close();
  await games.close();
}

console.log(`\n${scenarios.length - failed}/${scenarios.length} passed; screenshots in ${OUT}`);
process.exitCode = failed ? 1 : 0;
