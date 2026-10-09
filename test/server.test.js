/**
 * The game server end to end: a real server on a free port, real Colyseus
 * clients, an in-memory database. One server for the whole file, because
 * Colyseus keeps its matchmaker in module state, one per process. Its clock
 * runs ten times faster than a real game's, so tests don't wait on seconds.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { matchMaker } from '@colyseus/core';
import { Client } from '@colyseus/sdk';

import { IDLE_MS, clearing, startGameServer, tooManyGames } from '../server/app.js';
import { playerId, replay, restoreGame } from '../server/room.js';
import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { advance, castleOf, checkState, nearStanding, newGame, occupancy, publicView } from '../src/core/game.js';
import { key } from '../src/core/hex.js';
import { GAME_NAMES } from '../src/core/names.js';
import { createServerNet } from '../src/client/net.js';
import { BUILDING_TYPES, END_ANYONE_TICKS, END_IDLE_MS, NPC, TICKS_PER_SECOND } from '../src/core/rules.js';

/** @type {Awaited<ReturnType<typeof startGameServer>>} */
let server;
/** @type {string} */
let base;
/** Messages Colyseus would otherwise print, such as a write that fails on purpose. */
const logged = [];
const MONITOR_PASSWORD = 'test-monitor-password';
const TICK_RATE = 10 * TICKS_PER_SECOND;

const TOKENS = { a: 'a'.repeat(32), b: 'b'.repeat(32), c: 'c'.repeat(32) };
const NAMES = { a: 'Ann', b: 'Bēla', c: 'Cai' };

before(async () => {
  const quiet = (...args) => { logged.push(args.join(' ')); };
  server = await startGameServer({
    port: 0,
    monitorPassword: MONITOR_PASSWORD,
    tickRate: TICK_RATE,
    // These tests start many games for one player; test/limit.test.js keeps the limit.
    gamesPerPlayer: Infinity,
    logger: { debug() {}, info() {}, trace() {}, warn: quiet, error: quiet },
  });
  base = server.url.replace(/\/$/, '');
  // The test players have signed in; the sign-in itself has its own tests.
  for (const [who, token] of Object.entries(TOKENS)) server.storage.savePlayer(playerId(token), NAMES[who]);
});

after(() => server.close());

/**
 * POST JSON, the way the page does.
 * @param {string} path
 * @param {unknown} body
 */
function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

/** Start a game for two over HTTP, the way the page does. */
async function startGame() {
  const res = await post('/api/games', { token: TOKENS.a, players: 2 });
  assert.equal(res.status, 201);
  return /** @type {string} */ ((await res.json()).id);
}

test('a player may start a game unless three of theirs wait for a player, or they sit in three under way', () => {
  const now = 1e12;
  const game = (/** @type {string} */ id, /** @type {string | null} */ creator, /** @type {Array<string | null>} */ seats) => ({ id, creator, seats, updatedAt: now - 1000 });
  const mine = [game('w1', 'p', ['p', null]), game('w2', 'p', [null, null]), game('s1', 'q', ['q', 'p'])];
  const tooManyGamesNow = (/** @type {ReturnType<typeof game>[]} */ games, /** @type {string} */ pid, /** @type {number} */ limit) => tooManyGames(games, pid, limit, now);
  assert.equal(tooManyGamesNow(mine, 'p', 3), null, 'two waiting, two seats');
  assert.equal(tooManyGamesNow([...mine, { ...game('w3', 'p', [null]), updatedAt: now - IDLE_MS }], 'p', 3), null, 'one idle for days does not count');
  assert.equal(tooManyGamesNow([...mine, { ...game('w3', 'p', ['q', null]), fallen: [1] }], 'p', 3), null, 'nor one whose free seat has fallen');
  const waiting = tooManyGamesNow([...mine, game('w3', 'p', [null])], 'p', 3);
  assert.deepEqual(waiting?.games.map((g) => g.id), ['w1', 'w2', 'w3']);
  assert.match(waiting?.error ?? '', /^You have 3 games of yours waiting for a player\./);
  assert.deepEqual([waiting?.waiting, waiting?.seated], [3, 0], 'how many, for the page to say in its words');
  const seated = tooManyGamesNow([...mine, game('s2', 'q', ['p', 'q'])], 'p', 3);
  assert.deepEqual(seated?.games.map((g) => g.id), ['w1', 's1', 's2'], 'the games they sit in');
  assert.match(seated?.error ?? '', /^You have a seat in 3 games under way\./);
  assert.deepEqual([seated?.waiting, seated?.seated], [0, 3]);
  const both = tooManyGamesNow([...mine, game('w3', 'p', ['p'])].map((g) => (g.id === 'w3' ? { ...g, seats: ['p', null] } : g)), 'p', 3);
  assert.deepEqual(both?.games.map((g) => g.id), ['w1', 'w2', 's1', 'w3']);
  assert.match(both?.error ?? '', /waiting for a player, and a seat in 3 games/);
  assert.deepEqual([both?.waiting, both?.seated], [3, 3]);
  // What each can do with one: delete their own that nobody else plays, else leave it.
  assert.deepEqual(['w1', 'w2', 's1'].map((id) => clearing(/** @type {any} */ (mine.find((g) => g.id === id)), 'p')), ['delete', 'delete', 'leave']);
  assert.equal(clearing(game('x', 'p', ['p', 'q']), 'p'), 'leave', 'someone else plays it');
  assert.equal(clearing(game('x', 'p', ['q', null]), 'p'), null, 'started, but not sitting in, a game someone plays');
});

/** A sign-in challenge, and its answer. */
async function challenge() {
  const res = await fetch(`${base}/api/challenge`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { id, question } = await res.json();
  const [, a, b] = /^(\d+) \+ (\d+)$/.exec(question) ?? [];
  return { id, answer: Number(a) + Number(b) };
}

/**
 * Join a game as the player with this token.
 * @param {string} gameId
 * @param {string} token
 */
async function join(gameId, token) {
  const room = await new Client(base).joinOrCreate('game', { gameId, token });
  await until(() => seen(room).seed !== undefined);
  return room;
}

/** Poll until `check` holds, or fail after `ms`. */
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${check}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * The game as a client sees it: the room state's JSON strings parsed back
 * into the core's view.
 * @param {any} room
 */
function seen(room) {
  const s = room.state.toJSON();
  const parse = (/** @type {Record<string, string>} */ m) => Object.fromEntries(
    Object.entries(m ?? {}).map(([k, v]) => [k, JSON.parse(v)]),
  );
  return { ...parse(s.fields), buildings: parse(s.buildings), units: parse(s.units), running: s.running };
}

/**
 * Give a command as the player in this room.
 * @param {any} room
 * @param {unknown} command
 */
const give = (room, command) => room.request('command', command);

/** Whether a request was refused, and why. */
async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return /** @type {any} */ (e).reason ?? /** @type {any} */ (e).message;
  }
}

async function leaveAll(...rooms) {
  await Promise.all(rooms.map((r) => r.leave()));
}

/**
 * Wait until a room has been disposed, so the next join has to load its game
 * from the database.
 * @param {string} roomId
 */
async function roomClosed(roomId) {
  const end = Date.now() + 3000;
  while ((await matchMaker.query({ name: 'game' })).some((r) => r.roomId === roomId)) {
    if (Date.now() > end) throw new Error(`room ${roomId} never closed`);
    await sleep(20);
  }
}

/**
 * A cell where side 0 may build, in a view of the game.
 * @param {any} view
 */
function buildSpot(view) {
  const board = createBoard({ ...BOARD_OPTIONS, seed: view.seed });
  const taken = occupancy(view).buildingAt;
  const tile = board.list.find((t) => t.buildable && !taken.has(key(t.q, t.r)) && nearStanding(view, 0, t));
  assert.ok(tile);
  return { q: tile.q, r: tile.r };
}

/** Both players in a new game, with the clock running. */
async function twoPlayers() {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  await until(() => seen(a).running && seen(b).running);
  return { id, a, b };
}

// --- HTTP ------------------------------------------------------------------

test('the server serves the page and its modules, all by relative addresses', async () => {
  const html = await (await fetch(`${base}/`)).text();
  // Relative, so a proxy can serve the game under a subfolder.
  assert.match(html, /<script src="vendor\/colyseus\.js"><\/script>\n<script type="module" src="client\/main\.js"><\/script>/);
  assert.doesNotMatch(html, /(src|href)="\//, 'no root-relative addresses');

  for (const path of ['/client/main.js', '/client/play.js', '/core/game.js', '/vendor/colyseus.js']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', /javascript/, path);
  }
  assert.equal((await fetch(`${base}/client/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/client/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/core/../../server/app.js`)).status, 404, 'only src/ is served');
  assert.ok([403, 404].includes((await fetch(`${base}/core/%2e%2e/%2e%2e/package.json`)).status));
});

test('a big game\'s whole state fits the encoder\'s buffer, without the overflow warning', async () => {
  // A game of two with 150 units a side at home: about 43 KB, well past
  // Colyseus's default of 16 KB.
  const seed = 11;
  const board = createBoard({ ...BOARD_OPTIONS, seed, players: 2 });
  const state = newGame(board, { mode: 'coop' });
  for (const u of Object.values(state.units)) {
    for (let i = 0; i < 12; i++) {
      const id = `u${state.nextId++}`;
      state.units[id] = { ...u, id };
    }
  }
  assert.deepEqual(checkState(board, state), []);
  server.storage.createGame({ id: 'big-game', seed, state, seats: [null, null] });

  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const room = await join('big-game', TOKENS.a);
    assert.equal(Object.keys(seen(room).units).length, Object.keys(state.units).length, 'every unit arrived');
    await leaveAll(room);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings.filter((w) => /buffer overflow/.test(w)), []);
});

test('a game\'s seats are listed by name, for those who have left too', async () => {
  const id = await startGame();
  const room = await join(id, TOKENS.a);
  await leaveAll(room);
  const seats = await (await fetch(`${base}/api/games/${id}/seats`)).json();
  assert.deepEqual(seats.map((/** @type {any} */ s) => s?.name ?? null), ['Ann', null]);
  assert.equal((await fetch(`${base}/api/games/nope/seats`)).status, 404);
});

test('new games are stored with a castle per side, and listed; unknown ones are 404', async () => {
  const id = await startGame();
  const game = await (await fetch(`${base}/api/games/${id}`)).json();
  assert.equal(game.id, id);
  assert.deepEqual(game.seats, [null, null]);
  assert.equal(game.seq, 0);
  assert.equal(game.state.tick, 0);
  assert.deepEqual(Object.values(game.state.buildings).map((b) => [b.owner, b.type]), [[0, 'castle'], [1, 'castle'], [2, 'lair']]);

  const lobby = await (await fetch(`${base}/api/games`)).json();
  assert.deepEqual(lobby.find((g) => g.id === id)?.seats, [null, null]);
  assert.equal(lobby.find((g) => g.id === id)?.mode, 'coop');
  const alone = await post('/api/games', { token: TOKENS.a });
  assert.equal(alone.status, 201);
  assert.deepEqual((await (await fetch(`${base}/api/games/${(await alone.json()).id}`)).json()).seats, [null], 'one player by default');
  const ffa = await post('/api/games', { token: TOKENS.a, mode: 'ffa', players: 2 });
  assert.equal(ffa.status, 201);
  const ffaGame = await (await fetch(`${base}/api/games/${(await ffa.json()).id}`)).json();
  assert.equal(ffaGame.state.mode, 'ffa');
  const easy = await post('/api/games', { token: TOKENS.a, mode: 'easy' });
  assert.equal(easy.status, 201);
  const easyGame = await (await fetch(`${base}/api/games/${(await easy.json()).id}`)).json();
  assert.deepEqual([easyGame.state.mode, easyGame.seats.length], ['easy', 1], 'Easy Lord, one player by default');
  const fast = await post('/api/games', { token: TOKENS.a, mode: 'shared', breeding: 'fast', players: 2 });
  assert.equal(fast.status, 201);
  const fastId = (await fast.json()).id;
  const fastState = (await (await fetch(`${base}/api/games/${fastId}`)).json()).state;
  assert.deepEqual([fastState.mode, fastState.breeding], ['shared', 'fast']);
  assert.deepEqual([...new Set((await (await fetch(`${base}/api/games`)).json()).map((/** @type {any} */ g) => g.breeding))].sort(), ['fast', 'normal'], 'normal by default');
  assert.equal((await post('/api/games', { token: TOKENS.a, mode: 'solo' })).status, 400);
  assert.equal((await post('/api/games', { token: TOKENS.a, mode: 'veryEasy' })).status, 400, 'Very Easy Lord gave way to Fast');
  assert.equal((await post('/api/games', { token: TOKENS.a, breeding: 'veryFast' })).status, 400);
  const sixteen = await post('/api/games', { token: TOKENS.a, players: 16 });
  assert.equal(sixteen.status, 201);
  assert.equal((await (await fetch(`${base}/api/games/${(await sixteen.json()).id}`)).json()).seats.length, 16);
  for (const bad of [{ players: 0 }, { players: 17 }, { players: 1, mode: 'ffa' }]) {
    assert.equal((await post('/api/games', { token: TOKENS.a, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal(lobby.find((g) => g.id === id)?.tick, 0);
  assert.deepEqual(await (await fetch(`${base}/api/games/${id}/commands`)).json(), []);

  assert.equal((await fetch(`${base}/api/games/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/games/nope/commands`)).status, 404);
  assert.equal((await fetch(`${base}/api/games/${encodeURIComponent('../x')}`)).status, 404);
});

test('the monitor, which can call any room method, needs its password', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const call = `/monitor/api/room/call?roomId=${a.roomId}&method=disconnect&args=%5B%5D`;
  const basic = (password) => ({ authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` });

  for (const path of ['/monitor/', '/monitor/api', `/monitor/api/room?roomId=${a.roomId}`, call]) {
    assert.equal((await fetch(base + path)).status, 401, path);
    assert.equal((await fetch(base + path, { headers: basic('wrong') })).status, 401, path);
  }
  assert.equal(matchMaker.getLocalRoomById(a.roomId) !== undefined, true, 'the room is still open');

  const rooms = await (await fetch(`${base}/monitor/api`, { headers: basic(MONITOR_PASSWORD) })).json();
  assert.ok(JSON.stringify(rooms).includes(a.roomId));
  await leaveAll(a);
});

// --- signing in ------------------------------------------------------------

test('signing in takes a name and the answer to the server\'s sum', async () => {
  const token = 's'.repeat(32);
  const sum = await challenge();

  assert.equal((await post('/api/players', { token: 'short', name: 'Sam', challenge: sum.id, answer: sum.answer })).status, 400);
  const badName = await post('/api/players', { token, name: 'Sam 🙂', challenge: sum.id, answer: sum.answer });
  assert.equal(badName.status, 400);
  assert.deepEqual(await badName.json(), { error: 'bad name' });
  assert.equal(server.storage.loadPlayer(playerId(token)), null);

  const badLanguage = await post('/api/players', { token, name: 'Sam', language: 'de', challenge: sum.id, answer: sum.answer });
  assert.equal(badLanguage.status, 400);
  assert.deepEqual(await badLanguage.json(), { error: 'bad language' });

  // A bad name or language didn't use the challenge up, so it still works.
  const ok = await post('/api/players', { token, name: '  Sam   Lee ', language: 'auto', challenge: sum.id, answer: String(sum.answer) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { pid: playerId(token), name: 'Sam Lee', language: 'auto' });
  assert.equal(server.storage.loadPlayer(playerId(token)).name, 'Sam Lee');

  // Every challenge answers once, and a wrong answer uses one up too.
  const again = await post('/api/players', { token, name: 'Sam', challenge: sum.id, answer: sum.answer });
  assert.equal(again.status, 403);
  const next = await challenge();
  assert.equal((await post('/api/players', { token, name: 'Sam', challenge: next.id, answer: next.answer + 1 })).status, 403);
  assert.equal((await post('/api/players', { token, name: 'Sam', challenge: next.id, answer: next.answer })).status, 403);
  assert.equal((await post('/api/players', { token, name: 'Sam', challenge: 'made-up', answer: 2 })).status, 403);
  // The page always sends a language: without one, the right answer fails
  // as a wrong one does, and the sum is used up.
  const bare = await challenge();
  const noLanguage = await post('/api/players', { token, name: 'Bot', challenge: bare.id, answer: bare.answer });
  assert.equal(noLanguage.status, 403);
  assert.deepEqual(await noLanguage.json(), { error: 'wrong answer' });
  assert.equal((await post('/api/players', { token, name: 'Bot', language: 'auto', challenge: bare.id, answer: bare.answer })).status, 403, 'used up');
  for (const body of ['{broken', JSON.stringify('not an object'), JSON.stringify({ name: 'x'.repeat(4000) })]) {
    const res = await fetch(`${base}/api/players`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.ok(res.status === 400 || res.status === 413, `${res.status} for ${body.slice(0, 20)}`);
    assert.deepEqual(await res.json(), { error: 'bad request' }, 'no stack trace');
  }
  assert.equal(server.storage.loadPlayer(playerId(token)).name, 'Sam Lee', 'refusals change nothing');

  // Signing in again, with a new sum, renames, and takes the language chosen.
  const rename = await challenge();
  const renamed = await post('/api/players', { token, name: 'Самуил', language: 'en', challenge: rename.id, answer: rename.answer });
  assert.deepEqual(await renamed.json(), { pid: playerId(token), name: 'Самуил', language: 'en' });
  assert.equal(server.storage.loadPlayer(playerId(token)).name, 'Самуил');
});

test('the settings page changes a player\'s name and language, with no sum', async () => {
  const token = 'e'.repeat(32);
  const pid = playerId(token);
  const stranger = await post('/api/settings', { token, name: 'Eve' });
  assert.equal(stranger.status, 401);
  assert.deepEqual(await stranger.json(), { error: 'sign in first' });
  assert.equal(server.storage.loadPlayer(pid), null);

  server.storage.savePlayer(pid, 'Eve');
  const both = await post('/api/settings', { token, name: '  Eve   Ray ', language: 'ru' });
  assert.equal(both.status, 200);
  assert.deepEqual(await both.json(), { pid, name: 'Eve Ray', language: 'ru' });
  assert.deepEqual(await (await post('/api/me', { token })).json(), { pid, name: 'Eve Ray', language: 'ru' });

  // What isn't given stays as it was.
  assert.deepEqual(await (await post('/api/settings', { token, language: 'auto' })).json(), { pid, name: 'Eve Ray', language: 'auto' });
  assert.deepEqual(await (await post('/api/settings', { token, name: 'Eve' })).json(), { pid, name: 'Eve', language: 'auto' });

  for (const [body, error] of [
    [{ token, name: 'Eve 🙂' }, 'bad name'],
    [{ token, name: null, language: 'en' }, 'bad name'],
    [{ token, language: 'EN' }, 'bad language'],
    [{ token, name: 'Eva', language: 'de' }, 'bad language'],
  ]) {
    const res = await post('/api/settings', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error });
  }
  const kept = server.storage.loadPlayer(pid);
  assert.deepEqual([kept.name, kept.language], ['Eve', 'auto'], 'refusals change nothing');
});

test('a token can ask who it belongs to', async () => {
  assert.deepEqual(await (await post('/api/me', { token: TOKENS.a })).json(), { pid: playerId(TOKENS.a), name: 'Ann', language: 'auto' });
  for (const body of [{ token: 'y'.repeat(32) }, { token: 'short' }, {}]) {
    const res = await post('/api/me', body);
    assert.equal(res.status, 200, 'not signed in is an answer, not an error');
    assert.equal(await res.json(), null);
  }
});

test('starting or joining a game needs a player who has signed in', async () => {
  const stranger = 'z'.repeat(32);
  assert.equal((await fetch(`${base}/api/games`, { method: 'POST' })).status, 401);
  const refused = await post('/api/games', { token: stranger });
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: 'sign in first' });

  const id = await startGame();
  await assert.rejects(new Client(base).joinOrCreate('game', { gameId: id, token: stranger }), /sign in first/);
  assert.equal((await matchMaker.query({ name: 'game' })).some((r) => r.metadata?.gameId === id), false);
  assert.deepEqual((await (await fetch(`${base}/api/games/${id}`)).json()).seats, [null, null], 'no seat taken');
});

// --- joining ---------------------------------------------------------------

test('joining needs a player token and a game that exists', async () => {
  const id = await startGame();
  const client = new Client(base);
  await assert.rejects(client.joinOrCreate('game', { gameId: id }));
  await assert.rejects(client.joinOrCreate('game', { gameId: id, token: 'short' }));
  await assert.rejects(client.joinOrCreate('game', { gameId: 'nope', token: TOKENS.a }), /no game/);
});

test('the first two players take the seats; later ones watch', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  const c = await join(id, TOKENS.c);
  assert.equal(a.roomId, c.roomId, 'one room per game');

  await until(() => Object.keys(c.state.toJSON().viewers).length === 3);
  const viewers = c.state.toJSON().viewers;
  assert.equal(viewers[a.sessionId].seat, 0);
  assert.equal(viewers[b.sessionId].seat, 1);
  assert.equal(viewers[c.sessionId].seat, -1);
  assert.equal(viewers[a.sessionId].pid.includes('a'.repeat(8)), false, 'the token itself is never shared');
  assert.deepEqual(Object.values(viewers).map((v) => v.name).sort(), ['Ann', 'Bēla', 'Cai']);
  assert.equal((await (await fetch(`${base}/api/games/${id}`)).json()).seats.filter(Boolean).length, 2);
  const listed = (await (await fetch(`${base}/api/games`)).json()).find((g) => g.id === id);
  assert.deepEqual(listed.seats, [{ pid: playerId(TOKENS.a), name: 'Ann' }, { pid: playerId(TOKENS.b), name: 'Bēla' }],
    'the lobby shows who plays, by public id and name');
  await leaveAll(a, b, c);
});

test('a second room for an open game is refused', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  await assert.rejects(new Client(base).create('game', { gameId: id, token: TOKENS.b }), /already open/);
  await leaveAll(a);
});

// --- the clock -------------------------------------------------------------

test('the clock runs only while both seated players are here', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  await sleep(100);
  assert.deepEqual([seen(a).running, seen(a).tick], [false, 0], 'Blue alone: waiting for Crimson');

  const b = await join(id, TOKENS.b);
  const c = await join(id, TOKENS.c);
  await until(() => seen(a).tick >= 25);
  assert.equal(seen(c).running, true, 'spectators see it too');
  assert.ok(Object.keys(seen(a).units).length > 0, 'the castles are making units');

  await b.leave();
  await until(() => !seen(a).running);
  const stopped = seen(a).tick;
  await sleep(100);
  assert.equal(seen(a).tick, stopped, 'paused while Crimson is away');
  await leaveAll(a, c);
});

test('the game\'s creator may have it go on without the players missing, until they are back', async () => {
  const res = await post('/api/games', { token: TOKENS.a, players: 3 });
  const id = /** @type {string} */ ((await res.json()).id);
  const a = await join(id, TOKENS.a);
  let b = await join(id, TOKENS.b);
  await sleep(50);
  assert.equal(seen(a).running, false, 'waiting for the third player');
  assert.equal(a.state.toJSON().creator, playerId(TOKENS.a), 'the page knows who may start it');

  assert.equal(await refusal(b.request('startNow')), 'not a game you started');
  assert.equal(await refusal(give(a, { type: 'away' })), 'unknown command', 'only the room says who is away');
  assert.equal(await a.request('startNow'), true);
  await until(() => seen(a).running);
  assert.deepEqual(seen(a).players.slice(0, 3).map((p) => p.away), [undefined, undefined, true]);
  assert.deepEqual(server.storage.listCommands(id).map((c) => [c.player, c.command]), [[2, { type: 'away' }]], 'logged, so replays agree');
  assert.equal(await refusal(a.request('startNow')), 'nobody is missing');

  // Crimson leaves: the game waits again, until it goes on without them too.
  await b.leave();
  await until(() => !seen(a).running);
  assert.equal(await a.request('startNow'), true);
  await until(() => seen(a).running);
  assert.deepEqual(seen(a).players.slice(0, 3).map((p) => p.away), [undefined, true, true]);

  // Back, and a newcomer in the free seat: the game waits for both again.
  b = await join(id, TOKENS.b);
  const c = await join(id, TOKENS.c);
  await until(() => seen(a).players.every((p) => p.away === undefined));
  assert.equal(c.state.toJSON().viewers[c.sessionId]?.seat, 2);
  assert.deepEqual(server.storage.listCommands(id).slice(-2).map((x) => [x.player, x.command.type]).sort(), [[1, 'back'], [2, 'back']]);
  await c.leave();
  await until(() => !seen(a).running);
  await leaveAll(a, b);
});

test('a game ends for everyone when its creator ends it, or anyone seated after an hour; saved, and its scores kept', async () => {
  const res = await post('/api/games', { token: TOKENS.a, players: 2 });
  const id = /** @type {string} */ ((await res.json()).id);
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  const c = await join(id, TOKENS.c);
  await until(() => seen(a).tick >= 5);
  assert.equal(await refusal(b.request('endGame')), 'only its creator may end it in its first hour');
  assert.equal(await refusal(c.request('endGame')), 'only its players may end it, until it is a day old with none of them here', 'a spectator may not');
  assert.equal(await refusal(give(a, { type: 'end' })), 'unknown command', 'only the room ends it');

  // An hour on, Crimson may; against the Dark Lord, he wins.
  const room = matchMaker.getLocalRoomById(a.roomId);
  room.game.tick = END_ANYONE_TICKS;
  room.game.players[0].tally.kills = 77;
  room.game.players[1].tally.born = 3;
  assert.equal(await b.request('endGame'), true);
  await until(() => seen(a).over !== undefined);
  const lord = seen(a).players.find((/** @type {any} */ p) => p.side === 8);
  assert.equal(seen(a).winner, lord.team);
  assert.equal(seen(a).running, false);
  assert.deepEqual(server.storage.listCommands(id).map((x) => [x.player, x.command]), [[1, { type: 'end' }]], 'logged');
  assert.ok(server.storage.loadGame(id)?.state.over !== undefined, 'saved finished at once');
  assert.equal(await refusal(a.request('endGame')), 'the game is over');

  // Each player's score went to the high scores, by name, the details with it.
  const best = await (await fetch(`${base}/api/scores`)).json();
  const ours = best.filter((/** @type {any} */ x) => x.game.id === id);
  assert.deepEqual(ours.map((/** @type {any} */ x) => [x.name, x.points, x.won, x.open]), [[NAMES.a, 770, false, true], [NAMES.b, 15, false, true]]);
  assert.equal(ours[1].details.tally.born, 3);
  await leaveAll(a, b, c);
});

test('a day old, with none of its players here, an abandoned game may be ended by anyone viewing it', async () => {
  const res = await post('/api/games', { token: TOKENS.a, players: 2 });
  const id = /** @type {string} */ ((await res.json()).id);
  const a = await join(id, TOKENS.a);
  const c = await join(id, TOKENS.b);
  await until(() => c.state.toJSON().seats.length === 2);
  await c.request('releaseSeat');
  await until(() => c.state.toJSON().viewers[c.sessionId]?.seat === -1);
  const room = matchMaker.getLocalRoomById(a.roomId);
  room.createdAt = Date.now() - END_IDLE_MS - 1;
  assert.equal(await refusal(c.request('endGame')), 'only its players may end it, until it is a day old with none of them here', 'Ann is here');
  await leaveAll(a);
  await until(() => [...room.state.viewers.values()].length === 1);
  assert.equal(await c.request('endGame'), true);
  await until(() => seen(c).over !== undefined);
  const lord = seen(c).players.find((/** @type {any} */ p) => p.side === 8);
  assert.equal(seen(c).winner, lord.team, 'its players gave up');
  assert.deepEqual(server.storage.listCommands(id).at(-1)?.command, { type: 'end', idle: 1 });
  await leaveAll(c);
});

test('a player whose castle fell may take a free base; the game waits for no fallen side', async () => {
  const res = await post('/api/games', { token: TOKENS.a, players: 4 });
  const id = /** @type {string} */ ((await res.json()).id);
  const a = await join(id, TOKENS.a);
  let b = await join(id, TOKENS.b);
  assert.equal(await a.request('startNow'), true);
  await until(() => seen(a).running);

  // Crimson's castle falls.
  const room = matchMaker.getLocalRoomById(a.roomId);
  const castle = /** @type {any} */ (Object.values(room.game.buildings)).find((x) => x.owner === 1 && x.type === 'castle');
  castle.hp = 0;
  await until(() => seen(a).players[1].lost !== undefined);
  await b.leave();
  await sleep(50);
  assert.equal(seen(a).running, true, 'no waiting for a side that has lost');

  b = await join(id, TOKENS.b);
  assert.equal(b.state.toJSON().viewers[b.sessionId]?.seat, 1, 'back in the seat they had');
  assert.equal(await b.request('claimSeat', { seat: 3 }), 3, 'the free base they picked');
  await until(() => seen(a).players[3].away === undefined);
  assert.deepEqual(a.state.toJSON().seats, [playerId(TOKENS.a), '', '', playerId(TOKENS.b)]);
  assert.equal(await give(b, { type: 'upgrade', building: castleOf(seen(b), 3)?.id }), server.storage.listCommands(id).at(-1)?.seq ?? -1);

  // A newcomer gets the free base whose castle stands, never the fallen one.
  const c = await join(id, TOKENS.c);
  assert.equal(c.state.toJSON().viewers[c.sessionId]?.seat, 2);
  assert.equal(await refusal(b.request('claimSeat')), null, 'asking again, with a standing seat, is harmless');

  // Crimson is still named on the side they played first, in the lobby and
  // at the end; and when the game ends, both of their sides' scores are theirs.
  const seats = await (await fetch(`${base}/api/games/${id}/seats`)).json();
  assert.deepEqual(seats.map((/** @type {any} */ x) => x?.name ?? null), [NAMES.a, NAMES.b, NAMES.c, NAMES.b]);
  const listed = (await (await fetch(`${base}/api/games`)).json()).find((/** @type {any} */ g) => g.id === id);
  assert.deepEqual(listed.former.map((/** @type {any} */ x) => x?.name ?? null), [null, NAMES.b, null, null]);
  room.game.players[1].tally.kills = 9;
  room.game.players[3].tally.kills = 4;
  assert.equal(await a.request('endGame'), true);
  await until(() => server.storage.scoresOf(id).length > 0);
  assert.deepEqual(server.storage.scoresOf(id).map((x) => [x.seat, x.name]), [[0, NAMES.a], [1, NAMES.b], [2, NAMES.c], [3, NAMES.b]]);
  await leaveAll(a, b, c);
});

// --- commands --------------------------------------------------------------

test('the server refuses commands from spectators, while paused, and that the rules refuse', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  assert.equal(await refusal(give(a, { type: 'upgrade', building: 'b1' })), 'the game is paused');

  const b = await join(id, TOKENS.b);
  const c = await join(id, TOKENS.c);
  await until(() => seen(a).running);
  assert.equal(await refusal(give(c, { type: 'upgrade', building: 'b1' })), 'not seated');
  assert.equal(await refusal(give(a, { type: 'upgrade', building: castleOf(seen(a), 1)?.id })), 'not your building');
  assert.equal(await refusal(give(a, { type: 'crew', building: 'b1', units: [] })), 'the castle is home to every unit');
  assert.equal(await refusal(give(a, { type: 'launch' })), 'unknown command');
  assert.equal(await refusal(give(a, 'north')), 'not a command');
  assert.equal(await refusal(give(a, { type: 'build', kind: 'tower', q: { deep: 1 }, r: 0 })), 'not a command');
  assert.equal(await refusal(give(a, { type: 'upgrade', building: 'b'.repeat(100) })), 'not a command');
  assert.equal(await refusal(give(a, { type: 'crew', building: 'b1', units: [{ id: 'u3' }] })), 'not a command');
  // A crew as long as a full band reaches the rules; one longer doesn't.
  const band = BUILDING_TYPES.band.capacity;
  assert.notEqual(await refusal(give(a, { type: 'crew', building: 'b1', units: Array(band).fill('u3') })), 'not a command');
  assert.equal(await refusal(give(a, { type: 'crew', building: 'b1', units: Array(band + 1).fill('u3') })), 'not a command');

  assert.deepEqual(server.storage.listCommands(id), []);
  assert.equal(seen(a).buildings.b1.grade, 1);
  await leaveAll(a, b, c);
});

test('an accepted command is logged, with its tick, before any player sees it', async () => {
  const { id, a, b } = await twoPlayers();

  /** How many commands were logged when Crimson first saw the upgrade begin. */
  let loggedWhenSeen = null;
  b.onStateChange(() => {
    if (loggedWhenSeen === null && seen(b).buildings.b1?.upgrading !== undefined) {
      loggedWhenSeen = server.storage.listCommands(id).length;
    }
  });

  const tickBefore = seen(a).tick;
  assert.equal(await give(a, { type: 'upgrade', building: 'b1' }), 1, 'answered with the command number');
  await until(() => loggedWhenSeen !== null);
  assert.equal(loggedWhenSeen, 1);
  const [logged1] = server.storage.listCommands(id);
  assert.deepEqual([logged1.player, logged1.command], [0, { type: 'upgrade', building: 'b1' }]);
  assert.ok(logged1.tick >= tickBefore);
  await leaveAll(a, b);
});

test('a command whose write fails is refused and leaves the game as it was', async () => {
  const { a, b } = await twoPlayers();
  const { recordCommand } = server.storage;
  server.storage.recordCommand = () => { throw new Error('disk full'); };
  try {
    assert.ok(await refusal(give(a, { type: 'upgrade', building: 'b1' })));
  } finally {
    server.storage.recordCommand = recordCommand;
  }
  assert.ok(logged.some((line) => line.includes('disk full')), 'the failure is logged');
  await sleep(50); // patches would have gone out by now
  assert.equal(seen(a).buildings.b1.grade, 1);

  assert.equal(await give(a, { type: 'upgrade', building: 'b1' }), 1, 'the same command goes through once writes work');
  await leaveAll(a, b);
});

test('a crew marches through the server, one cell of its route at a time', async () => {
  const { a, b } = await twoPlayers();
  const spot = buildSpot(seen(a));
  assert.equal(typeof await give(a, { type: 'build', kind: 'tower', ...spot }), 'number');
  await until(() => Object.values(seen(b).buildings).some((x) => x.type === 'tower'));
  const tower = /** @type {any} */ (Object.values(seen(b).buildings).find((x) => x.type === 'tower'));

  const crew = /** @type {string[]} */ (occupancy(seen(a)).inside.get('b1')).slice(0, 4);
  await give(a, { type: 'crew', building: tower.id, units: crew });
  await until(() => Object.values(seen(b).units).some((u) => u.to === tower.id));
  for (const u of Object.values(seen(b).units).filter((x) => x.to === tower.id && x.path)) {
    assert.equal(u.path.length, 1, 'players see only the next cell of a route');
  }
  // Up to five cells at two seconds each (four on scrub), on a clock that
  // falls behind when the machine is busy.
  await until(() => (occupancy(seen(b)).inside.get(tower.id)?.length ?? 0) === 4, 15000);
  await leaveAll(a, b);
});

// --- keeping games -----------------------------------------------------------

test('a game outlives its room: its snapshot comes back exactly, and its log rebuilds it', async () => {
  const { id, a, b } = await twoPlayers();
  await give(a, { type: 'upgrade', building: 'b1' });
  await give(a, { type: 'build', kind: 'pit', ...buildSpot(seen(a)) });
  await until(() => Object.values(seen(a).buildings).some((x) => x.type === 'pit'));
  const wagon = /** @type {any} */ (Object.values(seen(a).buildings).find((x) => x.type === 'pit'));
  await give(a, { type: 'crew', building: wagon.id, units: /** @type {string[]} */ (occupancy(seen(a)).inside.get('b1')).slice(0, 3) });
  await give(b, { type: 'upgrade', building: castleOf(seen(b), 1)?.id });
  await sleep(100);
  const firstRoom = a.roomId;
  await leaveAll(a, b);
  await roomClosed(firstRoom);

  // The room saved a snapshot as it closed; the next room starts from it.
  const saved = server.storage.loadGame(id);
  assert.equal(saved.seq, 4, 'the snapshot includes all four commands');
  const b2 = await join(id, TOKENS.b);
  assert.notEqual(b2.roomId, firstRoom, 'a new room');
  const { running, ...view } = seen(b2);
  assert.deepEqual(view, JSON.parse(JSON.stringify(publicView(saved.state))));
  await until(() => b2.state.toJSON().viewers[b2.sessionId]?.seat === 1, 3000);

  // Without the snapshot, the log alone rebuilds the same game: the core is
  // deterministic, so replaying the commands at their ticks and running the
  // clock on to the snapshot's tick lands on the very same state.
  const rebuilt = restoreGame({ ...saved, state: { garbage: true } }, (after) => server.storage.listCommands(id, { after }));
  while (rebuilt.game.tick < /** @type {any} */ (saved.state).tick) advance(rebuilt.board, rebuilt.game);
  assert.deepEqual(rebuilt.game, saved.state);
  assert.equal(rebuilt.seq, 4);
  await leaveAll(b2);
});

test('replaying refuses a log that does not fit the game', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 5 });
  const saved = {
    id: 'x', seed: 5, seq: 0, seats: [], createdAt: 0, updatedAt: 0,
    state: { garbage: true },
  };
  const { game } = restoreGame(saved, () => []);
  assert.throws(() => replay(board, game, [{ seq: 1, tick: 3, player: 0, command: { type: 'upgrade', building: 'b2' }, at: 0 }]), /command 1 does not replay: that building is gone/);
  assert.throws(() => replay(board, game, [{ seq: 2, tick: 1, player: 0, command: {}, at: 0 }]), /command 2 is from tick 1, before 3/);
});

test('a dropped connection comes back as the same viewer, in the same seat', async () => {
  const { a, b } = await twoPlayers();
  // The client only reconnects rooms that have been up a while (5 s by default).
  a.reconnection.minUptime = 0;
  let dropped = false;
  let back = false;
  a.onDrop(() => { dropped = true; });
  a.onReconnect(() => { back = true; });

  // Cut Blue's socket from the server side, as a network failure would.
  const serverSide = matchMaker.getLocalRoomById(a.roomId).clients.find((c) => c.sessionId === a.sessionId);
  serverSide.ref.terminate();

  await until(() => dropped);
  assert.ok(b.state.toJSON().viewers[a.sessionId], 'the viewer is kept while they reconnect');
  assert.equal(seen(b).running, true, 'and the game goes on');
  await until(() => back);
  assert.equal(b.state.toJSON().viewers[a.sessionId]?.seat, 0);
  assert.equal(await give(a, { type: 'upgrade', building: 'b1' }), 1, 'and can play on');
  await leaveAll(a, b);
});

test('releasing a seat lets a spectator take it', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  const c = await join(id, TOKENS.c);
  const seatOf = (room, who) => room.state.toJSON().viewers[who.sessionId]?.seat;

  assert.equal(await refusal(c.request('claimSeat')), 'no free seat');
  await a.request('releaseSeat');
  await until(() => seatOf(c, a) === -1);
  assert.equal(await c.request('claimSeat'), 0);
  await until(() => seatOf(a, c) === 0);
  assert.equal(await refusal(a.request('claimSeat')), 'no free seat');
  assert.equal(await b.request('claimSeat'), 1, 'asking for a seat you hold is harmless');
  await leaveAll(a, b, c);
});

test('in two teams, players fill the first team\'s seats, then the second\'s; a freed seat comes round again only after the rest', async () => {
  const res = await post('/api/games', { token: TOKENS.a, mode: 'teams', players: 3 });
  assert.equal(res.status, 201);
  const id = (await res.json()).id;
  assert.deepEqual((await (await fetch(`${base}/api/games/${id}`)).json()).state.players.map((/** @type {any} */ p) => p.team), [0, 1, 1, -1],
    'one against two, then the raiders');
  assert.equal((await post('/api/games', { token: TOKENS.a, mode: 'teams', players: 1 })).status, 400, 'two teams need two players');
  const seatOf = (/** @type {any} */ room, /** @type {any} */ who) => room.state.toJSON().viewers[who.sessionId]?.seat;
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  await until(() => seatOf(a, b) === 1);
  assert.equal(seatOf(a, a), 0);
  await b.request('releaseSeat');
  await until(() => seatOf(a, b) === -1);
  // Seat 1 is free again, but the next player goes on round the ring.
  const c = await join(id, TOKENS.c);
  await until(() => seatOf(a, c) === 2);
  assert.equal(await b.request('claimSeat'), 1, 'and then it is the free one');
  await leaveAll(a, b, c);
});

test('with NPCs, the clock runs without waiting for free seats, whose NPCs play as their seats; a newcomer takes one over', async () => {
  const res = await post('/api/games', { token: TOKENS.a, mode: 'coop', players: 2, npcs: true });
  assert.equal(res.status, 201);
  const id = (await res.json()).id;
  assert.equal((await post('/api/games', { token: TOKENS.a, npcs: 'yes' })).status, 400);
  const listed = (await (await fetch(`${base}/api/games`)).json()).find((/** @type {any} */ g) => g.id === id);
  assert.equal(listed.npcs, true);
  const a = await join(id, TOKENS.a);
  await until(() => a.state.running === true);
  const npcCommands = async () => (await (await fetch(`${base}/api/games/${id}/commands`)).json()).filter((/** @type {any} */ c) => c.player === 1);
  // NPC.start is 20 game seconds: two here.
  /** @type {any[]} */
  let given = [];
  for (let i = 0; i < 80 && !given.length; i++) {
    given = await npcCommands();
    await sleep(100);
  }
  assert.ok(given.length > 0, 'the NPC gave no command');
  assert.ok(given.every((c) => c.tick >= NPC.start));
  // Bēla comes along and takes the NPC's seat; it gives no more.
  const b = await join(id, TOKENS.b);
  await until(() => b.state.toJSON().viewers[b.sessionId]?.seat === 1);
  const before = (await npcCommands()).length;
  await sleep(NPC.think / TICK_RATE * 1000 * 3);
  assert.equal((await npcCommands()).length, before, 'the NPC stopped');
  await leaveAll(a, b);
});

test('selections are shared, but only for hexes on the board', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const c = await join(id, TOKENS.c);
  const selOf = () => {
    const v = c.state.toJSON().viewers[a.sessionId];
    return v?.hasSel ? { q: v.q, r: v.r } : null;
  };

  a.send('select', { q: 2, r: 3 });
  await until(() => selOf()?.q === 2);
  a.send('select', { q: 500, r: 3 });
  await until(() => selOf() === null);
  a.send('select', { q: 2, r: 3 });
  await until(() => selOf() !== null);
  a.send('select', 'junk');
  await until(() => selOf() === null);
  await leaveAll(a, c);
});

// --- the page's transport --------------------------------------------------

test('a player waiting for the others may rename the game, and the lobby shows it at once', async () => {
  const id = await startGame();
  const blue = await createServerNet({ client: new Client(base), gameId: id, token: TOKENS.a });
  await blue.ready();
  await until(() => blue.seat() === 0);
  assert.equal(blue.running(), false, 'waiting for the second player');
  const listed = async () => (await (await fetch(`${base}/api/games`)).json()).find((/** @type {any} */ g) => g.id === id);
  assert.ok(GAME_NAMES.includes((await listed()).name), 'named from the preset list');
  assert.deepEqual(await blue.send({ type: 'rename', name: 'Friday  fight' }), { ok: true });
  assert.equal((await listed()).name, 'Friday fight');
  assert.deepEqual(await blue.send({ type: 'rename', name: 'x'.repeat(30) }), { ok: false, reason: 'a name is 1 to 24 letters, digits and spaces' });
  assert.deepEqual(await blue.send({ type: 'upgrade', building: 'b1' }), { ok: false, reason: 'the game is paused' }, 'other commands wait for the clock');
  await blue.leave();
});

test('leaving a game from the lobby frees the seat in its open room too', async () => {
  const id = await startGame();
  const room = await join(id, TOKENS.a);
  await until(() => room.state.seats[0] === playerId(TOKENS.a));
  assert.deepEqual(await (await post(`/api/games/${id}/leave`, { token: TOKENS.a })).json(), { ok: true });
  await until(() => room.state.seats[0] === '');
  assert.deepEqual(server.storage.loadGame(id)?.seats, [null, null]);
  await leaveAll(room);
});

test('deleting a game closes its open room, which saves nothing more of it', async () => {
  const id = await startGame();
  const room = await join(id, TOKENS.a);
  const sentAway = new Promise((res) => room.onLeave(res));
  const before = logged.length;
  assert.deepEqual(await (await post(`/api/games/${id}/delete`, { token: TOKENS.a })).json(), { ok: true });
  await sentAway;
  await roomClosed(room.roomId);
  assert.equal(server.storage.loadGame(id), null);
  assert.deepEqual(logged.slice(before), [], 'no failed save of the deleted game');
});

test('the page transport plays through the server and follows it', async () => {
  const id = await startGame();
  const blue = await createServerNet({ client: new Client(base), gameId: id, token: TOKENS.a });
  const crimson = await createServerNet({ client: new Client(base), gameId: id, token: TOKENS.b });
  await Promise.all([blue.ready(), crimson.ready()]);

  await until(() => blue.seat() === 0 && crimson.seat() === 1 && blue.viewers() === 2 && blue.running());
  assert.equal(blue.connected(), true);
  assert.equal(crimson.canClaimSeat(), false, 'no seat free');

  /** @type {any[]} */
  const crimsonSaw = [];
  crimson.onState((view) => crimsonSaw.push(view));
  assert.equal(crimsonSaw.length, 1, 'a late subscriber gets the current game');
  assert.deepEqual(Object.values(crimsonSaw[0].buildings).map((x) => [x.owner, x.type]), [[0, 'castle'], [1, 'castle'], [2, 'lair']]);
  await until(() => crimsonSaw.at(-1).tick > crimsonSaw[0].tick);
  const now = crimson.clock();
  assert.ok(now >= crimsonSaw.at(-1).tick && now <= crimsonSaw.at(-1).tick + 1, 'the clock runs between ticks');

  assert.deepEqual(await blue.send({ type: 'upgrade', building: 'b1' }), { ok: true });
  await until(() => crimsonSaw.at(-1).buildings.b1.upgrading !== undefined);
  assert.deepEqual(await crimson.send({ type: 'upgrade', building: 'b1' }), { ok: false, reason: 'not your building' });

  // Picks reach the other side as peers, with names.
  /** @type {any[]} */
  let peers = [];
  crimson.onPeers((list) => { peers = list; });
  blue.select({ q: 2, r: 3 });
  await until(() => peers.some((p) => !p.isMe && p.seat === 0 && p.sel?.q === 2));
  assert.equal(peers.filter((p) => p.isMe).length, 1);
  assert.equal(peers.find((p) => p.seat === 0)?.name, 'Ann');
  assert.equal(peers.find((p) => p.isMe)?.name, 'Bēla');
  assert.notEqual(peers[0].color, peers[1].color);

  // Blue gives up the seat, which pauses the game, and takes it back.
  await blue.releaseSeat();
  await until(() => blue.seat() === null && blue.canClaimSeat() && !crimson.running());
  await blue.claimSeat();
  await until(() => blue.seat() === 0 && crimson.running());

  await blue.leave();
  await crimson.leave();
  assert.equal(crimson.connected(), false);
});
