import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import {
  applyCommand, capacityOf, checkState, footprint, newGame, occupancy, publicView, random,
} from '../src/core/game.js';
import { BUILDING_TYPES, UNIT_LIMIT, UNIT_TYPES, WAGON_PATIENCE } from '../src/core/rules.js';
import { boardFrom, openBoard, run, runUntil, stateWith, unitsIn } from './helpers.js';

const OK = { ok: true };

test('a new game has one castle per side on the start sites, as plain JSON', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 1337 });
  const state = newGame(board);
  assert.deepEqual(checkState(board, state), []);
  assert.deepEqual(
    Object.values(state.buildings).map((b) => [b.owner, b.type, b.grade, b.q, b.r]),
    board.starts.map((s, owner) => [owner, 'castle', 1, s.q, s.r]),
  );
  assert.deepEqual(state.units, {});
  assert.equal(footprint('castle', 0, 0).length, 7, 'a castle covers a cell and its six neighbours');
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test('a castle makes a unit every two seconds until it is full', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }]);
  const { every, capacity } = BUILDING_TYPES.castle;
  run(board, state, /** @type {number} */ (every) - 1);
  assert.deepEqual(state.units, {});
  run(board, state, 1);
  assert.deepEqual(Object.values(state.units), [{ id: 'u2', owner: 0, type: 'militia', in: 'b1' }]);
  run(board, state, /** @type {number} */ (every) * (capacity + 5));
  assert.equal(occupancy(state).inside.get('b1')?.length, capacity);
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
  run(board, state, /** @type {number} */ (BUILDING_TYPES.castle.every) * 3);
  assert.equal(Object.keys(state.units).length, UNIT_LIMIT);
});

// --- sending units -------------------------------------------------------------

test('sent units leave one per tick, cross a cell a second, and go inside', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b1', 5, 10));
  assert.deepEqual(applyCommand(board, state, 0, { type: 'send', from: 'b1', to: 'b2', count: 3 }), OK);

  const out = Object.values(state.units).filter((u) => u.in === undefined);
  assert.deepEqual(out.map((u) => u.id), ['u10', 'u11', 'u12'], 'the first three go');
  const step = UNIT_TYPES.militia.speed;
  assert.deepEqual(out[1], {
    id: 'u11', owner: 0, type: 'militia', q: 0, r: 0, path: [[1, 0], [2, 0], [3, 0]], to: 'b2', since: 1, until: 1 + step,
  });
  assert.deepEqual(occupancy(state).onCell.get('0,0'), ['u10', 'u11', 'u12'], 'out on the castle\'s centre cell');

  // Three cells of grass: the first arrives after three steps, the rest a
  // tick apart.
  run(board, state, 3 * step - 1);
  assert.deepEqual(occupancy(state).inside.get('b2'), []);
  assert.deepEqual([state.units.u10.q, state.units.u10.r], [2, 0]);
  run(board, state, 1);
  assert.deepEqual(occupancy(state).inside.get('b2'), ['u10']);
  run(board, state, 2);
  assert.deepEqual(occupancy(state).inside.get('b2'), ['u10', 'u11', 'u12']);
  const made = Math.floor(state.tick / /** @type {number} */ (BUILDING_TYPES.castle.every));
  assert.equal(occupancy(state).inside.get('b1')?.length, 2 + made, 'two stayed, plus what the castle made meanwhile');
});

test('rough ground takes longer to cross', () => {
  const board = boardFrom({ '0,0': 'grass', '1,0': 'scrub', '2,0': 'grass', '3,0': 'grass' });
  const state = stateWith([{ id: 'b1' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b1', 1, 10));
  assert.deepEqual(applyCommand(board, state, 0, { type: 'send', from: 'b1', to: 'b2', count: 1 }), OK);
  const tick = runUntil(board, state, () => state.units.u10.in === 'b2');
  assert.equal(tick, 4 * UNIT_TYPES.militia.speed, 'scrub costs two steps, grass one');
});

test('units wait at the door of a full building, and follow a wagon that moved on', () => {
  const board = openBoard(4);
  const step = UNIT_TYPES.militia.speed;

  const full = stateWith(
    [{ id: 'b1', q: -2, r: 0 }, { id: 'b2', q: 2, r: 0 }],
    [...unitsIn('b1', 2, 10), ...unitsIn('b2', BUILDING_TYPES.tower.capacity, 100)],
  );
  assert.deepEqual(applyCommand(board, full, 0, { type: 'send', from: 'b1', to: 'b2', count: 2 }), OK);
  run(board, full, 4 * step + 20);
  assert.deepEqual([full.units.u10.q, full.units.u10.r, full.units.u10.to], [2, 0, 'b2'], 'waiting outside');
  assert.deepEqual(applyCommand(board, full, 0, { type: 'send', from: 'b2', to: 'b1', count: 1 }), OK);
  run(board, full, 1);
  assert.equal(full.units.u10.in, 'b2', 'in as soon as there is room');
  assert.equal(full.units.u11.in, undefined);

  const chase = stateWith([{ id: 'b1', q: -2, r: 0 }, { id: 'b2', type: 'wagon', q: 2, r: 0 }], unitsIn('b1', 1, 10));
  assert.deepEqual(applyCommand(board, chase, 0, { type: 'send', from: 'b1', to: 'b2', count: 1 }), OK);
  assert.deepEqual(applyCommand(board, chase, 0, { type: 'move', building: 'b2', q: 2, r: -2 }), OK);
  runUntil(board, chase, () => chase.units.u10.in === 'b2');
  assert.deepEqual([chase.buildings.b2.q, chase.buildings.b2.r], [2, -2]);
});

test('commands that are not allowed are refused, and change nothing', () => {
  // b4 stands on the edge, walled in by water.
  const board = openBoard(4, { '3,0': 'water', '3,1': 'water', '4,-1': 'water' });
  const state = stateWith(
    [{ id: 'b1', type: 'castle' }, { id: 'b2', q: -3, r: 0 }, { id: 'b3', owner: 1, q: 0, r: -3 }, { id: 'b4', q: 4, r: 0 }],
    unitsIn('b1', 3, 10),
  );
  assert.deepEqual(checkState(board, state), []);
  const before = JSON.stringify(state);

  /** @type {Array<[number, unknown, string]>} */
  const refusals = [
    [0, { type: 'send', from: 'b1', to: 'b3', count: 1 }, 'not your building'],
    [0, { type: 'send', from: 'b3', to: 'b1', count: 1 }, 'not your building'],
    [1, { type: 'send', from: 'b1', to: 'b2', count: 1 }, 'not your building'],
    [0, { type: 'send', from: 'b1', to: '__proto__', count: 1 }, 'not your building'],
    [0, { type: 'send', from: 'b1', to: 'b1', count: 1 }, 'same building'],
    [0, { type: 'send', from: 'b2', to: 'b1', count: 1 }, 'nobody inside'],
    [0, { type: 'send', from: 'b1', to: 'b2', count: 0 }, 'bad count'],
    [0, { type: 'send', from: 'b1', to: 'b2', count: 1.5 }, 'bad count'],
    [0, { type: 'send', from: 'b1', to: 'b4', count: 1 }, 'no way there'],
    [0, { type: 'upgrade', building: 'b3' }, 'not your building'],
    [0, { type: 'move', building: 'b2', q: 1, r: 1 }, 'cannot move'],
    [0, { type: 'fly' }, 'unknown command'],
    [0, null, 'not a command'],
    [0, 'send', 'not a command'],
    [2, { type: 'upgrade', building: 'b1' }, 'not a player'],
  ];
  for (const [player, command, reason] of refusals) {
    assert.deepEqual(applyCommand(board, state, player, command), { ok: false, reason }, JSON.stringify(command));
  }
  assert.equal(JSON.stringify(state), before);
});

// --- building ------------------------------------------------------------------

test('building needs open, buildable ground near one of your standing buildings', () => {
  const board = openBoard(5, { '2,-2': 'scrub', '-2,2': 'water' });
  const state = stateWith([{ id: 'b1', type: 'castle' }]);
  const tower = (/** @type {number} */ q, /** @type {number} */ r) => ({ type: 'build', kind: 'tower', q, r });

  assert.deepEqual(applyCommand(board, state, 0, tower(2, 0)), OK);
  assert.deepEqual(state.buildings.b2, { id: 'b2', owner: 0, type: 'tower', grade: 1, q: 2, r: 0 });
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
  const pick = (/** @type {any[]} */ list) => list[Math.floor(random(/** @type {any} */ (dice)) * list.length)];
  /** @type {Record<string, number>} */
  const accepted = {};

  for (let t = 0; t < ticks; t++) {
    if (t === ticks / 2 && midway) state = JSON.parse(JSON.stringify(state));
    if (t % 5 === 0) {
      for (const player of [0, 1]) {
        const own = Object.values(state.buildings).filter((b) => b.owner === player);
        const cell = pick(board.list);
        const command = pick([
          { type: 'send', from: pick(own).id, to: pick(own).id, count: 1 + Math.floor(random(/** @type {any} */ (dice)) * 20) },
          { type: 'build', kind: pick(['tower', 'wagon']), q: cell.q, r: cell.r },
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
  for (const type of ['send', 'build', 'upgrade', 'move']) assert.ok(accepted[type] > 0, `no ${type} was accepted`);
  assert.ok(Object.values(state.units).some((u) => u.in === undefined), 'some units are out marching');
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
    [(s) => { Object.assign(s.buildings.b2, { path: [[2, 0]], since: 1, until: 5 }); }, /cannot move/],
    [(s) => {
      for (const u of unitsIn('b2', 25, 50, 1)) s.units[u.id] = { ...u, type: 'militia' };
      s.nextId = 100;
    }, /more than it holds/],
    [(s) => { s.buildings.b3 = { id: 'b3', owner: 0, type: 'castle', grade: 1, q: -3, r: 3 }; }, /side 0 has 2 castles/],
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

test('the public view hides the dice and id counter, and cuts routes to the next cell', () => {
  const board = openBoard(4);
  const state = stateWith([{ id: 'b1', type: 'castle' }, { id: 'b2', q: 3, r: 0 }], unitsIn('b1', 1, 10));
  assert.deepEqual(applyCommand(board, state, 0, { type: 'send', from: 'b1', to: 'b2', count: 1 }), OK);
  const view = publicView(state);
  assert.equal('rng' in view, false);
  assert.equal('nextId' in view, false);
  assert.deepEqual(view.units.u10.path, [[1, 0]]);
  assert.equal(state.units.u10.path?.length, 3, 'the state keeps the whole route');
  assert.deepEqual(occupancy(view).onCell.get('0,0'), ['u10'], 'a view has the state\'s shape, so the same lookups work on it');
});
