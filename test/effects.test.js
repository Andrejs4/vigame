import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EFFECT_TIME, Effects, FLASH_TIME } from '../src/client/effects.js';
import { TICKS_PER_SECOND } from '../src/core/rules.js';

/**
 * A view as the page gets it, with just what the effects read.
 * @param {number} tick
 * @param {Array<Record<string, any>>} buildings
 * @param {Array<Record<string, any>>} [units]
 */
function viewAt(tick, buildings, units = []) {
  return /** @type {any} */ ({
    seed: 1,
    tick,
    players: [],
    buildings: Object.fromEntries(buildings.map((b) => [b.id, { owner: 0, q: 0, r: 0, grade: 1, ...b }])),
    units: Object.fromEntries(units.map((u) => [u.id, { owner: 0, ...u }])),
  });
}

const kinds = (/** @type {Effects} */ fx) => fx.list.map((e) => e.kind);

test('a building with fewer hit points than before was hit, and flashes briefly', () => {
  const fx = new Effects();
  const started = fx.update(viewAt(10, [{ id: 'b1', type: 'tower', hp: 500 }]), viewAt(11, [{ id: 'b1', type: 'tower', hp: 470 }]), 1000);
  assert.deepEqual(started, fx.list);
  assert.deepEqual(fx.list.map(({ kind, damage, building }) => ({ kind, damage, id: building?.id })), [{ kind: 'hit', damage: 30, id: 'b1' }]);
  assert.equal(fx.flash('b1', 1000), 1);
  assert.equal(fx.flash('b1', 1000 + FLASH_TIME), 0);
  assert.equal(fx.flash('b2', 1000), 0);

  // Repairs and upgrades add hit points, which is nothing to show.
  assert.deepEqual(fx.update(viewAt(11, [{ id: 'b1', type: 'tower', hp: 470 }]), viewAt(12, [{ id: 'b1', type: 'tower', hp: 471 }]), 1100), []);
  assert.equal(fx.list.length, 1);
});

test('a building gone fell, unless it was a band breaking up or a site given up', () => {
  const fx = new Effects();
  const before = viewAt(20, [
    { id: 'tower', type: 'tower', hp: 12 },
    { id: 'band', type: 'band' },
    { id: 'quit', type: 'farm', hp: 100, raised: 0 },
    { id: 'shot', type: 'farm', hp: 100, raised: 0 },
    { id: 'flat', type: 'pit', hp: 0, raised: 0 },
  ]);
  const hit = viewAt(21, [...Object.values(before.buildings).map((b) => (b.id === 'shot' ? { ...b, hp: 40 } : b))]);
  fx.update(before, hit, 0);
  fx.update(hit, viewAt(21 + TICKS_PER_SECOND, []), 1000);
  assert.deepEqual(fx.list.filter((e) => e.kind === 'fall').map((e) => e.building?.id).sort(), ['flat', 'shot', 'tower']);

  // A site hit long before it went was given up.
  const late = new Effects();
  const site = (/** @type {number} */ tick, /** @type {number} */ hp) => viewAt(tick, [{ id: 'shot', type: 'farm', hp, raised: 0 }]);
  late.update(site(20, 100), site(21, 40), 0);
  late.update(site(21 + 2 * TICKS_PER_SECOND, 40), viewAt(22 + 2 * TICKS_PER_SECOND, []), 2000);
  assert.deepEqual(kinds(late), ['hit']);
});

test('a unit gone died: out on the map where it was, inside a building as one', () => {
  const fx = new Effects();
  const castle = { id: 'c', type: 'castle', hp: 2000 };
  fx.update(
    viewAt(5, [castle], [{ id: 'u1', q: 3, r: 1 }, { id: 'u2', in: 'c' }, { id: 'u3', in: 'c' }, { id: 'u4', in: 'c' }, { id: 'u5', q: 2, r: 2 }]),
    // u4 walks out and u5 walks in: both still alive.
    viewAt(6, [castle], [{ id: 'u4', q: 1, r: 0 }, { id: 'u5', in: 'c' }]),
    0,
  );
  assert.deepEqual(fx.list.map((e) => ({ kind: e.kind, unit: e.unit?.id, building: e.building?.id, count: e.count })), [
    { kind: 'death', unit: 'u1', building: undefined, count: 1 },
    { kind: 'death', unit: undefined, building: 'c', count: 2 },
  ]);
});

test('a jump between updates plays nothing: the first update, a long gap, another game', () => {
  const fx = new Effects();
  const a = viewAt(10, [{ id: 'b1', type: 'tower', hp: 500 }], [{ id: 'u1', q: 0, r: 0 }]);
  const b = viewAt(10 + 3 * TICKS_PER_SECOND + 1, []);
  fx.update(null, a, 0);
  fx.update(a, b, 0);
  fx.update(a, { ...viewAt(11, []), seed: 2 }, 0);
  assert.deepEqual(fx.list, []);
});

test('effects play for their time, then are dropped', () => {
  const fx = new Effects();
  fx.update(viewAt(1, [{ id: 'b1', type: 'tower', hp: 500 }]), viewAt(2, [{ id: 'b1', type: 'tower', hp: 400 }]), 50);
  assert.equal(fx.playing(50 + EFFECT_TIME.hit - 1), true);
  assert.equal(fx.playing(50 + EFFECT_TIME.hit), false);
  assert.deepEqual(fx.list, []);
});
