import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TERRAIN, createBoard, tileAt } from '../src/core/board.js';
import { findPath } from '../src/core/game.js';
import { distance, hexagon } from '../src/core/hex.js';
import { BUILDING_TYPES, RANGED_RANGE } from '../src/core/rules.js';

/** @param {ReturnType<typeof createBoard>} b */
const terrainOf = (b) => b.list.map((t) => `${t.q},${t.r}:${t.terrain}`).join(' ');

test('the same seed always produces the same map', () => {
  assert.equal(terrainOf(createBoard({ seed: 42 })), terrainOf(createBoard({ seed: 42 })));
  assert.notEqual(terrainOf(createBoard({ seed: 42 })), terrainOf(createBoard({ seed: 43 })));
  assert.deepEqual(createBoard({ seed: 42 }).starts, createBoard({ seed: 42 }).starts);
});

test('the shipped seed has a mix of terrain, mostly passable', () => {
  const b = createBoard({ seed: 1337 });
  const counts = {};
  for (const t of b.list) counts[t.terrain] = (counts[t.terrain] ?? 0) + 1;
  for (const terrain of Object.keys(TERRAIN)) assert.ok(counts[terrain] > 0, `no ${terrain}`);
  assert.ok(b.list.filter((t) => t.passable).length > b.list.length / 2);
});

test('board shape and size follow the options', () => {
  assert.equal(createBoard().list.length, 24 * 16);
  assert.equal(createBoard({ width: 5, height: 3 }).list.length, 15);
  assert.equal(createBoard({ shape: 'hexagon', radius: 7 }).list.length, 169);
  assert.equal(createBoard({ hexSize: 20 }).hexSize, 20);
});

test('tiles carry their terrain rules and a tint in [0, 1)', () => {
  for (const t of createBoard({ seed: 7 }).list) {
    assert.equal(t.moveCost, TERRAIN[t.terrain].moveCost);
    assert.equal(t.passable, TERRAIN[t.terrain].passable);
    assert.equal(t.buildable, TERRAIN[t.terrain].buildable);
    assert.ok(t.tint >= 0 && t.tint < 1);
  }
  assert.deepEqual(
    Object.entries(TERRAIN).map(([name, t]) => `${name}:${t.passable}/${t.buildable}`),
    ['grass:true/true', 'meadow:true/true', 'scrub:true/false', 'water:false/false'],
  );
});

test('every map has castle sites on opposite sides and a lair site between, cleared and joined by land', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const b = createBoard({ seed });
    assert.equal(b.starts.length, 3, `seed ${seed}`);
    const [west, east, lair] = b.starts;
    const x = (/** @type {{ q: number, r: number }} */ c) => c.q + c.r / 2;
    assert.ok(x(west) < x(lair) && x(lair) < x(east), `seed ${seed}: west, lair, east from left to right`);
    for (const s of b.starts) {
      for (const o of hexagon(2)) {
        assert.ok(tileAt(b, s.q + o.q, s.r + o.r)?.buildable, `seed ${seed}: ${s.q + o.q},${s.r + o.r} is open ground`);
      }
    }
    assert.ok(findPath(b, west, east, () => false), `seed ${seed}: the castles can reach each other`);
    assert.ok(findPath(b, west, lair, () => false), `seed ${seed}: and the lair`);
  }
});

test('castles start out of the lair\'s reach, and of each other\'s', () => {
  // Reaches count from the edge of seven-cell footprints: one cell each side.
  const castleReach = RANGED_RANGE + /** @type {number} */ (BUILDING_TYPES.castle.reach) + 2;
  const lairReach = /** @type {{ reach: number }} */ (BUILDING_TYPES.lair.attack).reach + 2;
  for (let players = 1; players <= 8; players++) {
    for (const seed of [1, 3, 7]) {
      const { starts } = createBoard({ seed, players });
      const lair = /** @type {{ q: number, r: number }} */ (starts.at(-1));
      const castles = starts.slice(0, -1);
      for (const c of castles) {
        assert.ok(distance(c, lair) > Math.max(castleReach, lairReach), `${players} players, seed ${seed}: a castle in reach of the lair`);
        for (const d of castles) {
          if (d !== c) assert.ok(distance(c, d) > castleReach, `${players} players, seed ${seed}: castles in reach`);
        }
      }
    }
  }
});

test('tileAt finds on-board tiles and nothing off-board', () => {
  const b = createBoard();
  const first = b.list[0];
  assert.equal(tileAt(b, first.q, first.r), first);
  assert.equal(tileAt(b, 999, 999), undefined);
});
