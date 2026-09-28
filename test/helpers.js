/**
 * Shared test fixtures.
 */

import { TERRAIN } from '../src/board.js';
import { STATE_VERSION, advance, checkState } from '../src/game.js';
import { hexagon, key } from '../src/hex.js';

/**
 * A hand-built board from a terrain map, for tests that need exact terrain.
 * @param {Record<string, import('../src/board.js').Terrain>} terrainByKey
 *   e.g. { '0,0': 'grass', '1,0': 'scrub' }.
 * @param {{ seed?: number, starts?: import('../src/hex.js').Axial[] }} [options]
 * @returns {import('../src/board.js').Board}
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
 * @param {Record<string, import('../src/board.js').Terrain>} [except]
 * @param {{ seed?: number, starts?: import('../src/hex.js').Axial[] }} [options]
 */
export function openBoard(radius, except = {}, options = {}) {
  /** @type {Record<string, import('../src/board.js').Terrain>} */
  const terrain = {};
  for (const { q, r } of hexagon(radius)) terrain[key(q, r)] = 'grass';
  return boardFrom({ ...terrain, ...except }, options);
}

/**
 * A two-side state with exactly these buildings and units, for tests that
 * set up a position by hand.
 * @param {Array<Partial<import('../src/game.js').Building> & { id: string }>} buildings
 * @param {Array<Partial<import('../src/game.js').Unit> & { id: string }>} [units]
 * @param {number} [seed]
 * @returns {import('../src/game.js').GameState}
 */
export function stateWith(buildings, units = [], seed = 1) {
  const ids = [...buildings, ...units].map((e) => Number(e.id.slice(1)));
  return {
    version: STATE_VERSION,
    seed,
    tick: 0,
    rng: 1,
    nextId: Math.max(0, ...ids) + 1,
    players: [{ id: 0 }, { id: 1 }],
    buildings: Object.fromEntries(buildings.map((b) => [b.id, { owner: 0, type: 'tower', grade: 1, q: 0, r: 0, ...b }])),
    units: Object.fromEntries(units.map((u) => [u.id, { owner: 0, type: 'militia', ...u }])),
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
 * @param {import('../src/board.js').Board} board
 * @param {import('../src/game.js').GameState} state
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
 * @param {import('../src/board.js').Board} board
 * @param {import('../src/game.js').GameState} state
 * @param {() => boolean} done
 * @param {number} [limit]
 */
export function runUntil(board, state, done, limit = 2000) {
  for (let i = 0; i < limit && !done(); i++) run(board, state, 1);
  if (!done()) throw new Error(`not done after ${limit} ticks`);
  return state.tick;
}
