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
/** @typedef {import('../core/game.js').Veteran} Veteran */
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
 * @property {(board: Board, state: GameState) => void} [opening] What it
 *   puts on the map as it opens, such as monsters' camps.
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
 * Village defence's waves: from `first`, every `every`, wave n is n + 1
 * ghouls and floor(n / 3) ogres (the Easy Lord's, at half their hit
 * points), on open cells across the map from the player's castle. Tried
 * with a player who only keeps everyone home: the castle barely holds;
 * with two towers crewed, easily.
 */
export const WAVES = Object.freeze({ first: 60 * TICKS_PER_SECOND, every: 60 * TICKS_PER_SECOND });

/**
 * The Dark Lord's, the castle, and the castle mirrored through the map's
 * middle (the lair's site), for an act's monsters.
 * @param {Board} board
 * @param {GameState} state
 */
function sides(board, state) {
  const lord = state.players.find((p) => p.side === DARK_LORD);
  const castle = Object.values(state.buildings).find((b) => b.owner === YOU && b.type === 'castle');
  if (!lord || !castle) return null;
  const middle = board.starts[board.starts.length - 1];
  return { lord, castle, across: { q: 2 * middle.q - castle.q, r: 2 * middle.r - castle.r } };
}

/**
 * The Dark Lord's monsters on the open cells nearest `near`: plain data,
 * with no dice, so the same in every game. Guards (`home`) keep to the
 * cell each is put on.
 * @param {Board} board
 * @param {GameState} state
 * @param {number} lord
 * @param {string[]} kinds
 * @param {import('../core/hex.js').Axial} near
 * @param {boolean} [guards]
 */
function placeMonsters(board, state, lord, kinds, near, guards = false) {
  const taken = occupancy(state).buildingAt;
  const cells = board.list
    .filter((t) => t.passable && !taken.has(key(t.q, t.r)))
    .sort((a, b) => distance(a, near) - distance(b, near) || a.q - b.q || a.r - b.r);
  kinds.forEach((type, i) => {
    const cell = cells[i];
    if (!cell) return;
    const id = `b${state.nextId++}`;
    /** @type {import('../core/game.js').Building} */
    const b = { id, owner: lord, type, grade: 1, q: cell.q, r: cell.r, hp: 0, ...(guards ? { home: /** @type {[number, number]} */ ([cell.q, cell.r]) } : {}) };
    b.hp = maxHp(state, b);
    state.buildings[id] = b;
  });
}

/**
 * Send the act's wave due now, if one is: the Dark Lord's, who has no lair
 * in it, from across the map.
 * @param {Board} board
 * @param {GameState} state
 */
function sendWave(board, state) {
  const since = state.tick - WAVES.first;
  if (since < 0 || since % WAVES.every !== 0) return;
  const at = sides(board, state);
  if (!at) return;
  const wave = since / WAVES.every + 1;
  const kinds = [...Array(wave + 1).fill('ghoul'), ...Array(Math.floor(wave / 3)).fill('ogre')];
  placeMonsters(board, state, at.lord.id, kinds, at.across);
}

/**
 * Clearing the woods' monsters: CAMPS camps, each of these, guarding the
 * far side of the map from the start; at its time, a last wave of these,
 * and every monster left goes for the castle.
 */
export const CAMPS = Object.freeze({
  count: 5,
  camp: Object.freeze(['ghoul', 'ghoul', 'ghoul', 'ogre']),
  last: Object.freeze(['ghoul', 'ghoul', 'ghoul', 'ghoul', 'ghoul', 'ghoul', 'ogre', 'ogre']),
  /** Cells at least this far from the castle may hold a camp. */
  far: 13,
});

/**
 * The camps of Clearing the woods, as it opens: their centres spread over
 * the far side of the map, the farthest from the castle first, then each
 * as far as can be from the castle and those before.
 * @param {Board} board
 * @param {GameState} state
 */
function makeCamps(board, state) {
  const at = sides(board, state);
  if (!at) return;
  const room = board.list.filter((t) => t.passable && distance(t, at.castle) >= CAMPS.far);
  /** @type {import('../core/hex.js').Axial[]} */
  const centres = [];
  for (let i = 0; i < CAMPS.count && room.length; i++) {
    const spread = (/** @type {import('../core/hex.js').Axial} */ t) => Math.min(distance(t, at.castle), ...centres.map((c) => distance(t, c)));
    const best = room.reduce((a, b) => (spread(b) > spread(a) || (spread(b) === spread(a) && (b.q < a.q || (b.q === a.q && b.r < a.r))) ? b : a));
    centres.push(best);
  }
  for (const c of centres) placeMonsters(board, state, at.lord.id, [...CAMPS.camp], c, true);
}

/**
 * Clearing the woods at its time, with monsters left: a last wave from
 * across the map, and all of them go for the castle.
 * @param {Board} board
 * @param {GameState} state
 */
function lastWave(board, state) {
  if (state.tick !== state.story?.until) return;
  const at = sides(board, state);
  if (!at || !monstersOf(state).length) return;
  placeMonsters(board, state, at.lord.id, [...CAMPS.last], at.across);
  for (const b of monstersOf(state)) delete b.home;
}

/**
 * The Dark Lord's monsters on the map.
 * @param {GameState} state
 */
const monstersOf = (state) => Object.values(state.buildings).filter((b) => state.players[b.owner]?.side === DARK_LORD);

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
  {
    // A fresh castle on a fresh map whose far side is crawling with
    // monsters, guarding their camps: more than enough to bring the castle
    // down all at once. Bands clear them out; won once none is left. At
    // ten minutes, those left and a last wave all come for the castle:
    // won if they all die.
    id: 'clearing-woods',
    name: 'Clearing the woods',
    seed: 7373,
    minutes: 10,
    mode: 'easy',
    builds: ['pit', 'farm', 'tower', 'band'],
    setup(state) {
      for (const b of Object.values(state.buildings)) if (b.type === 'lair') delete state.buildings[b.id];
    },
    opening: makeCamps,
    tick: lastWave,
    outcome(state) {
      const you = state.players[YOU];
      if (you.lost !== undefined) return 'fallen';
      if (nobodyLeft(state)) return 'empty';
      return state.tick > 0 && !monstersOf(state).length ? 'cleared' : null;
    },
    wins: ['cleared'],
  },
];

/**
 * Heroes born to the player this tick take the places of the heroes waiting
 * from earlier acts, the best first, with all they had learnt; once none
 * wait, heroes are born new as usual. The director calls it after every
 * tick; an act's opening, for the heroes it starts with.
 * @param {GameState} state
 */
export function welcomeHeroes(state) {
  const waiting = state.story?.heroes;
  if (!waiting) return;
  for (const u of Object.values(state.units)) {
    if (!waiting.length) break;
    if (u.owner !== YOU || !u.hero || u.born !== state.tick) continue;
    Object.assign(u, /** @type {Veteran} */ (waiting.shift()));
  }
  if (state.story && !waiting.length) delete state.story.heroes;
}

/**
 * The heroes an act's game leaves for the next act: the player's that
 * are still alive, and those still waiting, the best first.
 * @param {GameState} state
 * @returns {Veteran[]}
 */
export function veteransOf(state) {
  const alive = Object.values(state.units)
    .filter((u) => u.owner === YOU && u.hero)
    .map(({ name, level, xp, skills, practice }) => ({ name, level, xp, skills: { ...skills }, practice: { ...practice } }));
  return [...alive, ...structuredClone(state.story?.heroes ?? [])].sort((a, b) => b.level - a.level || b.xp - a.xp);
}

/**
 * An act by its id.
 * @param {string} id
 */
export function actOf(id) {
  return ACTS.find((a) => a.id === id) ?? null;
}

/**
 * The opening of an act, numbered from 0: its map's seed and its game,
 * with the player in seat 0, and the heroes from earlier acts waiting to
 * be born again (`welcomeHeroes`).
 * @param {number} index
 * @param {Veteran[]} [heroes]
 * @returns {{ seed: number, state: GameState }}
 */
export function newStoryGame(index, heroes = []) {
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
  act.opening?.(board, state);
  if (heroes.length) state.story.heroes = structuredClone(heroes);
  welcomeHeroes(state);
  return { seed: act.seed, state };
}
