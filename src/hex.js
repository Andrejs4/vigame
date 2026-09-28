/**
 * Pointy-top hexagon math on axial coordinates (q, r).
 *
 * Reference: https://www.redblobgames.com/grids/hexagons/
 *
 * Axial coordinates are the cube coordinates (x, y, z) with the redundant
 * axis dropped: q = x, r = z, and the implied s = -q - r. Every function
 * here is pure; nothing touches the DOM or a canvas.
 */

/** @typedef {{ q: number, r: number }} Axial */

/** The six axial neighbour offsets, clockwise from due east. */
export const DIRECTIONS = /** @type {const} */ ([
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]);

const SQRT3 = Math.sqrt(3);

/**
 * Stable string key for an axial coordinate, for Map/Set membership.
 * @param {number} q
 * @param {number} r
 * @returns {string}
 */
export function key(q, r) {
  return q + ',' + r;
}

/**
 * Parse a key produced by {@link key} back into an axial coordinate.
 * @param {string} k
 * @returns {Axial}
 */
export function parseKey(k) {
  const i = k.indexOf(',');
  return { q: Number(k.slice(0, i)), r: Number(k.slice(i + 1)) };
}

/**
 * The neighbour of (q, r) in one of the six directions.
 * @param {number} q
 * @param {number} r
 * @param {number} direction Index into {@link DIRECTIONS}; wraps.
 * @returns {Axial}
 */
export function neighbor(q, r, direction) {
  const d = DIRECTIONS[((direction % 6) + 6) % 6];
  return { q: q + d.q, r: r + d.r };
}

/**
 * All six neighbours of (q, r), regardless of whether they exist on a board.
 * @param {number} q
 * @param {number} r
 * @returns {Axial[]}
 */
export function neighbors(q, r) {
  return DIRECTIONS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

/**
 * Hex distance in steps, i.e. the length of the shortest path ignoring cost.
 * @param {Axial} a
 * @param {Axial} b
 * @returns {number}
 */
export function distance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = -dq - dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}

/**
 * Centre of hex (q, r) in world pixels, pointy-top orientation.
 * `size` is the circumradius: centre to any corner.
 * @param {number} q
 * @param {number} r
 * @param {number} size
 * @returns {{ x: number, y: number }}
 */
export function axialToPixel(q, r, size) {
  return {
    x: size * SQRT3 * (q + r / 2),
    y: size * 1.5 * r,
  };
}

/**
 * Inverse of {@link axialToPixel}: which hex contains this world point.
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @returns {Axial} Rounded to the nearest whole hex.
 */
export function pixelToAxial(x, y, size) {
  const qf = ((SQRT3 / 3) * x - y / 3) / size;
  const rf = ((2 / 3) * y) / size;
  return axialRound(qf, rf);
}

/**
 * Round fractional axial coordinates to the nearest hex.
 *
 * Rounds in cube space and repairs the component with the largest rounding
 * error, which is what keeps the result on the q + r + s = 0 plane.
 * @param {number} qf
 * @param {number} rf
 * @returns {Axial}
 */
export function axialRound(qf, rf) {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);

  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);

  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;

  return { q, r };
}

/**
 * The six corner offsets of a pointy-top hex, relative to its centre.
 * Corner 0 points due north; corners proceed clockwise.
 * @param {number} size
 * @returns {Array<{ x: number, y: number }>}
 */
export function corners(size) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    out.push({ x: size * Math.cos(angle), y: size * Math.sin(angle) });
  }
  return out;
}

/**
 * Axial coordinates for a rectangular board `width` x `height`.
 *
 * Rows are offset so the result looks like a rectangle on screen rather than
 * a rhombus, which is what a strategy map usually wants.
 * @param {number} width
 * @param {number} height
 * @returns {Axial[]}
 */
export function rectangle(width, height) {
  const out = [];
  for (let r = 0; r < height; r++) {
    const rowOffset = Math.floor(r / 2);
    for (let q = -rowOffset; q < width - rowOffset; q++) {
      out.push({ q, r });
    }
  }
  return out;
}

/**
 * Axial coordinates for a hexagonal board of the given radius.
 * Radius 0 is a single hex; radius 1 is that hex plus its six neighbours.
 * @param {number} radius
 * @returns {Axial[]}
 */
export function hexagon(radius) {
  const out = [];
  for (let q = -radius; q <= radius; q++) {
    const lo = Math.max(-radius, -q - radius);
    const hi = Math.min(radius, -q + radius);
    for (let r = lo; r <= hi; r++) out.push({ q, r });
  }
  return out;
}

/**
 * Bounding box of a set of hexes in world pixels, including hex extents.
 * @param {Axial[]} hexes
 * @param {number} size
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, width: number, height: number }}
 */
export function bounds(hexes, size) {
  const w = (SQRT3 * size) / 2;
  const h = size;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { q, r } of hexes) {
    const { x, y } = axialToPixel(q, r, size);
    if (x - w < minX) minX = x - w;
    if (x + w > maxX) maxX = x + w;
    if (y - h < minY) minY = y - h;
    if (y + h > maxY) maxY = y + h;
  }
  if (!hexes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}
