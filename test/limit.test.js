// The limit on games a player has on the go, through a game server that
// keeps it (test/server.test.js lifts it). Its own file, so its own process:
// Colyseus allows one game server per process.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { startGameServer } from '../server/app.js';
import { playerId } from '../server/room.js';
import { GAME_NAMES } from '../src/core/names.js';

/** @type {Awaited<ReturnType<typeof startGameServer>>} */
let server;
/** @type {string} */
let base;

const TOKENS = { a: 'a'.repeat(32), b: 'b'.repeat(32), c: 'c'.repeat(32) };
const PIDS = { a: playerId(TOKENS.a), b: playerId(TOKENS.b), c: playerId(TOKENS.c) };

before(async () => {
  const quiet = () => {};
  server = await startGameServer({ port: 0, logger: { debug: quiet, info: quiet, trace: quiet, warn: quiet, error: quiet } });
  base = server.url.replace(/\/$/, '');
  server.storage.savePlayer(PIDS.a, 'Ann');
  server.storage.savePlayer(PIDS.b, 'Bēla');
  server.storage.savePlayer(PIDS.c, 'Cai');
});

after(() => server.close());

/**
 * POST JSON, the way the page does.
 * @param {string} path
 * @param {unknown} body
 */
function post(path, body) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/**
 * Start a game for two over HTTP.
 * @param {string} token
 */
const start = (token) => post('/api/games', { token, players: 2 });

test('three games waiting, or seats in three under way, send a player back to them', async () => {
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const res = await start(TOKENS.a);
    assert.equal(res.status, 201);
    ids.push((await res.json()).id);
  }
  const refused = await start(TOKENS.a);
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.match(body.error, /^You have 3 games of yours waiting for a player\./);
  assert.deepEqual(body.games.map((/** @type {any} */ g) => g.id).sort(), [...ids].sort());
  assert.ok(body.games.every((/** @type {any} */ g) => GAME_NAMES.includes(g.name) && !('creator' in g)), 'named, as the lobby lists them');
  assert.ok(body.games.every((/** @type {any} */ g) => g.clear === 'delete'), 'hers, nobody else in them: she may delete them');
  assert.equal((await start(TOKENS.b)).status, 201, 'others may still start games');
  // Who started a game is kept, and shown nowhere.
  const listed = await (await fetch(`${base}/api/games`)).json();
  assert.ok(listed.every((/** @type {any} */ g) => !('creator' in g)));
  assert.equal('creator' in await (await fetch(`${base}/api/games/${ids[0]}`)).json(), false);

  // Bēla fills one of Ann's: it waits no more, so Ann may start another.
  server.storage.saveSeats(ids[0], [PIDS.a, PIDS.b]);
  assert.equal((await start(TOKENS.a)).status, 201);

  // Bēla now sits in three of Ann's games under way: she must play one first.
  server.storage.saveSeats(ids[1], [null, PIDS.b]);
  server.storage.saveSeats(ids[2], [null, PIDS.b]);
  const seated = await start(TOKENS.b);
  assert.equal(seated.status, 409);
  const why = await seated.json();
  assert.match(why.error, /^You have a seat in 3 games under way\./);
  assert.deepEqual(why.games.map((/** @type {any} */ g) => g.id).sort(), [...ids].sort());
  assert.ok(why.games.every((/** @type {any} */ g) => g.clear === 'leave'), 'Ann\'s games: Bēla may leave them');

  // A game that is over doesn't count.
  const saved = server.storage.loadGame(ids[2]);
  server.storage.saveSnapshot(ids[2], { state: { .../** @type {any} */ (saved?.state), over: 10 }, seq: 0 });
  assert.equal((await start(TOKENS.b)).status, 201);
});

test('a player deletes a game of theirs that nobody else plays, or leaves one, to start another', async () => {
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await (await start(TOKENS.c)).json()).id);
  assert.equal((await start(TOKENS.c)).status, 409);
  const act = (/** @type {string} */ id, /** @type {string} */ what, token = TOKENS.c) => post(`/api/games/${id}/${what}`, { token });

  assert.equal((await act(ids[0], 'delete', TOKENS.a)).status, 403, 'not hers to delete');
  assert.equal((await act(ids[0], 'delete', 'x'.repeat(32))).status, 401);
  assert.equal((await act('nope', 'delete')).status, 404);
  assert.deepEqual(await (await act(ids[0], 'delete')).json(), { ok: true });
  assert.equal((await fetch(`${base}/api/games/${ids[0]}`)).status, 404, 'gone');
  assert.equal((await start(TOKENS.c)).status, 201, 'room for another');

  // Once someone else sits in one, Cai may only leave it, and only a seat he holds.
  server.storage.saveSeats(ids[1], [PIDS.c, PIDS.a]);
  assert.deepEqual(await (await act(ids[1], 'delete')).json(), { error: 'someone else plays it' });
  assert.deepEqual(await (await act(ids[1], 'leave')).json(), { ok: true });
  assert.deepEqual(server.storage.loadGame(ids[1])?.seats, [null, PIDS.a]);
  assert.deepEqual(await (await act(ids[1], 'leave')).json(), { error: 'you have no seat there' });
});
