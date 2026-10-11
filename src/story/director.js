/**
 * Story mode's director: after every tick of an act's game, the game server
 * asks it whether the act has come out (its `outcome`), and if so ends the
 * game: won, the player's team wins; lost, nobody does. It changes the game
 * as plain data, as the core does, but outside the core's rules, so a game
 * rebuilt from its command log alone doesn't end the same: story games
 * don't need that (their snapshots carry them).
 */

import { actOf } from './acts.js';

/**
 * End an act's game once it has come out.
 * @param {import('../core/game.js').GameState} state
 * @returns {boolean} Whether it ended now.
 */
export function direct(state) {
  if (!state.story || state.over !== undefined) return false;
  const act = actOf(state.story.act);
  const result = act?.outcome(state);
  if (!act || !result) return false;
  state.story.result = result;
  state.over = state.tick;
  if (act.wins.includes(result)) {
    const you = state.players[0];
    state.winner = you.team;
    you.tally.won = 1;
  }
  return true;
}
