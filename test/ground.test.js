import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { TERRAIN, createBoard } from '../src/core/board.js';
import { GROUND_FROM, GROUND_FULL, GROUND_PICTURES, GROUND_VERSIONS, groundLook, groundShown } from '../src/client/ground.js';

test('every terrain has its ground pictures, each a file in art/', () => {
  assert.deepEqual(Object.keys(GROUND_VERSIONS).sort(), Object.keys(TERRAIN).sort());
  for (const name of GROUND_PICTURES) assert.ok(existsSync(new URL(`../src/client/art/${name}.webp`, import.meta.url)), `no ${name}.webp`);
  assert.equal(GROUND_PICTURES.length, Object.values(GROUND_VERSIONS).reduce((a, b) => a + b, 0));
});

test('a cell\'s picture, turn and mirror come from its tint: the same on every page, and all of them used', () => {
  const board = createBoard({ seed: 1337, players: 8 });
  const looks = board.list.map((t) => groundLook(t));
  assert.deepEqual(looks, createBoard({ seed: 1337, players: 8 }).list.map((t) => groundLook(t)), 'the same map, the same ground');
  for (const [i, look] of looks.entries()) {
    assert.ok(look && look.name.startsWith(`ground-${board.list[i].terrain}-`) && GROUND_PICTURES.includes(look.name));
    assert.ok(Number.isInteger(look.turn) && look.turn >= 0 && look.turn < 6);
  }
  assert.deepEqual(new Set(looks.map((l) => l?.name)), new Set(GROUND_PICTURES), 'every version shows somewhere');
  assert.deepEqual(new Set(looks.map((l) => l?.turn)).size, 6, 'every turn');
  assert.deepEqual(new Set(looks.map((l) => l?.mirror)).size, 2, 'mirrored and not');
  assert.equal(groundLook({ terrain: 'lava', tint: 0.5 }), null);
});

test('the pictures fade in as the view comes close, and not further out', () => {
  assert.deepEqual([0.4, 1, GROUND_FROM, (GROUND_FROM + GROUND_FULL) / 2, GROUND_FULL, 2.5].map((z) => Number(groundShown(z).toFixed(3))), [0, 0, 0, 0.5, 1, 1]);
  // In full at the closest zoom and two presses of − out; gone at the third.
  assert.deepEqual([0, 1, 2, 3].map((presses) => groundShown(2.5 / 1.25 ** presses)), [1, 1, 1, 0]);
  // With the wheel: four notches out in full, gone at the sixth.
  assert.deepEqual([4, 6].map((notches) => groundShown(2.5 / 1.12 ** notches)), [1, 0]);
});
