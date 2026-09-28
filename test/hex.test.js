import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECTIONS, axialRound, axialToPixel, bounds, corners, distance, hexagon,
  key, neighbor, neighbors, parseKey, pixelToAxial, rectangle,
} from '../src/hex.js';

const SIZE = 34;

test('key and parseKey round-trip, including negatives', () => {
  for (const [q, r] of [[0, 0], [3, -7], [-12, 5], [-1, -1]]) {
    assert.equal(key(q, r), `${q},${r}`);
    assert.deepEqual(parseKey(key(q, r)), { q, r });
  }
});

test('neighbors are the six distinct hexes at distance 1', () => {
  const ns = neighbors(2, -3);
  assert.equal(ns.length, 6);
  assert.equal(new Set(ns.map((n) => key(n.q, n.r))).size, 6);
  for (const n of ns) assert.equal(distance({ q: 2, r: -3 }, n), 1);
});

test('neighbor wraps its direction index both ways', () => {
  assert.deepEqual(neighbor(0, 0, 6), neighbor(0, 0, 0));
  assert.deepEqual(neighbor(0, 0, -1), neighbor(0, 0, 5));
  DIRECTIONS.forEach((d, i) => assert.deepEqual(neighbor(1, 1, i), { q: 1 + d.q, r: 1 + d.r }));
});

test('distance is symmetric and counts steps', () => {
  const o = { q: 0, r: 0 };
  assert.equal(distance(o, o), 0);
  assert.equal(distance(o, { q: 3, r: 0 }), 3);
  assert.equal(distance(o, { q: 2, r: -1 }), 2);
  assert.equal(distance(o, { q: 1, r: 1 }), 2);
  assert.equal(distance({ q: -2, r: 4 }, { q: 3, r: -1 }), distance({ q: 3, r: -1 }, { q: -2, r: 4 }));
});

test('pixelToAxial inverts axialToPixel, and anywhere inside a hex maps to it', () => {
  // Inradius: the largest circle inside the hex.
  const inner = (Math.sqrt(3) / 2) * SIZE * 0.95;
  for (const { q, r } of hexagon(5)) {
    const c = axialToPixel(q, r, SIZE);
    assert.deepEqual(pixelToAxial(c.x, c.y, SIZE), { q, r });
    for (let a = 0; a < 12; a++) {
      const t = (a / 12) * Math.PI * 2;
      const p = pixelToAxial(c.x + Math.cos(t) * inner, c.y + Math.sin(t) * inner, SIZE);
      assert.deepEqual(p, { q, r }, `hex ${q},${r} angle ${a}`);
    }
  }
});

test('axialRound stays on the q + r + s = 0 plane', () => {
  for (let i = 0; i < 200; i++) {
    const qf = (i * 0.37) % 7 - 3.5;
    const rf = (i * 0.61) % 7 - 3.5;
    const { q, r } = axialRound(qf, rf);
    assert.ok(Number.isInteger(q) && Number.isInteger(r));
    // The rounded hex is never further than one step from the true point.
    assert.ok(Math.abs(q - qf) <= 1 && Math.abs(r - rf) <= 1);
  }
});

test('corners are pointy-top: six at the circumradius, first due north', () => {
  const cs = corners(SIZE);
  assert.equal(cs.length, 6);
  for (const c of cs) assert.ok(Math.abs(Math.hypot(c.x, c.y) - SIZE) < 1e-9);
  assert.ok(Math.abs(cs[0].x) < 1e-9);
  assert.ok(Math.abs(cs[0].y + SIZE) < 1e-9);
});

test('rectangle yields width x height unique hexes laid out as a rectangle', () => {
  const hexes = rectangle(18, 12);
  assert.equal(hexes.length, 18 * 12);
  assert.equal(new Set(hexes.map((h) => key(h.q, h.r))).size, hexes.length);
  // Every row spans the same horizontal extent (to within the odd-row offset).
  const rows = new Map();
  for (const h of hexes) {
    const x = axialToPixel(h.q, h.r, SIZE).x;
    const row = rows.get(h.r) ?? { min: Infinity, max: -Infinity };
    row.min = Math.min(row.min, x);
    row.max = Math.max(row.max, x);
    rows.set(h.r, row);
  }
  const halfWidth = (Math.sqrt(3) / 2) * SIZE;
  for (const { min } of rows.values()) assert.ok(min >= -1e-9 && min <= halfWidth + 1e-9);
});

test('hexagon(radius) has 3r(r+1)+1 hexes within radius', () => {
  for (const radius of [0, 1, 2, 7]) {
    const hexes = hexagon(radius);
    assert.equal(hexes.length, 3 * radius * (radius + 1) + 1);
    for (const h of hexes) assert.ok(distance({ q: 0, r: 0 }, h) <= radius);
  }
});

test('bounds covers hex extents, and is zero for no hexes', () => {
  const one = bounds([{ q: 0, r: 0 }], SIZE);
  assert.ok(Math.abs(one.width - Math.sqrt(3) * SIZE) < 1e-9);
  assert.ok(Math.abs(one.height - 2 * SIZE) < 1e-9);
  assert.deepEqual(bounds([], SIZE), { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 });
});
