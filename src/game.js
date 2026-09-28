/**
 * The game core: the whole game as plain data, and the rules that change it.
 *
 * The state (GameState below) is plain JSON. It is saved, sent and simulated
 * as it is, with no conversion layer. Three things change it:
 *
 *   applyCommand   what a player does: send units, build, upgrade, move a wagon
 *   advance        one tick of time: production, marching, wagons rolling
 *   newGame        the opening position
 *
 * Nothing here reads the clock, Math.random, the DOM or the network, so the
 * same seed and the same commands at the same ticks always give the same game:
 * on the page, on the game server, in a replay, and in a simulation run with
 * no players at all. Randomness, when the rules need it, comes from `random`,
 * whose seed is part of the state.
 *
 * Each fact is stored once. A building records its anchor cell (a castle's
 * centre); the cells it covers follow from its type. A unit records where it
 * is: inside a building, or on a cell. What stands on a cell and who is inside
 * a building are worked out from that (`occupancy`), never stored, so they
 * cannot disagree with it. A wagon carries its units because they record only
 * that they are inside it.
 */

import { distance, key, neighbors, parseKey } from './hex.js';
import { tileAt } from './board.js';
import { BUILDING_TYPES, BUILD_RANGE, DEPART_GAP, SIDES, UNIT_LIMIT, UNIT_TYPES, WAGON_PATIENCE } from './rules.js';

/** @typedef {import('./hex.js').Axial} Axial */
/** @typedef {import('./board.js').Board} Board */
/** @typedef {[number, number]} Cell A cell as [q, r], the compact form paths use. */

/**
 * @typedef {object} Building
 * @property {string} id
 * @property {number} owner Side number, an index into SIDES.
 * @property {string} type A key of BUILDING_TYPES.
 * @property {number} grade From 1 to the type's `grades`.
 * @property {number} q Anchor cell: the building's cell, or a castle's centre.
 * @property {number} r
 * @property {Cell[]} [path] A moving building's route, next cell first.
 * @property {number} [since] While it rolls to path[0]: the tick it set off,
 * @property {number} [until] and the tick it gets there. It holds both cells meanwhile.
 * @property {number} [waiting] The tick it found its next cell taken.
 */

/**
 * @typedef {object} Unit
 * @property {string} id
 * @property {number} owner
 * @property {string} type A key of UNIT_TYPES.
 * @property {string} [in] The building it is inside. Otherwise it is on cell (q, r).
 * @property {number} [q]
 * @property {number} [r]
 * @property {Cell[]} [path] Cells still to cross, next first.
 * @property {string} [to] The building it is heading for.
 * @property {number} [since] While it steps to path[0]: the tick it set off,
 * @property {number} [until] and the tick it gets there.
 */

/**
 * @typedef {object} GameState
 * @property {number} version The shape of this object; see STATE_VERSION.
 * @property {number} seed The map's seed. The board is rebuilt from it.
 * @property {number} tick Ticks since the game began.
 * @property {number} rng The random generator's state.
 * @property {number} nextId The number the next building or unit id gets.
 * @property {Array<{ id: number }>} players One per side in this game.
 * @property {Record<string, Building>} buildings By id.
 * @property {Record<string, Unit>} units By id.
 */

/**
 * @typedef {{ type: 'send', from: string, to: string, count: number }
 *   | { type: 'build', kind: string, q: number, r: number }
 *   | { type: 'upgrade', building: string }
 *   | { type: 'move', building: string, q: number, r: number }} Command
 * @typedef {{ ok: true } | { ok: false, reason: string }} Outcome
 */

/**
 * @typedef {object} Occupancy What is where, worked out from a state.
 * @property {Map<string, string>} buildingAt Cell key to the building covering
 *   it. A rolling wagon covers the cell it is leaving and the one it is entering.
 * @property {Map<string, string[]>} inside Building id to the units inside, in id order.
 * @property {Map<string, string[]>} onCell Cell key to the units out on it.
 * @property {number[]} unitCount Units per side.
 */

/** Bump when GameState changes shape, and teach `checkState` the new one. */
export const STATE_VERSION = 1;

/**
 * The opening position: one castle per side, on the board's start sites.
 * @param {Board} board
 * @returns {GameState}
 */
export function newGame(board) {
  /** @type {GameState} */
  const state = {
    version: STATE_VERSION,
    seed: board.seed,
    tick: 0,
    rng: board.seed >>> 0,
    nextId: 1,
    players: [],
    buildings: {},
    units: {},
  };
  board.starts.slice(0, SIDES.length).forEach((start, owner) => {
    state.players.push({ id: owner });
    const id = newId(state, 'b');
    state.buildings[id] = { id, owner, type: 'castle', grade: 1, q: start.q, r: start.r };
  });
  return state;
}

/**
 * A number in [0, 1) from the game's own generator (mulberry32), which moves
 * its state on. Use this, never Math.random, so replays come out the same.
 * @param {GameState} state
 */
export function random(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * @param {GameState} state
 * @param {'b' | 'u'} prefix
 */
function newId(state, prefix) {
  return `${prefix}${state.nextId++}`;
}

/**
 * The cells a building of this type covers when anchored at (q, r).
 * @param {string} type
 * @param {number} q
 * @param {number} r
 * @returns {Axial[]}
 */
export function footprint(type, q, r) {
  return BUILDING_TYPES[type]?.size === 7 ? [{ q, r }, ...neighbors(q, r)] : [{ q, r }];
}

/**
 * Every cell a building holds: its footprint, plus the cell a rolling wagon
 * is entering.
 * @param {Building} b
 * @returns {Axial[]}
 */
function heldCells(b) {
  const cells = footprint(b.type, b.q, b.r);
  if (b.until !== undefined && b.path?.length) cells.push({ q: b.path[0][0], r: b.path[0][1] });
  return cells;
}

/**
 * How many units a building holds.
 * @param {Building} b
 */
export function capacityOf(b) {
  return BUILDING_TYPES[b.type].capacity * b.grade;
}

/**
 * What is where. Built fresh from the state whenever it is needed: for a few
 * hundred units that takes microseconds, and it can never go stale.
 * @param {Pick<GameState, 'players' | 'buildings' | 'units'>} state
 * @returns {Occupancy}
 */
export function occupancy(state) {
  /** @type {Map<string, string>} */
  const buildingAt = new Map();
  /** @type {Map<string, string[]>} */
  const inside = new Map();
  /** @type {Map<string, string[]>} */
  const onCell = new Map();
  const unitCount = state.players.map(() => 0);

  for (const b of Object.values(state.buildings)) {
    inside.set(b.id, []);
    for (const c of heldCells(b)) buildingAt.set(key(c.q, c.r), b.id);
  }
  for (const u of Object.values(state.units)) {
    unitCount[u.owner] = (unitCount[u.owner] ?? 0) + 1;
    if (u.in !== undefined) {
      inside.get(u.in)?.push(u.id);
    } else {
      const k = key(/** @type {number} */ (u.q), /** @type {number} */ (u.r));
      const list = onCell.get(k);
      if (list) list.push(u.id);
      else onCell.set(k, [u.id]);
    }
  }
  return { buildingAt, inside, onCell, unitCount };
}

/**
 * The cheapest route over passable cells, by terrain cost, not entering
 * blocked cells.
 * @param {Board} board
 * @param {Axial} from
 * @param {Axial} goal
 * @param {(cellKey: string) => boolean} blocked
 * @returns {Cell[] | null} The cells to cross, `goal` last; null when there is no way.
 */
export function findPath(board, from, goal, blocked) {
  const start = key(from.q, from.r);
  const end = key(goal.q, goal.r);
  if (start === end) return [];

  /** @type {Map<string, number>} */
  const cost = new Map([[start, 0]]);
  /** @type {Map<string, string>} */
  const prev = new Map();
  const frontier = [{ q: from.q, r: from.r, c: 0 }];

  while (frontier.length) {
    // Boards have a few hundred cells; a linear scan beats a heap here. Ties
    // go to the earliest entry, so the route is the same every time.
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].c < frontier[bi].c) bi = i;
    const cur = frontier.splice(bi, 1)[0];
    const ck = key(cur.q, cur.r);
    if (ck === end) break;
    if (cur.c > /** @type {number} */ (cost.get(ck))) continue;

    for (const n of neighbors(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      const tile = tileAt(board, n.q, n.r);
      if (!tile || !tile.passable || blocked(nk)) continue;
      const c = cur.c + tile.moveCost;
      if (c < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, c);
        prev.set(nk, ck);
        frontier.push({ q: n.q, r: n.r, c });
      }
    }
  }

  if (!prev.has(end)) return null;
  /** @type {Cell[]} */
  const path = [];
  for (let k = end; k !== start; k = /** @type {string} */ (prev.get(k))) {
    const { q, r } = parseKey(k);
    path.push([q, r]);
  }
  return path.reverse();
}

/**
 * Ticks to enter a cell at a speed (ticks per cell on open ground).
 * @param {Board} board
 * @param {number} speed
 * @param {Cell} cell
 */
function stepTicks(board, speed, cell) {
  return speed * /** @type {import('./board.js').Tile} */ (tileAt(board, cell[0], cell[1])).moveCost;
}

/**
 * Units may cross any cell but one under another side's building.
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {number} owner
 */
function hostileCells(state, occ, owner) {
  return (/** @type {string} */ k) => {
    const id = occ.buildingAt.get(k);
    return id !== undefined && state.buildings[id].owner !== owner;
  };
}

/**
 * A wagon may only roll into a cell no other building holds, so wagons never
 * pass through each other.
 * @param {Occupancy} occ
 * @param {string} self
 */
function takenCells(occ, self) {
  return (/** @type {string} */ k) => {
    const id = occ.buildingAt.get(k);
    return id !== undefined && id !== self;
  };
}

/**
 * Set a unit off along its path at tick `at`.
 * @param {Board} board
 * @param {Unit} u
 * @param {number} at
 */
function setOff(board, u, at) {
  const path = /** @type {Cell[]} */ (u.path);
  u.since = at;
  u.until = at + stepTicks(board, UNIT_TYPES[u.type].speed, path[0]);
}

// --- commands ----------------------------------------------------------------

/**
 * @param {string} reason
 * @returns {Outcome}
 */
function refuse(reason) {
  return { ok: false, reason };
}

/**
 * The player's own building with this id, if there is one.
 * @param {GameState} state
 * @param {number} player
 * @param {unknown} id
 * @returns {Building | null}
 */
function ownBuilding(state, player, id) {
  if (typeof id !== 'string' || !Object.hasOwn(state.buildings, id)) return null;
  const b = state.buildings[id];
  return b.owner === player ? b : null;
}

/**
 * The cell a command names, if it names one.
 * @param {Record<string, unknown>} cmd
 * @returns {Axial | null}
 */
function commandCell(cmd) {
  return Number.isSafeInteger(cmd.q) && Number.isSafeInteger(cmd.r)
    ? { q: /** @type {number} */ (cmd.q), r: /** @type {number} */ (cmd.r) }
    : null;
}

/**
 * Apply one player's command, if it is allowed. Every change a player makes
 * goes through here, on the page and on the game server alike. The command is
 * checked field by field, since on the server it arrives straight off the
 * wire, and nothing changes unless it is allowed.
 *
 * @param {Board} board
 * @param {GameState} state
 * @param {number} player The side giving the command.
 * @param {unknown} command A {@link Command}, or anything claiming to be one.
 * @returns {Outcome}
 */
export function applyCommand(board, state, player, command) {
  if (!state.players.some((p) => p.id === player)) return refuse('not a player');
  if (!command || typeof command !== 'object') return refuse('not a command');
  const cmd = /** @type {Record<string, unknown>} */ (command);
  const occ = occupancy(state);
  switch (cmd.type) {
    case 'send': return sendUnits(board, state, occ, player, cmd);
    case 'build': return build(board, state, occ, player, cmd);
    case 'upgrade': return upgrade(state, player, cmd);
    case 'move': return moveBuilding(board, state, occ, player, cmd);
    default: return refuse('unknown command');
  }
}

/**
 * Send up to `count` units from one of your buildings to another. They leave
 * one after another and march by the cheapest route.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function sendUnits(board, state, occ, player, cmd) {
  const from = ownBuilding(state, player, cmd.from);
  const to = ownBuilding(state, player, cmd.to);
  if (!from || !to) return refuse('not your building');
  if (from.id === to.id) return refuse('same building');
  if (!Number.isSafeInteger(cmd.count) || /** @type {number} */ (cmd.count) < 1) return refuse('bad count');
  const ids = /** @type {string[]} */ (occ.inside.get(from.id));
  if (!ids.length) return refuse('nobody inside');
  const path = findPath(board, from, to, hostileCells(state, occ, player));
  if (!path) return refuse('no way there');

  ids.slice(0, /** @type {number} */ (cmd.count)).forEach((id, i) => {
    const u = state.units[id];
    delete u.in;
    u.q = from.q;
    u.r = from.r;
    u.path = path.map(([q, r]) => [q, r]);
    u.to = to.id;
    setOff(board, u, state.tick + i * DEPART_GAP);
  });
  return { ok: true };
}

/**
 * Build on open ground near one of your standing buildings.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function build(board, state, occ, player, cmd) {
  const kind = typeof cmd.kind === 'string' && Object.hasOwn(BUILDING_TYPES, cmd.kind) ? cmd.kind : null;
  if (!kind || !BUILDING_TYPES[kind].build) return refuse('cannot build that');
  const at = commandCell(cmd);
  if (!at) return refuse('bad cell');
  for (const c of footprint(kind, at.q, at.r)) {
    if (!tileAt(board, c.q, c.r)?.buildable) return refuse('cannot build there');
    if (occ.buildingAt.has(key(c.q, c.r))) return refuse('cell taken');
  }
  if (!nearStanding(state, player, at)) return refuse('too far from your buildings');

  const id = newId(state, 'b');
  state.buildings[id] = { id, owner: player, type: kind, grade: 1, q: at.q, r: at.r };
  return { ok: true };
}

/**
 * Whether a cell is within building range of one of the player's buildings
 * that doesn't move.
 * @param {GameState} state
 * @param {number} player
 * @param {Axial} at
 */
export function nearStanding(state, player, at) {
  return Object.values(state.buildings).some((b) => b.owner === player
    && !BUILDING_TYPES[b.type].speed
    && footprint(b.type, b.q, b.r).some((c) => distance(c, at) <= BUILD_RANGE));
}

/**
 * Raise a building's grade by one.
 * @param {GameState} state
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function upgrade(state, player, cmd) {
  const b = ownBuilding(state, player, cmd.building);
  if (!b) return refuse('not your building');
  if (b.grade >= BUILDING_TYPES[b.type].grades) return refuse('fully upgraded');
  b.grade += 1;
  return { ok: true };
}

/**
 * Send a wagon to a cell. It finishes the step it is taking first. Moving it
 * to where it already is stops it there.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function moveBuilding(board, state, occ, player, cmd) {
  const b = ownBuilding(state, player, cmd.building);
  if (!b) return refuse('not your building');
  if (!BUILDING_TYPES[b.type].speed) return refuse('cannot move');
  const goal = commandCell(cmd);
  if (!goal || !tileAt(board, goal.q, goal.r)?.passable) return refuse('cannot go there');

  const rolling = b.until !== undefined && b.path?.length ? b.path[0] : null;
  const from = rolling ? { q: rolling[0], r: rolling[1] } : { q: b.q, r: b.r };
  const route = findPath(board, from, goal, takenCells(occ, b.id));
  if (!route) return refuse('no way there');

  const path = rolling ? [rolling, ...route] : route;
  if (path.length) b.path = path;
  else delete b.path;
  delete b.waiting;
  return { ok: true };
}

// --- time --------------------------------------------------------------------

/**
 * Move the game on by one tick.
 * @param {Board} board
 * @param {GameState} state
 */
export function advance(board, state) {
  state.tick += 1;
  const occ = occupancy(state);
  produce(state, occ);
  rollWagons(board, state, occ);
  marchUnits(board, state, occ);
}

/**
 * Buildings that make units add one when their time comes, while they have
 * room and their side is under the unit limit.
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function produce(state, occ) {
  for (const b of Object.values(state.buildings)) {
    const type = BUILDING_TYPES[b.type];
    if (!type.produces || !type.every || state.tick % type.every !== 0) continue;
    const inside = /** @type {string[]} */ (occ.inside.get(b.id));
    if (inside.length >= capacityOf(b) || occ.unitCount[b.owner] >= UNIT_LIMIT) continue;
    const id = newId(state, 'u');
    state.units[id] = { id, owner: b.owner, type: type.produces, in: b.id };
    inside.push(id);
    occ.unitCount[b.owner] += 1;
  }
}

/**
 * Wagons roll cell by cell. A wagon only sets off into a cell no building
 * holds, and holds it until it arrives, so two wagons never share or swap
 * cells. One that stays blocked looks for another way, and stops if there is
 * none.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function rollWagons(board, state, occ) {
  for (const b of Object.values(state.buildings)) {
    const speed = BUILDING_TYPES[b.type].speed;
    if (!speed || !b.path) continue;

    if (b.until !== undefined) {
      if (state.tick < b.until) continue;
      occ.buildingAt.delete(key(b.q, b.r));
      [b.q, b.r] = /** @type {Cell} */ (b.path.shift());
      delete b.since;
      delete b.until;
    }
    if (!b.path.length) {
      delete b.path;
      continue;
    }

    const next = b.path[0];
    const nk = key(next[0], next[1]);
    if (!occ.buildingAt.has(nk)) {
      occ.buildingAt.set(nk, b.id);
      b.since = state.tick;
      b.until = state.tick + stepTicks(board, speed, next);
      delete b.waiting;
      continue;
    }

    b.waiting ??= state.tick;
    if (state.tick - b.waiting < WAGON_PATIENCE) continue;
    const goal = b.path[b.path.length - 1];
    const detour = findPath(board, b, { q: goal[0], r: goal[1] }, takenCells(occ, b.id));
    if (detour?.length) {
      b.path = detour;
      b.waiting = state.tick;
    } else {
      delete b.path;
      delete b.waiting;
    }
  }
}

/**
 * Units step from cell to cell, and go inside when they reach the building
 * they were sent to. If it is full they wait at the door; if it has moved
 * they follow it; if it is gone they stay where they are.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function marchUnits(board, state, occ) {
  for (const u of Object.values(state.units)) {
    if (u.in !== undefined) continue;
    if (u.path?.length) {
      if (state.tick < /** @type {number} */ (u.until)) continue;
      [u.q, u.r] = /** @type {Cell} */ (u.path.shift());
      if (u.path.length) {
        u.since = u.until;
        u.until = /** @type {number} */ (u.since) + stepTicks(board, UNIT_TYPES[u.type].speed, u.path[0]);
        continue;
      }
      delete u.path;
      delete u.since;
      delete u.until;
    }
    if (u.to !== undefined) arrive(board, state, occ, u);
  }
}

/**
 * A unit at the end of its route.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Unit} u
 */
function arrive(board, state, occ, u) {
  const target = ownBuilding(state, u.owner, u.to);
  if (!target) {
    delete u.to;
    return;
  }
  const here = { q: /** @type {number} */ (u.q), r: /** @type {number} */ (u.r) };
  if (footprint(target.type, target.q, target.r).some((c) => c.q === here.q && c.r === here.r)) {
    const inside = /** @type {string[]} */ (occ.inside.get(target.id));
    if (inside.length >= capacityOf(target)) return;
    delete u.q;
    delete u.r;
    delete u.to;
    u.in = target.id;
    inside.push(u.id);
    return;
  }
  const path = findPath(board, here, target, hostileCells(state, occ, u.owner));
  if (path?.length) {
    u.path = path;
    setOff(board, u, state.tick);
  } else {
    delete u.to;
  }
}

// --- checks and views --------------------------------------------------------

/**
 * Everything wrong with a state: an empty list for a sound one. The rules
 * keep these invariants; tests and simulations can check them after every
 * step, and the server checks a saved state before trusting it.
 * @param {Board} board
 * @param {unknown} raw
 * @returns {string[]}
 */
export function checkState(board, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['not a state'];
  const state = /** @type {GameState} */ (raw);
  /** @type {string[]} */
  const problems = [];
  const fail = (/** @type {string} */ message) => { problems.push(message); };

  if (state.version !== STATE_VERSION) return [`state version ${String(state.version)}, not ${STATE_VERSION}`];
  if (state.seed !== board.seed) fail('seed does not match the board');
  if (!Number.isSafeInteger(state.tick) || state.tick < 0) fail('bad tick');
  if (!Number.isSafeInteger(state.rng) || state.rng < 0) fail('bad rng');
  if (!Number.isSafeInteger(state.nextId) || state.nextId < 1) fail('bad nextId');
  if (!Array.isArray(state.players) || !state.players.every((p, i) => p?.id === i) || state.players.length > SIDES.length) {
    return [...problems, 'bad players'];
  }
  if (!isRecord(state.buildings) || !isRecord(state.units)) return [...problems, 'bad buildings or units'];

  const isOwner = (/** @type {unknown} */ o) => Number.isInteger(o) && Number(o) >= 0 && Number(o) < state.players.length;
  const issued = (/** @type {string} */ id, /** @type {string} */ prefix) => {
    const n = Number(id.slice(1));
    return id[0] === prefix && Number.isSafeInteger(n) && n >= 1 && n < state.nextId && id === `${prefix}${n}`;
  };
  const isCell = (/** @type {unknown} */ c) => Array.isArray(c) && c.length === 2
    && Boolean(tileAt(board, c[0], c[1])?.passable);
  const isTiming = (/** @type {Building | Unit} */ e) => (e.since === undefined && e.until === undefined)
    || (Number.isSafeInteger(e.since) && Number.isSafeInteger(e.until) && Number(e.until) > Number(e.since));

  /** @type {Map<string, string>} */
  const held = new Map();
  const castles = state.players.map(() => 0);
  for (const [id, b] of Object.entries(state.buildings)) {
    if (!b || b.id !== id || !issued(id, 'b')) { fail(`building ${id}: bad id`); continue; }
    const type = typeof b.type === 'string' && Object.hasOwn(BUILDING_TYPES, b.type) ? BUILDING_TYPES[b.type] : null;
    if (!type) { fail(`building ${id}: unknown type`); continue; }
    if (!isOwner(b.owner)) { fail(`building ${id}: bad owner`); continue; }
    if (!Number.isInteger(b.grade) || b.grade < 1 || b.grade > type.grades) fail(`building ${id}: bad grade`);
    if (b.type === 'castle') castles[b.owner] += 1;
    if (!Number.isSafeInteger(b.q) || !Number.isSafeInteger(b.r)) { fail(`building ${id}: bad cell`); continue; }

    for (const c of footprint(b.type, b.q, b.r)) {
      const tile = tileAt(board, c.q, c.r);
      if (!(type.speed ? tile?.passable : tile?.buildable)) fail(`building ${id}: cannot stand on ${c.q},${c.r}`);
    }
    if (b.path !== undefined && !(Array.isArray(b.path) && b.path.length && b.path.every(isCell))) fail(`building ${id}: bad path`);
    if (!isTiming(b) || (b.until !== undefined && !b.path?.length)) fail(`building ${id}: bad timing`);
    if ((b.path !== undefined || b.until !== undefined) && !type.speed) fail(`building ${id}: cannot move`);

    for (const c of heldCells(b)) {
      const k = key(c.q, c.r);
      const other = held.get(k);
      if (other !== undefined) fail(`buildings ${other} and ${id} both hold ${k}`);
      held.set(k, id);
    }
  }
  castles.forEach((n, owner) => { if (n > 1) fail(`side ${owner} has ${n} castles`); });

  const inside = new Map(Object.keys(state.buildings).map((id) => [id, 0]));
  const counts = state.players.map(() => 0);
  for (const [id, u] of Object.entries(state.units)) {
    if (!u || u.id !== id || !issued(id, 'u')) { fail(`unit ${id}: bad id`); continue; }
    if (typeof u.type !== 'string' || !Object.hasOwn(UNIT_TYPES, u.type)) fail(`unit ${id}: unknown type`);
    if (!isOwner(u.owner)) { fail(`unit ${id}: bad owner`); continue; }
    counts[u.owner] += 1;

    if (u.in !== undefined) {
      const home = typeof u.in === 'string' && Object.hasOwn(state.buildings, u.in) ? state.buildings[u.in] : null;
      if (!home || home.owner !== u.owner) fail(`unit ${id}: inside a building that isn't its side's`);
      else inside.set(home.id, /** @type {number} */ (inside.get(home.id)) + 1);
      if ([u.q, u.r, u.path, u.to, u.since, u.until].some((v) => v !== undefined)) fail(`unit ${id}: inside and out`);
      continue;
    }
    if (!isCell([u.q, u.r])) fail(`unit ${id}: not on a passable cell`);
    if (u.path !== undefined && !(Array.isArray(u.path) && u.path.length && u.path.every(isCell))) fail(`unit ${id}: bad path`);
    if (!isTiming(u) || (u.path !== undefined) !== (u.until !== undefined)) fail(`unit ${id}: bad timing`);
    if (u.to !== undefined && typeof u.to !== 'string') fail(`unit ${id}: bad destination`);
  }

  for (const [id, n] of inside) {
    if (n > capacityOf(state.buildings[id])) fail(`building ${id}: ${n} inside, more than it holds`);
  }
  counts.forEach((n, owner) => { if (n > UNIT_LIMIT) fail(`side ${owner} has ${n} units`); });
  return problems;
}

/** @param {unknown} v */
function isRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * What players are shown of a state: all of it, except the random seed and id
 * counter, with each route cut to its next cell. That is all a screen needs
 * to draw movement, and it keeps a unit's update small as it marches. Hidden
 * information, such as fog of war, would be filtered here, per side.
 * @param {GameState} state
 */
export function publicView(state) {
  /**
   * @template {Building | Unit} E
   * @param {Record<string, E>} entities
   * @returns {Record<string, E>}
   */
  const cut = (entities) => Object.fromEntries(Object.entries(entities).map(([id, e]) => (
    [id, e.path ? { ...e, path: e.path.slice(0, 1) } : e]
  )));
  return {
    version: state.version,
    seed: state.seed,
    tick: state.tick,
    players: state.players,
    buildings: cut(state.buildings),
    units: cut(state.units),
  };
}
