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
import { playerId } from '../server/room.js';
import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { checkState, newGame } from '../src/core/game.js';
import { axialToPixel, distance } from '../src/core/hex.js';
import { GAME_NAMES } from '../src/core/names.js';
import { BUILDING_TYPES } from '../src/core/rules.js';
import { GROUND_PICTURES } from '../src/client/ground.js';
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

/** Wait for what is selected to read so: its lines, shown ones only, joined by " | ". */
const waitSelection = (page, pattern, timeout = 5000) => page.waitForFunction(
  (source) => new RegExp(source).test([...document.querySelectorAll('#selection > :not([hidden])')].map((e) => e.textContent).join(' | ')),
  pattern.source,
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
 * or only the first `only`, and pressing the order button `sort` if given;
 * with the button, or `key` if given.
 * @returns {Promise<string>} The dialog's count, such as "3 of 20", when it opened.
 */
async function confirmCrew(page, { add = 0, only = undefined, shot = '', key = '', sort = '' } = {}) {
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
  if (sort) await page.click(`#crew-sort [data-sort="${sort}"]`);
  // Enter or the letter that opened it confirms, as the button does (and
  // the chooser stays shut, though an order button has the focus).
  if (key) await page.keyboard.press(key);
  else await page.click('#crew-ok');
  await page.waitForSelector('#crew', { state: 'hidden' });
  return count ?? '';
}

/** Give a building a crew of `n` units with the Crew button; they set off. */
async function crewWith(page, b, n) {
  await selectBuilding(page, b);
  await page.click('#crew-button');
  await confirmCrew(page, { add: n, key: 'c', sort: 'level' });
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
        observers: text('observers'),
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

/**
 * How the game's buttons fit: those whose text overflows, each one's lines
 * of text (its key in the corner aside), the rows they make, and the
 * panel's width.
 * @param {import('playwright').Page} page
 */
const controlsFit = (page) => page.evaluate(() => {
  const range = document.createRange();
  const lines = (/** @type {Element} */ button) => {
    const bottoms = new Set();
    for (const node of button.childNodes) {
      if (node.nodeName === 'KBD') continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width) bottoms.add(Math.round(rect.bottom));
    }
    return bottoms.size;
  };
  const buttons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#controls :is(button, .button)')]).filter((b) => b.offsetParent);
  return {
    over: buttons.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.id),
    lines: Object.fromEntries(buttons.map((b) => [b.id, lines(b)])),
    rows: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
    width: Math.round(/** @type {HTMLElement} */ (document.getElementById('controls')).getBoundingClientRect().width),
  };
});

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
  // The banners above and below the form load, by relative addresses (so
  // under a subfolder too).
  await page.waitForFunction(() => {
    const banners = /** @type {HTMLImageElement[]} */ ([...document.querySelectorAll('#login .banner')]);
    return banners.length === 2 && banners.every((b) => b.complete && b.naturalWidth === 1040);
  });
  const question = await page.waitForFunction(() => {
    const m = /(\d+) \+ (\d+)\?/.exec(document.getElementById('login-question')?.textContent ?? '');
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
 * @param {string} list 'mine', 'open' or 'playing'
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
 * A finished game, saved as it ended: the lobby lists it under Recently
 * finished, and opening it shows its table of points, with the name of the
 * player who held the seat; the table closes, comes back from Scores, and
 * Leave the match goes back to the lobby.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 */
async function finished(browser, url) {
  const page = await newPlayer(browser, url, 'finished', 'Fay');
  await inLobby(page);
  const token = await page.evaluate(() => localStorage.getItem('vigame.token'));
  const seed = 5;
  const board = createBoard({ ...BOARD_OPTIONS, seed, players: 1 });
  const state = newGame(board, { mode: 'coop' });
  // Won at 15 minutes: a quick win, the winners' points twice over.
  Object.assign(state, { tick: 9000, over: 9000, winner: 0 });
  state.players[1].lost = 9000;
  Object.assign(state.players[0].tally, { kills: 120, damage: 43210, castles: 1, born: 9, stone: 30, food: 25, built: 3, upgrades: 2, won: 1 });
  Object.assign(state.players[1].tally, { kills: 5, damage: 800 });
  assert.deepEqual(checkState(board, state), []);
  games.storage.createGame({ id: 'finished-game', seed, state, seats: [playerId(/** @type {string} */ (token))] });

  // Recently finished starts folded away.
  assert.equal(await page.locator('#lobby-done-section[open]').count(), 0);
  await page.click('#lobby-done-section summary');
  const row = page.locator('#lobby-done li', { hasText: 'Fay' });
  await row.waitFor({ timeout: 10000 });
  await row.locator('a').click();
  await inGame(page);
  await page.waitForSelector('#scores[open]');
  assert.equal(await text(page, '#scores-title'), 'You won');
  assert.equal(await text(page, '#scores-outcome'), '15:00 · Blue won · quick win: points ×2');
  // The side, its total and bonus first, then the lines, the weightiest first.
  assert.deepEqual(await page.$$eval('#scores-head th', (ths) => ths.map((th) => th.textContent)),
    ['Side', 'Total', 'Bonus', 'Win', 'Castles', 'Felled', 'Kills', 'Damage', 'Upgrades', 'Built', 'Born', 'Stone', 'Food']);
  // Fay: (1200 + 4321 + 500 + 45 + 30 + 2 + 60 + 100 + 500) × 2 = 13516, shown as 14k with the
  // exact points in its tooltip; the Dark Lord: 50 + 80, no bonus.
  await page.waitForFunction(() => document.querySelector('#scores-body tr td')?.textContent === 'Fay · Blue');
  const rows = await page.$$eval('#scores-body tr', (trs) => trs.map((tr) => [...tr.cells].slice(0, 4).map((td) => td.textContent)));
  assert.deepEqual(rows, [['Fay · Blue', '14k', '×2', '500'], ['Dark Lord', '130', '', '0']]);
  assert.equal(await page.getAttribute('#scores-body tr td.total', 'title'), '13516');
  // Every column in view on a desktop, and Keep watching has the focus.
  const fitsTable = (/** @type {import('playwright').Page} */ p) => p.$eval('#scores .scores-wrap', (w) => w.scrollWidth <= w.clientWidth);
  assert.ok(await fitsTable(page), 'the table of points scrolls on a desktop');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'scores-close');
  await page.screenshot({ path: join(OUT, 'scores.png') });

  // A viewer in Russian sees the table in Russian.
  const ru = await newPlayer(browser, url, 'finished-ru', 'Фая', { viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });
  await inLobby(ru);
  await ru.goto(`${url}?game=finished-game`);
  await inGame(ru);
  await ru.waitForSelector('#scores[open]');
  assert.equal(await text(ru, '#scores-title'), 'Игра окончена');
  assert.equal(await text(ru, '#scores-outcome'), '15:00 · победили Синие · быстрая победа: очки ×2');
  await ru.waitForFunction(() => document.querySelector('#scores-body tr td')?.textContent === 'Fay · Синие');
  assert.deepEqual(await ru.$$eval('#scores-head th', (ths) => ths.slice(0, 4).map((th) => th.textContent)), ['Сторона', 'Всего', 'Бонус', 'Победа']);
  assert.equal(await text(ru, '#scores-leave'), 'Покинуть матч');
  assert.ok(await fitsTable(ru), 'the Russian table of points scrolls on a desktop');
  await ru.screenshot({ path: join(OUT, 'scores-ru.png') });
  await ru.context().close();

  await page.click('#scores-close');
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__vigame.scoresOpen), false);
  assert.equal(await page.locator('#seat-button').isHidden(), true, 'no seat to give up once it is over');
  await page.click('#scores-button');
  await page.waitForSelector('#scores[open]');
  await page.click('#scores-leave');
  await inLobby(page);
  await page.context().close();
}

/**
 * Ann's settings, from the lobby and back: a name with a symbol is refused,
 * a new name and language are kept, then she puts hers back; Back changes
 * nothing. The page is in the language chosen, or the one Auto stands for,
 * and turns as either changes; so is the lobby.
 * @param {import('playwright').Page} a
 * @param {{ full: boolean }} options
 */
async function settings(a, { full }) {
  const open = async () => {
    await a.click('#lobby-settings');
    await a.waitForSelector('#settings:not([hidden])');
    assert.match(new URL(a.url()).search, /^\?settings$/);
  };
  const saved = async (name) => {
    await a.click('#settings-save');
    await inLobby(a);
    await waitText(a, '#lobby-name', name);
    assert.equal(new URL(a.url()).search, '', 'the address is the lobby again');
  };
  const lang = () => a.evaluate(() => document.documentElement.lang);
  await open();
  assert.equal(await a.inputValue('#settings-name'), 'Ann');
  assert.equal(await a.inputValue('#settings-language'), 'auto');
  await waitText(a, '#settings-language option[value="auto"]', 'Auto (English)');
  await waitText(a, '#settings-title', 'Settings');
  await a.fill('#settings-name', 'Ann \u{1F642}');
  await a.click('#settings-save');
  await waitMatch(a, '#settings-error', /letters or digits/);
  // Once signed in, Auto puts the name first: a name in Cyrillic letters
  // turns the page Russian, error and all.
  await a.fill('#settings-name', 'Анна');
  await waitText(a, '#settings-language option[value="auto"]', 'Авто (Русский)');
  await waitText(a, '#settings-title', 'Настройки');
  await waitText(a, '#settings-save', 'Сохранить');
  await waitMatch(a, '#settings-error', /букв или цифр/);
  assert.equal(await lang(), 'ru');
  // Choosing English turns it back, whatever the name.
  await a.selectOption('#settings-language', 'en');
  await waitText(a, '#settings-title', 'Settings');
  await a.selectOption('#settings-language', 'ru');
  await saved('Анна');
  // The lobby is in Russian now, How to play and About too.
  assert.equal(await lang(), 'ru');
  await waitText(a, '#lobby-new', 'Новая игра');
  await waitText(a, '#lobby-settings', 'Настройки');
  await waitText(a, '#lobby-mine-section h2 [data-word]', 'Ваши игры');
  await waitText(a, '#lobby-mode option[value="ffa"]', 'Все против всех: каждый сам за себя');
  await waitText(a, '#lobby-mode option[value="veryEasy"]', 'Очень Лёгкий Лорд: как Общий Лёгкий, и юниты плодятся вдвое быстрее');
  await a.click('#lobby-how-section summary');
  await a.click('#lobby-about-section summary');
  assert.equal(await a.locator('#lobby-how-section [lang="ru"]').isVisible(), true);
  assert.equal(await a.locator('#lobby-how-section [lang="en"]').isVisible(), false);
  assert.ok(await a.locator('#lobby-about-section [lang="ru"] a[href="https://github.com/Andrejs4/vigame"]').isVisible(), 'the Russian About links the source');
  if (full) await a.screenshot({ path: join(OUT, 'lobby-ru.png'), fullPage: true });
  await a.click('#lobby-how-section summary');
  await a.click('#lobby-about-section summary');

  await open();
  assert.equal(await a.inputValue('#settings-name'), 'Анна');
  assert.equal(await a.inputValue('#settings-language'), 'ru');
  await waitText(a, '#settings-back', 'Назад');
  if (full) await a.screenshot({ path: join(OUT, 'settings.png') });
  await a.fill('#settings-name', 'Ann');
  await waitText(a, '#settings-title', 'Настройки');
  await a.selectOption('#settings-language', 'auto');
  await waitText(a, '#settings-title', 'Settings');
  if (full) await a.screenshot({ path: join(OUT, 'settings-en.png') });
  await saved('Ann');
  assert.equal(await lang(), 'en', 'the lobby is in English again');
  await waitText(a, '#lobby-new', 'New game');

  await open();
  assert.equal(await a.inputValue('#settings-language'), 'auto');
  await a.fill('#settings-name', 'Nobody');
  await a.click('#settings-back');
  await inLobby(a);
  await waitText(a, '#lobby-name', 'Ann');
}

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
  await a.waitForFunction(() => [...document.querySelectorAll('#login .banner')].every((b) => /** @type {HTMLImageElement} */ (b).complete));
  if (full) await a.screenshot({ path: join(OUT, 'login.png') });
  // The name field says what it is for. The language is Auto at first,
  // which says what it stands for: on the login page the browser comes
  // first, so English here, even for a name in Cyrillic letters.
  assert.equal(await a.getAttribute('#login-name', 'placeholder'), 'Visible name (15)');
  assert.equal(await a.inputValue('#login-language'), 'auto');
  await waitText(a, '#login-language option[value="auto"]', 'Auto (English)');
  await a.fill('#login-name', 'Анна');
  await waitText(a, '#login-language option[value="auto"]', 'Auto (English)');
  await waitText(a, '#login-submit', 'Play');
  // Choosing Russian turns the page Russian at once, and Auto turns it back.
  await a.selectOption('#login-language', 'ru');
  await waitText(a, '#login-submit', 'Играть');
  await waitMatch(a, '#login-question', /^Сколько будет \d+ \+ \d+\?$/);
  assert.equal(await a.getAttribute('#login-name', 'placeholder'), 'Имя в игре (15)');
  await waitText(a, '#login-language option[value="auto"]', 'Авто (English)');
  assert.equal(await a.evaluate(() => document.documentElement.lang), 'ru');
  if (full) await a.screenshot({ path: join(OUT, 'login-ru.png') });
  await a.selectOption('#login-language', 'auto');
  await waitText(a, '#login-submit', 'Play');
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
  assert.equal(await a.evaluate(() => document.documentElement.lang), 'en', 'the lobby is in English');
  await a.waitForSelector('#lobby-mine-empty:not([hidden])');
  if (full) await a.screenshot({ path: join(OUT, 'lobby.png') });
  // Under the lists, How to play and About, folded at first; About links
  // the source code. Opened, then folded again as they were.
  assert.equal(await a.locator('#lobby-how-section[open], #lobby-about-section[open]').count(), 0, 'How to play and About start folded');
  await a.click('#lobby-how-section summary');
  await a.click('#lobby-about-section summary');
  // The tab's icon, by a relative address, so under a subfolder too.
  assert.equal(await a.evaluate(async () => {
    const res = await fetch(/** @type {HTMLLinkElement} */ (document.querySelector('link[rel=icon]')).href);
    return `${res.status} ${res.headers.get('content-type')}`;
  }), '200 image/png', 'the icon loads');
  assert.ok(await a.locator('#lobby-about-section [lang="en"] a[href="https://github.com/Andrejs4/vigame"]').isVisible(), 'About links the source');
  assert.equal(await a.locator('#lobby-about-section [lang="ru"]').isVisible(), false, 'only the English About shows');
  if (full) await a.screenshot({ path: join(OUT, 'lobby-about.png'), fullPage: true });
  await a.click('#lobby-how-section summary');
  await a.click('#lobby-about-section summary');
  await settings(a, { full });
  assert.equal(await a.inputValue('#lobby-players'), '1', 'one player against the Dark Lord by default');
  await a.selectOption('#lobby-players', '2');
  await a.click('#lobby-new');
  await inGame(a);
  const link = a.url();
  assert.match(link, /\?game=[\w-]+$/);
  await waitText(a, '#seat', 'Ann · Blue');
  // Alone of two, and the Players line blinks while the game waits.
  await waitText(a, '#players', '1/2');
  assert.equal(await a.locator('#players.waiting').count(), 1, 'Players does not blink while waiting');
  // She started it, so she could start it without Bēla; she waits.
  await waitText(a, '#start-button', 'Start');
  // Recenter looks at her own castle, close enough to read unit counts.
  const home = await a.evaluate(() => {
    const v = /** @type {any} */ (window).__vigame;
    return Object.values(v.view.buildings).find((b) => b.type === 'castle' && b.owner === 0);
  });
  await a.click('#recenter');
  const centre = await hexPoint(a, home.q, home.r);
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await a.locator('#board').boundingBox());
  assert.ok(Math.abs(centre.x - (box.x + box.width / 2)) < 2 && Math.abs(centre.y - (box.y + box.height / 2)) < 2, 'Recenter did not centre on her castle');
  assert.ok(await a.evaluate(() => /** @type {any} */ (window).__vigame.camera.zoom) > 0.45, 'Recenter is too far out to show unit counts');
  await waitText(a, '#time', '0:00 · paused');
  assert.equal(await a.locator('#build-tower').isDisabled(), true);

  // The game starts with one of the preset names. Ann renames it while she
  // waits: a name with a symbol is refused on the page, a good one is tidied
  // and taken, and the tab's title follows.
  const named = await text(a, '#game-name');
  assert.ok(GAME_NAMES.includes(named ?? ''), `"${named}" is not a preset name`);
  const rename = `${label === 'direct' ? 'Friday' : 'Sunday'} fight`;
  await a.click('#rename-button');
  await a.waitForSelector('#rename[open]');
  await a.fill('#rename-input', 'Ann & co');
  await a.keyboard.press('Enter');
  await waitMatch(a, '#rename-error', /letters, digits and spaces/);
  await a.fill('#rename-input', `  ${rename.replace(' ', '   ')} `);
  await a.keyboard.press('Enter');
  await a.waitForSelector('#rename', { state: 'hidden' });
  await waitText(a, '#game-name', rename);
  assert.equal(await a.title(), `${rename} · Vigame`);

  // Bēla logs in and finds the game in the lobby by its name, waiting for her.
  const b = await newPlayer(browser, url, `${label}-b`, 'Bēla');
  await inLobby(b);
  await b.locator('#lobby-open li', { hasText: rename }).first().waitFor({ timeout: 10000 });
  if (full) await b.screenshot({ path: join(OUT, 'lobby-games.png') });
  await openFromLobby(b, 'open', 'Ann & —');
  await waitText(b, '#seat', 'Bēla · Crimson');
  await waitMatch(a, '#time', /^0:0[1-9]$/);
  assert.equal(await a.locator('#start-button').isVisible(), false, 'nobody missing, nothing to start');
  assert.equal(await b.locator('#start-button').isVisible(), false, 'Start is the creator\'s');

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
  await a.waitForFunction((n) => /** @type {any} */ (window).__vigame.ground.images.size === n, GROUND_PICTURES.length);
  if (!full) {
    for (const p of [a, b]) await p.context().close();
    return;
  }

  // Each castle is drawn in its side's colour: the cell below and left of its
  // centre is the castle's, and clear of its labels. Each in view, drawn:
  // the canvas catches up on the next frame.
  const crimson = await castleOf(a, 1);
  const tint = async (c) => {
    await lookAt(a, c);
    await frames(a);
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
  // The game page has no legend: How to play and About are in the lobby.
  assert.equal(await a.locator('#legend, #how-to-play').count(), 0, 'no legend in the game');

  // A drag pans rather than clicks.
  const camBefore = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  await a.mouse.move(640, 420);
  await a.mouse.down();
  await a.mouse.move(700, 460, { steps: 5 });
  await a.mouse.up();
  const camAfter = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  assert.ok(Math.abs(camAfter.x - camBefore.x) > 10, 'drag did not pan');
  // A click whose hand wobbles a few pixels is still a click, and the board
  // holds still.
  const wobbled = await castleOf(a, 0);
  await lookAt(a, wobbled);
  await a.keyboard.press('Escape');
  await a.waitForFunction(() => /** @type {any} */ (window).__vigame.selected === null);
  const camStill = await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera }));
  const at = await hexPoint(a, wobbled.q, wobbled.r);
  await a.mouse.move(at.x, at.y);
  await a.mouse.down();
  await a.mouse.move(at.x + 3, at.y + 2);
  await a.mouse.move(at.x - 2, at.y + 4);
  await a.mouse.up();
  await a.waitForFunction((id) => /** @type {any} */ (window).__vigame.selected === id, wobbled.id);
  assert.deepEqual(await a.evaluate(() => ({ .../** @type {any} */ (window).__vigame.camera })), camStill, 'a wobbling click moved the board');

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
  // What is selected shows its type's picture, and its lines: what it is,
  // its crew and work, its HP.
  await waitSelection(a, /^Tower \(grade 1\) \| crew \d+\/\d+ · going up\s+\d+%/);
  assert.equal(await a.getAttribute('#selection-picture', 'data-picture'), 'tower');
  await a.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id].raised === undefined, tower.id, { timeout: 60000 });
  await crewWith(a, tower, 0);
  await waitSelection(a, /^Tower \(grade 1\) \| crew \d+\/\d+ \| HP \d+\/\d+$/);
  // Each control on show (but the zoom's signs), each stock and what is
  // selected have a picture, which loads from the address the page's style
  // gives it (under a subfolder too).
  const pictures = await a.$$eval('#controls :is(button, .button):not(#zoom-in, #zoom-out), .stock .figure, #selection-picture', (els) => els
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const before = getComputedStyle(el, '::before');
      return { id: el.id || el.className, mask: before.getPropertyValue('mask-image') || before.getPropertyValue('-webkit-mask-image') };
    }));
  assert.ok(pictures.length >= 18, `only ${pictures.length} pictures`);
  for (const { id, mask } of pictures) assert.match(mask, /^url\(".+\.svg"\)$/, `${id} has no picture`);
  const loaded = await a.evaluate((urls) => Promise.all(urls.map((u) => fetch(u).then((r) => r.ok && /svg/.test(r.headers.get('content-type') ?? '')))),
    pictures.map(({ mask }) => /** @type {string} */ (/^url\("(.+)"\)$/.exec(mask)?.[1])));
  pictures.forEach(({ id }, i) => assert.ok(loaded[i], `${id}'s picture doesn't load`));
  // Each button with a key shows its letter in bold.
  assert.deepEqual(await a.$$eval('#controls button[aria-keyshortcuts]', (els) => els.map((el) => el.querySelector('b')?.textContent)),
    ['T', 'W', 'P', 'F', 'B', 'U', 'C', 'H', 'A']);
  // The upgrade is work for the crew too. U upgrades, as the button does.
  await a.keyboard.press('u');
  await waitSelection(a, /^Tower \(grade 1\) \| crew \d+\/\d+ · upgrading\s+\d+%/);
  await waitSelection(a, /^Tower \(grade 2\)/, 60000);
  await b.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id].grade === 2, tower.id);

  // Short of dark metal, W says so at once, before any cell or crew is chosen.
  await a.keyboard.press('w');
  await waitText(a, '#message', "Can't build a wagon: not enough dark metal.");
  assert.equal(await a.locator('#build-wagon').getAttribute('aria-pressed'), 'false', 'not placing a wagon');

  // Building far from your own buildings is refused, and the page says why.
  await a.keyboard.press('Escape');
  await lookAt(a, crimson);
  await a.keyboard.press('t');
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
  // Ticked: the best at home, up to half of them, three at most while 20
  // or fewer are home, one while fewer than 8; as the chooser found them.
  await a.waitForSelector('#crew[open]');
  const atHome = await a.$$eval('#crew-list .where', (els) => els.filter((e) => e.textContent === 'at home').length);
  const ticks = Math.min(8, Math.floor(atHome / 2), atHome < 8 ? 1 : atHome <= 20 ? 3 : 8);
  assert.equal(await confirmCrew(a, { shot: 'crew.png', key: 'p' }), `${ticks} of 8`, `${atHome} at home`);
  await a.waitForFunction((n) => Object.keys(/** @type {any} */ (window).__vigame.view.buildings).length === n, count + 1);
  const pit = (await buildings(a)).find((x) => x.type === 'pit');
  await a.waitForFunction((id) => /** @type {any} */ (window).__vigame.view.buildings[id].work > 0, pit.id, { timeout: 30000 });
  await selectBuilding(a, pit);
  await waitSelection(a, /^Pit \| crew \d+\/\d+ · depth 0\/\d+, \d+ stone \| HP \d+\/\d+$/);
  // Stone from 60 and dark metal from 30 show in bold: enough to spend.
  for (const [id, from] of [['stone', 60], ['metal', 30]]) {
    const [shown, bold] = await a.$eval(`#${id}`, (el) => [Number(el.textContent), el.classList.contains('marked')]);
    assert.equal(bold, shown >= from, `${id} ${shown} is ${bold ? '' : 'not '}bold`);
  }
  await a.click('#return-button');
  await a.waitForFunction((id) => !Object.values(/** @type {any} */ (window).__vigame.view.units)
    .some((u) => u.to === id || u.in === id), pit.id);
  await a.keyboard.press('Escape');

  // A building gone while the page holds it: Ann starts another pit, aims
  // it, opens its crew chooser, and meanwhile (as from another tab) gives it
  // up. The page lets go of it all and says so.
  const site = await buildWith(a, 'pit', blue, { crew: 1 });
  await selectBuilding(a, site);
  await a.keyboard.press('a');
  assert.equal(await a.evaluate(() => /** @type {any} */ (window).__vigame.aiming), site.id, 'A aims, as Attack does');
  await a.keyboard.press('c');
  await a.waitForSelector('#crew[open]');
  // Each unit shows its age; a mouse drag down the list ticks each row it crosses.
  assert.match(await a.locator('#crew-list .stats').first().textContent() ?? '', /· \d+m$/);
  // Each has a portrait beside its two lines, no taller than they are: a
  // hero's face, and a silhouette for the rest.
  const crewFaces = await a.$$eval('#crew-list label', (els) => els.map((label) => {
    const box = (/** @type {string} */ s) => /** @type {Element} */ (label.querySelector(s)).getBoundingClientRect();
    const u = /** @type {any} */ (window).__vigame.view.units[/** @type {HTMLInputElement} */ (label.querySelector('input')).value];
    return {
      face: box('.portrait').height,
      text: box('.where').bottom - box('.name').top,
      hero: u ? Boolean(u.hero) : null,
      cut: /** @type {Element} */ (label.querySelector('.portrait')).classList.contains('face'),
    };
  }));
  for (const { face, text, hero, cut } of crewFaces) {
    assert.ok(face > 0 && face <= text, `a portrait ${face}px tall beside ${text}px of text`);
    if (hero !== null) assert.equal(cut, hero, 'a face for a hero, a silhouette for the rest');
  }
  assert.equal(await text(a, '#crew-count'), '1 of 8');
  const ids = await a.$$eval('#crew-list input:not(:checked)', (els) => els.slice(0, 3).map((e) => /** @type {HTMLInputElement} */ (e).value));
  const rowOf = (/** @type {string} */ id) => a.locator(`#crew-list input[value="${id}"]`).locator('xpath=..').boundingBox();
  const first = /** @type {{ x: number, y: number, height: number }} */ (await rowOf(ids[0]));
  const last = /** @type {{ x: number, y: number, height: number }} */ (await rowOf(ids[2]));
  await a.mouse.move(first.x + 30, first.y + first.height / 2);
  await a.mouse.down();
  await a.mouse.move(last.x + 30, last.y + last.height / 2, { steps: 10 });
  await a.mouse.up();
  const ticked = await a.$$eval('#crew-list input:checked', (els) => els.map((e) => /** @type {HTMLInputElement} */ (e).value));
  assert.ok(ids.every((id) => ticked.includes(id)), `the drag ticked ${ticked} rather than ${ids}`);
  assert.equal(await text(a, '#crew-count'), '4 of 8');
  // Ordered by level, then by nearness to the pit, the rows move and the
  // same units stay ticked.
  const tickedIds = () => a.$$eval('#crew-list input:checked', (els) => els.map((e) => /** @type {HTMLInputElement} */ (e).value).sort());
  const tickedBefore = await tickedIds();
  // A pit wants building: its button says so, and puts the best builders first.
  assert.equal(await text(a, '#crew-sort-skill'), 'Building');
  await a.click('#crew-sort-skill');
  const skills = await a.$$eval('#crew-list .stats', (els) => els.map((e) => Number(/· Building (\d+) ·/.exec(e.textContent ?? '')?.[1])));
  assert.deepEqual(skills, [...skills].sort((x, y) => y - x), 'best builders first');
  // Heroes first, their ages in gold. The list holds the units there were
  // as it opened, so each row is checked against its own unit: one born
  // since isn't in it, and one gone since is skipped.
  await a.click('#crew-sort [data-sort="hero"]');
  const rows = await a.$$eval('#crew-list label', (els) => els.map((e) => ({
    id: /** @type {HTMLInputElement} */ (e.querySelector('input')).value,
    marked: Boolean(e.querySelector('.stats .hero')),
  })));
  const heroes = rows.map((row) => row.marked);
  assert.deepEqual(heroes, [...heroes].sort((x, y) => Number(y) - Number(x)), 'heroes first');
  const isHero = await a.evaluate((ids) => ids.map((id) => {
    const u = /** @type {any} */ (window).__vigame.view.units[id];
    return u ? Boolean(u.hero) : null;
  }), rows.map((row) => row.id));
  rows.forEach((row, i) => {
    if (isHero[i] !== null) assert.equal(row.marked, isHero[i], `unit ${row.id} marked as a hero is`);
  });
  await a.click('#crew-sort [data-sort="level"]');
  const levels = await a.$$eval('#crew-list .stats', (els) => els.map((e) => Number(/^Lv (\d+)/.exec(e.textContent ?? '')?.[1])));
  assert.deepEqual(levels, [...levels].sort((x, y) => y - x), 'highest level first');
  await a.click('#crew-sort [data-sort="near"]');
  // Where each was as the list opened, which is what it orders by: those on
  // the move have gone on since.
  const reach = await a.$$eval('#crew-list input', (els) => {
    const v = /** @type {any} */ (window).__vigame;
    const then = v.crewView;
    const site = then.buildings[v.crewTarget];
    return els.map((e) => {
      const u = then.units[/** @type {HTMLInputElement} */ (e).value];
      const at = (u.in && then.buildings[u.in]) || u;
      return (Math.abs(at.q - site.q) + Math.abs(at.r - site.r) + Math.abs(at.q + at.r - site.q - site.r)) / 2;
    });
  });
  assert.deepEqual(reach, [...reach].sort((x, y) => x - y), 'closest first');
  assert.equal(await a.getAttribute('#crew-sort [data-sort="near"]', 'aria-pressed'), 'true');
  assert.deepEqual(await tickedIds(), tickedBefore, 'the ticks stay');
  assert.deepEqual(await a.evaluate(() => /** @type {any} */ (window).__vigame.net.send({ type: 'abort', building: /** @type {any} */ (window).__vigame.crewTarget })), { ok: true });
  await a.waitForSelector('#crew', { state: 'hidden' });
  await waitText(a, '#message', 'Your pit is gone.');
  assert.deepEqual(await a.evaluate(() => {
    const v = /** @type {any} */ (window).__vigame;
    return [v.selected, v.aiming, v.crewTarget];
  }), [null, null, null], 'the page let go of the pit');

  // Her castle has no crew: Heroes takes the button's place, listing her
  // heroes alive now, highest level first, with every skill's level. H
  // closes it again, and it stays closed.
  await selectBuilding(a, await castleOf(a, 0));
  assert.ok(await a.isHidden('#crew-button'), 'no Crew for a castle');
  // Units are born meanwhile: those there before it opened must be in it.
  const opened = await a.evaluate(() => /** @type {any} */ (window).__vigame.view.tick);
  await a.keyboard.press('h');
  await a.waitForSelector('#heroes[open]');
  const listed = await a.$$eval('#heroes-list li:not(.none):not(.fallen)', (els) => els.map((e) => ({
    id: /** @type {HTMLElement} */ (e).dataset.unit,
    level: Number(/^Lv *(\d+) · \d+m$/.exec(e.querySelector('.stats')?.textContent ?? '')?.[1]),
    skills: e.querySelector('.skills')?.textContent ?? '',
  })));
  // Each listed unit is a hero of hers (unless gone since), and each of
  // hers born before it opened is listed.
  const heroIds = listed.map((h) => h.id);
  const { fits, earlier } = await a.evaluate(({ tick, ids }) => {
    const units = /** @type {any} */ (window).__vigame.view.units;
    return {
      fits: ids.map((id) => (units[id] ? units[id].owner === 0 && Boolean(units[id].hero) : null)),
      earlier: Object.values(units).filter((u) => u.owner === 0 && u.hero && u.born <= tick).map((u) => u.id),
    };
  }, { tick: opened, ids: heroIds });
  assert.ok(fits.every((fit) => fit !== false), `only her heroes listed: ${heroIds}`);
  assert.ok(earlier.every((id) => heroIds.includes(id)), `every hero of hers listed: ${earlier} in ${heroIds}`);
  if (!heroIds.length) assert.equal(await a.locator('#heroes-list .none').count(), 1, 'none yet, it says');
  assert.deepEqual(listed.map((h) => h.level), listed.map((h) => h.level).sort((x, y) => y - x), 'highest level first');
  // Each hero has its face beside its three lines, which doesn't make the
  // row any taller: it is no taller than the lines, and leaves them their
  // width, so the skills still fit on one.
  const heroRows = await a.$$eval('#heroes-list li:not(.none)', (els) => els.map((li) => {
    const box = (/** @type {string} */ s) => /** @type {Element} */ (li.querySelector(s)).getBoundingClientRect();
    const tops = [...li.querySelectorAll('.skills span')].map((s) => s.getBoundingClientRect().top);
    return {
      face: box('.portrait').height,
      text: box('.skills').bottom - box('.name').top,
      skillLines: new Set(tops).size,
      cut: /** @type {Element} */ (li.querySelector('.portrait')).classList.contains('face'),
    };
  }));
  for (const { face, text, skillLines, cut } of heroRows) {
    assert.ok(face > 0 && face <= text, `a portrait ${face}px tall beside ${text}px of text`);
    assert.equal(skillLines, 1, 'the skills fit on one line');
    assert.ok(cut, "a hero's portrait is a face");
  }
  // Both sheets of faces load, from the addresses the page's style gives them.
  assert.deepEqual(await a.evaluate(() => Promise.all(['men', 'women'].map((sheet) => {
    const span = document.createElement('span');
    span.className = `portrait face ${sheet}`;
    document.body.append(span);
    const url = /url\("?(.*?)"?\)/.exec(getComputedStyle(span).backgroundImage)?.[1] ?? '';
    span.remove();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth);
      img.onerror = () => resolve(0);
      img.src = url;
    });
  }))), [256, 256], 'both sheets of faces load');
  // Each level takes three places, "Lv  8" to "Lv100", so the skills line up.
  const skillLine = new RegExp(`^${['Att', 'Mel', 'Bld', 'Frm', 'Brd', 'Run'].map((s) => `${s} Lv[ \\d]{2}\\d`).join('')}$`);
  for (const { skills } of listed) assert.match(skills, skillLine);
  await a.screenshot({ path: join(OUT, 'heroes.png') });
  // A hero the page saw die goes below the living, as last seen: how long
  // it lived in silver, and how it died where it would be. (One is made up
  // here, from one of her units: nobody dies this early in the game.)
  await a.evaluate(() => {
    const v = /** @type {any} */ (window).__vigame;
    const u = Object.values(v.view.units).find((x) => x.owner === 0);
    v.fallen.push({ ...u, id: 'gone', name: 'Fulk Gage', hero: true, born: 0, died: 6000, how: 'combat' });
  });
  // H shuts the list, and H at once opens it again. Shut, the list keeps
  // the focus until the next frame, and must leave the key to the page:
  // both keys go in one task here, so no frame comes between.
  assert.ok(await a.evaluate(() => {
    const list = /** @type {HTMLDialogElement} */ (document.getElementById('heroes'));
    const h = () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
    h();
    const shut = !list.open;
    h();
    return shut && list.open;
  }), 'H shuts the heroes list, and H right away opens it again');
  await a.waitForSelector('#heroes[open]');
  assert.deepEqual(await a.$eval('#heroes-list li:last-child', (li) => ({
    fallen: li.classList.contains('fallen'),
    name: li.querySelector('.name')?.textContent,
    age: li.querySelector('.stats .fallen')?.textContent,
    silver: getComputedStyle(/** @type {Element} */ (li.querySelector('.stats .fallen'))).color,
    where: li.querySelector('.where')?.textContent,
  })), { fallen: true, name: 'Fulk Gage', age: '10m', silver: 'rgb(201, 209, 217)', where: 'died in combat' });
  assert.match(await text(a, '#heroes-count'), / · 1 fallen$/);
  await a.screenshot({ path: join(OUT, 'heroes-fallen.png') });
  await a.keyboard.press('h');
  await a.waitForSelector('#heroes', { state: 'hidden', timeout: 3000 });
  await a.evaluate(() => /** @type {any} */ (window).__vigame.fallen.pop());
  await a.keyboard.press('Escape');

  // Bēla forms a band next to her castle (who goes is chosen as it forms),
  // then leads it; its members go along inside.
  const before = (await buildings(b)).length;
  await b.click('#build-band');
  await b.waitForFunction(() => /** @type {any} */ (window).__vigame.highlights.length > 0);
  const bandCells = await b.evaluate(() => /** @type {any} */ (window).__vigame.highlights);
  const bandSpot = await openCell(b, bandCells.map((k) => k.split(',').map(Number))
    .sort(([q1, r1], [q2, r2]) => distance({ q: q1, r: r1 }, crimson) - distance({ q: q2, r: r2 }, crimson)));
  await clickHex(b, bandSpot.q, bandSpot.r);
  // A band wants ranged attack, with close combat beside it.
  await b.waitForSelector('#crew[open]');
  assert.equal(await text(b, '#crew-sort-skill'), 'Attack');
  assert.match(await b.locator('#crew-list .stats').first().textContent() ?? '', /· Ranged attack \d+ ·/);
  assert.match(await b.locator('#crew-list .where').first().textContent() ?? '', /· Close combat \d+$/);
  await confirmCrew(b, { key: 'Enter' });
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
    // Somewhere to its left, to see its picture turn that way.
    return v.board.list
      .filter((t) => t.passable && !v.occ.buildingAt.has(`${t.q},${t.r}`) && d(t) === 2 && t.q + t.r / 2 < w.q + w.r / 2)
      .map((t) => [t.q, t.r]);
  }, wagon);
  const dest = await openCell(b, goal);
  await clickHex(b, dest.q, dest.r);
  // Going left, its picture is mirrored, on the other side's page too.
  await a.waitForFunction((id) => {
    const v = /** @type {any} */ (window).__vigame;
    const w = v.view.buildings[id];
    const next = w?.path?.[0];
    return Boolean(next) && next[0] - w.q + (next[1] - w.r) / 2 < 0 && v.facingLeft.includes(id);
  }, wagon.id, { timeout: 6000 });
  await a.waitForFunction(({ id, q, r }) => {
    const w = /** @type {any} */ (window).__vigame.view.buildings[id];
    return w.q !== q || w.r !== r;
  }, wagon, { timeout: 6000 });
  assert.equal(await insideOf(a, wagon.id), riders, 'the units rode along');
  await frames(a);
  await a.screenshot({ path: join(OUT, 'game-blue.png') });
  // Each Build button's tooltip is play help, then the price, its numbers
  // from the rules.
  assert.equal(await a.getAttribute('#build-tower', 'title'),
    'Tower (T). Defends, striking from 5 cells away, the farthest of all; no strike reaches those inside. Cost: 60 stone.');
  assert.equal(await a.getAttribute('#build-band', 'title'),
    'Band (B). Up to 80 units moving together, with no cover: every strike reaches them. Cost: free.');

  // Bēla steps away, so the game pauses with her band still on its way:
  // Ann's board then stands still, and is not redrawn frame after frame.
  const gameUrl = b.url();
  await b.goto('about:blank');
  await waitMatch(a, '#time', /paused/);
  await a.waitForTimeout(300);
  const stillFrom = await a.evaluate(() => /** @type {any} */ (window).__vigame.draws);
  await a.waitForTimeout(500);
  const redrawn = await a.evaluate(() => /** @type {any} */ (window).__vigame.draws) - stillFrom;
  assert.ok(redrawn <= 1, `a paused board was redrawn ${redrawn} times in half a second`);

  // Bēla comes back: same seat, same game, no login. Then she goes to the
  // lobby, finds the game among hers, and opens it again.
  await b.goto(gameUrl);
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
  await waitText(a, '#observers', '1');
  await waitText(a, '#players', '2/2');
  assert.equal(await a.locator('#players.waiting').count(), 0, 'Players still blinks with everyone here');
  assert.equal(await c.locator('#build-tower').isDisabled(), true);

  // A link to a game that doesn't exist lands in the lobby, which says so.
  // (Chromium logs the refused join request itself as a console error, and
  // below, the refused New game.)
  const lost = await newPlayer(browser, `${url}?game=nope`, `${label}-lost`, 'Lou', undefined, /^Failed to load resource: .* (521|409)\b/);
  await inLobby(lost);
  await waitText(lost, '#lobby-notice', 'There is no game at that address.');
  assert.equal(new URL(lost.url()).search, '', 'the address is the lobby again');
  // Lou leaves three games of his waiting for a player; New game then says
  // so, and lists them to go back to.
  await lost.evaluate(async () => {
    const token = localStorage.getItem('vigame.token');
    for (let i = 0; i < 3; i++) {
      const res = await fetch('api/games', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, players: 2 }),
      });
      if (res.status !== 201) throw new Error(`game ${i}: ${res.status}`);
    }
  });
  await lost.click('#lobby-new');
  await waitMatch(lost, '#lobby-limit-text', /^You have 3 games of yours waiting for a player\./);
  assert.equal(await lost.locator('#lobby-limit-games li a', { hasText: 'Join' }).count(), 3);
  if (label === 'direct') await lost.screenshot({ path: join(OUT, 'lobby-limit.png') });
  // Nobody else plays them, so each has Delete; Lou deletes the first, after
  // confirming, and the lobby says so.
  assert.equal(await lost.locator('#lobby-limit-games li button', { hasText: 'Delete' }).count(), 3);
  lost.once('dialog', (dialog) => dialog.accept());
  await lost.locator('#lobby-limit-games li button', { hasText: 'Delete' }).first().click();
  await waitMatch(lost, '#lobby-notice', /^Deleted “.+”\.$/);
  assert.equal(await lost.locator('#lobby-limit').isHidden(), true);
  assert.equal(new URL(lost.url()).search, '', 'still in the lobby');
  // Lou finds Ann and Bēla's game among those under way, folded away until
  // opened, and watches it from there.
  assert.equal(await lost.locator('#lobby-playing-section[open]').count(), 0);
  await lost.click('#lobby-playing-section summary');
  await openFromLobby(lost, 'playing', 'Ann & Bēla');
  await waitText(lost, '#seat', 'Lou · Spectator');

  for (const p of [a, b, c, lost]) await p.context().close();
}

/**
 * Latvian on a phone and Finnish on a desktop, each by its browser: the
 * login page, the lobby, and a game's buttons, their bold keys and their fit.
 * @param {import('playwright').Browser} browser
 * @param {string} url
 */
async function latvianFinnish(browser, url) {
  const lv = await openPage(browser, 'latvian', { ...PHONE, locale: 'lv-LV' });
  await lv.goto(url);
  await lv.waitForSelector('#login:not([hidden])');
  await waitText(lv, '#login-submit', 'Spēlēt');
  await waitText(lv, '#login-language option[value="auto"]', 'Auto (Latviešu)');
  await logIn(lv, 'Līga', { touch: true });
  await inLobby(lv);
  await waitText(lv, '#lobby-new', 'Jauna spēle');
  await waitText(lv, '#lobby-mode option[value="coop"]', 'Sadarbība: kopā pret Tumšo Kungu');
  assert.equal(await lv.evaluate(() => document.documentElement.lang), 'lv');
  assert.equal(await lv.locator('#lobby-how-section [lang="lv"]').count(), 1);
  // A Very Easy Lord game: one stock for both, and castles raise units twice as fast.
  await lv.selectOption('#lobby-mode', 'veryEasy');
  assert.equal(await lv.locator('#lobby-mode option:checked').textContent(), 'Ļoti Vieglais Kungs: kā Kopīgais Vieglais, un vienības vairojas divreiz ātrāk');
  await lv.screenshot({ path: join(OUT, 'lobby-lv.png') });
  await lv.selectOption('#lobby-players', '2');
  await lv.tap('#lobby-new');
  await inGame(lv);
  assert.equal(await lv.evaluate(() => /** @type {any} */ (window).__vigame.view.mode), 'veryEasy');
  const fi = await newPlayer(browser, lv.url(), 'finnish', 'Aino', { viewport: { width: 1280, height: 800 }, locale: 'fi-FI' });
  await inGame(fi);
  await waitMatch(lv, '#time', /^0:0[1-9]$/);

  // Each key's letter in bold (on the phone, not bold), every label fitting.
  const bold = (/** @type {import('playwright').Page} */ page) => page.$$eval('#controls button[aria-keyshortcuts]', (els) => els.map((el) => el.querySelector('b')?.textContent));
  assert.equal(await lv.locator('#build-tower').innerText(), 'Tornis\n60');
  assert.equal(await lv.locator('#seat-button').innerText(), 'Atlaist');
  assert.deepEqual(await bold(lv), ['T', 'R', 'e', 'F', 'B', 'U', 'K', 'V', 'A']);
  const lvFit = await controlsFit(lv);
  assert.deepEqual(lvFit.over, [], 'a Latvian label overflows its button');
  assert.ok(Object.values(lvFit.lines).every((n) => n <= 2) && lvFit.rows <= 3, `Latvian buttons: ${JSON.stringify(lvFit)}`);
  await lv.screenshot({ path: join(OUT, 'game-lv-phone.png') });

  assert.equal(await fi.locator('#build-farm').innerText(), 'Farmi · 30');
  assert.equal(await fi.getAttribute('#build-farm', 'title'),
    'Farmi (F). Kasvattaa ruokaa. Heikko: puolet siihen osuvista iskuista osuu sisällä oleviin. Hinta: 30 kiveä.');
  assert.deepEqual(await bold(fi), ['T', 'V', 'p', 'F', 'J', 'K', 'R', 'S', 'y']);
  const fiFit = await controlsFit(fi);
  assert.deepEqual(fiFit.over, [], 'a Finnish label overflows its button');
  assert.ok(Object.values(fiFit.lines).every((n) => n === 1) && fiFit.width <= 200, `Finnish buttons: ${JSON.stringify(fiFit)}`);
  await fi.screenshot({ path: join(OUT, 'game-fi.png') });
  // Its keys, and the English ones too (B is Joukko's). (Vaunu, a wagon,
  // wants dark metal the side hasn't got.)
  for (const [key, id] of [['f', 'build-farm'], ['j', 'build-band'], ['p', 'build-pit'], ['b', 'build-band']]) {
    await fi.keyboard.press(key);
    assert.equal(await fi.getAttribute(`#${id}`, 'aria-pressed'), 'true', `${key} doesn't press ${id}`);
    await fi.keyboard.press('Escape');
  }
  for (const p of [lv, fi]) await p.context().close();
}

/**
 * A game for sixteen, which its creator starts with one other player
 * there: the other fourteen are away, and the Dark Lord is as strong as
 * for eight.
 */
async function sixteen(browser, url) {
  const page = await newPlayer(browser, url, 'sixteen', 'Sven');
  await inLobby(page);
  await page.selectOption('#lobby-players', '16');
  await page.click('#lobby-new');
  await inGame(page);
  await waitText(page, '#players', '1/16');
  const other = await newPlayer(browser, page.url(), 'sixteen-b', 'Tove');
  await inGame(other);
  await waitText(other, '#seat', 'Tove · Crimson');
  await waitText(page, '#start-button', 'Start');
  assert.equal(await other.locator('#start-button').isVisible(), false, 'Start is the creator\'s');
  assert.equal(await page.locator('#time').textContent(), '0:00 · paused');
  await page.locator('#status').screenshot({ path: join(OUT, 'start-button.png') });

  await page.click('#start-button');
  await waitMatch(page, '#time', /^0:0[1-9]$/);
  await waitText(page, '#players', '2/16, 14 away');
  assert.equal(await page.locator('#start-button').isVisible(), false);
  const view = await page.evaluate(() => /** @type {any} */ (window).__vigame.view);
  assert.equal(view.players.filter((/** @type {any} */ p) => p.away).length, 14);
  assert.equal(Object.values(view.buildings).filter((/** @type {any} */ b) => b.type === 'castle').length, 16);
  assert.equal(/** @type {any} */ (Object.values(view.buildings).find((/** @type {any} */ b) => b.type === 'lair')).hp, 4 * BUILDING_TYPES.lair.hp, 'the Dark Lord as strong as for eight');
  // The whole ring of castles, each side in its own colour.
  for (let i = 0; i < 6; i++) await page.click('#zoom-out');
  await frames(page);
  await page.screenshot({ path: join(OUT, 'game-sixteen.png') });
  // Close up, each cell shows a picture of its ground.
  await page.waitForFunction((n) => /** @type {any} */ (window).__vigame.ground.images.size === n, GROUND_PICTURES.length);
  await page.click('#recenter');
  for (let i = 0; i < 12; i++) await page.click('#zoom-in');
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__vigame.camera.zoom), 2.5, 'not at the closest zoom');
  await frames(page);
  await page.screenshot({ path: join(OUT, 'ground.png') });
  for (const p of [page, other]) await p.context().close();
}

/** The login page, the lobby, settings and a Shared Easy Lord game on a phone, with a desktop teammate. */
async function phone(browser, url) {
  // A browser in Russian: the login page is in Russian, and Auto stands
  // for Russian, even for a name in Latin letters.
  const page = await openPage(browser, 'phone', { ...PHONE, locale: 'ru-RU' });
  await page.goto(url);
  await page.waitForSelector('#login:not([hidden])');
  await waitText(page, '#login-submit', 'Играть');
  await waitMatch(page, '#login-question', /^Сколько будет \d+ \+ \d+\?$/);
  await waitText(page, '#login-language option[value="auto"]', 'Авто (Русский)');
  await page.screenshot({ path: join(OUT, 'login-phone.png') });
  await logIn(page, 'Pia', { touch: true });
  await inLobby(page);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await waitText(page, '#lobby-new', 'Новая игра');
  assert.ok(await fits(), 'the lobby scrolls sideways on a phone');
  await page.screenshot({ path: join(OUT, 'lobby-phone.png') });
  await page.tap('#lobby-settings');
  await page.waitForSelector('#settings:not([hidden])');
  await waitText(page, '#settings-language option[value="auto"]', 'Авто (Русский)');
  await waitText(page, '#settings-title', 'Настройки');
  assert.ok(await fits(), 'the settings page scrolls sideways on a phone');
  await page.tap('#settings-back');
  await inLobby(page);
  await page.selectOption('#lobby-mode', 'shared');
  await page.selectOption('#lobby-players', '2');
  await page.tap('#lobby-new');
  await inGame(page);
  // Oli's browser is in Russian too, on a desktop.
  const other = await newPlayer(browser, page.url(), 'phone-opponent', 'Oli', { viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });
  await inGame(other);
  await waitMatch(page, '#time', /^0:0[1-9]$/);
  // Shared Easy Lord: both see the team's stock, both starts' stone together.
  for (const p of [page, other]) {
    await waitText(p, '#stone-label', 'Общ. камень');
    await waitText(p, '#stone', '400');
  }

  const layout = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
    return {
      innerWidth,
      innerHeight,
      status: box('status'),
      tactics: box('tactics'),
      controls: box('controls'),
      minimap: box('minimap'),
    };
  });
  assert.ok(await fits(), 'the game scrolls sideways on a phone');
  assert.ok(layout.controls.bottom <= layout.innerHeight && layout.controls.left >= 0
    && layout.controls.right <= layout.innerWidth, 'controls are off-screen');
  assert.ok(layout.controls.top > layout.status.bottom, 'controls overlap the status panel');
  assert.ok(layout.tactics.top > layout.status.bottom && layout.tactics.bottom < layout.controls.top
    && layout.tactics.left >= 0 && layout.tactics.right <= layout.innerWidth, 'the stock and selection overlap the panels or the screen edge');
  assert.ok(layout.minimap.top > layout.status.bottom && layout.minimap.bottom < layout.tactics.top
    && layout.minimap.right <= layout.innerWidth, 'the minimap overlaps the panels or the screen edge');

  // The status panel folds to its header, and the minimap hides by the arrow
  // in the stock panel's corner, which stays to bring it back.
  const statusHeight = () => page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById('status')).offsetHeight);
  const unfolded = await statusHeight();
  await page.tap('#status-toggle');
  assert.equal(await page.locator('#status-body').isHidden(), true, 'the status panel does not fold');
  assert.equal(await page.getAttribute('#status-toggle', 'aria-expanded'), 'false');
  assert.ok(await statusHeight() < unfolded / 3, 'the folded status panel is still tall');
  await page.tap('#minimap-toggle');
  assert.equal(await page.locator('#minimap').isHidden(), true, 'the minimap does not hide');
  assert.equal(await page.locator('#minimap-toggle').isVisible(), true, 'the minimap\'s arrow went with it');
  assert.equal(await page.getAttribute('#minimap-toggle', 'title'), 'Показать миникарту (M)');
  await frames(page);
  await page.screenshot({ path: join(OUT, 'phone-folded.png') });
  await page.tap('#status-toggle');
  await page.tap('#minimap-toggle');
  assert.equal(await page.locator('#status-body').isVisible(), true);
  assert.equal(await page.locator('#minimap').isVisible(), true);
  assert.equal(await statusHeight(), unfolded);

  const castle = await castleOf(page, 0);
  await selectBuilding(page, castle, { touch: true });
  // With no hover on a touch screen, the last tapped hex is the tile readout.
  assert.notEqual(await text(page, '#tile'), '—', 'tile readout cleared after a tap');

  // The buttons in Russian, each key's letter in bold. On the phone a price
  // is on its own line; every label fits its button in two lines at most, in
  // three rows, as in English (Воз, Яма and Апгрейд keep the first row).
  await waitMatch(page, '#upgrade', /^Апгрейд · \d+$/);
  assert.equal(await page.locator('#build-tower').innerText(), 'Башня\n60');
  assert.equal(await page.locator('#build-band').innerText(), 'Отряд');
  assert.equal(await page.locator('#heroes-button').innerText(), 'Герои…');
  assert.equal(await page.locator('#seat-button').innerText(), 'Отпусти');
  assert.deepEqual(await page.$$eval('#controls button[aria-keyshortcuts]', (els) => els.map((el) => el.querySelector('b')?.textContent)),
    ['Б', 'В', 'Я', 'а', 'О', 'г', 'д', 'р', 'т']);
  // A phone has no keys, so the letters aren't bold there.
  assert.ok(await page.$$eval('#controls button b', (els) => els.every((b) => getComputedStyle(b).fontWeight === getComputedStyle(/** @type {Element} */ (b.parentElement)).fontWeight)),
    'key letters are bold on a phone');
  const phoneFit = await controlsFit(page);
  assert.deepEqual(phoneFit.over, [], 'a button\'s label overflows it on a phone');
  assert.ok(Object.values(phoneFit.lines).every((n) => n <= 2), `a label takes three lines on a phone: ${JSON.stringify(phoneFit.lines)}`);
  assert.ok(phoneFit.rows <= 3, `the buttons take ${phoneFit.rows} rows on a phone`);
  // Once a castle falls, the seat button offers a new base: it fits as well
  // (put in its place for one measure, as no castle falls here).
  const newBase = await page.evaluate(() => {
    const button = /** @type {HTMLElement} */ (document.getElementById('seat-button'));
    const label = button.textContent;
    button.textContent = 'Новая база';
    const range = document.createRange();
    range.selectNodeContents(button);
    const lines = new Set([...range.getClientRects()].filter((r) => r.width).map((r) => Math.round(r.bottom))).size;
    const rows = new Set([...document.querySelectorAll('#controls :is(button, .button)')]
      .filter((b) => /** @type {HTMLElement} */ (b).offsetParent).map((b) => Math.round(b.getBoundingClientRect().top))).size;
    const over = button.scrollWidth > button.clientWidth + 1;
    button.textContent = label;
    return { lines, rows, over };
  });
  assert.deepEqual(newBase, { lines: newBase.lines, rows: phoneFit.rows, over: false }, 'New base does not fit on a phone');
  assert.ok(newBase.lines <= 2, `New base takes ${newBase.lines} lines on a phone`);
  // On a desktop each label keeps to one line, its key in bold, and the
  // tooltips are in Russian.
  assert.equal(await other.locator('#build-tower').innerText(), 'Башня · 60');
  assert.equal(await other.$eval('#build-tower b', (b) => Number(getComputedStyle(b).fontWeight) > 500), true, 'key letters are not bold on a desktop');
  assert.equal(await other.getAttribute('#build-tower', 'title'),
    'Башня (Б). Защита: бьёт на 5 клеток, дальше всех; удары не достают тех, кто внутри. Цена: 60 камней.');
  assert.equal(await other.getAttribute('#build-wagon', 'title'),
    'Воз (В). Едет и везёт до 15; удары их не достают. Цена: 15 тёмного металла, возле вашего замка.');
  assert.match(await other.getAttribute('#build-pit', 'title') ?? '', /^Яма \(Я\)\. Добывает камень\. .+\. Цена: \+1% к голоду/);
  await waitText(other, '#controls .group-label', 'Строить');
  const desktopFit = await controlsFit(other);
  assert.deepEqual(desktopFit.over, [], 'a button\'s label overflows it on a desktop');
  assert.ok(Object.values(desktopFit.lines).every((n) => n === 1), `a label wraps on a desktop: ${JSON.stringify(desktopFit.lines)}`);
  assert.ok(desktopFit.width <= 200, `the buttons' panel is ${desktopFit.width} px wide`);
  await other.screenshot({ path: join(OUT, 'game-ru.png') });
  // M hides the minimap and shows it again, also where it types "ь"; this
  // browser keeps the choice.
  await other.keyboard.press('m');
  assert.equal(await other.locator('#minimap').isHidden(), true, 'M does not hide the minimap');
  assert.equal(await other.evaluate(() => JSON.parse(localStorage.getItem('vigame.folded') ?? '{}').minimap), true, 'the choice is not kept');
  await other.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'ь', code: 'KeyM', bubbles: true })));
  assert.equal(await other.locator('#minimap').isVisible(), true, 'M on a Russian keyboard does not show the minimap');
  // Б picks Башня whichever layout the keyboard is set to (Б is the comma
  // key), and so does the English T; А (the F key) picks Ферма.
  for (const [key, code, id] of [['б', 'Comma', 'build-tower'], [',', 'Comma', 'build-tower'], ['е', 'KeyT', 'build-tower'],
    ['t', 'KeyT', 'build-tower'], ['а', 'KeyF', 'build-farm']]) {
    await other.evaluate(([key, code]) => dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true })), [key, code]);
    assert.equal(await other.getAttribute(`#${id}`, 'aria-pressed'), 'true', `${key} (${code}) doesn't press ${id}`);
    await other.keyboard.press('Escape');
    assert.equal(await other.getAttribute(`#${id}`, 'aria-pressed'), 'false');
  }
  // The panels and the crew and heroes dialogs are in Russian too.
  assert.deepEqual(await other.$$eval('#status dt', (els) => els.map((el) => el.textContent)),
    ['Игра', 'Время', 'Вы', 'Игроки', 'Юниты', 'Клетка', 'Зрители']);
  await waitText(other, '#seat', 'Oli · Багровые');
  const crimson = await castleOf(other, 1);
  await selectBuilding(other, crimson);
  await waitSelection(other, /^Замок \(ур\. 1\) \| \d+\/40 дома · новый юнит\s+\d+% \| Прочность \d+\/\d+$/);
  await other.click('#heroes-button');
  await other.waitForSelector('#heroes[open]');
  assert.equal(await text(other, '#heroes-title'), 'Герои');
  assert.match(await text(other, '#heroes-hint') ?? '', /^Сначала высший уровень, потом павшие\. Att стрельба · Mel ближний бой · /);
  assert.match(await text(other, '#heroes-count') ?? '', /^\d+ геро(й|я|ев) из \d+$/);
  await other.screenshot({ path: join(OUT, 'heroes-ru.png') });
  await other.click('#heroes button[value="close"]');
  await other.click('#build-tower');
  const spot = await openCell(other, await spotsNear(other, crimson));
  await clickHex(other, spot.q, spot.r);
  await other.waitForSelector('#crew[open]');
  assert.equal(await text(other, '#crew-title'), 'Стройка: Башня');
  assert.equal(await text(other, '#crew-hint'), 'До 20; отмечены лучшие для этой работы из тех, кто дома.');
  assert.equal(await text(other, '#crew-sort-skill'), 'Атака');
  assert.match(await text(other, '#crew-count') ?? '', /^\d+ из 20$/);
  await other.screenshot({ path: join(OUT, 'crew-ru.png') });
  await other.click('#crew-cancel');
  await other.keyboard.press('Escape');

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
  ['Latvian on a phone, Finnish on a desktop', () => latvianFinnish(browser, games.url)],
  ['a finished game\'s points', () => finished(browser, games.url)],
  ['sixteen players, started without the missing', () => sixteen(browser, games.url)],
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
