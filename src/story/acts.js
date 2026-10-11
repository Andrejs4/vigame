/**
 * Story mode: a campaign of acts, played alone, each on the same map for
 * everyone, which also teaches the game. An act is the usual game with a
 * story part (`Story` in game.js): what may be built, a time limit, and
 * its own way to be won or lost (`outcome`, checked by director.js after
 * every tick). Acts are built here from the core's own pieces (`newGame`,
 * then changed as plain data), so the usual game knows nothing of them.
 *
 * Pure like the core: the game server and the tests use it. The page needs
 * none of it: what it shows comes with the game's `story`.
 */

import { BOARD_OPTIONS, createBoard } from '../core/board.js';
import { newGame } from '../core/game.js';
import { MAX_HUNGER, TICKS_PER_SECOND } from '../core/rules.js';

/** @typedef {import('../core/game.js').GameState} GameState */

/**
 * @typedef {object} Act
 * @property {string} id Kept in its games (`story.act`), and a key of the page's words for it.
 * @property {string} name Its game's name, in English (the page shows its own word).
 * @property {number} seed Its map's: the same for every player.
 * @property {number} minutes Its time limit.
 * @property {string[]} builds What may be built in it.
 * @property {(state: GameState) => void} setup Changes to the usual opening.
 * @property {(state: GameState) => string | null} outcome How it has come out,
 *   or null while it goes on.
 * @property {string[]} wins The outcomes that win it.
 */

/** The player's side in an act: the only seat. */
const YOU = 0;

/**
 * Whether the player has no units left.
 * @param {GameState} state
 */
const nobodyLeft = (state) => !Object.values(state.units).some((u) => u.owner === YOU);

/** @type {Act[]} */
export const ACTS = [
  {
    // Your castle alone, starving: no enemy but the usual raiders. Feed the
    // village (farms grow food, pits dig the stone farms cost) until hunger
    // is gone, within fifteen minutes.
    id: 'dying-village',
    name: 'Dying village',
    seed: 3407,
    minutes: 15,
    builds: ['pit', 'farm'],
    setup(state) {
      const you = state.players[YOU];
      you.hunger = MAX_HUNGER;
      you.food = 0;
    },
    outcome(state) {
      const you = state.players[YOU];
      if (you.lost !== undefined) return 'fallen';
      if (nobodyLeft(state)) return 'empty';
      if (state.tick > 0 && you.hunger === 0) return 'fed';
      if (state.tick >= (state.story?.until ?? Infinity)) return 'time';
      return null;
    },
    wins: ['fed'],
  },
];

/**
 * An act by its id.
 * @param {string} id
 */
export function actOf(id) {
  return ACTS.find((a) => a.id === id) ?? null;
}

/**
 * The opening of an act, numbered from 0: its map's seed and its game,
 * with the player in seat 0.
 * @param {number} index
 * @returns {{ seed: number, state: GameState }}
 */
export function newStoryGame(index) {
  const act = ACTS[index];
  const board = createBoard({ ...BOARD_OPTIONS, seed: act.seed, players: 1 });
  // No Dark Lord: a game of one side, and the raiders.
  const state = newGame(board, { mode: 'ffa' });
  state.name = act.name;
  state.story = {
    act: act.id, builds: [...act.builds], until: act.minutes * 60 * TICKS_PER_SECOND,
    ...(index === ACTS.length - 1 ? { final: /** @type {true} */ (true) } : {}),
  };
  act.setup(state);
  return { seed: act.seed, state };
}
