/**
 * Story mode's director: after every tick of an act's game, the game server
 * has it put heroes from earlier acts in the places of those just born
 * (`welcomeHeroes`), let the act do its own part (its `tick`, such as
 * sending waves), and ask whether the act has come out (its `outcome`):
 * if so it ends the game, won, the player's team wins; lost, nobody does.
 * A game the core ended this tick (the castle fell, and only the Dark Lord
 * stands) is given its outcome too. It changes the game as plain data, as
 * the core does, but outside the core's rules, so a game rebuilt from its
 * command log alone doesn't end the same: story games don't need that
 * (their snapshots carry them).
 */

import { actOf, welcomeHeroes } from './acts.js';

/**
 * After a tick of an act's game: what the act does itself (`tick`, such as
 * its waves), then end it once it has come out.
 * @param {import('../core/board.js').Board} board
 * @param {import('../core/game.js').GameState} state
 * @returns {boolean} Whether it ended now.
 */
export function direct(board, state) {
  if (!state.story || state.story.result !== undefined) return false;
  const ended = state.over !== undefined;
  if (ended && state.over !== state.tick) return false; // ended earlier: given up, or before the director knew
  const act = actOf(state.story.act);
  if (!ended) {
    welcomeHeroes(state);
    act?.tick?.(board, state);
  }
  const result = act?.outcome(state);
  if (!act || !result) return false;
  state.story.result = result;
  state.over = state.tick;
  delete state.winner;
  for (const p of state.players) p.tally.won = 0;
  if (act.wins.includes(result)) {
    const you = state.players[0];
    state.winner = you.team;
    you.tally.won = 1;
  }
  return true;
}
