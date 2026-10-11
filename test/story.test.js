import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { advance, applyCommand, checkState, publicView } from '../src/core/game.js';
import { MAX_HUNGER, START_STONE, START_UNITS, TICKS_PER_SECOND } from '../src/core/rules.js';
import { ACT_WORDS, storyTip } from '../src/client/story/story.js';
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

test("Starving village's tips come at their game seconds, each once, and not to a page that comes late", () => {
  const story = newStoryGame(0).state.story;
  const at = (/** @type {number} */ second, after = 0) => storyTip({ tick: second * TICKS_PER_SECOND, story }, after)?.word ?? null;
  assert.equal(at(7), null);
  assert.equal(at(8), 'tipStarvingFarm');
  assert.equal(at(8, 8), null, 'shown once');
  assert.equal(at(9.5), 'tipStarvingFarm');
  assert.equal(at(10), null, 'too late for it');
  assert.deepEqual([at(20, 8), at(34, 20), at(40, 34)], ['tipStarvingPit', 'tipStarvingCrew', 'tipStarvingLuck']);
  assert.equal(storyTip({ tick: 8 * TICKS_PER_SECOND, over: 80, story }, 0), null, 'none once over');
  for (const words of Object.values(ACT_WORDS)) {
    assert.deepEqual(words.tips.map(([s]) => s), words.tips.map(([s]) => s).sort((a, b) => a - b), 'in order');
  }
});
