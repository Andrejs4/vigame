/**
 * Board construction: which hexes exist, and what is on each one.
 *
 * Terrain is generated from a seeded value-noise field so the same seed always
 * produces the same map — important for a turn-based game where clients must
 * agree on the board without shipping it over the wire.
 */

import { axialToPixel, hexagon, key, rectangle } from './hex.js';

/** @typedef {import('./hex.js').Axial} Axial */
/** @typedef {'grass' | 'meadow' | 'scrub' | 'water'} Terrain */
/** @typedef {{ q: number, r: number, terrain: Terrain, tint: number, moveCost: number, passable: boolean }} Tile */

/** Movement cost and passability per terrain type. */
export const TERRAIN = /** @type {Record<Terrain, { moveCost: number, passable: boolean, label: string }>} */ ({
  grass:  { moveCost: 1, passable: true,  label: 'Grass' },
  meadow: { moveCost: 1, passable: true,  label: 'Meadow' },
  scrub:  { moveCost: 2, passable: true,  label: 'Scrub' },
  water:  { moveCost: Infinity, passable: false, label: 'Water' },
});

/**
 * Deterministic 32-bit hash of two integers plus a seed.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} A float in [0, 1).
 */
function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Smoothstep, for interpolating between noise lattice points. */
function smooth(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Seeded value noise sampled in world space.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number} Roughly in [0, 1].
 */
function valueNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Two octaves of value noise. Enough shape for a readable map, cheap enough
 * to regenerate every time rather than storing.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
function fbm(x, y, seed) {
  return valueNoise(x, y, seed) * 0.65 + valueNoise(x * 2.3, y * 2.3, seed + 101) * 0.35;
}

/**
 * Build a board.
 *
 * @param {object} [options]
 * @param {'rectangle' | 'hexagon'} [options.shape='rectangle']
 * @param {number} [options.width=18] Columns, when shape is 'rectangle'.
 * @param {number} [options.height=12] Rows, when shape is 'rectangle'.
 * @param {number} [options.radius=7] Radius, when shape is 'hexagon'.
 * @param {number} [options.seed=1337]
 * @param {number} [options.hexSize=34] Circumradius in world pixels.
 * @returns {{ tiles: Map<string, Tile>, list: Tile[], hexSize: number, seed: number }}
 */
export function createBoard(options = {}) {
  const {
    shape = 'rectangle',
    width = 18,
    height = 12,
    radius = 7,
    seed = 1337,
    hexSize = 34,
  } = options;

  const coords = shape === 'hexagon' ? hexagon(radius) : rectangle(width, height);
  const tiles = new Map();
  const list = [];

  for (const { q, r } of coords) {
    // Sample noise in world space so terrain features keep their shape
    // regardless of the board's coordinate layout.
    const p = axialToPixel(q, r, hexSize);
    const n = fbm(p.x / 240, p.y / 240, seed);
    const detail = hash2(q, r, seed + 7);

    /** @type {Terrain} */
    let terrain;
    if (n < 0.30) terrain = 'water';
    else if (n < 0.38) terrain = 'scrub';
    else if (n > 0.66) terrain = 'meadow';
    else terrain = 'grass';

    const tile = {
      q,
      r,
      terrain,
      // Per-tile tint keeps a large field of one terrain from looking flat.
      tint: detail,
      moveCost: TERRAIN[terrain].moveCost,
      passable: TERRAIN[terrain].passable,
    };
    tiles.set(key(q, r), tile);
    list.push(tile);
  }

  return { tiles, list, hexSize, seed };
}

/**
 * Look up a tile, or undefined if the coordinate is off-board.
 * @param {{ tiles: Map<string, Tile> }} board
 * @param {number} q
 * @param {number} r
 * @returns {Tile | undefined}
 */
export function tileAt(board, q, r) {
  return board.tiles.get(key(q, r));
}
