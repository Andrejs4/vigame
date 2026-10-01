import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EFFECT_TIME, Effects, FLASH_TIME, fallenHeroes, fallenHeroesNote } from '../src/client/effects.js';
import { FOOD_PERIOD, MAX_HUNGER, TICKS_PER_SECOND } from '../src/core/rules.js';

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

test('the player hears of their heroes who die: in combat, or of hunger at a meal while starving', () => {
  /** A view with the sides' hunger, and these units. */
  const at = (/** @type {number} */ tick, /** @type {number} */ hunger, /** @type {Array<Record<string, any>>} */ units) => /** @type {any} */ ({
    seed: 1, tick, mode: 'coop', buildings: {},
    players: [{ id: 0, team: 0, hunger }, { id: 1, team: 0, hunger: 0 }],
    units: Object.fromEntries(units.map((u) => [u.id, { owner: 0, name: `Unit ${u.id}`, ...u }])),
  });
  const army = [{ id: 'u1', hero: true }, { id: 'u2', hero: true }, { id: 'u3' }, { id: 'u4', owner: 1, hero: true }];
  // Away from a meal, every hero gone of the player's own died in combat; an
  // ordinary unit and another side's hero go unmentioned.
  const battle = fallenHeroes(at(100, MAX_HUNGER, army), at(101, MAX_HUNGER, []), 0);
  assert.deepEqual(battle, { combat: ['Unit u1', 'Unit u2'], hunger: [] });
  assert.equal(fallenHeroesNote(battle), '2 heroes died in combat.');
  // Over a meal, starving, they died of hunger; well fed, in combat.
  const meal = (/** @type {number} */ hunger) => fallenHeroes(at(FOOD_PERIOD - 1, hunger, army), at(FOOD_PERIOD, hunger, army.slice(1)), 0);
  assert.equal(fallenHeroesNote(meal(MAX_HUNGER)), 'Hero Unit u1 died from hunger.');
  assert.equal(fallenHeroesNote(meal(50)), 'Hero Unit u1 died in combat.');
  assert.equal(fallenHeroesNote({ combat: ['Ann'], hunger: ['Bo', 'Cy'] }), 'Hero Ann died in combat; 2 heroes died from hunger.');
  assert.equal(fallenHeroesNote({ combat: [], hunger: [] }), null);
  // Not for a spectator, nor across a jump in time.
  assert.deepEqual(fallenHeroes(at(100, 0, army), at(101, 0, []), null), { combat: [], hunger: [] });
  assert.deepEqual(fallenHeroes(at(100, 0, army), at(100 + 60 * TICKS_PER_SECOND, 0, []), 0), { combat: [], hunger: [] });
});
