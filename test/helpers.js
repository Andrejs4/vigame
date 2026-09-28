/**
 * Shared test fixtures.
 */

import { TERRAIN } from '../src/board.js';
import { key } from '../src/hex.js';

/**
 * A hand-built board from a terrain map, for tests that need exact terrain.
 * @param {Record<string, import('../src/board.js').Terrain>} terrainByKey
 *   e.g. { '0,0': 'grass', '1,0': 'scrub' }.
 * @param {number} [seed=1]
 */
export function boardFrom(terrainByKey, seed = 1) {
  const tiles = new Map();
  const list = [];
  for (const [k, terrain] of Object.entries(terrainByKey)) {
    const [q, r] = k.split(',').map(Number);
    const tile = {
      q, r, terrain, tint: 0.5,
      moveCost: TERRAIN[terrain].moveCost,
      passable: TERRAIN[terrain].passable,
    };
    tiles.set(key(q, r), tile);
    list.push(tile);
  }
  return { tiles, list, hexSize: 34, seed };
}

/**
 * A game object in the shape createGame returns, with the given units.
 * @param {Array<Partial<import('../src/game.js').Unit> & { id: string }>} units
 */
export function gameWith(units, currentPlayer = 0) {
  return {
    units: new Map(units.map((u) => [u.id, {
      owner: 0, q: 0, r: 0, move: 2, moveMax: 2, name: 'Infantry', ...u,
    }])),
    turn: 1,
    currentPlayer,
    selectedUnitId: null,
  };
}
