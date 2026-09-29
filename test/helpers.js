/**
 * Shared test fixtures.
 */

import { TERRAIN } from '../src/core/board.js';
import { STATE_VERSION, advance, checkState } from '../src/core/game.js';
import { hexagon, key } from '../src/core/hex.js';
import { BUILDING_TYPES, SKILLS } from '../src/core/rules.js';

/** Every skill at `level`. */
export const skillsAt = (/** @type {number} */ level) => Object.fromEntries(Object.keys(SKILLS).map((s) => [s, level]));

/**
 * A hand-built board from a terrain map, for tests that need exact terrain.
 * @param {Record<string, import('../src/core/board.js').Terrain>} terrainByKey
 *   e.g. { '0,0': 'grass', '1,0': 'scrub' }.
 * @param {{ seed?: number, starts?: import('../src/core/hex.js').Axial[] }} [options]
 * @returns {import('../src/core/board.js').Board}
 */
export function boardFrom(terrainByKey, { seed = 1, starts = [] } = {}) {
  const tiles = new Map();
  const list = [];
  for (const [k, terrain] of Object.entries(terrainByKey)) {
    const [q, r] = k.split(',').map(Number);
    const tile = {
      q, r, terrain, tint: 0.5,
      moveCost: TERRAIN[terrain].moveCost,
      passable: TERRAIN[terrain].passable,
      buildable: TERRAIN[terrain].buildable,
    };
    tiles.set(key(q, r), tile);
    list.push(tile);
  }
  return { tiles, list, hexSize: 34, seed, starts };
}

/**
 * A hexagonal board of one terrain, with exceptions.
 * @param {number} radius
 * @param {Record<string, import('../src/core/board.js').Terrain>} [except]
 * @param {{ seed?: number, starts?: import('../src/core/hex.js').Axial[] }} [options]
 */
export function openBoard(radius, except = {}, options = {}) {
  /** @type {Record<string, import('../src/core/board.js').Terrain>} */
  const terrain = {};
  for (const { q, r } of hexagon(radius)) terrain[key(q, r)] = 'grass';
  return boardFrom({ ...terrain, ...except }, options);
}

/**
 * A two-side state with exactly these buildings and units, for tests that
 * set up a position by hand. Buildings default to unharmed towers at 0,0,
 * and units to fresh level 1 units named Test Unit; types that work start
 * with none done. Two sides, each on its own team (free for all), with
 * 1000 stone each.
 * @param {Array<Partial<import('../src/core/game.js').Building> & { id: string }>} buildings
 * @param {Array<Partial<import('../src/core/game.js').Unit> & { id: string }>} [units]
 * @param {number} [seed]
 * @returns {import('../src/core/game.js').GameState}
 */
export function stateWith(buildings, units = [], seed = 1) {
  const ids = [...buildings, ...units].map((e) => Number(e.id.slice(1)));
  const building = (/** @type {Partial<import('../src/core/game.js').Building>} */ b) => {
    const type = BUILDING_TYPES[b.type ?? 'tower'];
    return {
      owner: 0, type: 'tower', grade: 1, q: 0, r: 0,
      ...(type?.hp ? { hp: type.hp * (b.grade ?? 1) } : {}),
      ...(type?.work !== undefined ? { work: 0 } : {}),
      ...(type?.depth !== undefined ? { dug: 0 } : {}),
      ...b,
    };
  };
  const unit = (/** @type {Partial<import('../src/core/game.js').Unit>} */ u) => ({
    owner: 0, name: 'Test Unit', level: 1, xp: 0, skills: skillsAt(0), practice: skillsAt(0), ...u,
  });
  return {
    version: STATE_VERSION,
    mode: 'ffa',
    seed,
    tick: 0,
    rng: 1,
    nextId: Math.max(0, ...ids) + 1,
    players: [{ id: 0, team: 0, stone: 1000, food: 0, hunger: 0 }, { id: 1, team: 1, stone: 1000, food: 0, hunger: 0 }],
    buildings: Object.fromEntries(buildings.map((b) => [b.id, building(b)])),
    units: Object.fromEntries(units.map((u) => [u.id, unit(u)])),
  };
}

/**
 * Units inside a building, as many as asked, with ids from `first`.
 * @param {string} building
 * @param {number} count
 * @param {number} first
 * @param {number} [owner]
 */
export function unitsIn(building, count, first, owner = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: `u${first + i}`, owner, in: building }));
}

/**
 * Advance `ticks` times, checking the state after every tick.
 * @param {import('../src/core/board.js').Board} board
 * @param {import('../src/core/game.js').GameState} state
 * @param {number} ticks
 */
export function run(board, state, ticks) {
  for (let i = 0; i < ticks; i++) {
    advance(board, state);
    const problems = checkState(board, state);
    if (problems.length) throw new Error(`tick ${state.tick}: ${problems.join('; ')}`);
  }
}

/**
 * Advance until `done` holds, checking every tick; fail after `limit` ticks.
 * @param {import('../src/core/board.js').Board} board
 * @param {import('../src/core/game.js').GameState} state
 * @param {() => boolean} done
 * @param {number} [limit]
 */
export function runUntil(board, state, done, limit = 2000) {
  for (let i = 0; i < limit && !done(); i++) run(board, state, 1);
  if (!done()) throw new Error(`not done after ${limit} ticks`);
  return state.tick;
}
