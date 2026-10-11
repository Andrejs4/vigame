import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { advance, applyCommand, checkState, publicView } from '../src/core/game.js';
import { MAX_HUNGER, START_STONE, START_UNITS } from '../src/core/rules.js';
import { ACTS, actOf, newStoryGame } from '../src/story/acts.js';
import { direct } from '../src/story/director.js';

/** @param {number} seed */
const boardOf = (seed) => createBoard({ ...BOARD_OPTIONS, seed, players: 1 });

test('the first act, Starving village: your castle alone, starving, the same for every player', () => {
  assert.equal(ACTS[0].id, 'starving-village');
  const { seed, state } = newStoryGame(0);
  assert.deepEqual(checkState(boardOf(seed), state), []);
  assert.deepEqual(newStoryGame(0), { seed, state }, 'the same map and opening every time');
  assert.equal(state.name, 'Starving village');
  assert.deepEqual(state.story, { act: 'starving-village', builds: ['pit', 'farm'], until: 10 * 60 * 10, final: true });
  const you = state.players[0];
  assert.deepEqual([you.hunger, you.food, you.stone], [MAX_HUNGER, 0, START_STONE], 'starving, with the usual stone');
  assert.equal(Object.keys(state.units).length, START_UNITS);
  assert.deepEqual(Object.values(state.buildings).map((b) => b.type), ['castle'], 'no Dark Lord, nobody else');
  assert.deepEqual(state.players.map((p) => p.team), [0, -1], 'you, and the raiders');
  assert.deepEqual(publicView(state).story, state.story, 'the page sees the act');
  assert.equal(state.breeding, 'normal');
});

test('an act allows only its buildings', () => {
  const { seed, state } = newStoryGame(0);
  const board = boardOf(seed);
  const castle = Object.values(state.buildings)[0];
  const spot = board.list.find((t) => t.buildable && Math.abs(t.q - castle.q) + Math.abs(t.r - castle.r) === 3);
  assert.ok(spot);
  for (const kind of ['tower', 'band']) {
    assert.deepEqual(applyCommand(board, structuredClone(state), 0, { type: 'build', kind, q: spot.q, r: spot.r, units: [Object.keys(state.units)[0]] }),
      { ok: false, reason: 'not in this act' }, kind);
  }
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'farm', q: spot.q, r: spot.r }), { ok: true });
  assert.deepEqual(checkState(board, { ...state, story: { ...state.story, builds: ['lair'] } }), ['bad story']);
});

test('the director ends Starving village: won once hunger is gone, or at the time with food for all; lost with nobody left, the castle fallen, or food short', () => {
  const play = (/** @type {(s: any) => void} */ change) => {
    const { seed, state } = newStoryGame(0);
    advance(boardOf(seed), state);
    change(state);
    direct(state);
    return [state.story?.result, state.over, state.winner];
  };
  assert.deepEqual(play(() => {}), [undefined, undefined, undefined], 'it goes on');
  assert.deepEqual(play((s) => { s.players[0].hunger = 0; }), ['fed', 1, 0]);
  assert.deepEqual(play((s) => { s.units = {}; }), ['empty', 1, undefined]);
  assert.deepEqual(play((s) => { s.players[0].lost = 1; }), ['fallen', 1, undefined]);
  const until = /** @type {number} */ (newStoryGame(0).state.story?.until);
  // The meal as time runs out, looked at the tick before: 12 units, and
  // the castle's harvest feeds 20; with 20 more, it falls short.
  assert.deepEqual(play((s) => { s.tick = s.story.until - 1; }), ['supplied', until - 1, 0], 'food for everyone at that meal');
  const crowd = (/** @type {any} */ s) => {
    const one = Object.values(s.units)[0];
    for (let i = 0; i < 20; i++) s.units[`x${i}`] = { ...one, id: `x${i}` };
  };
  assert.deepEqual(play((s) => { s.tick = s.story.until - 1; crowd(s); }), [undefined, undefined, undefined], 'food short for 32: not yet');
  assert.deepEqual(play((s) => { s.tick = s.story.until; crowd(s); }), ['time', until, undefined], 'and then lost');
  // Won is won: a game already over is left alone.
  const { state } = newStoryGame(0);
  state.over = 5;
  state.players[0].hunger = 0;
  assert.equal(direct(state), false);
  assert.equal(actOf('nope'), null);
});
