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
import { fullMeal, maxHp, newGame, occupancy } from '../core/game.js';
import { distance, key } from '../core/hex.js';
import { DARK_LORD, MAX_HUNGER, TICKS_PER_SECOND } from '../core/rules.js';

/** @typedef {import('../core/game.js').GameState} GameState */
/** @typedef {import('../core/board.js').Board} Board */

/**
 * @typedef {object} Act
 * @property {string} id Kept in its games (`story.act`), and a key of the page's words for it.
 * @property {string} name Its game's name, in English (the page shows its own word).
 * @property {number} seed Its map's: the same for every player.
 * @property {number} minutes Its time limit.
 * @property {string} [mode] Its game's mode (`MODES` in rules.js): one side
 *   alone if not given.
 * @property {string[]} builds What may be built in it.
 * @property {(state: GameState) => void} setup Changes to the usual opening.
 * @property {(board: Board, state: GameState) => void} [tick] What it does
 *   itself after every tick, such as send waves.
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

/**
 * Village defence's waves: from `first`, every `every`, wave n is
 * ceil(n / 2) ghouls and floor(n / 4) ogres (the Easy Lord's, at half their
 * hit points), on open cells across the map from the player's castle.
 */
export const WAVES = Object.freeze({ first: 60 * TICKS_PER_SECOND, every: 60 * TICKS_PER_SECOND });

/**
 * Send the act's wave due now, if one is: the Dark Lord's, who has no lair
 * in it. Plain data, with no dice, so the same in every game.
 * @param {Board} board
 * @param {GameState} state
 */
function sendWave(board, state) {
  const since = state.tick - WAVES.first;
  if (since < 0 || since % WAVES.every !== 0) return;
  const lord = state.players.find((p) => p.side === DARK_LORD);
  const castle = Object.values(state.buildings).find((b) => b.owner === YOU && b.type === 'castle');
  if (!lord || !castle) return;
  const wave = since / WAVES.every + 1;
  const kinds = [...Array(Math.ceil(wave / 2)).fill('ghoul'), ...Array(Math.floor(wave / 4)).fill('ogre')];
  // Across the map: the castle mirrored through its middle (the lair's site).
  const middle = board.starts[board.starts.length - 1];
  const across = { q: 2 * middle.q - castle.q, r: 2 * middle.r - castle.r };
  const taken = occupancy(state).buildingAt;
  const cells = board.list
    .filter((t) => t.passable && !taken.has(key(t.q, t.r)))
    .sort((a, b) => distance(a, across) - distance(b, across) || a.q - b.q || a.r - b.r);
  kinds.forEach((type, i) => {
    const cell = cells[i];
    if (!cell) return;
    const id = `b${state.nextId++}`;
    const b = { id, owner: lord.id, type, grade: 1, q: cell.q, r: cell.r, hp: 0 };
    b.hp = maxHp(state, b);
    state.buildings[id] = b;
  });
}

/** @type {Act[]} */
export const ACTS = [
  {
    // Your castle alone, starving: no enemy but the usual raiders. Save the
    // village from starvation (farms grow food, pits dig the stone farms
    // cost): won at once when hunger is gone, or after ten minutes if there
    // is food for everyone at the next meal.
    id: 'starving-village',
    name: 'Starving village',
    seed: 3407,
    minutes: 10,
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
      // Time runs out with a meal (ten minutes, a meal a minute): won if
      // that meal feeds everyone, so looked at the tick before it.
      const until = state.story?.until ?? Infinity;
      if (state.tick === until - 1 && fullMeal(state, YOU)) return 'supplied';
      return state.tick >= until ? 'time' : null;
    },
    wins: ['fed', 'supplied'],
  },
  {
    // A fresh castle on a fresh map, and waves of the Dark Lord's horde
    // from across it (he has no lair here): hold out for ten minutes.
    // Other buildings stand between them and the castle, whose units
    // raise none while they mend it; towers strike them.
    id: 'village-defence',
    name: 'Village defence',
    seed: 5151,
    minutes: 10,
    mode: 'easy',
    builds: ['pit', 'farm', 'tower'],
    setup(state) {
      for (const b of Object.values(state.buildings)) if (b.type === 'lair') delete state.buildings[b.id];
    },
    tick: sendWave,
    outcome(state) {
      const you = state.players[YOU];
      if (you.lost !== undefined) return 'fallen';
      if (nobodyLeft(state)) return 'empty';
      return state.tick >= (state.story?.until ?? Infinity) ? 'held' : null;
    },
    wins: ['held'],
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
  // One side, and the raiders, unless the act has a mode of its own.
  const state = newGame(board, { mode: act.mode ?? 'ffa' });
  state.name = act.name;
  state.story = {
    act: act.id, builds: [...act.builds], until: act.minutes * 60 * TICKS_PER_SECOND,
    ...(index === ACTS.length - 1 ? { final: /** @type {true} */ (true) } : {}),
  };
  act.setup(state);
  return { seed: act.seed, state };
}
