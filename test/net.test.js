import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/board.js';
import { newGame } from '../src/game.js';
import { createLocalNet } from '../src/net.js';
import { TICKS_PER_SECOND } from '../src/rules.js';
import { run } from './helpers.js';

const TICK_MS = 1000 / TICKS_PER_SECOND;

test('the local transport runs the game on its own clock, and never races to catch up', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ms = 0;
  const board = createBoard({ ...BOARD_OPTIONS, seed: 1337 });
  const net = createLocalNet({ board, state: newGame(board), now: () => ms });
  /** @type {number[]} */
  const ticks = [];
  net.onState((view) => ticks.push(view.tick));
  assert.deepEqual(ticks, [0], 'a new listener gets the game at once');

  ms = 2.5 * TICK_MS;
  t.mock.timers.tick(ms);
  assert.equal(ticks.at(-1), 2);
  assert.equal(net.clock(), 2.5, 'between ticks, for drawing motion');
  assert.equal(net.running(), true);

  // A tab that slept for a minute carries on from where it was.
  ms = 60_000;
  t.mock.timers.tick(ms - 2.5 * TICK_MS);
  assert.equal(ticks.at(-1), 3);
  net.stop();
});

test('the local transport gives commands as the side being played, and can switch sides', async () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 1337 });
  const state = newGame(board);
  run(board, state, 1);
  const net = createLocalNet({ board, state, now: () => 0 });
  net.stop();
  /** @type {Array<number | null>} */
  const seats = [];
  net.onSeat((seat) => seats.push(seat));

  assert.equal(net.seat(), 0);
  assert.deepEqual(await net.send({ type: 'upgrade', building: 'b2' }), { ok: false, reason: 'not your building' });
  assert.deepEqual(await net.send({ type: 'upgrade', building: 'b1' }), { ok: true });
  net.switchSide();
  assert.deepEqual(seats, [1]);
  assert.deepEqual(await net.send({ type: 'upgrade', building: 'b2' }), { ok: true });
  assert.deepEqual([state.buildings.b1.grade, state.buildings.b2.grade], [2, 2]);
});
