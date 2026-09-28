import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TERRAIN, createBoard, tileAt } from '../src/board.js';
import { findPath } from '../src/game.js';
import { hexagon } from '../src/hex.js';

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
  assert.equal(createBoard().list.length, 18 * 12);
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

test('every map has two castle sites, cleared, on opposite sides, and joined by land', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const b = createBoard({ seed });
    assert.equal(b.starts.length, 2, `seed ${seed}`);
    const [west, east] = b.starts;
    assert.ok(west.q + west.r / 2 < east.q + east.r / 2, `seed ${seed}: west is left of east`);
    for (const s of b.starts) {
      for (const o of hexagon(2)) {
        assert.ok(tileAt(b, s.q + o.q, s.r + o.r)?.buildable, `seed ${seed}: ${s.q + o.q},${s.r + o.r} is open ground`);
      }
    }
    assert.ok(findPath(b, west, east, () => false), `seed ${seed}: the castles can reach each other`);
  }
});

test('tileAt finds on-board tiles and nothing off-board', () => {
  const b = createBoard();
  const first = b.list[0];
  assert.equal(tileAt(b, first.q, first.r), first);
  assert.equal(tileAt(b, 999, 999), undefined);
});
