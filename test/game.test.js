import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import {
  advance, applyCommand, capacityOf, checkState, crewOf, footprint, levelXp, newGame, occupancy, publicView, random,
  starveChance,
} from '../src/core/game.js';
import {
  BUILDING_TYPES, COMBAT_PERIOD, FOOD_PER_UNIT, FOOD_PERIOD, KILL_XP, LEVEL_RATE, RANGED_DAMAGE, LEVEL_XP, MAX_LEVEL, SKILL_XP, START_UNITS, UNIT_LIMIT, WAGON_PATIENCE,
  WALK_TICKS, WORK_BASE,
} from '../src/core/rules.js';
import { boardFrom, openBoard, run, runUntil, skillsAt, stateWith, unitsIn } from './helpers.js';

const OK = { ok: true };

/** A whole unit, from the fields a test cares about. */
const unit = (/** @type {Partial<import('../src/core/game.js').Unit> & { id: string }} */ u) => stateWith([], [u]).units[u.id];

test('a new game has one castle per side on the start sites, with named units inside, as plain JSON', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 1337 });
  const state = newGame(board);
  assert.deepEqual(checkState(board, state), []);
  assert.deepEqual(
    Object.values(state.buildings).map((b) => [b.owner, b.type, b.grade, b.q, b.r, b.work]),
    board.starts.map((s, owner) => [owner, 'castle', 1, s.q, s.r, 0]),
  );
  const occ = occupancy(state);
  assert.deepEqual(Object.values(state.buildings).map((b) => occ.inside.get(b.id)?.length), [START_UNITS, START_UNITS]);
  const names = Object.values(state.units).map((u) => u.name);
  for (const name of names) assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  assert.ok(new Set(names).size > START_UNITS, 'names vary');
  assert.ok(Object.values(state.units).every((u) => u.level === 1 && Object.values(u.skills).every((s) => s === 0)));
  assert.equal(footprint('castle', 0, 0).length, 7, 'a castle covers a cell and its six neighbours');
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.deepEqual(newGame(board), state, 'the same seed names the same units');
});

// --- breeding, levels and skills ---------------------------------------------

test('a castle\'s units raise new ones, sooner the more there are and the better they breed', () => {
  const board = openBoard(4);
  const { work } = BUILDING_TYPES.castle;
  /** @param {Array<Partial<import('../src/core/game.js').Unit> & { id: string }>} units */
  const firstBirth = (units) => {
    const state = stateWith([{ id: 'b1', type: 'castle' }], units);
    const before = Object.keys(state.units).length;
    return runUntil(board, state, () => Object.keys(state.units).length > before);
  };
  const ten = unitsIn('b1', 10, 10);
  assert.equal(firstBirth(ten), Math.ceil(/** @type {number} */ (work) / (10 * WORK_BASE)));
  assert.equal(firstBirth(unitsIn('b1', 20, 10)), Math.ceil(/** @type {number} */ (work) / (20 * WORK_BASE)));
  const breeders = ten.map((u) => ({ ...u, level: WORK_BASE, skills: { ...skillsAt(0), breeding: WORK_BASE } }));
  assert.equal(firstBirth(breeders), Math.ceil(/** @type {number} */ (work) / (10 * 2 * WORK_BASE)), 'skill adds to the work');

  const state = stateWith([{ id: 'b1', type: 'castle' }], ten);
  runUntil(board, state, () => Object.keys(state.units).length > 10);
  const [born] = Object.values(state.units).slice(-1);
  assert.deepEqual(born, { ...born, id: 'u20', owner: 0, level: 1, xp: 0, skills: skillsAt(0), in: 'b1' });
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
  const towerRoom = BUILDING_TYPES.tower.capacity * 3;
  const inCastle = UNIT_LIMIT - 3 * towerRoom;
  assert.ok(inCastle > 0 && inCastle < BUILDING_TYPES.castle.capacity * 3, 'the castle still has room');
  const state = stateWith([
    { id: 'b1', type: 'castle', grade: 3 },
    { id: 'b2', grade: 3, q: 3, r: 0 },
    { id: 'b3', grade: 3, q: -3, r: 0 },
    { id: 'b4', grade: 3, q: 0, r: 3 },
  ], [
    ...unitsIn('b1', inCastle, 1000),
    ...unitsIn('b2', towerRoom, 2000),
    ...unitsIn('b3', towerRoom, 3000),
    ...unitsIn('b4', towerRoom, 4000),
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

test('a pit is built with its crew, who walk there and dig it deeper', () => {
  const board = openBoard(5);
  const state = stateWith([{ id: 'b1', type: 'castle' }], unitsIn('b1', 10, 10));
  const crew = ['u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17'];
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'pit', q: 3, r: 0, units: crew }), OK);
  assert.deepEqual(state.buildings.b20, {
    id: 'b20', owner: 0, type: 'pit', grade: 1, q: 3, r: 0, hp: BUILDING_TYPES.pit.hp, work: 0, dug: 0,
  });
  assert.deepEqual(crewOf(state, 'b20'), crew);

  runUntil(board, state, () => occupancy(state).inside.get('b20')?.length === crew.length);
  const { work } = state.buildings.b20;
  run(board, state, 1);
  assert.equal(state.buildings.b20.work, /** @type {number} */ (work) + crew.length * WORK_BASE);
  const stone = state.players[0].stone;
  runUntil(board, state, () => state.buildings.b20.dug === 1, 1000);
  assert.equal(state.players[0].stone, stone + 1, 'straight into the stock');
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
    { id: 'b5', type: 'pit', q: 3, r: -3, dug: 100 }, { id: 'b6', type: 'pit', q: -3, r: 3 },
  ], [...unitsIn('b1', 10, 10), { id: 'u30', owner: 1, in: 'b3' }]);
  assert.deepEqual(checkState(board, state), []);
  const before = JSON.stringify(state);
  const nine = unitsIn('b1', 9, 10).map((u) => u.id);

  /** @type {Array<[number, unknown, string]>} */
  const refusals = [
    [0, { type: 'crew', building: 'b3', units: [] }, 'not your building'],
    [1, { type: 'crew', building: 'b2', units: [] }, 'not your building'],
    [0, { type: 'crew', building: '__proto__', units: [] }, 'not your building'],
    [0, { type: 'crew', building: 'b1', units: [] }, 'the castle is home to every unit'],
    [0, { type: 'crew', building: 'b5', units: [] }, 'dug out'],
    [0, { type: 'crew', building: 'b2', units: 'u10' }, 'bad units'],
    [0, { type: 'crew', building: 'b2', units: ['u10', 'u10'] }, 'bad units'],
    [0, { type: 'crew', building: 'b2', units: [10] }, 'bad units'],
    [0, { type: 'crew', building: 'b2', units: ['u30'] }, 'not your unit'],
    [0, { type: 'crew', building: 'b2', units: ['__proto__'] }, 'not your unit'],
    [0, { type: 'crew', building: 'b6', units: nine }, 'too many units'],
    [0, { type: 'crew', building: 'b4', units: ['u10'] }, 'no way there'],
    [0, { type: 'build', kind: 'pit', q: -1, r: 2, units: 'u10' }, 'bad units'],
    [0, { type: 'build', kind: 'pit', q: -1, r: 2, units: nine }, 'too many units'],
    [0, { type: 'upgrade', building: 'b3' }, 'not your building'],
    [0, { type: 'upgrade', building: 'b6' }, 'fully upgraded'],
    [0, { type: 'move', building: 'b2', q: 1, r: 1 }, 'cannot move'],
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

// --- stone, food and hit points --------------------------------------------------

test('stone pays for towers, farms and upgrades; pits and wagons are free', () => {
  const board = openBoard(5);
  const state = stateWith([{ id: 'b1', type: 'castle' }]);
  state.players[0].stone = 100;
  const build = (/** @type {string} */ kind, /** @type {number} */ q) => applyCommand(board, state, 0, { type: 'build', kind, q, r: 0 });
  assert.deepEqual(build('tower', 2), OK);
  assert.deepEqual(build('farm', 3), OK);
  assert.equal(state.players[0].stone, 100 - BUILDING_TYPES.tower.cost - BUILDING_TYPES.farm.cost);
  assert.deepEqual(build('tower', -2), { ok: false, reason: 'not enough stone' });
  assert.deepEqual(build('pit', -2), OK);
  assert.deepEqual(build('wagon', -3), OK);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'upgrade', building: 'b1' }), { ok: false, reason: 'not enough stone' });
  state.players[0].stone = 1000;
  assert.deepEqual(applyCommand(board, state, 0, { type: 'upgrade', building: 'b1' }), OK);
  assert.equal(state.players[0].stone, 1000 - /** @type {number} */ (BUILDING_TYPES.castle.upgrade));
  assert.equal(state.buildings.b1.hp, 2 * BUILDING_TYPES.castle.hp, 'an upgrade adds hit points');
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
  // 7 + 300 from the castle, shared by 100: 3 each, 7 left over.
  assert.deepEqual([crowd.players[0].food, crowd.players[0].hunger], [7, 2]);

  // In a tower, so nobody is born meanwhile.
  const fed = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b2', 10, 1000));
  fed.players[0].hunger = 20;
  run(board, fed, FOOD_PERIOD);
  assert.deepEqual([fed.players[0].food, fed.players[0].hunger], [300 - 10 * FOOD_PER_UNIT, 15]);
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
  assert.ok(state.units.u10.practice.ranged > 0);
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

test('the side whose castle falls has lost, and gives no more commands', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }]);
  state.buildings.b1.hp = 0;
  run(board, state, 1);
  assert.equal(state.players[0].lost, 1);
  assert.deepEqual(applyCommand(board, state, 0, { type: 'build', kind: 'pit', q: 3, r: 0 }), { ok: false, reason: 'your castle has fallen' });
});

test('units mend their damaged building before their usual work', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'pit', q: 1, r: 0, hp: 100 }], unitsIn('b1', 5, 10));
  run(board, state, 10);
  assert.equal(state.buildings.b1.hp, 100 + 10, '5 units mend 1 hit point a tick');
  assert.equal(state.buildings.b1.work, 0, 'no digging meanwhile');
  assert.ok(state.units.u10.practice.build > 0);
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

// --- building ------------------------------------------------------------------

test('building needs open, buildable ground near one of your standing buildings', () => {
  const board = openBoard(5, { '2,-2': 'scrub', '-2,2': 'water' });
  const state = stateWith([{ id: 'b1', type: 'castle' }]);
  const tower = (/** @type {number} */ q, /** @type {number} */ r) => ({ type: 'build', kind: 'tower', q, r });

  assert.deepEqual(applyCommand(board, state, 0, tower(2, 0)), OK);
  assert.deepEqual(state.buildings.b2, { id: 'b2', owner: 0, type: 'tower', grade: 1, q: 2, r: 0, hp: BUILDING_TYPES.tower.hp });
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

test('upgrading raises grade and room, up to the top grade', () => {
  const state = stateWith([{ id: 'b1' }]);
  const { capacity, grades } = BUILDING_TYPES.tower;
  assert.equal(capacityOf(state.buildings.b1), capacity);
  for (let g = 2; g <= grades; g++) assert.deepEqual(applyCommand(openBoard(1), state, 0, { type: 'upgrade', building: 'b1' }), OK);
  assert.equal(capacityOf(state.buildings.b1), capacity * grades);
  assert.deepEqual(applyCommand(openBoard(1), state, 0, { type: 'upgrade', building: 'b1' }), { ok: false, reason: 'fully upgraded' });
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
function randomGame(seed, ticks, midway) {
  const board = createBoard({ ...BOARD_OPTIONS, seed });
  let state = newGame(board);
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
      s.buildings.b3 = { id: 'b3', owner: 0, type: 'pit', grade: 1, q: -3, r: 0, hp: 1, work: 0, dug: 100 };
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
  assert.deepEqual(Object.keys(view.units.u10).sort(), ['id', 'level', 'name', 'owner', 'path', 'q', 'r', 'since', 'skills', 'to', 'until']);
  assert.deepEqual(view.units.u10.path, [[1, 0]]);
  assert.equal(state.units.u10.path?.length, 3, 'the state keeps the whole route');
  assert.deepEqual(occupancy(view).onCell.get('0,0'), ['u10'], 'a view has the state\'s shape, so the same lookups work on it');

  run(board, state, 1);
  assert.equal(state.units.u10.practice.running, 1);
  assert.deepEqual(publicView(state).units.u10, view.units.u10, 'a tick of practice changes nothing players see');
});
