import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreRows } from '../server/scores.js';
import { openStorage } from '../server/storage.js';
import { TICKS_PER_SECOND } from '../src/core/rules.js';

const minute = 60 * TICKS_PER_SECOND;
const tally = (/** @type {Record<string, number>} */ t) => ({
  kills: 0, damage: 0, castles: 0, felled: 0, upgrades: 0, built: 0, born: 0, stone: 0, food: 0, won: 0, ...t,
});
/**
 * @param {string} id
 * @param {Array<string | null>} seats
 * @param {Array<Record<string, number>>} tallies One for each side, the players' first.
 * @param {{ winner?: number, over?: number }} [how]
 */
const ended = (id, seats, tallies, { winner, over = 60 * minute } = {}) => ({
  id, name: `Game ${id}`, mode: 'ffa', over, ...(winner === undefined ? {} : { winner }), seats,
  players: tallies.map((t, i) => ({ id: i, side: i, team: i, tally: tally(t) })),
});

test('a game\'s scores: each seated player\'s total as its table counts it, with what it came from', () => {
  // Won at 15 minutes: 10 kills, 7 born and the win, twice over for the quick win.
  const rows = scoreRows(ended('g1', ['a', null, 'c'], [{ kills: 10, won: 1, born: 7 }, { kills: 3 }, {}, { kills: 999 }], { winner: 0, over: 15 * minute }));
  assert.deepEqual(rows.map((r) => [r.seat, r.pid, r.points, r.won]), [[0, 'a', 1270, true], [2, 'c', 0, false]], 'no empty seat, no raiders');
  assert.deepEqual(rows[0].details, { side: 0, times: 2, over: 15 * minute, tally: tally({ kills: 10, won: 1, born: 7 }) });
});

test('the high scores are kept once per game, the best first, and stay when the game goes', () => {
  const storage = openStorage();
  for (const [pid, name] of [['a', 'Ann'], ['b', 'Bēla'], ['c', 'Cai']]) storage.savePlayer(pid, name, 'auto');
  storage.createGame({ id: 'g1', seed: 1, state: { over: 1 }, seats: ['a', 'b'] });
  const g1 = ended('g1', ['a', 'b'], [{ kills: 10, won: 1 }, { kills: 3 }], { winner: 0, over: 15 * minute });
  storage.recordScores(g1, 5);
  storage.recordScores({ ...g1, players: [{ id: 0, side: 0, team: 0, tally: tally({ kills: 99 }) }] }, 6);
  // Nobody won; a tie with Bēla's 30, made earlier, comes first; nothing counts nothing.
  storage.recordScores(ended('g2', ['c', 'a'], [{ kills: 3 }, {}]), 2);
  const best = storage.bestScores();
  assert.deepEqual(best.map((s) => [s.name, s.points, s.won, s.game.id, s.open]), [
    ['Ann', 1200, true, 'g1', true],
    ['Cai', 30, false, 'g2', false],
    ['Bēla', 30, false, 'g1', true],
  ], 'kept once: the second write for g1 changed nothing');
  assert.equal(best[0].details.tally?.kills, 10);
  assert.deepEqual(storage.scoresOf('g1').map((s) => s.name), ['Ann', 'Bēla']);

  for (let i = 0; i < 12; i++) storage.recordScores(ended(`m${i}`, ['b'], [{ kills: 200 + i }]), 10);
  assert.equal(storage.bestScores().length, 10);
  assert.equal(storage.bestScores()[0].points, 2110);
  storage.close();
});
