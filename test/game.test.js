import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import {
  advance, applyCommand, capacityOf, checkState, crewOf, footprint, levelXp, newGame, occupancy, publicView, random,
  depthOf, endWinner, fullMeal, sharesStock, isRising, killChance, maxHp, pointsOf, quickWin, scoreOf, seatsOf, starveChance, ROOM_COMMANDS, teamOfSeat, workFor,
} from '../src/core/game.js';
import {
  BAND_TRAINING, BUILDING_TYPES, COMBAT_PERIOD, DARK_LORD, TICKS_PER_SECOND, HORDE_PERIOD, HORDE_START, RAIDERS, RAID_PERIOD, RAID_PER_PLAYER, SALVAGE, SIDES, FOOD_PER_UNIT, FOOD_PERIOD, KILL_XP, LEVEL_RATE, RANGED_DAMAGE, LEVEL_XP, MAX_HUNGER, MAX_LEVEL, SKILL_RATE, SKILL_XP, START_UNITS, UNIT_LIMIT, WAGON_PATIENCE,
  WALK_TICKS, WORK_BASE,
} from '../src/core/rules.js';
import { distance } from '../src/core/hex.js';
import { GAME_NAMES } from '../src/core/names.js';
import { boardFrom, noTally, openBoard, run, runUntil, skillsAt, stateWith, unitsIn } from './helpers.js';

const OK = { ok: true };

/** The stone dug from a pit once it is dug out. */
const DUG_OUT = /** @type {number} */ (BUILDING_TYPES.pit.depth) * /** @type {number} */ (BUILDING_TYPES.pit.perDepth);

/** A whole unit, from the fields a test cares about. */
const unit = (/** @type {Partial<import('../src/core/game.js').Unit> & { id: string }} */ u) => stateWith([], [u]).units[u.id];

test('a new game has a castle per player on the start sites, with named units inside, as plain JSON', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 1337 });
  const state = newGame(board);
  assert.deepEqual(checkState(board, state), []);
  assert.equal(state.mode, 'coop', 'cooperation by default');
  assert.ok(GAME_NAMES.includes(state.name), 'named from the preset list');
  assert.equal(publicView(state).name, state.name, 'which everyone sees');
  assert.deepEqual(
    Object.values(state.buildings).map((b) => [b.owner, b.type, b.q, b.r]),
    board.starts.map((s, owner) => [owner, owner === 2 ? 'lair' : 'castle', s.q, s.r]),
  );
  assert.deepEqual(state.players.map((p) => p.team), [0, 0, 1, -1], 'the players against the Dark Lord, and the raiders against all');
  const occ = occupancy(state);
  assert.deepEqual(Object.values(state.buildings).map((b) => occ.inside.get(b.id)?.length), [START_UNITS, START_UNITS, 0]);
  const ffa = newGame(board, { mode: 'ffa' });
  assert.deepEqual(checkState(board, ffa), []);
  assert.deepEqual([ffa.players.map((p) => p.team), Object.values(ffa.buildings).map((b) => b.type)], [[0, 1, -1], ['castle', 'castle']]);
  const names = Object.values(state.units).map((u) => u.name);
  for (const name of names) assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.ok(new Set(names).size > START_UNITS, 'names vary');
  assert.ok(Object.values(state.units).every((u) => u.level === 1 && Object.values(u.skills).every((s) => s === 0)));
  assert.equal(footprint('castle', 0, 0).length, 7, 'a castle covers a cell and its six neighbours');
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.deepEqual(newGame(board), state, 'the same seed names the same units');
});

test('games seat 1 to 16 players, on maps that grow with them', () => {
  for (const players of [1, 8, 9, 16]) {
    const board = createBoard({ ...BOARD_OPTIONS, seed: 9, players });
    assert.equal(board.starts.length, players + 1, 'a site per player, and the lair\'s');
    for (const mode of players > 1 ? ['coop', 'easy', 'shared', 'teams', 'ffa'] : ['coop', 'easy', 'shared']) {
      const state = newGame(board, { mode });
      assert.deepEqual(checkState(board, state), [], `${players} players, ${mode}`);
      assert.equal(seatsOf(state), players);
      assert.equal(Object.values(state.buildings).filter((b) => b.type === 'castle').length, players);
      // Each seat has a colour of its own, never the Dark Lord's or the raiders'.
      const seats = state.players.slice(0, players).map((p) => p.side);
      assert.equal(new Set(seats).size, players);
      assert.ok(seats.every((side) => !SIDES[side].npc), `${players} players, ${mode}`);
    }
  }
  assert.deepEqual(newGame(createBoard({ ...BOARD_OPTIONS, seed: 9, players: 2 })).players.map((p) => p.side), [0, 1, DARK_LORD, RAIDERS],
    'the first eight seats keep the colours they had before there were more');
  assert.ok(createBoard({ ...BOARD_OPTIONS, seed: 9, players: 8 }).list.length > 3 * createBoard({ ...BOARD_OPTIONS, seed: 9 }).list.length);
});

// --- breeding, levels and skills ---------------------------------------------

test('a castle\'s units raise new ones, sooner the more there are and the better they breed', () => {
  const board = openBoard(4);
  const { work = 0, idleWork = 0 } = BUILDING_TYPES.castle;
  /** @param {Array<Partial<import('../src/core/game.js').Unit> & { id: string }>} units */
  const firstBirth = (units) => {
    const state = stateWith([{ id: 'b1', type: 'castle' }], units);
    const before = Object.keys(state.units).length;
    return runUntil(board, state, () => Object.keys(state.units).length > before, 2 * work);
  };
  const ten = unitsIn('b1', 10, 10);
  assert.equal(firstBirth(ten), Math.ceil(work / (10 * WORK_BASE + idleWork)));
  assert.equal(firstBirth(unitsIn('b1', 20, 10)), Math.ceil(work / (20 * WORK_BASE + idleWork)));
  const breeders = ten.map((u) => ({ ...u, level: WORK_BASE, skills: { ...skillsAt(0), breeding: WORK_BASE } }));
  assert.equal(firstBirth(breeders), Math.ceil(work / (10 * 2 * WORK_BASE + idleWork)), 'skill adds to the work');
  assert.equal(firstBirth([]), Math.ceil(work / idleWork), 'slowly, with nobody at home');

  const state = stateWith([{ id: 'b1', type: 'castle' }], ten);
  runUntil(board, state, () => Object.keys(state.units).length > 10);
  const [born] = Object.values(state.units).slice(-1);
  assert.deepEqual(born, { ...born, id: 'u20', owner: 0, level: 1, xp: 0, skills: skillsAt(0), in: 'b1' });
  assert.equal(born.born, state.tick, 'it knows when it was born');
  assert.match(born.name, /^\w+ \w+$/);
});

test('a full castle raises no one, and its units learn nothing meanwhile', () => {
  const board = openBoard(4);
  const { capacity } = BUILDING_TYPES.castle;
  const state = stateWith([{ id: 'b1', type: 'castle' }], unitsIn('b1', capacity, 10));
  run(board, state, 100);
  assert.equal(Object.keys(state.units).length, capacity);
  assert.equal(state.buildings.b1.work, 0);
  assert.ok(Object.values(state.units).every((u) => u.xp === 0));
});

test('no side makes units past the unit limit', () => {
  const board = openBoard(5);
  // Full towers round the castle, and the rest of the limit at home.
  const towers = [
    { id: 'b2', grade: 3, q: 3, r: 0 }, { id: 'b3', grade: 3, q: -3, r: 0 }, { id: 'b4', grade: 3, q: 0, r: 3 },
    { id: 'b5', grade: 3, q: 0, r: -3 }, { id: 'b6', grade: 1, q: 3, r: -3 },
  ];
  const castle = { id: 'b1', type: 'castle', grade: 3 };
  const room = (/** @type {{ type?: string, grade: number }} */ b) => capacityOf(/** @type {any} */ ({ type: 'tower', ...b }));
  const inCastle = UNIT_LIMIT - towers.reduce((sum, t) => sum + room(t), 0);
  assert.ok(inCastle > 0 && inCastle < room(castle), 'the castle still has room');
  const state = stateWith([castle, ...towers], [
    ...unitsIn('b1', inCastle, 1000),
    ...towers.flatMap((t, i) => unitsIn(t.id, room(t), 2000 + 1000 * i)),
  ]);
  assert.deepEqual(checkState(board, state), []);
  run(board, state, 100);
  assert.equal(Object.keys(state.units).length, UNIT_LIMIT);
});

test('work trains its skill up to the unit\'s level, and the level, each more slowly than the last', () => {
  const board = openBoard(3);
  const state = stateWith([{ id: 'b1', type: 'pit', q: 1, r: 0 }], unitsIn('b1', 1, 10));
  const u = state.units.u10;

  run(board, state, SKILL_XP);
  assert.deepEqual([u.level, u.skills.build, u.practice.build], [1, 1, 0], 'a skill level takes SKILL_XP ticks of work');
  const perLevel = (/** @type {number} */ level) => levelXp(level) / LEVEL_RATE.build;
  assert.equal(perLevel(1), LEVEL_XP / LEVEL_RATE.build);
  run(board, state, perLevel(1) - SKILL_XP - 1);
  assert.deepEqual([u.level, u.skills.build, u.practice.build], [1, 1, SKILL_XP - 1]);
  run(board, state, 1);
  assert.deepEqual([u.level, u.xp, u.skills.build, u.practice.build], [2, 0, 2, 0], 'a level takes LEVEL_XP');
  run(board, state, SKILL_XP);
  assert.deepEqual([u.skills.build, u.practice.build], [2, SKILL_XP], 'the skill waits for the level');
  run(board, state, perLevel(2) - SKILL_XP);
  assert.deepEqual([u.level, u.skills.build], [3, 3], 'and rises with it');
  assert.deepEqual({ ...u.skills, build: 0 }, skillsAt(0), 'other skills are untouched');

  assert.ok(levelXp(2) > levelXp(1) && levelXp(MAX_LEVEL - 1) > 1000 * levelXp(1), 'levels take ever longer');
  assert.equal(levelXp(MAX_LEVEL), Infinity);
  u.level = MAX_LEVEL - 1;
  u.xp = levelXp(MAX_LEVEL - 1) - 1;
  run(board, state, 2);
  assert.deepEqual([u.level, u.xp], [MAX_LEVEL, 0], 'the top level is the last');
});

test('about one unit in ten is a hero, whose levels cost less: three times as high for the same work', () => {
  // The first units of twenty games: heroes among them, about one in ten.
  const units = Array.from({ length: 20 }, (_, i) => Object.values(newGame(createBoard({ ...BOARD_OPTIONS, seed: 100 + i })).units)).flat();
  const heroes = units.filter((u) => u.hero).length;
  assert.ok(heroes > units.length * 0.05 && heroes < units.length * 0.2, `${heroes} heroes of ${units.length}`);
  assert.ok(units.every((u) => u.hero === undefined || u.hero === true));

  // What a hero reaches with the experience that takes an ordinary unit to a level.
  const reached = (/** @type {boolean} */ hero, /** @type {number} */ xp) => {
    let level = 1;
    while (level < MAX_LEVEL && xp >= levelXp(level, hero)) xp -= levelXp(level++, hero);
    return level;
  };
  const toLevel = (/** @type {number} */ level) => Array.from({ length: level - 1 }, (_, i) => levelXp(i + 1)).reduce((a, b) => a + b, 0);
  assert.deepEqual([5, 10, 20].map((level) => reached(true, toLevel(level))), [12, 27, 58]);
  assert.equal(reached(true, toLevel(34)), MAX_LEVEL, 'and stops at the top');

  // A hero levels up on its own table as it works.
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', type: 'pit', q: 3, r: 0 }], unitsIn('b2', 1, 10));
  state.units.u10.hero = true;
  run(board, state, Math.ceil(levelXp(1, true) / LEVEL_RATE.build));
  assert.equal(state.units.u10.level, 2, 'sooner than LEVEL_XP');
  state.units.u10.hero = /** @type {any} */ (false);
  assert.deepEqual(checkState(board, state), ['unit u10: bad hero']);
});

// --- crews ---------------------------------------------------------------------

test('a crew leaves one per tick, walks a cell in two seconds, and goes inside', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b1', 5, 10));
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b2', units: ['u10', 'u11', 'u12'] }), OK);

  const out = Object.values(state.units).filter((u) => u.in === undefined);
  assert.deepEqual(out.map((u) => u.id), ['u10', 'u11', 'u12']);
  const { q, r, path, to, since, until } = out[1];
  assert.deepEqual({ q, r, path, to, since, until }, {
    q: 0, r: 0, path: [[1, 0], [2, 0], [3, 0]], to: 'b2', since: 1, until: 1 + WALK_TICKS,
  });
  assert.deepEqual(crewOf(state, 'b2'), ['u10', 'u11', 'u12'], 'on their way, they are its crew already');

  run(board, state, 3 * WALK_TICKS - 1);
  assert.deepEqual(occupancy(state).inside.get('b2'), []);
  assert.deepEqual([state.units.u10.q, state.units.u10.r], [2, 0]);
  run(board, state, 1);
  assert.deepEqual(occupancy(state).inside.get('b2'), ['u10']);
  run(board, state, 2);
  assert.deepEqual(occupancy(state).inside.get('b2'), ['u10', 'u11', 'u12']);
  assert.equal(state.units.u10.practice.running, 3 * WALK_TICKS, 'walking trains running');
});

test('a new crew list sends those left off home, and an empty one sends them all', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], [
    ...unitsIn('b1', 2, 10), ...unitsIn('b2', 2, 20),
  ]);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b2', units: ['u21', 'u10'] }), OK);
  assert.deepEqual(crewOf(state, 'b2'), ['u10', 'u21']);
  runUntil(board, state, () => state.units.u20.in === 'b1' && state.units.u10.in === 'b2');
  assert.equal(state.units.u21.in, 'b2', 'one who stays, stays');

  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b2', units: [] }), OK);
  runUntil(board, state, () => crewOf(state, 'b2').length === 0 && Object.values(state.units).every((u) => u.in === 'b1'));
});

test('units called home leave any building or way to one; those home already stay', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }, { id: 'b3', q: 0, r: 3 }], [
    ...unitsIn('b1', 2, 10), ...unitsIn('b2', 3, 20),
  ]);
  // u11 sets off for b3, and is called back on the way with two of b2's crew.
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b3', units: ['u11'] }), OK);
  run(board, state, WALK_TICKS + 1);
  const call = { type: 'home', units: ['u10', 'u11', 'u20', 'u21'] };
  assert.deepEqual(applyCommand(board, state, 0, call), OK);
  assert.deepEqual(['u10', 'u11', 'u20', 'u21', 'u22'].map((id) => state.units[id].in ?? state.units[id].to), ['b1', 'b1', 'b1', 'b1', 'b2']);
  assert.deepEqual([state.units.u20.until, state.units.u21.until], [state.tick + WALK_TICKS, state.tick + 1 + WALK_TICKS], 'a tick apart');
  assert.deepEqual(applyCommand(board, state, 0, call), { ok: false, reason: 'they are all home' });
  runUntil(board, state, () => ['u10', 'u11', 'u20', 'u21'].every((id) => state.units[id].in === 'b1'));
  assert.deepEqual(crewOf(state, 'b2'), ['u22']);
  assert.deepEqual(crewOf(state, 'b3'), []);
  assert.deepEqual(checkState(board, state), []);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'home', units: ['nope'] }), { ok: false, reason: 'one of those units is gone' });
});

test('rough ground slows a unit, and running speeds it up, to a second a cell at best', () => {
  const board = boardFrom({ '0,0': 'grass', '1,0': 'scrub', '2,0': 'grass', '3,0': 'grass' });
  const walk = (/** @type {number} */ running) => {
    const state = stateWith([{ id: 'b1' }, { id: 'b2', q: 3, r: 0 }], [
      { id: 'u10', in: 'b1', level: MAX_LEVEL, skills: { ...skillsAt(0), running } },
    ]);
    assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b2', units: ['u10'] }), OK);
    return runUntil(board, state, () => state.units.u10.in === 'b2');
  };
  assert.equal(walk(0), 4 * WALK_TICKS, 'scrub costs two steps, grass one');
  assert.equal(walk(MAX_LEVEL), 2 * WALK_TICKS);
});

test('a full castle still takes its units in, and stops breeding; units follow a wagon that moved on', () => {
  const board = openBoard(4);
  const { capacity } = BUILDING_TYPES.castle;
  const full = stateWith(
    [{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }],
    [...unitsIn('b1', capacity, 100), ...unitsIn('b2', 2, 10)],
  );
  assert.deepEqual(applyCommand(board, full, 0, { type: 'crew', building: 'b2', units: [] }), OK);
  runUntil(board, full, () => full.units.u10.in === 'b1' && full.units.u11.in === 'b1');
  run(board, full, 100);
  assert.equal(occupancy(full).inside.get('b1')?.length, capacity + 2);
  assert.equal(Object.keys(full.units).length, capacity + 2, 'no one was born');

  const chase = stateWith([{ id: 'b1', q: -2, r: 0 }, { id: 'b2', type: 'wagon', q: 2, r: 0 }], unitsIn('b1', 1, 10));
  assert.deepEqual(applyCommand(board, chase, 0, { type: 'crew', building: 'b2', units: ['u10'] }), OK);
  assert.deepEqual(applyCommand(board, chase, 0, { type: 'move', building: 'b2', q: 2, r: -2 }), OK);
  runUntil(board, chase, () => chase.units.u10.in === 'b2');
  assert.deepEqual([chase.buildings.b2.q, chase.buildings.b2.r], [2, -2]);
});

// --- pits ------------------------------------------------------------------------

test('a pit goes up at half its hit points once its crew gets there, then they dig it deeper', () => {
  const board = openBoard(5);
  const state = stateWith([{ id: 'b1', type: 'castle' }], unitsIn('b1', 10, 10));
  const crew = ['u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17'];
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'pit', q: 3, r: 0, units: crew }), OK);
  assert.deepEqual(state.buildings.b20, {
    id: 'b20', owner: 0, type: 'pit', grade: 1, q: 3, r: 0, raised: 0, hp: BUILDING_TYPES.pit.hp / 2, work: 0, dug: 0,
  });
  assert.deepEqual(crewOf(state, 'b20'), crew);

  // Nothing goes up until someone is there; then each builder adds a tick of work.
  runUntil(board, state, () => (occupancy(state).inside.get('b20')?.length ?? 0) > 0);
  assert.equal(state.buildings.b20.raised, 0);
  const builders = occupancy(state).inside.get('b20')?.length ?? 0;
  run(board, state, 1);
  assert.equal(state.buildings.b20.raised, builders * WORK_BASE);
  runUntil(board, state, () => !isRising(state.buildings.b20), 1000);
  assert.equal(state.buildings.b20.hp, BUILDING_TYPES.pit.hp, 'full hit points once it stands');
  assert.equal(state.buildings.b20.work, 0, 'no digging while it went up');
  assert.ok(state.units.u10.xp > 0 && state.units.u10.practice.build > 0, 'building trains the builders');

  runUntil(board, state, () => occupancy(state).inside.get('b20')?.length === crew.length);
  const { work } = state.buildings.b20;
  run(board, state, 1);
  assert.equal(state.buildings.b20.work, /** @type {number} */ (work) + crew.length * WORK_BASE);
  const stone = state.players[0].stone;
  runUntil(board, state, () => state.buildings.b20.dug === 1, 1000);
  assert.equal(state.players[0].stone, stone + 1, 'straight into the stock');
});

test('a pit a grade deeper gains hit points', () => {
  const board = openBoard(4);
  const { work, perDepth, hp, hpPerDepth = 0 } = BUILDING_TYPES.pit;
  const state = stateWith([{ id: 'b1', type: 'pit', q: 1, r: 0, dug: /** @type {number} */ (perDepth) - 1, work: /** @type {number} */ (work) - 1 }], unitsIn('b1', 1, 10));
  assert.equal(maxHp(state, state.buildings.b1), hp);
  run(board, state, 1);
  assert.equal(depthOf(state.buildings.b1), 1);
  assert.equal(state.buildings.b1.hp, hp + hpPerDepth);
  assert.equal(maxHp(state, state.buildings.b1), hp + hpPerDepth);
});

test('a dug-out pit sends its crew home, and takes no other', () => {
  const board = openBoard(5);
  const { work, depth, perDepth } = BUILDING_TYPES.pit;
  const deepest = /** @type {number} */ (depth) * /** @type {number} */ (perDepth);
  const state = stateWith(
    [{ id: 'b1', type: 'castle' }, { id: 'b2', type: 'pit', q: 3, r: 0, dug: deepest - 1, work: /** @type {number} */ (work) - 1 }],
    [...unitsIn('b1', 1, 10), ...unitsIn('b2', 2, 20)],
  );
  run(board, state, 1);
  assert.deepEqual([state.buildings.b2.dug, state.buildings.b2.work], [deepest, 0]);
  assert.deepEqual(crewOf(state, 'b2'), []);
  assert.deepEqual([state.units.u20.to, state.units.u21.to], ['b1', 'b1']);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b2', units: ['u10'] }), { ok: false, reason: 'dug out' });
  runUntil(board, state, () => state.units.u20.in === 'b1' && state.units.u21.in === 'b1');
});

test('commands that are not allowed are refused, and change nothing', () => {
  // b4 stands on the edge, walled in by water.
  const board = openBoard(4, { '3,0': 'water', '3,1': 'water', '4,-1': 'water' });
  const state = stateWith([
    { id: 'b1', type: 'castle' }, { id: 'b2', q: -3, r: 0 }, { id: 'b3', owner: 1, q: 0, r: -3 }, { id: 'b4', q: 4, r: 0 },
    { id: 'b5', type: 'pit', q: 3, r: -3, dug: DUG_OUT }, { id: 'b6', type: 'pit', q: -3, r: 3 },
  ], [...unitsIn('b1', 10, 10), { id: 'u30', owner: 1, in: 'b3' }]);
  assert.deepEqual(checkState(board, state), []);
  const before = JSON.stringify(state);
  const nine = unitsIn('b1', 9, 10).map((u) => u.id);

  /** @type {Array<[number, unknown, string]>} */
  const refusals = [
    [0, { type: 'crew', building: 'b3', units: [] }, 'not your building'],
    [1, { type: 'crew', building: 'b2', units: [] }, 'not your building'],
    [0, { type: 'crew', building: '__proto__', units: [] }, 'that building is gone'],
    [0, { type: 'crew', building: 'b9', units: [] }, 'that building is gone'],
    [0, { type: 'upgrade', building: 'b9' }, 'that building is gone'],
    [0, { type: 'abort', building: 'b9' }, 'that building is gone'],
    [0, { type: 'target', building: 'b9', target: 'b3' }, 'that building is gone'],
    [0, { type: 'move', building: 'b9', q: 1, r: 1 }, 'that building is gone'],
    [0, { type: 'crew', building: 'b1', units: [] }, 'the castle is home to every unit'],
    [0, { type: 'crew', building: 'b5', units: [] }, 'dug out'],
    [0, { type: 'crew', building: 'b2', units: 'u10' }, 'bad units'],
    [0, { type: 'crew', building: 'b2', units: ['u10', 'u10'] }, 'bad units'],
    [0, { type: 'crew', building: 'b2', units: [10] }, 'bad units'],
    [0, { type: 'crew', building: 'b2', units: ['u30'] }, 'not your unit'],
    [0, { type: 'crew', building: 'b2', units: ['__proto__'] }, 'one of those units is gone'],
    [0, { type: 'crew', building: 'b2', units: ['u10', 'u99'] }, 'one of those units is gone'],
    [0, { type: 'crew', building: 'b6', units: nine }, 'too many units'],
    [0, { type: 'crew', building: 'b4', units: ['u10'] }, 'no way there'],
    [0, { type: 'build', kind: 'pit', q: -1, r: 2, units: 'u10' }, 'bad units'],
    [0, { type: 'build', kind: 'pit', q: -1, r: 2, units: nine }, 'too many units'],
    [0, { type: 'upgrade', building: 'b3' }, 'not your building'],
    [0, { type: 'upgrade', building: 'b6' }, 'fully upgraded'],
    [0, { type: 'move', building: 'b2', q: 1, r: 1 }, 'cannot move'],
    [0, { type: 'rename', name: 'a'.repeat(25) }, 'a name is 1 to 24 letters, digits and spaces'],
    [0, { type: 'rename', name: '<b>' }, 'a name is 1 to 24 letters, digits and spaces'],
    [0, { type: 'rename' }, 'a name is 1 to 24 letters, digits and spaces'],
    [0, { type: 'fly' }, 'unknown command'],
    [0, null, 'not a command'],
    [0, 'crew', 'not a command'],
    [2, { type: 'upgrade', building: 'b1' }, 'not a player'],
  ];
  for (const [player, command, reason] of refusals) {
    assert.deepEqual(applyCommand(board, state, player, command), { ok: false, reason }, JSON.stringify(command));
  }
  assert.equal(JSON.stringify(state), before);
});

test('any player may rename the game, while it goes on', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', owner: 1, type: 'castle', q: 3, r: 0 }]);
  assert.deepEqual(applyCommand(board, state, 1, { type: 'rename', name: '  Pit   party 2 ' }), OK);
  assert.equal(state.name, 'Pit party 2', 'tidied');
  state.name = 'Pit & party';
  assert.deepEqual(checkState(board, state), ['bad name']);
  state.name = 'Pit party';
  state.over = 10;
  assert.deepEqual(applyCommand(board, state, 0, { type: 'rename', name: 'Afterparty' }), { ok: false, reason: 'the game is over' });
});

// --- stone, food and hit points --------------------------------------------------

test('stone pays for towers, farms and upgrades; pits cost hunger and wagons dark metal', () => {
  const board = openBoard(5);
  const state = stateWith([{ id: 'b1', type: 'castle' }]);
  state.players[0].stone = 100;
  const build = (/** @type {string} */ kind, /** @type {number} */ q) => applyCommand(board, state, 0, { type: 'build', kind, q, r: 0 });
  assert.deepEqual(build('tower', 2), OK);
  assert.deepEqual(build('farm', 3), OK);
  assert.equal(state.players[0].stone, 100 - BUILDING_TYPES.tower.cost - BUILDING_TYPES.farm.cost);
  assert.deepEqual(build('tower', -2), { ok: false, reason: 'not enough stone' });
  assert.deepEqual(build('pit', -2), OK);
  assert.equal(state.players[0].hunger, BUILDING_TYPES.pit.hunger, 'a pit costs its side hunger');
  state.players[0].hunger = MAX_HUNGER;
  assert.deepEqual(build('pit', 4), OK, 'even at its hungriest');
  assert.equal(state.players[0].hunger, MAX_HUNGER, 'free then: hunger goes no higher');
  assert.deepEqual(checkState(board, state), []);
  assert.deepEqual(build('wagon', -3), OK);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'upgrade', building: 'b1' }), { ok: false, reason: 'not enough stone' });
  state.players[0].stone = 1000;
  assert.deepEqual(applyCommand(board, state, 0, { type: 'upgrade', building: 'b1' }), OK);
  assert.equal(state.players[0].stone, 1000 - /** @type {number} */ (BUILDING_TYPES.castle.upgrade));
  assert.deepEqual([state.buildings.b1.grade, state.buildings.b1.upgrading], [1, 0], 'paid for, not done yet');
});

test('castles and farms grow food every minute, farms more with a crew', () => {
  const board = openBoard(5);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', type: 'farm', q: 3, r: 0 }]);
  run(board, state, FOOD_PERIOD);
  const idle = (BUILDING_TYPES.castle.capacity / 2) * FOOD_PER_UNIT + /** @type {number} */ (BUILDING_TYPES.farm.base);
  assert.equal(state.players[0].food, idle, 'what half of those the castle can hold eat, plus the farm\'s base');

  const worked = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', type: 'farm', q: 3, r: 0 }], unitsIn('b2', 1, 10));
  run(board, worked, FOOD_PERIOD);
  assert.ok(worked.players[0].food > idle - FOOD_PER_UNIT, 'more, less what the farmer ate');
  assert.ok(worked.units.u10.practice.farming > 0);
});

test('a side eats every minute; short shares make it hungry, full ones less so', () => {
  const board = openBoard(4);
  const crowd = stateWith([{ id: 'b1', type: 'castle' }], unitsIn('b1', 100, 1000));
  crowd.players[0].food = 7;
  run(board, crowd, FOOD_PERIOD);
  // 7 + 200 from the castle (for half its 40), shared by 100: 2 each, 7 left
  // over; hunger goes a quarter of the way to the 80% they went short.
  assert.deepEqual([crowd.players[0].food, crowd.players[0].hunger], [7, 20]);

  // In a tower, so nobody is born meanwhile.
  const fed = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b2', 10, 1000));
  fed.players[0].hunger = 20;
  run(board, fed, FOOD_PERIOD);
  assert.deepEqual([fed.players[0].food, fed.players[0].hunger], [200 - 10 * FOOD_PER_UNIT, 15]);
});

test('fullMeal says whether the store and the harvest before the meal feed everyone', () => {
  const board = openBoard(4);
  // The castle gives 200 before each meal: a full one for 20 units, in a tower
  // so nobody is born meanwhile.
  const twenty = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b2', 20, 1000));
  assert.equal(fullMeal(publicView(twenty), 0), true);
  run(board, twenty, FOOD_PERIOD);
  assert.deepEqual([twenty.players[0].food, twenty.players[0].hunger], [0, 0]);

  const more = stateWith([{ id: 'b1', type: 'castle' }], unitsIn('b1', 21, 1000));
  assert.equal(fullMeal(more, 0), false);
  more.players[0].food = FOOD_PER_UNIT;
  assert.equal(fullMeal(more, 0), true, 'the store makes up the rest');
  const farmed = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', type: 'farm', q: 3, r: 0 }], unitsIn('b1', 21, 1000));
  assert.equal(fullMeal(farmed, 0), true, "so does a farm's base");
});

test('hunger follows how short meals fall: none on full ones, half on half rations', () => {
  const board = openBoard(4);
  // No castle, so the food is only what each meal is given.
  const state = stateWith([{ id: 'b2', q: 3, r: 0 }], unitsIn('b2', 10, 1000));
  const meals = (/** @type {number} */ share, /** @type {number} */ n) => {
    for (let i = 0; i < n; i++) {
      state.players[0].food = share * 10;
      run(board, state, FOOD_PERIOD);
    }
    return state.players[0].hunger;
  };
  assert.equal(meals(5, 1), 13, 'a quarter of the way to 50, rounded up');
  assert.equal(meals(5, 30), 50, 'half rations settle at half hunger');
  assert.equal(meals(FOOD_PER_UNIT, 30), 0, 'full meals bring it back to none');
  assert.equal(meals(0, 30), MAX_HUNGER, 'nothing at all brings it to the top');
});

test('at full hunger units may starve, the more likely the lower their level', () => {
  assert.equal(starveChance(1), 0.05);
  assert.ok(starveChance(50) < 0.01);
  assert.equal(starveChance(100), 0);

  const board = openBoard(4);
  const state = stateWith(
    [{ id: 'b1', grade: 3 }, { id: 'b2', q: 3, r: 0 }],
    [...unitsIn('b1', 60, 100), { id: 'u10', in: 'b2', level: 100, skills: skillsAt(0) }],
  );
  state.players[0].hunger = 99; // no castle, so no food: hunger reaches 100 at the meal
  run(board, state, FOOD_PERIOD);
  const left = Object.keys(state.units).length;
  assert.ok(left > 1 && left < 61, `${left} left`);
  assert.ok(state.units.u10, 'a level 100 unit never starves');
});

test('a unit with nowhere to go goes home', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }], [{ id: 'u10', q: 3, r: 0 }]);
  runUntil(board, state, () => state.units.u10.in === 'b1');
});

test('a band is free and needs units; it moves them, gives no cover, and breaks up once empty', () => {
  const board = openBoard(5);
  const state = stateWith([{ id: 'b1', type: 'castle' }], unitsIn('b1', 3, 10));
  state.players[0].stone = 0;
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'band', q: 3, r: 0 }), { ok: false, reason: 'a band needs units' });
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'band', q: 3, r: 0, units: ['u10', 'u11'] }), OK);
  assert.equal(state.buildings.b13.hp, undefined);
  assert.equal(occupancy(state).buildingAt.has('3,0'), false, 'it holds no cell');
  runUntil(board, state, () => occupancy(state).inside.get('b13')?.length === 2);

  assert.deepEqual(applyCommand(board, state, 0, { type: 'move', building: 'b13', q: 3, r: -3 }), OK);
  runUntil(board, state, () => !state.buildings.b13.path);
  assert.deepEqual(occupancy(state).inside.get('b13'), ['u10', 'u11'], 'they went along');

  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b13', units: [] }), OK);
  run(board, state, 1);
  assert.equal(state.buildings.b13, undefined, 'gone once nobody is in it');
  runUntil(board, state, () => state.units.u10.in === 'b1');

  // Nobody in it yet, its units still on their way: nothing to strike there
  // but them, and once they are dead it is gone too.
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'band', q: 4, r: 0, units: ['u10'] }), OK);
  const waiting = /** @type {string} */ (Object.keys(state.buildings).at(-1));
  assert.deepEqual([occupancy(state).inside.get(waiting), state.buildings[waiting].hp], [[], undefined]);
  delete state.units.u10;
  run(board, state, 1);
  assert.equal(state.buildings[waiting], undefined, 'gone once its units died on the way');
  assert.deepEqual(checkState(board, state), []);
});

test('a building with no hit points left collapses, and leaves its units standing', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', q: 2, r: 0 }], unitsIn('b1', 2, 10));
  state.buildings.b1.hp = 0;
  advance(board, state);
  assert.deepEqual(checkState(board, state), []);
  assert.equal(state.buildings.b1, undefined);
  assert.deepEqual(occupancy(state).onCell.get('2,0'), ['u10', 'u11']);
});

// --- fighting --------------------------------------------------------------------

test('units in a building strike enemy buildings in reach; a tower reaches further', () => {
  const board = openBoard(7);
  // Towers reach 3 + 2 = 5; the enemy tower 5 away is hit, the one 6 away isn't.
  const state = stateWith(
    [{ id: 'b1', q: 0, r: 0 }, { id: 'b2', owner: 1, q: 5, r: 0 }, { id: 'b3', owner: 1, q: -6, r: 0 }],
    unitsIn('b1', 2, 10),
  );
  run(board, state, COMBAT_PERIOD);
  assert.equal(state.buildings.b2.hp, BUILDING_TYPES.tower.hp - 2 * RANGED_DAMAGE);
  assert.equal(state.buildings.b3.hp, BUILDING_TYPES.tower.hp);
  assert.equal(state.units.u10.practice.ranged, SKILL_RATE.ranged, 'a strike trains its skill faster than a tick of work');
});

test('a building going up adds no reach, covers nobody, and can be neither upgraded nor moved', () => {
  const board = openBoard(7);
  // A rising tower's units reach only their own 3: the enemy tower 4 away is safe.
  const state = stateWith(
    [{ id: 'b1', q: 0, r: 0, raised: 0 }, { id: 'b2', owner: 1, q: 4, r: 0 }, { id: 'b3', type: 'wagon', q: -2, r: 0, raised: 0 }],
    unitsIn('b1', 2, 10),
  );
  run(board, state, COMBAT_PERIOD);
  assert.equal(state.buildings.b2.hp, BUILDING_TYPES.tower.hp);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'upgrade', building: 'b1' }), { ok: false, reason: 'still going up' });
  assert.deepEqual(applyCommand(board, state, 0, { type: 'move', building: 'b3', q: -2, r: 2 }), { ok: false, reason: 'still going up' });

  // Two strikes on a rising farm with three units inside: both fall on them.
  const farm = stateWith(
    [{ id: 'b1', type: 'farm', q: 0, r: 0, raised: 0 }, { id: 'b2', owner: 1, q: 1, r: 0 }],
    [...unitsIn('b1', 3, 10), ...unitsIn('b2', 2, 20, 1)],
  );
  run(board, farm, COMBAT_PERIOD);
  assert.equal(farm.buildings.b1.hp, BUILDING_TYPES.farm.hp / 2);
});

test('a building going up can be given up: its crew, inside or on the way, goes home, and its cost is lost', () => {
  const board = openBoard(5);
  const state = stateWith(
    [{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0, raised: 100 }],
    [...unitsIn('b2', 2, 10), ...unitsIn('b1', 1, 20)],
  );
  const crew = ['u10', 'u11', 'u20'];
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b2', units: crew }), OK);
  run(board, state, 3);
  assert.equal(state.units.u20.to, 'b2', 'one on the way');
  const stone = state.players[0].stone;
  assert.deepEqual(applyCommand(board, state, 0, { type: 'abort', building: 'b1' }), { ok: false, reason: 'it already stands' });
  assert.deepEqual(applyCommand(board, state, 0, { type: 'abort', building: 'b2' }), OK);
  assert.equal(state.buildings.b2, undefined);
  assert.equal(state.players[0].stone, stone, 'nothing back');
  assert.deepEqual(crew.map((id) => state.units[id].to), ['b1', 'b1', 'b1']);
  runUntil(board, state, () => crew.every((id) => state.units[id].in === 'b1'));
});

test('a strike that brings a building down earns a killing blow; its units are left outside', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', q: 0, r: 0 }, { id: 'b2', owner: 1, q: 1, r: 0, hp: 1 }], [
    ...unitsIn('b1', 1, 10), { id: 'u20', owner: 1, in: 'b2' },
  ]);
  run(board, state, COMBAT_PERIOD);
  assert.equal(state.buildings.b2, undefined);
  assert.ok(state.units.u10.xp >= KILL_XP, 'a killing blow');
  assert.deepEqual([state.units.u20.q, state.units.u20.r, state.units.u20.in], [1, 0, undefined], 'left standing');
});

test('allies don\'t strike each other; the Dark Lord\'s lair strikes by itself', () => {
  const board = openBoard(6);
  const state = stateWith([
    { id: 'b1', q: 0, r: 0 }, { id: 'b2', owner: 1, q: 2, r: 0 }, { id: 'b3', owner: 2, type: 'lair', q: -3, r: 0 },
  ], [...unitsIn('b1', 3, 10), ...unitsIn('b2', 3, 20, 1)]);
  state.mode = 'coop';
  state.players = [{ ...state.players[0], team: 0 }, { ...state.players[1], team: 0 }, { id: 2, side: 8, team: 1, stone: 0, metal: 0, food: 0, hunger: 0, tally: noTally() }];
  run(board, state, COMBAT_PERIOD);
  assert.equal(state.buildings.b2.hp, BUILDING_TYPES.tower.hp, 'allies left alone');
  assert.equal(state.buildings.b1.hp, BUILDING_TYPES.tower.hp - /** @type {any} */ (BUILDING_TYPES.lair.attack).damage, 'the lair struck the nearest');
  assert.ok(state.buildings.b3.hp < BUILDING_TYPES.lair.hp, 'and was struck back');
});

test('units out walking strike as they pass, and keep going', () => {
  const board = openBoard(5);
  const state = stateWith([
    { id: 'b1', q: -3, r: 0 }, { id: 'b2', owner: 1, q: 0, r: -2 }, { id: 'b3', q: 3, r: 0 },
  ], unitsIn('b1', 1, 10));
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b3', units: ['u10'] }), OK);
  runUntil(board, state, () => state.units.u10.in === 'b3');
  assert.ok(state.buildings.b2.hp < BUILDING_TYPES.tower.hp, 'the enemy tower was struck on the way');
});

test('raiders turn up now and then; bringing one down yields dark metal', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 3 });
  const game = newGame(board, { mode: 'ffa' });
  const wild = game.players.findIndex((p) => p.side === RAIDERS);
  runUntil(board, game, () => Object.values(game.buildings).some((b) => b.owner === wild), 6 * RAID_PERIOD);

  const state = stateWith([{ id: 'b1' }], unitsIn('b1', 1, 10));
  state.players.push({ id: 2, side: RAIDERS, team: -1, stone: 0, metal: 0, food: 0, hunger: 0, tally: noTally() });
  state.buildings.b2 = { id: 'b2', owner: 2, type: 'raider', grade: 1, q: 2, r: 0, hp: 1 };
  state.nextId = 11;
  const metal = state.players[0].metal;
  run(openBoard(4), state, COMBAT_PERIOD);
  assert.equal(state.buildings.b2, undefined);
  assert.equal(state.players[0].metal, metal + /** @type {number} */ (BUILDING_TYPES.raider.loot));
});

test('raiders come up to two for each player, tougher than they were', () => {
  assert.deepEqual([BUILDING_TYPES.raider.hp, BUILDING_TYPES.raider.attack?.damage], [500, 20]);
  // Alone against the Dark Lord, with two raiders out already far away, no
  // third comes (there used to be room for three).
  const board = createBoard({ ...BOARD_OPTIONS, seed: 3, players: 1 });
  const game = newGame(board);
  const wild = game.players.findIndex((p) => p.side === RAIDERS);
  const standing = Object.values(game.buildings);
  for (const t of board.list.filter((c) => c.passable && standing.every((b) => distance(b, c) > 8)).slice(0, RAID_PER_PLAYER)) {
    const id = `b${game.nextId++}`;
    game.buildings[id] = { id, owner: wild, type: 'raider', grade: 1, q: t.q, r: t.r, hp: BUILDING_TYPES.raider.hp };
  }
  assert.deepEqual(checkState(board, game), []);
  let most = 0;
  for (let i = 0; i < 4 * RAID_PERIOD; i++) {
    advance(board, game);
    most = Math.max(most, Object.values(game.buildings).filter((b) => b.owner === wild).length);
  }
  assert.equal(most, RAID_PER_PLAYER);
});

test('in cooperation the Dark Lord\'s lair sends out ever bigger waves of ghouls and ogres', () => {
  // A castle out of the lair's reach, so neither brings the other down first.
  const board = openBoard(9);
  const game = stateWith([{ id: 'b1', type: 'castle', q: -8, r: 0 }, { id: 'b2', owner: 1, type: 'lair', q: 3, r: 0 }]);
  const lord = 1;
  game.players[lord].side = DARK_LORD;
  const horde = () => Object.values(game.buildings).filter((b) => b.owner === lord && BUILDING_TYPES[b.type].hunts);
  run(board, game, HORDE_START - 1);
  assert.equal(horde().length, 0, 'nothing before the first wave');
  run(board, game, 1);
  const [first] = horde();
  assert.deepEqual(horde().map((b) => b.type), ['ghoul'], 'the first wave: a ghoul');
  run(board, game, COMBAT_PERIOD);
  const prey = game.buildings[first.id].target;
  assert.equal(prey && game.buildings[prey].type, 'castle', 'no farms yet, so it goes for a castle');
  run(board, game, 2 * HORDE_PERIOD - COMBAT_PERIOD);
  assert.ok(horde().some((b) => b.type === 'ogre'), 'the third wave brings an ogre');

  const map = createBoard({ ...BOARD_OPTIONS, seed: 3 });
  const alone = newGame(map, { mode: 'ffa' });
  run(map, alone, HORDE_START);
  assert.ok(!Object.values(alone.buildings).some((b) => BUILDING_TYPES[b.type].hunts), 'no horde without the Dark Lord');
});

test('the Dark Lord grows with the players: four times the hit points and twice the waves at eight, and no more past', () => {
  const lairOf = (/** @type {number} */ players) => Object.values(newGame(createBoard({ ...BOARD_OPTIONS, seed: 3, players })).buildings)
    .find((b) => b.type === 'lair');
  assert.equal(lairOf(2)?.hp, BUILDING_TYPES.lair.hp);
  assert.equal(lairOf(8)?.hp, 4 * BUILDING_TYPES.lair.hp);
  assert.equal(lairOf(16)?.hp, 4 * BUILDING_TYPES.lair.hp);

  // Eight seats around a lair of the Dark Lord's, only one of them with a castle.
  const board = openBoard(9);
  const game = stateWith([{ id: 'b1', type: 'castle', q: -8, r: 0 }, { id: 'b2', owner: 1, type: 'lair', q: 3, r: 0 }]);
  game.players[1].side = DARK_LORD;
  for (let side = 1; side <= 7; side++) {
    game.players.push({ id: game.players.length, side, team: 0, stone: 0, metal: 0, food: 0, hunger: 0, tally: noTally() });
  }
  game.buildings.b2.hp = 4 * BUILDING_TYPES.lair.hp;
  run(board, game, HORDE_START);
  const horde = Object.values(game.buildings).filter((b) => BUILDING_TYPES[b.type].hunts);
  assert.deepEqual(horde.map((b) => [b.type, b.hp]), [['ghoul', 4 * BUILDING_TYPES.ghoul.hp], ['ghoul', 4 * BUILDING_TYPES.ghoul.hp]]);
});

test('in Easy Lord the Dark Lord\'s lair and horde have half the hit points, and his waves are as big', () => {
  const map = createBoard({ ...BOARD_OPTIONS, seed: 3 });
  const easy = newGame(map, { mode: 'easy' });
  assert.deepEqual(easy.players.map((p) => p.team), [0, 0, 1, -1], 'the players together against him, as in cooperation');
  assert.equal(Object.values(easy.buildings).find((b) => b.type === 'lair')?.hp, BUILDING_TYPES.lair.hp / 2);

  // Three waves, from a lair far from the one castle, which has nobody to strike back.
  const horde = (/** @type {string} */ mode) => {
    const board = openBoard(9);
    const game = stateWith([{ id: 'b1', type: 'castle', q: -8, r: 0 }, { id: 'b2', owner: 1, type: 'lair', q: 3, r: 0 }]);
    game.mode = mode;
    game.players[1].side = DARK_LORD;
    game.buildings.b2.hp = maxHp(game, game.buildings.b2);
    run(board, game, HORDE_START + 2 * HORDE_PERIOD);
    return Object.values(game.buildings).filter((b) => BUILDING_TYPES[b.type].hunts).map((b) => [b.type, b.hp]);
  };
  const usual = horde('coop');
  assert.ok(usual.some(([type]) => type === 'ogre'), 'ghouls and an ogre by then');
  assert.deepEqual(horde('easy'), usual.map(([type, hp]) => [type, /** @type {number} */ (hp) / 2]));
});

test('castles raise units at the pace chosen with the game, in any mode: normal, fast (2×) or slow (0.5×)', () => {
  const map = createBoard({ ...BOARD_OPTIONS, seed: 3, players: 2 });
  for (const mode of ['coop', 'ffa']) {
    for (const breeding of ['normal', 'fast', 'slow']) {
      const game = newGame(map, { mode, breeding });
      assert.deepEqual(checkState(map, game), [], `${mode}, ${breeding}`);
      assert.equal(publicView(game).breeding, breeding);
    }
  }
  assert.equal(newGame(map).breeding, 'normal', 'normal by default');
  assert.deepEqual(checkState(map, { ...newGame(map), breeding: 'veryFast' }), ['bad breeding']);

  const board = openBoard(4);
  const { work = 0, idleWork = 0 } = BUILDING_TYPES.castle;
  assert.deepEqual(['normal', 'fast', 'slow'].map((breeding) => workFor({ breeding }, 'castle')), [work, work / 2, work * 2]);
  assert.equal(workFor({ breeding: 'slow' }, 'farm'), BUILDING_TYPES.farm.work, 'only units come faster or slower');
  assert.equal(workFor({ breeding: 'slow' }, 'tower'), undefined);
  /**
   * @param {string} breeding
   * @param {Array<Partial<import('../src/core/game.js').Unit> & { id: string }>} units
   */
  const firstBirth = (breeding, units) => {
    const state = stateWith([{ id: 'b1', type: 'castle' }], units);
    state.breeding = breeding;
    const before = Object.keys(state.units).length;
    return runUntil(board, state, () => Object.keys(state.units).length > before, 4 * work);
  };
  const ten = unitsIn('b1', 10, 10);
  assert.equal(firstBirth('normal', ten), Math.ceil(work / (10 * WORK_BASE + idleWork)));
  assert.equal(firstBirth('fast', ten), Math.ceil(work / (2 * (10 * WORK_BASE + idleWork))));
  // Slow takes twice the work; the units get better at it meanwhile, so a little less than twice the time.
  const slowly = firstBirth('slow', ten);
  assert.ok(slowly <= Math.ceil(2 * work / (10 * WORK_BASE + idleWork)) && slowly > 1.9 * firstBirth('normal', ten), String(slowly));
  assert.equal(firstBirth('fast', []), Math.ceil(work / (2 * idleWork)), 'and by itself, with nobody at home');

  // The units learn breeding no faster, and a slow castle's work stays whole.
  const state = stateWith([{ id: 'b1', type: 'castle' }], ten);
  const normal = structuredClone(state);
  state.breeding = 'fast';
  const slow = structuredClone(normal);
  slow.breeding = 'slow';
  run(board, state, 100);
  run(board, normal, 100);
  run(board, slow, 100);
  assert.deepEqual(state.units.u10.practice, normal.units.u10.practice);
  assert.deepEqual(checkState(board, slow), []);
});

test('in two teams, the first half of the ring plays the second, which gets the odd seat; no Dark Lord', () => {
  for (const [players, teams] of /** @type {Array<[number, number[]]>} */ ([[2, [0, 1]], [4, [0, 0, 1, 1]], [5, [0, 0, 1, 1, 1]], [16, [...Array(8).fill(0), ...Array(8).fill(1)]]])) {
    const board = createBoard({ ...BOARD_OPTIONS, seed: 5, players });
    const game = newGame(board, { mode: 'teams' });
    assert.deepEqual(checkState(board, game), []);
    assert.deepEqual(game.players.map((p) => p.team), [...teams, -1], `${players} players, then the raiders`);
    assert.deepEqual(teams, teams.map((_, seat) => teamOfSeat('teams', seat, players)));
    assert.ok(!Object.values(game.buildings).some((b) => b.type === 'lair'), 'no lair');
    assert.deepEqual(game.players.map((p) => p.stone).slice(0, players), Array(players).fill(game.players[0].stone), 'a stock each');
    // Giving up hands the win to the other team.
    assert.equal(endWinner(game, 0), 1);
    assert.equal(endWinner(game, players - 1), 0);
  }
  assert.equal(teamOfSeat('ffa', 3, 4), 3, 'in free for all, each seat a team of its own');
});

test('in Shared Easy Lord the team lives off one stock, kept by its first side, against an easy Lord', () => {
  const map = createBoard({ ...BOARD_OPTIONS, seed: 3 });
  const game = newGame(map, { mode: 'shared' });
  assert.deepEqual(checkState(map, game), []);
  assert.deepEqual(game.players.map((p) => p.stone), [400, 0, 0, 0], 'the players\' stone together, on the first');
  assert.equal(Object.values(game.buildings).find((b) => b.type === 'lair')?.hp, BUILDING_TYPES.lair.hp / 2);

  // Two castles, and forty units in towers (so nobody is born), all the second side's.
  const board = openBoard(6);
  const shared = (/** @type {string} */ mode) => {
    const state = stateWith(
      [{ id: 'b1', type: 'castle' }, { id: 'b2', owner: 1, type: 'castle', q: 4, r: -4 },
        { id: 'b3', owner: 1, q: 4, r: 0 }, { id: 'b4', owner: 1, q: 0, r: 4 }],
      [...unitsIn('b3', 20, 100, 1), ...unitsIn('b4', 20, 200, 1)],
    );
    state.mode = mode;
    state.players[1].team = 0;
    for (const p of state.players) Object.assign(p, { stone: 0, metal: 0 });
    return state;
  };
  const state = shared('shared');
  state.players[0].stone = 100;
  assert.deepEqual(checkState(board, state), []);
  // The second side builds and upgrades from the first's stone, while there is enough.
  assert.deepEqual(applyCommand(board, state, 1, { type: 'upgrade', building: 'b3' }), OK);
  assert.deepEqual([state.players[0].stone, state.players[1].stone], [100 - BUILDING_TYPES.tower.upgrade, 0]);
  assert.deepEqual(applyCommand(board, state, 1, { type: 'upgrade', building: 'b4' }), { ok: false, reason: 'not enough stone' });
  // Both castles' food feeds the forty at one meal, with one hunger for the team.
  delete state.buildings.b3.upgrading;
  run(board, state, FOOD_PERIOD);
  assert.deepEqual(state.players.slice(0, 2).map((p) => [p.food, p.hunger]), [[0, 0], [0, 0]], 'fed in full');
  const apart = shared('easy');
  run(board, apart, FOOD_PERIOD);
  assert.ok(apart.players[1].hunger > 0, 'apart, the second side\'s castle alone feeds only half of them');

  state.players[1].food = 5;
  assert.deepEqual(checkState(board, state), ['side 1: keeps stock apart from its team\'s']);
});

test('the horde goes for the nearest farm, turns on a building that strikes it, and on castles once no farm is left', () => {
  const board = openBoard(7);
  const sites = [
    { id: 'b1', type: 'castle', q: -5, r: 0 },
    { id: 'b2', type: 'farm', q: 3, r: 0 },
    { id: 'b3', type: 'farm', q: 6, r: -3 },
    { id: 'b4', owner: 1, type: 'ogre', q: 5, r: 0 },
  ];
  const state = stateWith(sites);
  run(board, state, COMBAT_PERIOD);
  assert.equal(state.buildings.b4.target, 'b2', 'the nearest farm');

  const struck = stateWith([...sites, { id: 'b5', q: 5, r: -3 }], unitsIn('b5', 2, 10));
  run(board, struck, COMBAT_PERIOD);
  assert.equal(struck.buildings.b4.target, 'b5', 'the tower that struck it');

  const bare = stateWith([sites[0], sites[3]]);
  run(board, bare, COMBAT_PERIOD);
  assert.equal(bare.buildings.b4.target, 'b1', 'no farm left: the castle');
});

test('the horde leaves a side whose player is away alone, but fights it on its way', () => {
  const board = openBoard(7);
  // The ogre's nearest farm is the third side's, whose player may be away.
  const sites = [
    { id: 'b1', type: 'castle', q: -5, r: 0 },
    { id: 'b2', owner: 2, type: 'farm', q: 3, r: 0 },
    { id: 'b3', type: 'farm', q: 6, r: -3 },
    { id: 'b4', owner: 1, type: 'ogre', q: 5, r: 0 },
  ];
  const game = (/** @type {Array<Partial<import('../src/core/game.js').Building> & { id: string }>} */ buildings, units = /** @type {any[]} */ ([])) => {
    const state = stateWith(buildings, units);
    state.players[1].side = DARK_LORD;
    // Teammates, as in cooperation.
    state.players.push({ id: 2, side: 2, team: 0, stone: 0, metal: 0, food: 0, hunger: 0, tally: noTally() });
    return state;
  };
  const here = game(sites);
  run(board, here, COMBAT_PERIOD);
  assert.equal(here.buildings.b4.target, 'b2', 'the nearest farm, while its player is here');

  const away = game(sites);
  assert.deepEqual(applyCommand(board, away, 2, { type: 'away' }), OK);
  assert.deepEqual(checkState(board, away), []);
  run(board, away, COMBAT_PERIOD);
  assert.equal(away.buildings.b4.target, 'b3', 'the nearest farm of a side whose player is here');

  // Going away, a side is let go by the horde already after it.
  assert.deepEqual(applyCommand(board, here, 2, { type: 'away' }), OK);
  assert.equal(here.buildings.b4.target, undefined);
  run(board, here, COMBAT_PERIOD);
  assert.equal(here.buildings.b4.target, 'b3');
  assert.deepEqual(applyCommand(board, here, 2, { type: 'back' }), OK);
  assert.equal(here.players[2].away, undefined);
  assert.deepEqual(applyCommand(board, here, 2, { type: 'back' }), { ok: false, reason: 'not away' });

  // A tower of the side away that strikes it is fought all the same.
  const struck = game([...sites, { id: 'b5', owner: 2, q: 5, r: -3 }], unitsIn('b5', 2, 10, 2));
  assert.deepEqual(applyCommand(board, struck, 2, { type: 'away' }), OK);
  run(board, struck, COMBAT_PERIOD);
  assert.equal(struck.buildings.b4.target, 'b5', 'the tower that struck it');

  assert.deepEqual(applyCommand(board, away, 2, { type: 'away' }), { ok: false, reason: 'already away' });
  assert.deepEqual(applyCommand(board, away, 1, { type: 'away' }), { ok: false, reason: 'not a seat' }, 'the Dark Lord is never away');
  assert.deepEqual(ROOM_COMMANDS, ['away', 'back', 'end']);
  const odd = structuredClone(away);
  /** @type {any} */ (odd.players[2]).away = false;
  /** @type {any} */ (odd.players[1]).away = true;
  assert.deepEqual(checkState(board, odd), ['side 1: bad away', 'side 2: bad away']);
});

test('wagons cost dark metal and go up only near the castle; bands can be aimed at', () => {
  const board = openBoard(7);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 5, r: 0 }]);
  state.players[0].metal = 10;
  const wagon = (/** @type {number} */ q) => applyCommand(board, state, 0, { type: 'build', kind: 'wagon', q, r: -2 });
  assert.deepEqual(wagon(-2), { ok: false, reason: 'not enough dark metal' });
  state.players[0].metal = 100;
  assert.deepEqual(wagon(6), { ok: false, reason: 'too far from your castle' }, 'though near the tower');
  assert.deepEqual(wagon(-2), OK);
  assert.equal(state.players[0].metal, 100 - /** @type {number} */ (BUILDING_TYPES.wagon.metal));

  // Bringing a wagon down yields a share of its price.
  const salvage = stateWith([{ id: 'b1', q: 0, r: 0 }, { id: 'b2', owner: 1, type: 'wagon', q: 2, r: 0, hp: 1 }], unitsIn('b1', 1, 10));
  const metal = salvage.players[0].metal;
  run(board, salvage, COMBAT_PERIOD);
  assert.equal(salvage.buildings.b2, undefined);
  assert.equal(salvage.players[0].metal, metal + Math.floor(/** @type {number} */ (BUILDING_TYPES.wagon.metal) * SALVAGE));

  // A tower aimed at an enemy band strikes its units, not the nearer tower.
  const aim = stateWith([
    { id: 'b1', q: 0, r: 0 }, { id: 'b2', owner: 1, type: 'band', q: 3, r: 0 }, { id: 'b3', owner: 1, q: 1, r: 0 },
  ], [...unitsIn('b1', 1, 10), ...unitsIn('b2', 1, 20, 1)]);
  assert.deepEqual(applyCommand(board, aim, 0, { type: 'target', building: 'b1', target: 'b2' }), OK);
  run(board, aim, COMBAT_PERIOD);
  assert.equal(aim.buildings.b3.hp, BUILDING_TYPES.tower.hp);
});

test('a kill is likelier the more the striker outclasses the target, 50% at most', () => {
  assert.equal(killChance(20, 20), 10);
  assert.ok(killChance(100, 1) > 45 && killChance(100, 1) < 50);
  assert.ok(killChance(0, 51) < 1);
});

test('some strikes on a farm or pit get through to its crew; a tower shelters its own', () => {
  const board = openBoard(4);
  const attackers = unitsIn('b1', 20, 100, 1);
  const farm = stateWith([{ id: 'b1', owner: 1, q: 0, r: 0 }, { id: 'b2', type: 'farm', q: 1, r: 0 }], [...attackers, ...unitsIn('b2', 6, 10)]);
  const tower = stateWith([{ id: 'b1', owner: 1, q: 0, r: 0 }, { id: 'b2', q: 1, r: 0, hp: 5000 }], [...attackers, ...unitsIn('b2', 6, 10)]);
  tower.buildings.b2.hp = BUILDING_TYPES.tower.hp; // stands long enough to tell
  run(board, farm, 5 * COMBAT_PERIOD);
  run(board, tower, 5 * COMBAT_PERIOD);
  const crew = (/** @type {any} */ s) => Object.values(s.units).filter((u) => u.owner === 0).length;
  assert.ok(crew(farm) < 6, 'the farm\'s crew took hits');
  assert.equal(crew(tower), 6, 'the tower\'s did not');
});

test('a target: a tower strikes it in reach, else the nearest; a band goes after it', () => {
  const board = openBoard(7);
  const state = stateWith([
    { id: 'b1', q: 0, r: 0 }, { id: 'b2', owner: 1, q: 2, r: 0 }, { id: 'b3', owner: 1, q: -5, r: 0 },
    { id: 'b4', owner: 1, q: 0, r: 7, type: 'farm' }, { id: 'b5', type: 'band', q: 0, r: -3 },
  ], [...unitsIn('b1', 1, 10), ...unitsIn('b5', 1, 20)]);
  assert.deepEqual(applyCommand(board, state, 1, { type: 'target', building: 'b1', target: 'b3' }), { ok: false, reason: 'not your building' });
  assert.deepEqual(applyCommand(board, state, 0, { type: 'target', building: 'b1', target: 'b5' }), { ok: false, reason: 'not an enemy' });
  assert.deepEqual(applyCommand(board, state, 0, { type: 'target', building: 'b1', target: 'b3' }), OK);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'target', building: 'b5', target: 'b4' }), OK);
  run(board, state, COMBAT_PERIOD);
  assert.ok(state.buildings.b3.hp < BUILDING_TYPES.tower.hp, 'its target, 5 away, in a tower\'s reach');
  assert.equal(state.buildings.b2.hp, BUILDING_TYPES.tower.hp, 'not the nearer one');
  runUntil(board, state, () => distance(state.buildings.b5, state.buildings.b4) <= 1, 1000);
  run(board, state, COMBAT_PERIOD);
  assert.ok(!state.buildings.b4 || state.buildings.b4.hp < BUILDING_TYPES.farm.hp, 'and strikes it');
});

// --- points -----------------------------------------------------------------------

test('fighting goes in the striker\'s tally: damage, buildings brought down, and kills', () => {
  const board = openBoard(5);
  // Two units in Blue's tower strike Crimson's, 3 cells off, which has 5 hit points left.
  const state = stateWith([{ id: 'b1' }, { id: 'b2', owner: 1, q: 3, r: 0, hp: 5 }], unitsIn('b1', 2, 10));
  run(board, state, COMBAT_PERIOD);
  assert.deepEqual([state.players[0].tally.damage, state.players[0].tally.felled], [5, 1], 'only the hit points it had');

  // Veterans against a crowd out in the open: each kill counts.
  const fight = stateWith([{ id: 'b1' }], [
    ...unitsIn('b1', 2, 10).map((u) => ({ ...u, level: MAX_LEVEL, skills: { ...skillsAt(0), ranged: MAX_LEVEL } })),
    ...[20, 21, 22].map((n) => ({ id: `u${n}`, owner: 1, q: 3, r: 0 })),
  ]);
  runUntil(board, fight, () => fight.players[0].tally.kills >= 2);
  assert.equal(fight.players[0].tally.kills, 3 - Object.values(fight.units).filter((u) => u.owner === 1).length);
});

test('work goes in its side\'s tally: births, stone, food, buildings finished and upgrades', () => {
  const board = openBoard(4);
  const almost = (/** @type {number | undefined} */ n) => /** @type {number} */ (n) - 1;
  const { castle, pit, farm, tower } = BUILDING_TYPES;
  const state = stateWith([
    { id: 'b1', type: 'castle', work: almost(castle.work) },
    { id: 'b2', type: 'pit', q: 3, r: 0, work: almost(pit.work) },
    { id: 'b3', type: 'farm', q: -3, r: 0, work: almost(farm.work) },
    { id: 'b4', q: 0, r: 3, raised: almost(tower.raise) },
    { id: 'b5', q: 0, r: -3, upgrading: almost(tower.raise) },
  ], [...unitsIn('b1', 10, 10), ...unitsIn('b2', 1, 20), ...unitsIn('b3', 1, 30), ...unitsIn('b4', 1, 40), ...unitsIn('b5', 1, 50)]);
  assert.deepEqual(checkState(board, state), []);
  run(board, state, 1);
  const { born, stone, food, built, upgrades } = state.players[0].tally;
  assert.deepEqual({ born, stone, food, built, upgrades }, { born: 1, stone: 1, food: 1, built: 1, upgrades: 2 }, 'grade 2 reached');
});

test('points are the tally by POINTS, each line rounded down', () => {
  const tally = { ...noTally(), kills: 2, damage: 57, felled: 1, castles: 1, born: 3, stone: 4, food: 19, built: 1, upgrades: 5, won: 1 };
  const { lines, total } = pointsOf(tally);
  assert.deepEqual(lines, { kills: 20, damage: 5, felled: 50, castles: 500, born: 15, stone: 4, food: 1, built: 20, upgrades: 250, won: 500 });
  assert.equal(total, 1365);
  assert.equal(pointsOf(noTally()).total, 0);
});

test('a quick win multiplies the winners\' points: twice from 10 to 20 minutes, half again to 40, else not', () => {
  const minute = 60 * TICKS_PER_SECOND;
  assert.deepEqual([0, 10 * minute - 1, 10 * minute, 20 * minute - 1, 20 * minute, 40 * minute - 1, 40 * minute, 90 * minute].map(quickWin),
    [1, 1, 2, 2, 1.5, 1.5, 1, 1]);
  assert.equal(quickWin(undefined), 1, 'not while it goes on');
  const state = stateWith([]);
  Object.assign(state.players[0].tally, { kills: 3, won: 1 });
  Object.assign(state.players[1].tally, { kills: 5, damage: 7 });
  Object.assign(state, { tick: 15 * minute, over: 15 * minute, winner: 0 });
  assert.deepEqual(scoreOf(state, 0), { lines: pointsOf(state.players[0].tally).lines, times: 2, total: 2 * 530 });
  assert.deepEqual([scoreOf(state, 1).times, scoreOf(state, 1).total], [1, 50], 'the losers get none');
  Object.assign(state, { tick: 25 * minute, over: 25 * minute });
  state.players[0].tally.stone = 1;
  assert.equal(scoreOf(state, 0).total, 796, '1.5 × 531, rounded down');
  delete state.winner;
  assert.equal(scoreOf(state, 0).times, 1, 'nobody won');
});

test('a player may end the game: against the Dark Lord he wins; in free for all the one side left, or nobody', () => {
  const ended = (/** @type {string} */ mode, /** @type {number} */ players, /** @type {(s: any) => void} */ setUp = () => {}) => {
    const board = createBoard({ ...BOARD_OPTIONS, seed: 7, players });
    const state = newGame(board, { mode });
    setUp(state);
    state.tick = 9000;
    const who = endWinner(state, 0);
    assert.deepEqual(applyCommand(board, state, 0, { type: 'end' }), OK);
    assert.deepEqual(checkState(board, state), []);
    assert.equal(state.over, 9000, 'the clock stops where it was');
    assert.equal(state.winner, who, 'as the page says before asking');
    assert.deepEqual(applyCommand(board, state, 1, { type: 'end' }), { ok: false, reason: 'the game is over' });
    return state;
  };
  const lord = ended('coop', 3);
  const lordTeam = lord.players.find((p) => p.side === DARK_LORD)?.team;
  assert.equal(lord.winner, lordTeam);
  assert.deepEqual(lord.players.map((p) => p.tally.won), lord.players.map((p) => Number(p.team === lordTeam)), 'he gets the win');
  assert.equal(ended('ffa', 4).winner, undefined, 'three others standing: nobody wins');
  const duel = ended('ffa', 2);
  assert.equal(duel.winner, duel.players[1].team, 'the other one of two wins');
  assert.equal(duel.players[1].tally.won, 1);
  // Ended as abandoned, every seat gives up: the Dark Lord wins, or in free for all nobody.
  const lordGame = newGame(createBoard({ ...BOARD_OPTIONS, seed: 7, players: 2 }), { mode: 'coop' });
  assert.equal(endWinner(lordGame, 0, true), lordGame.players.find((p) => p.side === DARK_LORD)?.team);
  assert.equal(endWinner(newGame(createBoard({ ...BOARD_OPTIONS, seed: 7, players: 2 }), { mode: 'ffa' }), 0, true), undefined);
  // A player whose castle has fallen may still end it; the raiders never win.
  const fallen = ended('ffa', 3, (s) => { s.players[0].lost = 0; s.players[2].lost = 0; });
  assert.equal(fallen.winner, fallen.players[1].team);
});

test('the side whose castle falls has lost; when one team is left, the game is over', () => {
  const board = openBoard(6);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', type: 'castle', owner: 1, q: 4, r: -2 }]);
  state.players.push({ ...state.players[1], id: 2, side: 2, team: 2, tally: noTally() });
  state.buildings.b3 = { id: 'b3', type: 'castle', owner: 2, grade: 1, q: -4, r: 2, hp: 1, work: 0 };
  state.nextId = 4;
  state.buildings.b1.hp = 0;
  run(board, state, 1);
  assert.equal(state.players[0].lost, 1);
  assert.equal(state.over, undefined, 'two sides still stand');
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'pit', q: 3, r: 0 }), { ok: false, reason: 'your castle has fallen' });
  state.buildings.b3.hp = 0;
  run(board, state, 1);
  assert.deepEqual([state.over, state.winner], [2, 1], 'the last one standing wins');
  assert.deepEqual(state.players.map((p) => p.tally.won), [0, 1, 0], 'and the win is in its tally');
  assert.deepEqual(applyCommand(board, state, 1, { type: 'upgrade', building: 'b2' }), { ok: false, reason: 'the game is over' });
  run(board, state, 5);
  assert.equal(state.tick, 2, 'and the clock has stopped');
});

test('units mend their damaged building before their usual work', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'pit', q: 1, r: 0, hp: 100 }], unitsIn('b1', 5, 10));
  run(board, state, 50);
  assert.equal(state.buildings.b1.hp, 100 + 10, '5 units mend a hit point every 5 ticks');
  assert.equal(state.buildings.b1.work, 0, 'no digging meanwhile');
  assert.ok(state.units.u10.practice.build > 0);
});

test('units with an enemy in reach fight it rather than mend their building', () => {
  const board = openBoard(4);
  // An enemy farm 2 cells away, in their ranged reach: they strike it and mend nothing.
  const near = stateWith([{ id: 'b1', type: 'pit', q: 0, r: 0, hp: 100 }, { id: 'b2', owner: 1, type: 'farm', q: 2, r: 0 }], unitsIn('b1', 5, 10));
  run(board, near, 50);
  assert.equal(near.buildings.b1.hp, 100, 'no mending while fighting');
  assert.ok(/** @type {number} */ (near.buildings.b2.hp) < 200, 'they fought');
  // 4 cells away, out of their reach: they mend.
  const far = stateWith([{ id: 'b1', type: 'pit', q: 0, r: 0, hp: 100 }, { id: 'b2', owner: 1, type: 'farm', q: 4, r: 0 }], unitsIn('b1', 5, 10));
  run(board, far, 50);
  assert.equal(far.buildings.b1.hp, 110);
  assert.equal(far.buildings.b2.hp, 200);
});

test('a band goes at its slowest member\'s pace', () => {
  const board = openBoard(5);
  const state = stateWith([{ id: 'b1', type: 'band', q: 0, r: 0 }], [
    { id: 'u10', in: 'b1', level: MAX_LEVEL, skills: { ...skillsAt(0), running: MAX_LEVEL } },
    { id: 'u11', in: 'b1' },
  ]);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'move', building: 'b1', q: 2, r: 0 }), OK);
  const tick = runUntil(board, state, () => !state.buildings.b1.path);
  assert.equal(tick, 1 + 2 * WALK_TICKS, 'as slow as the one who never ran');
});

test('a band\'s units train their running as it marches, as if they walked, every BAND_TRAINING', () => {
  const board = openBoard(8);
  const state = stateWith([{ id: 'b1', type: 'band', q: 0, r: 0 }], [{ id: 'u10', in: 'b1' }, { id: 'u11', in: 'b1' }]);
  const alone = stateWith([], [{ id: 'u10', q: 0, r: 0 }]);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'move', building: 'b1', q: 3, r: 0 }), OK);
  run(board, state, BAND_TRAINING - 1);
  assert.equal(state.buildings.b1.walked, 3 * WALK_TICKS, 'counted as it goes');
  assert.equal(publicView(state).buildings.b1.walked, undefined, 'and kept from players');
  assert.equal(state.units.u10.practice.running, 0, 'but not given yet');
  run(board, state, 1);
  assert.equal(state.buildings.b1.walked, undefined);
  // As much as one who walked the same way, by the same time.
  const walker = /** @type {any} */ (alone.units.u10);
  walker.path = [[1, 0], [2, 0], [3, 0]];
  walker.since = 0;
  walker.until = WALK_TICKS;
  run(board, alone, BAND_TRAINING);
  for (const id of ['u10', 'u11']) {
    assert.deepEqual([state.units[id].practice.running, state.units[id].xp], [alone.units.u10.practice.running, alone.units.u10.xp], id);
  }
});

test('units and bands cross pits, anyone\'s; wagons go around them', () => {
  // A corridor with an enemy pit in the middle, and a detour round it.
  const board = boardFrom({ '0,0': 'grass', '1,0': 'grass', '2,0': 'grass', '3,0': 'grass', '4,0': 'grass', '1,-1': 'grass', '2,-1': 'grass', '3,-1': 'grass' });
  const state = stateWith(
    [{ id: 'b1', q: 0, r: 0 }, { id: 'b2', owner: 1, type: 'pit', q: 2, r: 0 }, { id: 'b3', q: 4, r: 0 }, { id: 'b4', type: 'wagon', q: 1, r: 0 }],
    unitsIn('b1', 1, 10),
  );
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b3', units: ['u10'] }), OK);
  assert.deepEqual(state.units.u10.path, [[1, 0], [2, 0], [3, 0], [4, 0]], 'straight through the pit');
  assert.deepEqual(applyCommand(board, state, 0, { type: 'move', building: 'b4', q: 3, r: 0 }), OK);
  assert.deepEqual(state.buildings.b4.path, [[2, -1], [3, -1], [3, 0]], 'around it');
});

// --- building ------------------------------------------------------------------

test('building needs open, buildable ground near one of your standing buildings', () => {
  const board = openBoard(5, { '2,-2': 'scrub', '-2,2': 'water' });
  const state = stateWith([{ id: 'b1', type: 'castle' }]);
  const tower = (/** @type {number} */ q, /** @type {number} */ r) => ({ type: 'build', kind: 'tower', q, r });

  assert.deepEqual(applyCommand(board, state, 0, tower(2, 0)), OK);
  assert.deepEqual(state.buildings.b2, { id: 'b2', owner: 0, type: 'tower', grade: 1, q: 2, r: 0, raised: 0, hp: BUILDING_TYPES.tower.hp / 2 });
  /** @type {Array<[unknown, string]>} */
  const refusals = [
    [tower(2, 0), 'cell taken'],
    [tower(1, 0), 'cell taken'],
    [tower(2, -2), 'cannot build there'],
    [tower(-2, 2), 'cannot build there'],
    [tower(40, 40), 'cannot build there'],
    [tower(-5, 0), 'too far from your buildings'],
    [{ type: 'build', kind: 'castle', q: 3, r: -3 }, 'cannot build that'],
    [{ type: 'build', kind: 'constructor', q: 3, r: -3 }, 'cannot build that'],
    [{ type: 'build', kind: 'tower', q: '3', r: -3 }, 'bad cell'],
  ];
  for (const [command, reason] of refusals) {
    assert.deepEqual(applyCommand(board, state, 0, command), { ok: false, reason }, JSON.stringify(command));
  }

  // Wagons don't count as standing, and neither does the other side.
  const roaming = stateWith([{ id: 'b1', type: 'wagon' }, { id: 'b2', owner: 1, q: 2, r: 0 }]);
  assert.deepEqual(applyCommand(board, roaming, 0, tower(1, 0)), { ok: false, reason: 'too far from your buildings' });
});

test('a wagon upgrades for dark metal, three times, each for more hit points and no more room', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'wagon', q: 2, r: 0 }], unitsIn('b1', 15, 10));
  const { hp, hpPerGrade = 0, upgradeMetal = 0 } = BUILDING_TYPES.wagon;
  assert.deepEqual([hp, hpPerGrade, upgradeMetal], [300, 500, 50]);
  const upgrade = () => applyCommand(board, state, 0, { type: 'upgrade', building: 'b1' });
  state.players[0].metal = upgradeMetal - 1;
  assert.deepEqual(upgrade(), { ok: false, reason: 'not enough dark metal' });
  state.players[0].metal = 3 * upgradeMetal;
  const stone = state.players[0].stone;
  for (const grade of [2, 3, 4]) {
    assert.deepEqual(upgrade(), OK);
    runUntil(board, state, () => state.buildings.b1.upgrading === undefined);
    assert.deepEqual([state.buildings.b1.grade, state.buildings.b1.hp, capacityOf(state.buildings.b1)], [grade, hp + hpPerGrade * (grade - 1), 15]);
  }
  assert.deepEqual([state.players[0].metal, state.players[0].stone], [0, stone], 'dark metal only');
  assert.deepEqual(upgrade(), { ok: false, reason: 'fully upgraded' });
});

test('an upgrade is work for the crew, and brings the next grade\'s room and hit points once done', () => {
  const board = openBoard(1);
  const state = stateWith([{ id: 'b1' }], unitsIn('b1', 10, 10));
  const { capacity, grades, hp } = BUILDING_TYPES.tower;
  const upgrade = () => applyCommand(board, state, 0, { type: 'upgrade', building: 'b1' });
  for (let g = 2; g <= grades; g++) {
    assert.deepEqual(upgrade(), OK);
    assert.deepEqual(upgrade(), { ok: false, reason: 'already upgrading' });
    assert.equal(capacityOf(state.buildings.b1), capacity * (g - 1), 'no more room until it is done');
    runUntil(board, state, () => state.buildings.b1.upgrading === undefined);
    assert.deepEqual([state.buildings.b1.grade, capacityOf(state.buildings.b1), state.buildings.b1.hp], [g, capacity * g, hp * g]);
  }
  assert.ok(state.units.u10.practice.build > 0 || state.units.u10.skills.build > 0, 'upgrading trains the builders');
  assert.deepEqual(upgrade(), { ok: false, reason: 'fully upgraded' });
});

// --- wagons --------------------------------------------------------------------

test('a wagon rolls cell by cell, holding the cell ahead, and carries its units', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'wagon', q: -2, r: 0 }], unitsIn('b1', 3, 10));
  const speed = /** @type {number} */ (BUILDING_TYPES.wagon.speed);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'move', building: 'b1', q: 2, r: 0 }), OK);
  assert.deepEqual(state.buildings.b1.path, [[-1, 0], [0, 0], [1, 0], [2, 0]]);

  run(board, state, 1);
  assert.deepEqual([state.buildings.b1.since, state.buildings.b1.until], [1, 1 + speed]);
  const held = occupancy(state).buildingAt;
  assert.equal(held.get('-2,0'), 'b1');
  assert.equal(held.get('-1,0'), 'b1', 'the cell it is entering is taken too');

  const tick = runUntil(board, state, () => !state.buildings.b1.path);
  assert.equal(tick, 1 + 4 * speed);
  assert.deepEqual([state.buildings.b1.q, state.buildings.b1.r], [2, 0]);
  assert.deepEqual(occupancy(state).inside.get('b1'), ['u10', 'u11', 'u12'], 'the units rode along');
});

test('wagons never pass through each other: a blocked one waits, then goes around or stops', () => {
  // A corridor one cell wide: two wagons meet head on and neither can pass.
  const corridor = boardFrom(Object.fromEntries([0, 1, 2, 3, 4, 5].map((q) => [`${q},0`, 'grass'])));
  const headOn = stateWith([{ id: 'b1', type: 'wagon', q: 0, r: 0 }, { id: 'b2', type: 'wagon', q: 5, r: 0 }]);
  assert.deepEqual(applyCommand(corridor, headOn, 0, { type: 'move', building: 'b1', q: 5, r: 0 }), { ok: false, reason: 'no way there' });
  assert.deepEqual(applyCommand(corridor, headOn, 0, { type: 'move', building: 'b1', q: 4, r: 0 }), OK);
  assert.deepEqual(applyCommand(corridor, headOn, 0, { type: 'move', building: 'b2', q: 1, r: 0 }), OK);
  runUntil(corridor, headOn, () => !headOn.buildings.b1.path && !headOn.buildings.b2.path);
  const at = (/** @type {string} */ id) => [headOn.buildings[id].q, headOn.buildings[id].r];
  assert.deepEqual([at('b1'), at('b2')], [[2, 0], [3, 0]], 'they stopped face to face');

  // Open ground: a tower goes up in the wagon's way; it waits, then goes around.
  const board = openBoard(3);
  const state = stateWith([{ id: 'b1', type: 'wagon', q: -2, r: 0 }, { id: 'b2', q: 0, r: -2 }]);
  const speed = /** @type {number} */ (BUILDING_TYPES.wagon.speed);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'move', building: 'b1', q: 2, r: 0 }), OK);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'tower', q: 0, r: 0 }), OK);
  run(board, state, 1 + speed + WAGON_PATIENCE - 1);
  assert.deepEqual([state.buildings.b1.q, state.buildings.b1.r, state.buildings.b1.until], [-1, 0, undefined], 'waiting');
  runUntil(board, state, () => !state.buildings.b1.path);
  assert.deepEqual([state.buildings.b1.q, state.buildings.b1.r], [2, 0]);
});

// --- the core as a simulation -------------------------------------------------

/**
 * Play a game of random commands from both sides, a handful a second, for
 * `ticks` ticks, checking every rule after every tick.
 * @param {number} seed Map seed.
 * @param {number} ticks
 * @param {(state: import('../src/core/game.js').GameState) => void} [midway] Called halfway.
 */
function randomGame(seed, ticks, midway, mode = 'ffa') {
  const board = createBoard({ ...BOARD_OPTIONS, seed });
  let state = newGame(board, { mode });
  const dice = { rng: seed };
  const roll = () => random(/** @type {any} */ (dice));
  const pick = (/** @type {any[]} */ list) => list[Math.floor(roll() * list.length)];
  /** Up to `n` of a side's units, picked at random. */
  const some = (/** @type {number} */ player, /** @type {number} */ n) => {
    const ids = Object.values(state.units).filter((u) => u.owner === player).map((u) => u.id);
    return Array.from({ length: Math.min(n, ids.length) }, () => ids.splice(Math.floor(roll() * ids.length), 1)[0]);
  };
  /** @type {Record<string, number>} */
  const accepted = {};

  for (let t = 0; t < ticks; t++) {
    if (t === ticks / 2 && midway) state = JSON.parse(JSON.stringify(state));
    if (t % 5 === 0) {
      for (const player of [0, 1]) {
        const own = Object.values(state.buildings).filter((b) => b.owner === player);
        const cell = pick(board.list);
        const command = pick([
          { type: 'build', kind: pick(['tower', 'wagon', 'pit', 'farm', 'band']), q: cell.q, r: cell.r, units: some(player, Math.floor(roll() * 5)) },
          { type: 'crew', building: pick(own).id, units: some(player, Math.floor(roll() * 9)) },
          { type: 'upgrade', building: pick(own).id },
          { type: 'move', building: pick(own).id, q: cell.q, r: cell.r },
        ]);
        if (applyCommand(board, state, player, command).ok) accepted[command.type] = (accepted[command.type] ?? 0) + 1;
      }
    }
    run(board, state, 1);
  }
  return { state, accepted };
}

test('a long game of random commands from both sides never breaks a rule', () => {
  const { state, accepted } = randomGame(7, 3000);
  for (const type of ['build', 'crew', 'upgrade', 'move']) assert.ok(accepted[type] > 0, `no ${type} was accepted`);
  assert.ok(Object.values(state.units).some((u) => u.in === undefined), 'some units are out walking');
  assert.ok(Object.values(state.units).some((u) => u.level > 1), 'some units have levelled up');
});

test('the same commands at the same ticks give the same game, saved and reloaded or not', () => {
  const straight = randomGame(11, 1000);
  const reloaded = randomGame(11, 1000, () => {});
  assert.deepEqual(randomGame(11, 1000, () => {}, 'coop').state, randomGame(11, 1000, undefined, 'coop').state);
  assert.deepEqual(randomGame(11, 1000, () => {}, 'easy').state, randomGame(11, 1000, undefined, 'easy').state);
  assert.deepEqual(randomGame(11, 1000, () => {}, 'shared').state, randomGame(11, 1000, undefined, 'shared').state);
  assert.deepEqual(randomGame(11, 1000, () => {}, 'teams').state, randomGame(11, 1000, undefined, 'teams').state);
  assert.deepEqual(reloaded.state, straight.state);
  assert.notDeepEqual(randomGame(12, 1000).state, straight.state);
});

test('random is repeatable from its state', () => {
  const a = { rng: 42 };
  const b = { rng: 42 };
  const xs = [1, 2, 3].map(() => random(/** @type {any} */ (a)));
  assert.deepEqual(xs, [1, 2, 3].map(() => random(/** @type {any} */ (b))));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  assert.notEqual(xs[0], xs[1]);
});

// --- checks and views ----------------------------------------------------------

test('checkState finds broken states', () => {
  const board = openBoard(4);
  const sound = () => stateWith(
    [{ id: 'b1', type: 'castle' }, { id: 'b2', owner: 1, q: 3, r: 0 }],
    unitsIn('b1', 2, 10),
  );
  assert.deepEqual(checkState(board, sound()), []);

  /** @type {Array<[(s: any) => void, RegExp]>} */
  const cases = [
    [(s) => { s.buildings.b2.q = 1; }, /both hold 1,0/],
    [(s) => { s.units.u10.in = 'b2'; }, /isn't its side's/],
    [(s) => { s.units.u10.q = 1; s.units.u10.r = 0; }, /inside and out/],
    [(s) => { delete s.units.u10.in; s.units.u10.q = 9; s.units.u10.r = 9; }, /not on a passable cell/],
    [(s) => { s.buildings.b2.type = 'palace'; }, /unknown type/],
    [(s) => { s.buildings.b1.grade = 9; }, /bad grade/],
    [(s) => { s.buildings.b1.work = BUILDING_TYPES.castle.work; }, /bad work/],
    [(s) => { s.buildings.b2.work = 0; }, /bad work/],
    [(s) => { Object.assign(s.buildings.b2, { path: [[2, 0]], since: 1, until: 5 }); }, /cannot move/],
    [(s) => {
      for (const u of unitsIn('b2', 25, 50, 1)) s.units[u.id] = unit(u);
      s.nextId = 100;
    }, /more than it holds/],
    [(s) => {
      for (let i = 50; i < 71; i++) s.units[`u${i}`] = unit({ id: `u${i}`, owner: 1, q: 2, r: 0, to: 'b2' });
      s.nextId = 100;
    }, /a crew of 21, more than it holds/],
    [(s) => {
      s.buildings.b3 = { id: 'b3', owner: 0, type: 'pit', grade: 1, q: -3, r: 0, hp: 1, work: 0, dug: DUG_OUT };
      s.units.u11.in = 'b3';
      s.nextId = 100;
    }, /dug out, but still has a crew/],
    [(s) => { s.buildings.b3 = { id: 'b3', owner: 0, type: 'castle', grade: 1, q: -3, r: 3, hp: 1, work: 0 }; s.nextId = 100; }, /side 0 has 2 castles/],
    [(s) => { s.buildings.b2.hp = BUILDING_TYPES.tower.hp + 1; }, /bad hp/],
    [(s) => { s.players[1].stone = -1; }, /side 1: bad stock/],
    [(s) => { s.units.u10.skills.build = 2; }, /bad skills/],
    [(s) => { s.units.u10.practice.running = SKILL_XP + 1; }, /bad practice/],
    [(s) => { s.units.u10.xp = LEVEL_XP; }, /bad xp/],
    [(s) => { s.units.u10.level = MAX_LEVEL + 1; }, /bad level/],
    [(s) => { s.units.u10.name = ''; }, /bad name/],
    [(s) => { s.units.u10.id = 'u99'; }, /bad id/],
    [(s) => { s.seed = 2; }, /seed does not match/],
    [(s) => { s.version = 0; }, /state version 0/],
  ];
  for (const [breakIt, message] of cases) {
    const s = sound();
    breakIt(s);
    assert.match(checkState(board, s).join('\n'), message);
  }
  assert.deepEqual(checkState(board, null), ['not a state']);
});

test('the public view hides the dice, the id counter and experience, and cuts routes to the next cell', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b1', 1, 10));
  assert.deepEqual(applyCommand(board, state, 0, { type: 'crew', building: 'b2', units: ['u10'] }), OK);
  const view = publicView(state);
  assert.equal('rng' in view, false);
  assert.equal('nextId' in view, false);
  assert.deepEqual(Object.keys(view.units.u10).sort(), ['born', 'id', 'level', 'name', 'owner', 'path', 'q', 'r', 'since', 'skills', 'to', 'until']);
  assert.deepEqual(view.units.u10.path, [[1, 0]]);
  assert.equal(state.units.u10.path?.length, 3, 'the state keeps the whole route');
  assert.deepEqual(occupancy(view).onCell.get('0,0'), ['u10'], 'a view has the state\'s shape, so the same lookups work on it');

  run(board, state, 1);
  assert.equal(state.units.u10.practice.running, 1);
  assert.deepEqual(publicView(state).units.u10, view.units.u10, 'a tick of practice changes nothing players see');
  assert.ok(view.players.every((p) => !('tally' in p)), 'tallies are kept back while the game goes on');
  state.over = state.tick;
  assert.ok(publicView(state).players.every((p) => 'tally' in p), 'and shown once it is over');
});
