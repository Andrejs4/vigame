import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HIGH_SCORES, highScores } from '../server/scores.js';
import { TICKS_PER_SECOND } from '../src/core/rules.js';

const minute = 60 * TICKS_PER_SECOND;
const tally = (/** @type {Record<string, number>} */ t) => ({
  kills: 0, damage: 0, castles: 0, felled: 0, upgrades: 0, built: 0, born: 0, stone: 0, food: 0, won: 0, ...t,
});
/**
 * @param {string} id
 * @param {Array<string | null>} seats
 * @param {Array<Record<string, number>>} tallies One for each side, the players' first.
 * @param {{ winner?: number | null, over?: number, at?: number }} [how]
 */
const finished = (id, seats, tallies, { winner = null, over = 60 * minute, at = 1 } = {}) => ({
  id, name: `Game ${id}`, mode: 'ffa', over, winner, seats, updatedAt: at,
  players: tallies.map((t, i) => ({ id: i, team: i, tally: tally(t) })),
});
const names = /** @type {Record<string, string>} */ ({ a: 'Ann', b: 'Bēla', c: 'Cai' });
const nameOf = (/** @type {string} */ pid) => names[pid] ?? '?';

test('the high scores: the best totals of seated players in finished games, as their tables count them', () => {
  const games = [
    // Won at 15 minutes: 10 kills and the win, twice over for the quick win.
    finished('g1', ['a', 'b'], [{ kills: 10, won: 1 }, { kills: 3 }], { winner: 0, over: 15 * minute, at: 5 }),
    // Nobody won; the raiders' record (third) has no seat and doesn't count.
    finished('g2', ['b', null], [{ kills: 50 }, { kills: 80 }, { kills: 999 }], { at: 3 }),
    // A tie with g1's Bēla, made earlier, so it comes first; nothing counts nothing.
    finished('g3', ['c', 'a'], [{ kills: 3 }, {}], { at: 2 }),
  ];
  const best = highScores(games, nameOf);
  assert.deepEqual(best.map((s) => [s.name, s.points, s.won, s.game.id]), [
    ['Ann', 1200, true, 'g1'],
    ['Bēla', 500, false, 'g2'],
    ['Cai', 30, false, 'g3'],
    ['Bēla', 30, false, 'g1'],
  ]);
  assert.deepEqual(best[0].game, { id: 'g1', name: 'Game g1', mode: 'ffa' });

  const many = Array.from({ length: 15 }, (_, i) => finished(`m${i}`, ['a'], [{ kills: i + 1 }]));
  const top = highScores(many, nameOf);
  assert.equal(top.length, HIGH_SCORES);
  assert.deepEqual([top[0].points, top.at(-1)?.points], [150, 60]);
});
