import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countLabel, drawOrder, heading, pickAt, pipsOf } from '../src/client/render.js';
import { BUILDING_TYPES } from '../src/core/rules.js';

test('a building shows a pip for each upgrade, a pit for each grade of depth, a new one none', () => {
  const grades = (/** @type {string} */ type) => Array.from({ length: BUILDING_TYPES[type].grades }, (_, i) => pipsOf({ type, grade: i + 1 }));
  assert.deepEqual(grades('wagon'), [0, 1, 2, 3]);
  assert.deepEqual(grades('tower'), [0, 1, 2]);
  assert.deepEqual(grades('castle'), [0, 1, 2]);
  assert.deepEqual([pipsOf({ type: 'farm', grade: 1 }), pipsOf({ type: 'band', grade: 1 }), pipsOf({ type: 'lair', grade: 1 })], [0, 0, 0]);
  const { perDepth = 1 } = BUILDING_TYPES.pit;
  assert.deepEqual([0, perDepth - 1, perDepth, 2 * perDepth, 3 * perDepth].map((dug) => pipsOf({ type: 'pit', grade: 1, dug })), [0, 0, 1, 2, 3]);
});

test('a castle full, and so not breeding, shows its room beside its count; others only their count', () => {
  const castle = (/** @type {number} */ grade) => /** @type {any} */ ({ type: 'castle', grade });
  assert.deepEqual([12, 39, 40, 41].map((n) => countLabel(castle(1), n)), ['12', '39', '40/40', '41/40']);
  assert.deepEqual([59, 60, 65].map((n) => countLabel(castle(3), n)), ['59', '60/60', '65/60']);
  assert.equal(countLabel(/** @type {any} */ ({ type: 'tower', grade: 1 }), 20), '20');
  assert.equal(countLabel(/** @type {any} */ ({ type: 'band', grade: 1 }), 80), '80');
});

test('a moving building heads left or right by its next cell, and nowhere while it stands', () => {
  const going = (/** @type {string} */ type, /** @type {Array<[number, number]>} */ path) => heading({ type, q: 0, r: 0, path });
  // The six neighbours: east, west, then north-east, north-west, south-east, south-west.
  assert.deepEqual([[1, 0], [-1, 0], [1, -1], [0, -1], [0, 1], [-1, 1]].map((c) => going('ghoul', [/** @type {[number, number]} */ (c)])), [1, -1, 1, -1, 1, -1]);
  assert.equal(going('wagon', []), 0, 'standing');
  assert.equal(going('castle', [[-1, 0]]), 0, 'never moves');
});

/** Buildings by id, for drawOrder and pickAt: each at (0, 0) unless it says. */
const placed = (/** @type {Array<{ id: string, type: string, owner: number, q?: number }>} */ list) => Object.fromEntries(
  list.map((b) => [b.id, /** @type {any} */ ({ grade: 1, r: 0, q: 0, ...b })]),
);

test("bands are drawn over buildings, the viewer's own over another side's", () => {
  const buildings = placed([
    { id: 'b1', type: 'band', owner: 0 }, { id: 'b2', type: 'band', owner: 1 }, { id: 'b3', type: 'pit', owner: 1 }, { id: 'b4', type: 'tower', owner: 0, q: 1 },
  ]);
  assert.deepEqual(drawOrder(buildings, 0).map((b) => b.id), ['b3', 'b4', 'b2', 'b1']);
  assert.deepEqual(drawOrder(buildings, 1).map((b) => b.id), ['b3', 'b4', 'b1', 'b2']);
  assert.deepEqual(drawOrder(buildings, null).map((b) => b.id), ['b3', 'b4', 'b1', 'b2'], 'a spectator: as they were made');
});

test("a click picks the viewer's band over the building under it; another side's band only when aiming", () => {
  // Bēla's band (side 1) and Ann's (side 0) stand on Bēla's pit; Ann's tower is next to it.
  const buildings = placed([
    { id: 'b1', type: 'pit', owner: 1 }, { id: 'b2', type: 'band', owner: 1 }, { id: 'b3', type: 'band', owner: 0 }, { id: 'b4', type: 'tower', owner: 0, q: 1 },
  ]);
  const at = new Map([['0,0', 'b1'], ['1,0', 'b4']]);
  const pick = (/** @type {number | null} */ seat, /** @type {boolean} */ aiming, q = 0) => pickAt(buildings, at, { q, r: 0 }, seat, aiming);
  assert.equal(pick(0, false), 'b3', 'her own band');
  assert.equal(pick(1, false), 'b2', 'his own band');
  assert.equal(pick(0, true), 'b2', "aiming, the other side's band before the pit under it");
  assert.equal(pick(null, false), 'b2', 'a spectator, any band');
  assert.equal(pick(0, false, 1), 'b4');
  assert.equal(pick(0, true, 1), null, 'never her own');
  assert.equal(pick(0, false, 5), null, 'nothing there');
  // With only another side's band and the pit: selecting reaches the pit, aiming the band.
  delete buildings.b3;
  assert.equal(pick(0, false), 'b1');
  assert.equal(pick(0, true), 'b2');
  delete buildings.b2;
  assert.equal(pick(0, true), 'b1', 'then the pit');
});
