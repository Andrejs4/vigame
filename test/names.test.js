import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PORTRAIT_SIDE, portraitOf, unitName } from '../src/core/names.js';

/**
 * Every name unitName can make: its dice rolled in steps finer than its
 * lists, so each first name meets each surname.
 */
function everyName() {
  const steps = 200;
  /** @type {Set<string>} */
  const names = new Set();
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const rolls = [(i + 0.5) / steps, (j + 0.5) / steps];
      names.add(unitName(() => /** @type {number} */ (rolls.shift())));
    }
  }
  return [...names];
}

test('every name has a face, and every face a name', () => {
  const names = everyName();
  /** @type {Record<string, Set<number>>} */
  const used = { men: new Set(), women: new Set() };
  /** @type {Record<string, Set<string>>} */
  const firsts = { men: new Set(), women: new Set() };
  for (const name of names) {
    const portrait = portraitOf(name);
    assert.ok(portrait, `${name} has a face`);
    assert.ok(Number.isInteger(portrait.face) && portrait.face >= 0 && portrait.face < PORTRAIT_SIDE ** 2, `${name}: face ${portrait.face}`);
    assert.deepEqual(portraitOf(name), portrait, `${name} has the same face each time`);
    used[portrait.sheet].add(portrait.face);
    firsts[portrait.sheet].add(name.split(' ')[0]);
  }
  assert.equal(used.men.size, PORTRAIT_SIDE ** 2, 'every face of the men is used');
  assert.equal(used.women.size, PORTRAIT_SIDE ** 2, 'every face of the women is used');
  // A misspelt name in the women's list would put a woman among the men.
  assert.equal(firsts.women.size, 25);
  assert.equal(firsts.men.size, 31);
  assert.equal(portraitOf('Joan Smith')?.sheet, 'women');
  assert.equal(portraitOf('Jocelyn Smith')?.sheet, 'men');
});

test('a name unitName cannot make has no face', () => {
  for (const name of ['', 'Joan', 'Joan Smyth', 'Jon Smith', 'Joan Smith Jr', 'joan smith']) {
    assert.equal(portraitOf(name), null, name);
  }
});
