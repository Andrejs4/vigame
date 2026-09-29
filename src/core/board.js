/**
 * Board construction: which hexes exist, and what is on each one.
 *
 * Terrain is generated from a seeded value-noise field so the same seed always
 * produces the same map. The page, the game server and a simulation all build
 * the board from the game's seed, so it is never stored or sent.
 */

import { axialToPixel, hexagon, key, line, neighbors, rectangle } from './hex.js';

/** @typedef {import('./hex.js').Axial} Axial */
/** @typedef {'grass' | 'meadow' | 'scrub' | 'water'} Terrain */
/**
 * @typedef {{ q: number, r: number, terrain: Terrain, tint: number, moveCost: number,
 *   passable: boolean, buildable: boolean }} Tile
 * @typedef {{ tiles: Map<string, Tile>, list: Tile[], hexSize: number, seed: number, starts: Axial[] }} Board
 */

/**
 * The board every game is played on; only the seed differs between games.
 * The page and the game server must build the same board from a seed, so
 * both take the options from here.
 */
/** The map settings every game uses; its size follows from the number of players. */
export const BOARD_OPTIONS = Object.freeze({ shape: 'rectangle', hexSize: 34 });

/**
 * What each terrain allows. Units and wagons cross passable cells, at
 * `moveCost` times their speed; buildings stand on buildable ones. The two
 * are independent, so any mix is possible.
 */
export const TERRAIN = /** @type {Record<Terrain, { moveCost: number, passable: boolean, buildable: boolean, label: string }>} */ ({
  grass:  { moveCost: 1, passable: true,  buildable: true,  label: 'Grass' },
  meadow: { moveCost: 1, passable: true,  buildable: true,  label: 'Meadow' },
  scrub:  { moveCost: 2, passable: true,  buildable: false, label: 'Scrub' },
  water:  { moveCost: Infinity, passable: false, buildable: false, label: 'Water' },
});

/**
 * Where the castles go, by number of players, as fractions of the map's
 * width and height: in a ring, the first at the left. The Dark Lord's lair
 * goes in the middle (LAIR_SPOT), cleared in every game and left empty in
 * games without him. A table rather than sines and cosines, so browsers and
 * the server make exactly the same map.
 */
const START_SPOTS = [
  [{ fx: 0.14, fy: 0.5 }],
  [{ fx: 0.14, fy: 0.5 }, { fx: 0.86, fy: 0.5 }],
  [{ fx: 0.14, fy: 0.5 }, { fx: 0.68, fy: 0.188 }, { fx: 0.68, fy: 0.812 }],
  [{ fx: 0.14, fy: 0.5 }, { fx: 0.5, fy: 0.14 }, { fx: 0.86, fy: 0.5 }, { fx: 0.5, fy: 0.86 }],
  [{ fx: 0.14, fy: 0.5 }, { fx: 0.389, fy: 0.158 }, { fx: 0.791, fy: 0.288 }, { fx: 0.791, fy: 0.712 }, { fx: 0.389, fy: 0.842 }],
  [{ fx: 0.14, fy: 0.5 }, { fx: 0.32, fy: 0.188 }, { fx: 0.68, fy: 0.188 }, { fx: 0.86, fy: 0.5 }, { fx: 0.68, fy: 0.812 }, { fx: 0.32, fy: 0.812 }],
  [{ fx: 0.14, fy: 0.5 }, { fx: 0.276, fy: 0.219 }, { fx: 0.58, fy: 0.149 }, { fx: 0.824, fy: 0.344 }, { fx: 0.824, fy: 0.656 }, { fx: 0.58, fy: 0.851 }, { fx: 0.276, fy: 0.781 }],
  [{ fx: 0.14, fy: 0.5 }, { fx: 0.245, fy: 0.245 }, { fx: 0.5, fy: 0.14 }, { fx: 0.755, fy: 0.245 }, { fx: 0.86, fy: 0.5 }, { fx: 0.755, fy: 0.755 }, { fx: 0.5, fy: 0.86 }, { fx: 0.245, fy: 0.755 }],
];
const LAIR_SPOT = { fx: 0.5, fy: 0.5 };

/**
 * The map's size for a number of players: 18 by 12 for one or two, growing
 * with the square root of the players beyond, so each has about as much
 * ground (36 by 24 for eight).
 * @param {number} players
 */
export function boardSize(players) {
  const scale = Math.sqrt(Math.max(2, players) / 2);
  return { width: Math.round(18 * scale), height: Math.round(12 * scale) };
}

/** Cells around a start that are cleared to grass: the castle and a ring around it. */
const START_CLEARING = 2;

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
 * The cell nearest a spot on the map with room for a castle and its
 * clearing, all on the board.
 * @param {Axial[]} coords
 * @param {Set<string>} onBoard
 * @param {number} hexSize
 * @param {{ fx: number, fy: number }} spot
 * @returns {Axial | null}
 */
function startNear(coords, onBoard, hexSize, spot) {
  const points = coords.map((c) => ({ c, p: axialToPixel(c.q, c.r, hexSize) }));
  const xs = points.map(({ p }) => p.x);
  const ys = points.map(({ p }) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const tx = minX + (maxX - minX) * spot.fx;
  const ty = minY + (maxY - minY) * spot.fy;

  let best = null;
  let bestD = Infinity;
  for (const { c, p } of points) {
    if (!hexagon(START_CLEARING).every((o) => onBoard.has(key(c.q + o.q, c.r + o.r)))) continue;
    const d = (p.x - tx) ** 2 + (p.y - ty) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * Whether `to` can be walked to from `from` over passable terrain.
 * @param {Map<string, Terrain>} terrain
 * @param {Axial} from
 * @param {Axial} to
 */
function connected(terrain, from, to) {
  const seen = new Set([key(from.q, from.r)]);
  const queue = [from];
  while (queue.length) {
    const cur = /** @type {Axial} */ (queue.shift());
    if (cur.q === to.q && cur.r === to.r) return true;
    for (const n of neighbors(cur.q, cur.r)) {
      const k = key(n.q, n.r);
      const t = terrain.get(k);
      if (!t || !TERRAIN[t].passable || seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return false;
}

/**
 * Build a board.
 *
 * @param {object} [options]
 * @param {'rectangle' | 'hexagon'} [options.shape='rectangle']
 * @param {number} [options.players=2] How many players' castles it has sites for (1 to 8).
 * @param {number} [options.width] Columns, when shape is 'rectangle'; by default from `boardSize`.
 * @param {number} [options.height] Rows, likewise.
 * @param {number} [options.radius=7] Radius, when shape is 'hexagon'.
 * @param {number} [options.seed=1337]
 * @param {number} [options.hexSize=34] Circumradius in world pixels.
 * @returns {Board}
 */
export function createBoard(options = {}) {
  const players = Math.max(1, Math.min(START_SPOTS.length, Math.floor(options.players ?? 2)));
  const {
    shape = 'rectangle',
    width = boardSize(players).width,
    height = boardSize(players).height,
    radius = 7,
    seed = 1337,
    hexSize = 34,
  } = options;

  const coords = shape === 'hexagon' ? hexagon(radius) : rectangle(width, height);

  /** @type {Map<string, Terrain>} */
  const terrain = new Map();
  for (const { q, r } of coords) {
    // Sample noise in world space so terrain features keep their shape
    // regardless of the board's coordinate layout.
    const p = axialToPixel(q, r, hexSize);
    const n = fbm(p.x / 240, p.y / 240, seed);
    terrain.set(key(q, r), n < 0.30 ? 'water' : n < 0.38 ? 'scrub' : n > 0.66 ? 'meadow' : 'grass');
  }

  // Castle sites: open ground for the castle and a ring around it, so it can
  // stand there and its units can get out.
  const onBoard = new Set(terrain.keys());
  const starts = /** @type {Axial[]} */ (
    [...START_SPOTS[players - 1], LAIR_SPOT].map((spot) => startNear(coords, onBoard, hexSize, spot)).filter(Boolean)
  );
  for (const s of starts) {
    for (const o of hexagon(START_CLEARING)) {
      const k = key(s.q + o.q, s.r + o.r);
      if (terrain.get(k) !== 'meadow') terrain.set(k, 'grass');
    }
  }
  // Every castle can be reached from every other: if water cuts them apart,
  // a strip of scrub crosses it.
  for (let i = 1; i < starts.length; i++) {
    if (connected(terrain, starts[0], starts[i])) continue;
    for (const c of line(starts[0], starts[i])) {
      const k = key(c.q, c.r);
      if (!TERRAIN[/** @type {Terrain} */ (terrain.get(k))].passable) terrain.set(k, 'scrub');
    }
  }

  const tiles = new Map();
  const list = [];
  for (const { q, r } of coords) {
    const t = /** @type {Terrain} */ (terrain.get(key(q, r)));
    const tile = {
      q,
      r,
      terrain: t,
      // Per-tile tint keeps a large field of one terrain from looking flat.
      tint: hash2(q, r, seed + 7),
      moveCost: TERRAIN[t].moveCost,
      passable: TERRAIN[t].passable,
      buildable: TERRAIN[t].buildable,
    };
    tiles.set(key(q, r), tile);
    list.push(tile);
  }

  return { tiles, list, hexSize, seed, starts };
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
