import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Effects } from '../src/client/effects.js';
import { SOUNDS, SOUND_GAIN_MAX, soundsFor } from '../src/client/sounds.js';

/**
 * A view as the page gets it: players 0 and 2 are allies, 1 their enemy.
 * @param {number} tick
 * @param {Array<Record<string, any>>} buildings
 * @param {Array<Record<string, any>>} [units]
 * @param {Record<string, any>} [more]
 */
function viewAt(tick, buildings, units = [], more = {}) {
  return /** @type {any} */ ({
    seed: 1,
    tick,
    players: [{ id: 0, team: 0 }, { id: 1, team: 1 }, { id: 2, team: 0 }],
    buildings: Object.fromEntries(buildings.map((b) => [b.id, { owner: 0, q: 0, r: 0, grade: 1, type: 'tower', ...b }])),
    units: Object.fromEntries(units.map((u) => [u.id, { owner: 0, ...u }])),
    ...more,
  });
}

/** Cells with q < 0 are off screen; the rest are q / 10 across it. */
const where = (/** @type {number} */ q) => (q < 0 ? null : q / 10);

/**
 * The sounds going from one view to the next, as player `seat`.
 * @param {any} prev
 * @param {any} next
 * @param {number | null} [seat=0]
 */
function heard(prev, next, seat = 0) {
  const fresh = new Effects().update(prev, next, 0);
  return soundsFor({ prev, next, fresh, seat, where }).map((s) => s.name).sort();
}

test('your building hit is heard on screen, once, and nobody else\'s', () => {
  const before = viewAt(10, [{ id: 'a', hp: 500, q: 2 }, { id: 'b', hp: 500, q: 3 }, { id: 'off', hp: 500, q: -4 }, { id: 'e', owner: 1, hp: 500, q: 4 }]);
  const after = viewAt(11, [{ id: 'a', hp: 490, q: 2 }, { id: 'b', hp: 480, q: 3 }, { id: 'off', hp: 400, q: -4 }, { id: 'e', owner: 1, hp: 300, q: 4 }]);
  const fresh = new Effects().update(before, after, 0);
  assert.deepEqual(soundsFor({ prev: before, next: after, fresh, seat: 0, where }), [{ name: 'hit', pan: 0.2 }]);
  assert.deepEqual(heard(before, after, null), []);
});

test('your building lost is heard anywhere; an enemy\'s felled only on screen; an ally\'s not at all', () => {
  const standing = [{ id: 'mine', hp: 10, q: -5 }, { id: 'foe', owner: 1, hp: 10, q: 5 }, { id: 'far', owner: 1, hp: 10, q: -6 }, { id: 'ally', owner: 2, hp: 10, q: 6 }];
  assert.deepEqual(heard(viewAt(1, standing), viewAt(2, [])), ['felled', 'lost']);
  assert.deepEqual(heard(viewAt(1, standing.slice(2)), viewAt(2, [])), []);
  // A spectator hears every building felled on screen.
  assert.deepEqual(heard(viewAt(1, standing), viewAt(2, []), null), ['felled']);
});

test('a death is heard on screen only', () => {
  const castle = { id: 'c', type: 'castle', hp: 2000, q: -3 };
  assert.deepEqual(heard(viewAt(1, [], [{ id: 'u1', q: 2, r: 0 }]), viewAt(2, [])), ['death']);
  assert.deepEqual(heard(viewAt(1, [castle], [{ id: 'u1', q: -2, r: 0 }, { id: 'u2', in: 'c' }]), viewAt(2, [castle])), []);
});

test('your building finished or upgraded, your unit born, and the horde coming out are heard', () => {
  const before = viewAt(1, [{ id: 'site', raised: 900 }, { id: 'up', upgrading: 50 }, { id: 'theirs', owner: 1, raised: 5 }], [{ id: 'u1' }]);
  const after = viewAt(2, [{ id: 'site' }, { id: 'up', grade: 2 }, { id: 'theirs', owner: 1 }, { id: 'g1', owner: 1, type: 'ghoul', hp: 120 }],
    [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', owner: 1 }]);
  assert.deepEqual(heard(before, after), ['born', 'built', 'wave']);
  assert.deepEqual(heard(before, after, null), ['wave']);
});

test('the end of the game is heard as a win or a loss by your team', () => {
  const playing = viewAt(1, []);
  assert.deepEqual(heard(playing, viewAt(2, [], [], { over: 2, winner: 0 })), ['win']);
  assert.deepEqual(heard(playing, viewAt(2, [], [], { over: 2, winner: 1 })), ['lose']);
  assert.deepEqual(heard(playing, viewAt(2, [], [], { over: 2 })), ['lose']);
  assert.deepEqual(heard(playing, viewAt(2, [], [], { over: 2, winner: 0 }), null), []);
});

test('nothing is heard across a jump: the first update, or a long gap', () => {
  const next = viewAt(100, [], [{ id: 'u9' }], { over: 100, winner: 0 });
  assert.deepEqual(soundsFor({ prev: null, next, fresh: [], seat: 0, where }), []);
  assert.deepEqual(heard(viewAt(1, []), next), []);
});

test('every sound is gentle and short', () => {
  for (const [name, s] of Object.entries(SOUNDS)) {
    assert.ok(s.gain > 0 && s.gain <= SOUND_GAIN_MAX, `${name} is too loud`);
    assert.ok(['sine', 'triangle'].includes(s.wave), `${name} has a harsh wave`);
    for (const [note, at, length] of s.notes) {
      assert.ok(note >= 36 && note <= 96, `${name} has a note out of range`);
      assert.ok(at >= 0 && length > 0 && at + length <= 1.5, `${name} lasts too long`);
    }
  }
});
