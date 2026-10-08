/**
 * The high scores: when a game ends, each seated player's total, counted
 * as the game's own table of points counts it (`scoreOf`, quick-win bonus
 * included), goes into a table of its own (`scores`, in storage.js), with
 * the details behind it. Games may be cleared when the rules change; the
 * scores stay.
 */

import { scoreOf } from '../src/core/game.js';

/** How many the lobby lists. */
export const HIGH_SCORES = 10;

/**
 * @typedef {{ id: string, name: string | null, mode: string, over: number, winner?: number | null,
 *   seats: Array<string | null>, players: any[] }} EndedGame
 * @typedef {{ seat: number, pid: string, points: number, won: boolean,
 *   details: { side: number, times: number, over: number, tally: Record<string, number> } }} ScoreRow
 */

/**
 * Each seated player's score in a game that has ended; seats nobody held
 * have none.
 * @param {EndedGame} game
 * @returns {ScoreRow[]}
 */
export function scoreRows(game) {
  const winner = game.winner ?? undefined;
  const state = { players: game.players, over: game.over, ...(winner === undefined ? {} : { winner }) };
  return game.seats.flatMap((pid, seat) => {
    const p = game.players[seat];
    if (!pid || !p?.tally) return [];
    const { total, times } = scoreOf(state, seat);
    return [{
      seat, pid, points: total, won: winner !== undefined && p.team === winner,
      details: { side: p.side, times, over: game.over, tally: { ...p.tally } },
    }];
  });
}
