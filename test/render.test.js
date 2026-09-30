import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pipsOf } from '../src/client/render.js';
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
