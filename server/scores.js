/**
 * The lobby's high scores: the best totals any player has made in a
 * finished game, by the same count as the game's own table of points
 * (`scoreOf`), quick-win bonus included.
 */

import { scoreOf } from '../src/core/game.js';

/** How many the lobby lists. */
export const HIGH_SCORES = 10;

/**
 * @typedef {{ id: string, name: string | null, mode: string, over: number, winner: number | null,
 *   seats: Array<string | null>, players: any[], updatedAt: number }} FinishedGame
 * @typedef {{ name: string, seat: number, points: number, won: boolean,
 *   game: { id: string, name: string | null, mode: string }, at: number }} HighScore
 */

/**
 * The best totals of the players who held a seat when each game ended,
 * highest first; of two the same, the one made first. Seats nobody held,
 * and totals of nothing, don't count.
 * @param {FinishedGame[]} games
 * @param {(pid: string) => string} nameOf
 * @param {number} [limit]
 * @returns {HighScore[]}
 */
export function highScores(games, nameOf, limit = HIGH_SCORES) {
  /** @type {HighScore[]} */
  const all = [];
  for (const g of games) {
    const state = { players: g.players, over: g.over, ...(g.winner === null ? {} : { winner: g.winner }) };
    g.seats.forEach((pid, seat) => {
      const p = g.players[seat];
      if (!pid || !p?.tally) return;
      const points = scoreOf(state, seat).total;
      if (points <= 0) return;
      all.push({
        name: nameOf(pid), seat, points, won: g.winner !== null && p.team === g.winner,
        game: { id: g.id, name: g.name, mode: g.mode }, at: g.updatedAt,
      });
    });
  }
  return all.sort((a, b) => b.points - a.points || a.at - b.at || a.game.id.localeCompare(b.game.id) || a.seat - b.seat)
    .slice(0, limit);
}
