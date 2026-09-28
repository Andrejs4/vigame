/**
 * Turn-based game state: units, whose turn it is, and where a unit may move.
 *
 * Deliberately free of rendering and input concerns so it can later run
 * unchanged on a Colyseus server as the authoritative simulation.
 */

import { axialToPixel, key, neighbors } from './hex.js';
import { tileAt } from './board.js';

/** @typedef {import('./hex.js').Axial} Axial */
/** @typedef {import('./board.js').Tile} Tile */
/** @typedef {{ id: string, owner: number, q: number, r: number, move: number, moveMax: number, name: string }} Unit */

/** Player colours, indexed by owner id. */
export const PLAYERS = [
  { id: 0, name: 'Blue',   color: '#3d7fd8', accent: '#9ec5ff' },
  { id: 1, name: 'Crimson', color: '#c8473f', accent: '#ffb3ad' },
];

/**
 * Create the initial game state with a few units placed on passable tiles.
 * @param {ReturnType<typeof import('./board.js').createBoard>} board
 * @returns {{ units: Map<string, Unit>, turn: number, currentPlayer: number, selectedUnitId: string | null }}
 */
export function createGame(board) {
  /** @type {Map<string, Unit>} */
  const units = new Map();

  // Deployment zones sit inboard of the map edges so units are never tucked
  // under HUD panels or half off-screen at the default camera fit.
  const passable = board.list.filter((t) => t.passable);
  if (!passable.length) return { units, turn: 1, currentPlayer: 0, selectedUnitId: null };

  // Work in world space so deployment is independent of board shape.
  const points = passable.map((t) => ({ tile: t, p: axialToPixel(t.q, t.r, board.hexSize) }));
  const xs = points.map((e) => e.p.x);
  const ys = points.map((e) => e.p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const taken = new Set();

  /**
   * Nearest unoccupied passable tile to a point given in normalised board
   * coordinates, where (0, 0) is the top-left of the map and (1, 1) the
   * bottom-right.
   * @param {number} fx
   * @param {number} fy
   * @returns {Tile | undefined}
   */
  function deploy(fx, fy) {
    const tx = minX + spanX * fx;
    const ty = minY + spanY * fy;
    let best;
    let bestD = Infinity;
    for (const { tile, p } of points) {
      const k = key(tile.q, tile.r);
      if (taken.has(k)) continue;
      const d = (p.x - tx) ** 2 + (p.y - ty) ** 2;
      if (d < bestD) { bestD = d; best = tile; }
    }
    if (best) taken.add(key(best.q, best.r));
    return best;
  }

  const specs = [
    { owner: 0, name: 'Scout',    moveMax: 4, fx: 0.16, fy: 0.38 },
    { owner: 0, name: 'Infantry', moveMax: 2, fx: 0.16, fy: 0.62 },
    { owner: 1, name: 'Scout',    moveMax: 4, fx: 0.84, fy: 0.38 },
    { owner: 1, name: 'Infantry', moveMax: 2, fx: 0.84, fy: 0.62 },
  ];

  specs.forEach((spec, i) => {
    const tile = deploy(spec.fx, spec.fy);
    if (!tile) return;
    const id = 'u' + i;
    units.set(id, {
      id,
      owner: spec.owner,
      q: tile.q,
      r: tile.r,
      move: spec.moveMax,
      moveMax: spec.moveMax,
      name: spec.name,
    });
  });

  return { units, turn: 1, currentPlayer: 0, selectedUnitId: null };
}

/**
 * The unit occupying a hex, if any.
 * @param {{ units: Map<string, Unit> }} game
 * @param {number} q
 * @param {number} r
 * @returns {Unit | undefined}
 */
export function unitAt(game, q, r) {
  for (const u of game.units.values()) if (u.q === q && u.r === r) return u;
  return undefined;
}

/**
 * Every hex the unit can reach with its remaining movement, with the cost of
 * getting there. Uniform-cost search (Dijkstra) over terrain move costs.
 *
 * Tiles occupied by any unit are treated as blocked; friendly pass-through
 * would be a rules decision, so it is left out until the rules exist.
 *
 * @param {ReturnType<typeof import('./board.js').createBoard>} board
 * @param {{ units: Map<string, Unit> }} game
 * @param {Unit} unit
 * @returns {Map<string, number>} Hex key to accumulated movement cost.
 */
export function reachable(board, game, unit) {
  /** @type {Map<string, number>} */
  const cost = new Map([[key(unit.q, unit.r), 0]]);
  /** @type {Array<{ q: number, r: number, c: number }>} */
  const frontier = [{ q: unit.q, r: unit.r, c: 0 }];

  const occupied = new Set();
  for (const u of game.units.values()) {
    if (u.id !== unit.id) occupied.add(key(u.q, u.r));
  }

  while (frontier.length) {
    // Small frontiers; a linear scan beats a heap here.
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].c < frontier[bi].c) bi = i;
    }
    const cur = frontier.splice(bi, 1)[0];
    if (cur.c > (cost.get(key(cur.q, cur.r)) ?? Infinity)) continue;

    for (const n of neighbors(cur.q, cur.r)) {
      const k = key(n.q, n.r);
      const tile = tileAt(board, n.q, n.r);
      if (!tile || !tile.passable || occupied.has(k)) continue;

      const next = cur.c + tile.moveCost;
      if (next > unit.move) continue;
      if (next < (cost.get(k) ?? Infinity)) {
        cost.set(k, next);
        frontier.push({ q: n.q, r: n.r, c: next });
      }
    }
  }

  cost.delete(key(unit.q, unit.r));
  return cost;
}

/**
 * Move a unit, spending movement points. Returns false if the move is illegal.
 * @param {ReturnType<typeof import('./board.js').createBoard>} board
 * @param {{ units: Map<string, Unit>, currentPlayer: number }} game
 * @param {string} unitId
 * @param {number} q
 * @param {number} r
 * @returns {boolean}
 */
export function moveUnit(board, game, unitId, q, r) {
  const unit = game.units.get(unitId);
  if (!unit) return false;
  if (unit.owner !== game.currentPlayer) return false;

  const costs = reachable(board, game, unit);
  const spend = costs.get(key(q, r));
  if (spend === undefined) return false;

  unit.q = q;
  unit.r = r;
  unit.move -= spend;
  return true;
}

/**
 * End the current player's turn, restoring movement when the round wraps.
 * @param {{ units: Map<string, Unit>, turn: number, currentPlayer: number, selectedUnitId: string | null }} game
 */
export function endTurn(game) {
  game.selectedUnitId = null;
  game.currentPlayer = (game.currentPlayer + 1) % PLAYERS.length;
  if (game.currentPlayer === 0) game.turn += 1;

  for (const u of game.units.values()) {
    if (u.owner === game.currentPlayer) u.move = u.moveMax;
  }
}
