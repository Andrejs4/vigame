import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { distance } from '../src/core/hex.js';
import { advance, applyCommand, checkState, publicView } from '../src/core/game.js';
import { COMBAT_PERIOD, MAX_HUNGER, START_STONE, START_UNITS, TICKS_PER_SECOND } from '../src/core/rules.js';
import { openBoard, stateWith, unitsIn } from './helpers.js';
import { ACT_WORDS, storyTip } from '../src/client/story/story.js';
import { ACTS, CAMPS, WAVES, actOf, newStoryGame, veteransOf } from '../src/story/acts.js';
import { direct } from '../src/story/director.js';

/** @param {number} seed */
const boardOf = (seed) => createBoard({ ...BOARD_OPTIONS, seed, players: 1 });

test('the first act, Starving village: your castle alone, starving, the same for every player', () => {
  assert.equal(ACTS[0].id, 'starving-village');
  const { seed, state } = newStoryGame(0);
  assert.deepEqual(checkState(boardOf(seed), state), []);
  assert.deepEqual(newStoryGame(0), { seed, state }, 'the same map and opening every time');
  assert.equal(state.name, 'Starving village');
  assert.deepEqual(state.story, { act: 'starving-village', builds: ['pit', 'farm'], until: 10 * 60 * 10 });
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
    direct(boardOf(seed), state);
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
  assert.equal(direct(boardOf(newStoryGame(0).seed), state), false);
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
  assert.deepEqual([at(20, 8), at(34, 20), at(60, 34)], ['tipStarvingPit', 'tipStarvingCrew', 'tipStarvingLuck']);
  assert.equal(storyTip({ tick: 8 * TICKS_PER_SECOND, over: 80, story }, 0), null, 'none once over');
  for (const words of Object.values(ACT_WORDS)) {
    assert.deepEqual(words.tips.map(([s]) => s), words.tips.map(([s]) => s).sort((a, b) => a - b), 'in order');
  }
});

test('the second act, Village defence: a fresh castle on a fresh map, waves from across it, held for ten minutes', () => {
  assert.equal(ACTS[1].id, 'village-defence');
  const { seed, state } = newStoryGame(1);
  const board = boardOf(seed);
  assert.notEqual(seed, newStoryGame(0).seed, 'another map');
  assert.deepEqual(checkState(board, state), []);
  assert.deepEqual(state.story, { act: 'village-defence', builds: ['pit', 'farm', 'tower'], until: 10 * 60 * 10 });
  assert.equal(state.name, 'Village defence');
  assert.deepEqual(Object.values(state.buildings).map((b) => b.type), ['castle'], 'the Dark Lord has no lair');
  assert.deepEqual([state.players[0].hunger, state.players[0].food, state.players[0].stone], [0, 0, START_STONE]);
  const castle = /** @type {any} */ (Object.values(state.buildings)[0]);
  const monsters = () => Object.values(state.buildings).filter((b) => b.owner === 1);
  // The waves: none before WAVES.first, then bigger each WAVES.every, far from the castle.
  const until = (/** @type {number} */ tick) => {
    while (state.tick < tick) {
      advance(board, state);
      direct(board, state);
    }
  };
  until(WAVES.first - 1);
  assert.equal(monsters().length, 0);
  until(WAVES.first);
  assert.deepEqual(monsters().map((b) => b.type), ['ghoul', 'ghoul']);
  assert.ok(monsters().every((b) => distance(b, castle) >= 18), 'across the map');
  assert.equal(monsters()[0].hp, 600, 'the Easy Lord\'s, at half their hit points');
  assert.deepEqual(checkState(board, state), []);
  const again = newStoryGame(1).state;
  for (let i = 0; i < WAVES.first; i++) {
    advance(board, again);
    direct(board, again);
  }
  assert.deepEqual(again, state, 'the same in every game');
  // Won if the castle stands when time runs out; lost if it falls, though the core ended the game.
  const end = (/** @type {(s: any) => void} */ change) => {
    const s = newStoryGame(1).state;
    change(s);
    advance(board, s);
    direct(board, s);
    return [s.story?.result, s.over, s.winner];
  };
  const last = 10 * 60 * 10;
  assert.deepEqual(end((s) => { s.tick = last - 1; }), ['held', last, 0]);
  assert.deepEqual(end(() => {}), [undefined, undefined, undefined]);
  assert.deepEqual(end((s) => { Object.values(s.buildings)[0].hp = 0; }), ['fallen', 1, undefined], 'not the Dark Lord\'s win');
  assert.deepEqual(end((s) => { s.units = {}; }), ['empty', 1, undefined]);
});

test("an act's heroes go on to the next: each hero born there takes one's place, the best first, then new ones are born", () => {
  const { seed, state } = newStoryGame(0);
  const board = boardOf(seed);
  const skills = (/** @type {number} */ n) => ({ breeding: n, ranged: n, melee: n, build: 0, farming: n, running: 0 });
  /** @type {import('../src/core/game.js').Veteran[]} */
  const pool = [
    { name: 'Old Ada', level: 30, xp: 5, skills: skills(20), practice: skills(3) },
    { name: 'Old Bo', level: 12, xp: 0, skills: skills(4), practice: skills(0) },
  ];
  // Two of the first act's units made heroes, one already gone.
  const units = /** @type {any[]} */ (Object.values(state.units));
  units[0].hero = true;
  units[1].hero = true;
  delete state.units[units[1].id];
  const veterans = veteransOf({ ...state, story: { ...state.story, heroes: [pool[1]] } });
  assert.deepEqual(veterans.map((v) => v.name), ['Old Bo', units[0].name], 'the living, and those still waiting, the best first');
  assert.deepEqual(Object.keys(veterans[1]).sort(), ['level', 'name', 'practice', 'skills', 'xp']);

  // The next act: its opening heroes are the veterans, the rest wait for heroes born.
  const next = newStoryGame(1, pool);
  const heroes = Object.values(next.state.units).filter((u) => u.hero);
  const placed = Math.min(heroes.length, pool.length);
  heroes.slice(0, placed).forEach((u, i) => assert.deepEqual({ name: u.name, level: u.level, xp: u.xp, skills: u.skills, practice: u.practice }, pool[i]));
  assert.ok(heroes.slice(placed).every((u) => u.level === 1), 'then new ones');
  assert.deepEqual(next.state.story?.heroes ?? [], pool.slice(placed), 'still waiting');
  assert.equal(publicView(next.state).story?.heroes, undefined, 'players aren\'t shown them');
  const nextBoard = boardOf(next.seed);
  assert.deepEqual(checkState(nextBoard, next.state), []);
  // Played on, the next heroes born take the rest; then new ones come.
  while (next.state.story?.heroes && next.state.tick < 20 * 60 * TICKS_PER_SECOND) {
    advance(nextBoard, next.state);
    direct(nextBoard, next.state);
  }
  assert.equal(next.state.story?.heroes, undefined, 'all placed');
  const names = Object.values(next.state.units).map((u) => u.name);
  for (const v of pool) assert.ok(names.includes(v.name), `${v.name} born again`);
  const ada = /** @type {any} */ (Object.values(next.state.units).find((u) => u.name === 'Old Ada'));
  assert.ok(ada.level >= 30, 'with its levels');
  assert.deepEqual(checkState(nextBoard, next.state), []);
  assert.deepEqual(checkState(board, { ...state, story: { ...state.story, heroes: [{ ...pool[0], level: 0 }] } }), ['bad story hero']);
  assert.deepEqual(checkState(board, { ...state, story: { ...state.story, heroes: [] } }), ['bad story']);
});

test('the third act, Clearing the woods: camps of guards across the map; cleared, it is won; at ten minutes, all come with a last wave', () => {
  assert.equal(ACTS[2].id, 'clearing-woods');
  const { seed, state } = newStoryGame(2);
  const board = boardOf(seed);
  assert.deepEqual(checkState(board, state), []);
  assert.deepEqual(state.story, { act: 'clearing-woods', builds: ['pit', 'farm', 'tower', 'band'], until: 10 * 60 * 10, final: true });
  assert.deepEqual(newStoryGame(2), { seed, state }, 'the same for every player');
  const castle = /** @type {any} */ (Object.values(state.buildings).find((b) => b.type === 'castle'));
  const monsters = () => Object.values(state.buildings).filter((b) => b.owner === 1);
  assert.equal(monsters().length, CAMPS.count * CAMPS.camp.length);
  assert.ok(monsters().every((b) => b.home && b.home[0] === b.q && b.home[1] === b.r), 'each guards its cell');
  assert.ok(monsters().every((b) => distance(b, castle) >= CAMPS.far - 1), 'far from the castle');
  assert.ok(!Object.values(state.buildings).some((b) => b.type === 'lair'));
  // Left alone, they stay home for the ten minutes.
  const step = (/** @type {any} */ s, /** @type {number} */ n) => {
    for (let i = 0; i < n; i++) {
      advance(board, s);
      direct(board, s);
    }
  };
  const quiet = structuredClone(state);
  for (const u of Object.values(quiet.units)) u.in = castle.id;
  step(quiet, 60 * TICKS_PER_SECOND);
  const homes = (/** @type {any} */ s) => Object.values(s.buildings).filter((b) => /** @type {any} */ (b).owner === 1)
    .map((b) => /** @type {any} */ (b)).filter((b) => b.home && distance(b, { q: b.home[0], r: b.home[1] }) > 0).length;
  assert.equal(homes(quiet), 0, 'none wandered off');
  // At its time, a last wave, and none guards any more.
  const late = structuredClone(state);
  late.tick = /** @type {number} */ (late.story?.until) - 1;
  step(late, 1);
  const lord = Object.values(late.buildings).filter((b) => b.owner === 1);
  assert.equal(lord.length, CAMPS.count * CAMPS.camp.length + CAMPS.last.length);
  assert.ok(lord.every((b) => b.home === undefined), 'all come for the castle');
  assert.deepEqual(checkState(board, late), []);
  // Cleared, won; the castle fallen, lost.
  const end = (/** @type {(s: any) => void} */ change) => {
    const s = newStoryGame(2).state;
    change(s);
    step(s, 1);
    return [s.story?.result, s.over, s.winner];
  };
  const clear = (/** @type {any} */ s) => { for (const b of Object.values(s.buildings)) if (/** @type {any} */ (b).owner === 1) delete s.buildings[/** @type {any} */ (b).id]; };
  assert.deepEqual(end(clear), ['cleared', 1, 0]);
  assert.deepEqual(end(() => {}), [undefined, undefined, undefined]);
  assert.deepEqual(end((s) => { Object.values(s.buildings)[0].hp = 0; }), ['fallen', 1, undefined]);
});

test('a guard goes for an enemy near its home, gives up one too far, and goes back home', () => {
  const board = openBoard(14);
  const state = stateWith(
    [{ id: 'b1', type: 'castle', q: 0, r: 0 }, { id: 'b2', type: 'ghoul', owner: 1, q: 9, r: 0 }, { id: 'b3', type: 'farm', q: 5, r: 0 }],
    unitsIn('b1', 5, 1),
  );
  state.buildings.b2.home = [9, 0];
  const ticks = (/** @type {number} */ n) => { for (let i = 0; i < n; i++) advance(board, state); };
  ticks(COMBAT_PERIOD);
  assert.equal(state.buildings.b2.target, 'b3', 'the farm, 4 from its home');
  assert.deepEqual(checkState(board, state), []);
  // The farm gone, the castle is too far: it goes home.
  delete state.buildings.b3;
  ticks(30 * TICKS_PER_SECOND);
  assert.equal(state.buildings.b2.target, undefined);
  assert.deepEqual([state.buildings.b2.q, state.buildings.b2.r], [9, 0], 'back home');
  // Led off too far (say, struck from afar), it gives up and comes back.
  state.buildings.b2.home = [11, 0];
  state.buildings.b2.target = 'b1';
  ticks(COMBAT_PERIOD);
  assert.equal(state.buildings.b2.target, undefined, 'the castle is 10 from its home, past GUARD_LEASH');
  assert.deepEqual(checkState(board, { ...state, buildings: { ...state.buildings, b1: { ...state.buildings.b1, home: [0, 0] } } }), ['building b1: bad home']);
});
