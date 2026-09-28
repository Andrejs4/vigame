/**
 * The game server end to end: a real server on a free port, real Colyseus
 * clients, an in-memory database. One server for the whole file, because
 * Colyseus keeps its matchmaker in module state, one per process.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { matchMaker } from '@colyseus/core';
import { Client } from '@colyseus/sdk';

import { startGameServer } from '../server/app.js';
import { playerId, replay, restoreGame } from '../server/room.js';
import { BOARD_OPTIONS, createBoard } from '../src/board.js';
import { applyCommand, createGame, reachable } from '../src/game.js';
import { createServerNet, serialize } from '../src/net.js';

/** @type {Awaited<ReturnType<typeof startGameServer>>} */
let server;
/** @type {string} */
let base;
/** Messages Colyseus would otherwise print, such as a write that fails on purpose. */
const logged = [];
const MONITOR_PASSWORD = 'test-monitor-password';

before(async () => {
  const quiet = (...args) => { logged.push(args.join(' ')); };
  server = await startGameServer({
    port: 0,
    monitorPassword: MONITOR_PASSWORD,
    logger: { debug() {}, info() {}, trace() {}, warn: quiet, error: quiet },
  });
  base = server.url.replace(/\/$/, '');
  // The test players have signed in; the sign-in itself has its own tests.
  for (const [who, token] of Object.entries(TOKENS)) server.storage.savePlayer(playerId(token), NAMES[who]);
});

after(() => server.close());

const TOKENS = { a: 'a'.repeat(32), b: 'b'.repeat(32), c: 'c'.repeat(32) };
const NAMES = { a: 'Ann', b: 'Bēla', c: 'Cai' };

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

/** Start a game over HTTP, the way the page does. */
async function startGame() {
  const res = await post('/api/games', { token: TOKENS.a });
  assert.equal(res.status, 201);
  return /** @type {string} */ ((await res.json()).id);
}

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
  await until(() => room.state?.toJSON?.().seed !== undefined);
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

/** The game as a client sees it, in page (serialize) shape. */
function seen(room) {
  const s = room.state.toJSON();
  return { seed: s.seed, turn: s.turn, currentPlayer: s.currentPlayer, units: Object.values(s.units) };
}

/** Rebuild the page-side game for a state, to work out legal moves. */
function local(state) {
  const board = createBoard({ ...BOARD_OPTIONS, seed: state.seed });
  const game = createGame(board);
  game.units = new Map(state.units.map((u) => [u.id, { ...u }]));
  game.turn = state.turn;
  game.currentPlayer = state.currentPlayer;
  return { board, game };
}

/** A legal move for the side to play: its first unit, to its first reachable hex. */
function legalMove(state) {
  const { board, game } = local(state);
  const unit = [...game.units.values()].find((u) => u.owner === game.currentPlayer);
  const [k] = reachable(board, game, unit).keys();
  const [q, r] = k.split(',').map(Number);
  return { unit: unit.id, q, r };
}

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
    await new Promise((res) => setTimeout(res, 20));
  }
}

// --- HTTP ------------------------------------------------------------------

test('the server serves the page with the Colyseus client loaded first', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<script src="vendor\/colyseus\.js"><\/script>\n<script>\n\(\(\) => \{/, 'relative, so a proxy can serve it under a subfolder');
  const sdk = await fetch(`${base}/vendor/colyseus.js`);
  assert.equal(sdk.status, 200);
  assert.match(await sdk.text(), /Colyseus/);
});

test('new games are stored and listed, and unknown ones are 404', async () => {
  const id = await startGame();
  const game = await (await fetch(`${base}/api/games/${id}`)).json();
  assert.equal(game.id, id);
  assert.deepEqual(game.seats, [null, null]);
  assert.equal(game.state.turn, 1);
  assert.equal(game.state.units.length, 4);

  const lobby = await (await fetch(`${base}/api/games`)).json();
  assert.ok(lobby.some((g) => g.id === id && g.seatsTaken === 0));
  assert.deepEqual(await (await fetch(`${base}/api/games/${id}/moves`)).json(), []);

  assert.equal((await fetch(`${base}/api/games/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/games/nope/moves`)).status, 404);
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

  // A bad name didn't use the challenge up, so it still works.
  const ok = await post('/api/players', { token, name: '  Sam   Lee ', challenge: sum.id, answer: String(sum.answer) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { pid: playerId(token), name: 'Sam Lee' });
  assert.equal(server.storage.loadPlayer(playerId(token)).name, 'Sam Lee');

  // Every challenge answers once, and a wrong answer uses one up too.
  const again = await post('/api/players', { token, name: 'Sam', challenge: sum.id, answer: sum.answer });
  assert.equal(again.status, 403);
  const next = await challenge();
  assert.equal((await post('/api/players', { token, name: 'Sam', challenge: next.id, answer: next.answer + 1 })).status, 403);
  assert.equal((await post('/api/players', { token, name: 'Sam', challenge: next.id, answer: next.answer })).status, 403);
  assert.equal((await post('/api/players', { token, name: 'Sam', challenge: 'made-up', answer: 2 })).status, 403);
  for (const body of ['{broken', JSON.stringify('not an object'), JSON.stringify({ name: 'x'.repeat(4000) })]) {
    const res = await fetch(`${base}/api/players`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.ok(res.status === 400 || res.status === 413, `${res.status} for ${body.slice(0, 20)}`);
    assert.deepEqual(await res.json(), { error: 'bad request' }, 'no stack trace');
  }
  assert.equal(server.storage.loadPlayer(playerId(token)).name, 'Sam Lee', 'refusals change nothing');

  // Signing in again, with a new sum, renames.
  const rename = await challenge();
  assert.equal((await post('/api/players', { token, name: 'Samuel', challenge: rename.id, answer: rename.answer })).status, 200);
  assert.equal(server.storage.loadPlayer(playerId(token)).name, 'Samuel');
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
  await leaveAll(a, b, c);
});

test('a second room for an open game is refused', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  await assert.rejects(new Client(base).create('game', { gameId: id, token: TOKENS.b }), /already open/);
  await leaveAll(a);
});

// --- playing ---------------------------------------------------------------

test('the server refuses moves out of turn, of the wrong units, or malformed', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  const c = await join(id, TOKENS.c);
  const before = seen(a);
  const blue = legalMove(before);
  const crimsonUnit = before.units.find((u) => u.owner === 1);

  assert.equal(await refusal(b.request('endTurn')), 'not your turn');
  assert.equal(await refusal(b.request('move', blue)), 'not your turn');
  assert.equal(await refusal(c.request('endTurn')), 'not seated');
  assert.equal(await refusal(a.request('move', { unit: crimsonUnit.id, q: crimsonUnit.q + 1, r: crimsonUnit.r })), 'illegal move');
  assert.equal(await refusal(a.request('move', { ...blue, q: blue.q + 30 })), 'illegal move');
  assert.equal(await refusal(a.request('move', { ...blue, q: String(blue.q) })), 'illegal move');
  assert.equal(await refusal(a.request('move', 'north')), 'illegal move');

  assert.deepEqual(seen(a), before);
  assert.deepEqual(server.storage.listMoves(id), []);
  await leaveAll(a, b, c);
});

test('an accepted move is saved before any player sees it', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  const move = legalMove(seen(a));

  /** What was in the database at the moment Crimson first saw the move. */
  let loggedWhenSeen = null;
  b.onStateChange((state) => {
    const unit = state.units.get(move.unit);
    if (loggedWhenSeen === null && unit.q === move.q && unit.r === move.r) {
      loggedWhenSeen = server.storage.listMoves(id).length;
    }
  });

  assert.equal(await a.request('move', move), 1, 'answered with the move number');
  await until(() => loggedWhenSeen !== null);
  assert.equal(loggedWhenSeen, 1);

  assert.equal(await a.request('endTurn'), 2);
  await until(() => seen(b).currentPlayer === 1);
  assert.deepEqual(server.storage.listMoves(id).map((m) => m.command), [
    { type: 'move', ...move },
    { type: 'endTurn' },
  ]);
  assert.deepEqual(server.storage.loadGame(id).state, seen(b));
  await leaveAll(a, b);
});

test('a move whose write fails is refused and leaves the game as it was', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const before = seen(a);
  const move = legalMove(before);

  const { recordMove } = server.storage;
  server.storage.recordMove = () => { throw new Error('disk full'); };
  try {
    assert.ok(await refusal(a.request('move', move)));
  } finally {
    server.storage.recordMove = recordMove;
  }
  assert.ok(logged.some((line) => line.includes('disk full')), 'the failure is logged');
  await new Promise((res) => setTimeout(res, 100)); // a patch would have gone out by now
  assert.deepEqual(seen(a), before);

  assert.equal(await a.request('move', move), 1, 'the same move goes through once writes work');
  await leaveAll(a);
});

test('a game outlives its room: the next visitors find it as it was, seats included', async () => {
  const id = await startGame();
  let a = await join(id, TOKENS.a);
  let b = await join(id, TOKENS.b);
  await a.request('move', legalMove(seen(a)));
  await a.request('endTurn');
  await until(() => seen(a).currentPlayer === 1);
  const played = seen(a);
  const firstRoom = a.roomId;
  await leaveAll(a, b);
  await roomClosed(firstRoom);

  // Crimson comes back first and is still Crimson.
  b = await join(id, TOKENS.b);
  assert.notEqual(b.roomId, firstRoom, 'a new room');
  assert.deepEqual(seen(b), played);
  await until(() => b.state.toJSON().viewers[b.sessionId]?.seat === 1);
  a = await join(id, TOKENS.a);
  await until(() => b.state.toJSON().viewers[a.sessionId]?.seat === 0);
  await leaveAll(a, b);
});

test('a dropped connection comes back as the same viewer, in the same seat', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
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
  await until(() => back);
  assert.equal(b.state.toJSON().viewers[a.sessionId]?.seat, 0);
  assert.equal(await a.request('endTurn'), 1, 'and can play on');
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

// --- restoring -------------------------------------------------------------

test('replaying the move log rebuilds the saved game', async () => {
  const id = await startGame();
  const a = await join(id, TOKENS.a);
  const b = await join(id, TOKENS.b);
  await a.request('move', legalMove(seen(a)));
  await a.request('endTurn');
  await until(() => seen(b).currentPlayer === 1);
  await b.request('move', legalMove(seen(b)));
  await leaveAll(a, b);

  const saved = server.storage.loadGame(id);
  const { board, game } = replay(saved.seed, server.storage.listMoves(id));
  assert.deepEqual(serialize(board, game), saved.state);

  // Restoring prefers the saved state, and falls back to the log.
  const restored = restoreGame({ ...saved, state: { garbage: true } }, () => server.storage.listMoves(id));
  assert.deepEqual(serialize(restored.board, restored.game), saved.state);
  assert.throws(() => replay(saved.seed, [{ seq: 1, player: 1, command: { type: 'endTurn' } }]), /move 1/);
});

// --- the page's transport --------------------------------------------------

test('the page transport plays through the server and follows it', async () => {
  const id = await startGame();
  const blue = await createServerNet({ client: new Client(base), gameId: id, token: TOKENS.a });
  const crimson = await createServerNet({ client: new Client(base), gameId: id, token: TOKENS.b });
  await Promise.all([blue.ready(), crimson.ready()]);

  await until(() => blue.seat() === 0 && crimson.seat() === 1 && blue.viewers() === 2);
  assert.equal(blue.mode, 'online');
  assert.equal(blue.connected(), true);
  assert.equal(crimson.canClaimSeat(), false, 'no seat free');

  /** @type {any[]} */
  const crimsonSaw = [];
  crimson.onState((s) => crimsonSaw.push(s));
  const start = crimsonSaw.at(-1);
  assert.equal(start.currentPlayer, 0, 'a late subscriber gets the current state');

  // Blue plays the way the page does: apply locally, then commit.
  const { board, game } = local(start);
  const move = { type: 'move', ...legalMove(start) };
  assert.ok(applyCommand(board, game, 0, move));
  await blue.commit(serialize(board, game), move);
  await until(() => crimsonSaw.at(-1).units.find((u) => u.id === move.unit).q === move.q);

  // Crimson tries to move out of turn; the server refuses and Crimson's page
  // is handed the server's state to put back.
  const count = crimsonSaw.length;
  await crimson.commit(serialize(board, game), { type: 'endTurn' });
  assert.equal(crimsonSaw.length, count + 1);
  assert.equal(crimsonSaw.at(-1).currentPlayer, 0);

  // Selections reach the other side as peers.
  /** @type {any[]} */
  let peers = [];
  crimson.onPeers((list) => { peers = list; });
  blue.select({ q: move.q, r: move.r });
  await until(() => peers.some((p) => !p.isMe && p.seat === 0 && p.sel?.q === move.q));
  assert.equal(peers.filter((p) => p.isMe).length, 1);
  assert.equal(peers.find((p) => p.seat === 0)?.name, 'Ann');
  assert.equal(peers.find((p) => p.isMe)?.name, 'Bēla');
  assert.notEqual(peers[0].color, peers[1].color);

  // Blue gives up the seat; Crimson's page sees a seat it could not take
  // (it holds one), and Blue's page offers it back.
  await blue.releaseSeat();
  await until(() => blue.seat() === null && blue.canClaimSeat());
  await blue.claimSeat();
  await until(() => blue.seat() === 0);

  await blue.leave();
  await crimson.leave();
  assert.equal(crimson.connected(), false);
});
