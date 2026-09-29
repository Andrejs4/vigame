/**
 * The game core: the whole game as plain data, and the rules that change it.
 *
 * The state (GameState below) is plain JSON. It is saved, sent and simulated
 * as it is, with no conversion layer. Three things change it:
 *
 *   applyCommand   what a player does: build, choose a building's crew,
 *                  upgrade, move a wagon
 *   advance        one tick of time: work, marching, wagons rolling
 *   newGame        the opening position
 *
 * Nothing here reads the clock, Math.random, the DOM or the network, so the
 * same seed and the same commands at the same ticks always give the same game:
 * on the game server, in a replay, and in a simulation run with no players at
 * all. Randomness, when the rules need it, comes from `random`, whose seed is
 * part of the state.
 *
 * Each fact is stored once. A building records its anchor cell (a castle's
 * centre); the cells it covers follow from its type. A unit records where it
 * is: inside a building, or on a cell, and the building it is heading for. A
 * building's crew is the units inside it or heading for it. What stands on a
 * cell, who is inside a building and who is its crew are worked out from that
 * (`occupancy`, `crewOf`), never stored, so they cannot disagree with it. A
 * wagon carries its units because they record only that they are inside it.
 *
 * Players direct buildings, not units: units walk only when they are given
 * to a building's crew, or sent home to their castle. A castle is every
 * unit's home; its units there raise new ones. A pit's crew digs stone, and
 * a farm's grows food, straight into their side's stock. Stone pays for
 * towers, farms and upgrades. Every minute the side eats, and goes hungry
 * if it runs short. Work trains the skill it uses, and the unit's level with
 * it. A new building goes up only once its crew gets there, and does
 * nothing else until it stands; an upgrade, too, is work for the crew. A
 * building with no hit points left collapses. A unit with nowhere to go goes
 * home. A band is a group of units that moves like a wagon, gives
 * no cover, and breaks up once it has nobody.
 */

import { distance, key, neighbors, parseKey } from './hex.js';
import { tileAt } from './board.js';
import { unitName } from './names.js';
import {
  BUILDING_TYPES, BUILD_RANGE, DARK_LORD, HORDE_MAX, HORDE_PERIOD, HORDE_START, RAIDERS, SALVAGE, RAID_CHANCE, RAID_CLEAR, RAID_MAX, RAID_PERIOD, RAID_ROAM, START_METAL, DEFAULT_MODE, MAX_PLAYERS, MODES, COMBAT_PERIOD, DEPART_GAP, FOOD_PER_UNIT, KILL_EVEN, KILL_MAX, KILL_STEP, KILL_XP, MELEE_DAMAGE, MELEE_RANGE,
  RANGED_DAMAGE, RANGED_RANGE, REPAIR_WORK, FOOD_PERIOD, FOOD_STORE, HUNGER_LINE, LEVEL_GROWTH,
  LEVEL_RATE, LEVEL_XP, MAX_HUNGER, MAX_LEVEL, SIDES, SKILLS, SKILL_XP, START_STONE, START_UNITS, STARVE_CHANCE,
  UNIT_LIMIT, WAGON_PATIENCE, WALK_TICKS, WORK_BASE,
} from './rules.js';

/** @typedef {import('./hex.js').Axial} Axial */
/** @typedef {import('./board.js').Board} Board */
/** @typedef {import('./rules.js').Skill} Skill */
/** @typedef {[number, number]} Cell A cell as [q, r], the compact form paths use. */

/**
 * @typedef {object} Building
 * @property {string} id
 * @property {number} owner Side number, an index into SIDES.
 * @property {string} type A key of BUILDING_TYPES.
 * @property {number} grade From 1 to the type's `grades`.
 * @property {number} q Anchor cell: the building's cell, or a castle's centre.
 * @property {number} r
 * @property {number} [hp] Hit points left. Bands have none.
 * @property {number} [raised] Work put into raising it so far, only while it
 *   is going up: until its type's `raise`.
 * @property {number} [upgrading] Work put into its next grade so far, only
 *   while it is being upgraded: until `raiseWork`.
 * @property {number} [work] Work done toward what it yields next, for types that work.
 * @property {number} [mend] Repair work done toward the next hit point.
 * @property {string} [target] The enemy building its units go for.
 * @property {number} [dug] Stone dug from a pit so far; its depth follows from it.
 * @property {Cell[]} [path] A moving building's route, next cell first.
 * @property {number} [since] While it rolls to path[0]: the tick it set off,
 * @property {number} [until] and the tick it gets there. It holds both cells meanwhile.
 * @property {number} [waiting] The tick it found its next cell taken.
 */

/**
 * @typedef {object} Unit
 * @property {string} id
 * @property {number} owner
 * @property {string} name
 * @property {number} level From 1 to MAX_LEVEL.
 * @property {number} xp Experience toward the next level.
 * @property {Record<Skill, number>} skills Each from 0 up to `level`.
 * @property {Record<Skill, number>} practice Experience toward each skill's
 *   next level, up to SKILL_XP.
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
 * @property {string} mode A key of MODES.
 * @property {number} [over] The tick the game ended: once only one team (or
 *   none) of castles and lairs is left standing. Nothing happens after.
 * @property {number} [winner] The team left standing, if one is.
 * @property {number} seed The map's seed. The board is rebuilt from it.
 * @property {number} tick Ticks since the game began.
 * @property {number} rng The random generator's state.
 * @property {number} nextId The number the next building or unit id gets.
 * @property {Player[]} players One per side in this game.
 * @property {Record<string, Building>} buildings By id.
 * @property {Record<string, Unit>} units By id.
 */

/**
 * @typedef {object} Player A side, and what it has in store.
 * @property {number} id
 * @property {number} stone
 * @property {number} metal Dark metal.
 * @property {number} food
 * @property {number} hunger From 0 to MAX_HUNGER.
 * @property {number} side Its name and colours: an index into SIDES.
 * @property {number} team Sides on one team don't fight each other.
 * @property {number} [lost] The tick its castle (or lair) fell: the side is out of the game.
 */

/**
 * @typedef {{ type: 'build', kind: string, q: number, r: number, units?: string[] }
 *   | { type: 'crew', building: string, units: string[] }
 *   | { type: 'target', building: string, target: string }
 *   | { type: 'upgrade', building: string }
 *   | { type: 'abort', building: string }
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
export const STATE_VERSION = 8;

const SKILL_NAMES = /** @type {Skill[]} */ (Object.keys(SKILLS));

/**
 * Experience each level takes to leave, by level. Worked out once, by
 * multiplication only, so it comes out the same on every machine.
 */
const LEVEL_TABLE = [0, LEVEL_XP];
for (let level = 2; level < MAX_LEVEL; level++) LEVEL_TABLE.push(Math.round(LEVEL_TABLE[level - 1] * LEVEL_GROWTH));

/**
 * Experience a unit needs to go from this level to the next; Infinity at the top.
 * @param {number} level
 */
export function levelXp(level) {
  return LEVEL_TABLE[level] ?? Infinity;
}

/**
 * The opening position: a castle per player, on the board's start sites,
 * each with its first units; in cooperation, the players on one team and
 * the Dark Lord's lair in the middle.
 * @param {Board} board Made for as many players (`createBoard`'s `players`).
 * @param {{ mode?: string }} [options]
 * @returns {GameState}
 */
export function newGame(board, { mode = DEFAULT_MODE } = {}) {
  /** @type {GameState} */
  const state = {
    version: STATE_VERSION,
    mode,
    seed: board.seed,
    tick: 0,
    rng: board.seed >>> 0,
    nextId: 1,
    players: [],
    buildings: {},
    units: {},
  };
  const coop = mode === 'coop';
  // The board's last site is the lair's; the others are the players'.
  const players = board.starts.length - 1;
  board.starts.slice(0, coop ? players + 1 : players).forEach((start, owner) => {
    const npc = owner === players;
    const side = npc ? DARK_LORD : owner;
    state.players.push({
      id: owner, side, team: coop ? Number(npc) : owner, stone: npc ? 0 : START_STONE, metal: START_METAL, food: 0, hunger: 0,
    });
    const id = newId(state, 'b');
    const type = npc ? 'lair' : 'castle';
    /** @type {Building} */
    const b = { id, owner, type, grade: 1, q: start.q, r: start.r, hp: 0, ...(npc ? {} : { work: 0 }) };
    b.hp = maxHp(state, b); // the lair comes last, once every player is counted
    state.buildings[id] = b;
    if (!npc) for (let i = 0; i < START_UNITS; i++) newUnit(state, owner, id);
  });
  // The raiders: a side of their own, against everyone, with nothing yet.
  state.players.push({ id: state.players.length, side: RAIDERS, team: -1, stone: 0, metal: 0, food: 0, hunger: 0 });
  return state;
}

/**
 * A side's name and colours: an entry of SIDES.
 * @param {Pick<GameState, 'players'>} state
 * @param {number} owner
 */
export function sideOf(state, owner) {
  return SIDES[state.players[owner]?.side ?? owner] ?? SIDES[0];
}

/**
 * How many players a game seats: its sides, less the Dark Lord.
 * @param {Pick<GameState, 'players'>} state
 */
export function seatsOf(state) {
  return state.players.filter((p) => !SIDES[p.side]?.npc).length;
}

/**
 * Whether two sides are on one team, so they leave each other alone.
 * @param {Pick<GameState, 'players'>} state
 * @param {number} a
 * @param {number} b
 */
export function allied(state, a, b) {
  return state.players[a]?.team === state.players[b]?.team;
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

/** @returns {Record<Skill, number>} */
function noSkills() {
  return /** @type {Record<Skill, number>} */ (Object.fromEntries(SKILL_NAMES.map((s) => [s, 0])));
}

/**
 * A new unit, at level 1 with no skills, inside a building.
 * @param {GameState} state
 * @param {number} owner
 * @param {string} building
 */
function newUnit(state, owner, building) {
  const id = newId(state, 'u');
  const name = unitName(() => random(state));
  state.units[id] = { id, owner, name, level: 1, xp: 0, skills: noSkills(), practice: noSkills(), in: building };
  return id;
}

/**
 * A tick of work with a skill: experience for the unit, as much as the work
 * is worth, and a point for the skill, which rises while it is below the
 * unit's level.
 * @param {Unit} u
 * @param {Skill} skill
 */
function practise(u, skill, bonus = 0) {
  gainXp(u, LEVEL_RATE[skill] + bonus);
  const practice = Math.min(SKILL_XP, u.practice[skill] + 1);
  if (practice >= SKILL_XP && u.skills[skill] < u.level) {
    u.skills[skill] += 1;
    u.practice[skill] = 0;
  } else {
    u.practice[skill] = practice;
  }
}

/**
 * Experience for a unit's level.
 * @param {Unit} u
 * @param {number} xp
 */
function gainXp(u, xp) {
  u.xp += xp;
  while (u.level < MAX_LEVEL && u.xp >= levelXp(u.level)) {
    u.xp -= levelXp(u.level);
    u.level += 1;
  }
  if (u.level === MAX_LEVEL) u.xp = 0;
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
  if (BUILDING_TYPES[b.type].band) return [];
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
 * How much stronger the Dark Lord is for the number of players: players / 2,
 * never less than 1, so 4 at eight players. His buildings' hit points grow
 * by it, and his waves by its square root.
 * @param {Pick<GameState, 'players'>} state
 */
export function lordScale(state) {
  return Math.max(1, seatsOf(state) / 2);
}

/**
 * A building's hit points when unharmed: half while it is going up, and
 * more for the Dark Lord's with more players (`lordScale`).
 * @param {Pick<GameState, 'players'>} state
 * @param {Building} b
 */
export function maxHp(state, b) {
  const type = BUILDING_TYPES[b.type];
  const full = Math.round(type.hp * b.grade * (type.scales ? lordScale(state) : 1));
  return isRising(b) ? Math.ceil(full / 2) : full;
}

/**
 * Whether a building is still going up.
 * @param {Building} b
 */
export function isRising(b) {
  return b.raised !== undefined;
}

/**
 * Work a building's crew puts in toward its next grade: raising it while it
 * is going up, else upgrading it, which takes more at each grade.
 * @param {Building} b
 */
export function raiseWork(b) {
  const raise = BUILDING_TYPES[b.type].raise ?? 0;
  return isRising(b) ? raise : raise * b.grade;
}

/**
 * How deep a pit is, in grades.
 * @param {Building} b
 */
export function depthOf(b) {
  return Math.floor((b.dug ?? 0) / (BUILDING_TYPES[b.type].perDepth ?? 1));
}

/**
 * The most food a side can keep: FOOD_STORE meals for its castle's full house.
 * @param {Pick<GameState, 'buildings'>} state
 * @param {number} owner
 */
export function foodStore(state, owner) {
  const castle = castleOf(state, owner);
  return castle ? FOOD_STORE * FOOD_PER_UNIT * capacityOf(castle) : 0;
}

/**
 * The chance a unit starves at a meal while its side is as hungry as it gets.
 * @param {number} level
 */
export function starveChance(level) {
  const x = (MAX_LEVEL - level) / (MAX_LEVEL - 1);
  return STARVE_CHANCE * x * x * x;
}

/** Odds of a kill, by the striker's skill less the target's level (+100). */
const KILL_ODDS = new Array(201);
KILL_ODDS[100] = KILL_EVEN / (KILL_MAX - KILL_EVEN);
for (let x = 1; x <= 100; x++) {
  KILL_ODDS[100 + x] = KILL_ODDS[99 + x] * KILL_STEP;
  KILL_ODDS[100 - x] = KILL_ODDS[101 - x] / KILL_STEP;
}

/**
 * The chance, in percent, that a strike kills a unit.
 * @param {number} skill The striker's skill in use.
 * @param {number} level The target's level.
 */
export function killChance(skill, level) {
  const odds = KILL_ODDS[100 + Math.max(-100, Math.min(100, skill - level))];
  return (KILL_MAX * odds) / (1 + odds);
}

/**
 * A side's castle, home to its units.
 * @param {Pick<GameState, 'buildings'>} state
 * @param {number} owner
 * @returns {Building | undefined}
 */
export function castleOf(state, owner) {
  return Object.values(state.buildings).find((b) => b.owner === owner && b.type === 'castle');
}

/**
 * A building's crew: the units inside it or heading for it, in id order.
 * @param {Pick<GameState, 'units'>} state
 * @param {string} building
 * @returns {string[]}
 */
export function crewOf(state, building) {
  return Object.values(state.units).filter((u) => u.in === building || u.to === building).map((u) => u.id);
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
 * Ticks for a building to enter a cell at a speed (ticks per cell on open ground).
 * @param {Board} board
 * @param {number} speed
 * @param {Cell} cell
 */
function stepTicks(board, speed, cell) {
  return speed * /** @type {import('./board.js').Tile} */ (tileAt(board, cell[0], cell[1])).moveCost;
}

/**
 * Ticks for a unit to enter a cell: rough ground slows it, running skill
 * speeds it up.
 * @param {Board} board
 * @param {Unit} u
 * @param {Cell} cell
 */
function walkTicks(board, u, cell) {
  return Math.ceil((stepTicks(board, WALK_TICKS, cell) * 100) / (100 + u.skills.running));
}

/**
 * Units and bands may cross any cell but one under another side's
 * building. Pits, anyone's, they cross freely. (Wagons may enter no
 * building's cell, pits included: see takenCells.)
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {number} owner
 */
function hostileCells(state, occ, owner) {
  return (/** @type {string} */ k) => {
    const id = occ.buildingAt.get(k);
    if (id === undefined) return false;
    const b = state.buildings[id];
    return !allied(state, b.owner, owner) && b.type !== 'pit';
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
 * The cells a moving building may not enter: a wagon, any other building's;
 * a band, only the other side's.
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Building} b
 */
function wayFor(state, occ, b) {
  return BUILDING_TYPES[b.type].band ? hostileCells(state, occ, b.owner) : takenCells(occ, b.id);
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
  u.until = at + walkTicks(board, u, path[0]);
}

/**
 * The way a unit would take to a building: from the building it is in, or
 * from the end of the step it is taking, or from where it stands.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Unit} u
 * @param {Building} target
 * @returns {Cell[] | null}
 */
function routeFor(board, state, occ, u, target) {
  const from = u.in !== undefined
    ? state.buildings[u.in]
    : u.path ? { q: u.path[0][0], r: u.path[0][1] } : { q: /** @type {number} */ (u.q), r: /** @type {number} */ (u.r) };
  return findPath(board, from, target, hostileCells(state, occ, u.owner));
}

/**
 * Send a unit to a building along a route from `routeFor`. A unit inside a
 * building steps out onto its cell and sets off at `at`; one on the move
 * finishes its step first.
 * @param {Board} board
 * @param {GameState} state
 * @param {Unit} u
 * @param {Building} target
 * @param {Cell[]} route
 * @param {number} at
 */
function dispatch(board, state, u, target, route, at) {
  u.to = target.id;
  if (u.in !== undefined) {
    const from = state.buildings[u.in];
    delete u.in;
    u.q = from.q;
    u.r = from.r;
  } else if (u.path) {
    u.path = [u.path[0], ...route];
    return;
  }
  if (route.length) {
    u.path = route;
    setOff(board, u, at);
  }
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
 * Why a command can't use the building it names. One that is gone may have
 * fallen, or been given up, after the player's page last showed it.
 * @param {GameState} state
 * @param {unknown} id
 * @returns {Outcome}
 */
function notYours(state, id) {
  return refuse(typeof id === 'string' && Object.hasOwn(state.buildings, id) ? 'not your building' : 'that building is gone');
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
 * goes through here. The command is checked field by field, since on the
 * server it arrives straight off the wire, and nothing changes unless it is
 * allowed.
 *
 * @param {Board} board
 * @param {GameState} state
 * @param {number} player The side giving the command.
 * @param {unknown} command A {@link Command}, or anything claiming to be one.
 * @returns {Outcome}
 */
export function applyCommand(board, state, player, command) {
  if (!state.players.some((p) => p.id === player)) return refuse('not a player');
  if (state.over !== undefined) return refuse('the game is over');
  if (state.players[player].lost !== undefined) return refuse('your castle has fallen');
  if (!command || typeof command !== 'object') return refuse('not a command');
  const cmd = /** @type {Record<string, unknown>} */ (command);
  const occ = occupancy(state);
  switch (cmd.type) {
    case 'build': return build(board, state, occ, player, cmd);
    case 'crew': return crew(board, state, occ, player, cmd);
    case 'target': return aim(state, player, cmd);
    case 'upgrade': return upgrade(state, player, cmd);
    case 'abort': return abort(board, state, occ, player, cmd);
    case 'move': return moveBuilding(board, state, occ, player, cmd);
    default: return refuse('unknown command');
  }
}

/**
 * The units a command names for a crew: distinct units of the player's own.
 * @param {GameState} state
 * @param {number} player
 * @param {unknown} list
 * @returns {string[] | string} The unit ids, or why not.
 */
function unitList(state, player, list) {
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string') || new Set(list).size !== list.length) return 'bad units';
  // A unit may have died after the player's page last showed it.
  if (list.some((id) => !Object.hasOwn(state.units, id))) return 'one of those units is gone';
  if (list.some((id) => state.units[id].owner !== player)) return 'not your unit';
  return list;
}

/**
 * Make these units a building's whole crew: those not on the list go home,
 * and those on it come, from wherever they are. The units that leave one
 * building go out a tick apart.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Building} b
 * @param {string[]} ids
 * @returns {Outcome}
 */
function setCrew(board, state, occ, b, ids) {
  if (ids.length > capacityOf(b)) return refuse('too many units');
  const home = castleOf(state, b.owner);
  const wanted = new Set(ids);
  const moves = [
    ...crewOf(state, b.id).filter((id) => !wanted.has(id)).map((id) => ({ u: state.units[id], target: home })),
    ...ids.filter((id) => state.units[id].in !== b.id && state.units[id].to !== b.id).map((id) => ({ u: state.units[id], target: b })),
  ];
  const routes = moves.map(({ u, target }) => (target ? routeFor(board, state, occ, u, target) : null));
  if (routes.some((route) => !route)) return refuse('no way there');

  /** @type {Map<string, number>} */
  const leaving = new Map();
  moves.forEach(({ u, target }, i) => {
    const from = u.in ?? '';
    const n = leaving.get(from) ?? 0;
    leaving.set(from, n + 1);
    dispatch(board, state, u, /** @type {Building} */ (target), /** @type {Cell[]} */ (routes[i]), state.tick + n * DEPART_GAP);
  });
  return { ok: true };
}

/**
 * Choose a building's crew. An empty list sends them all home.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function crew(board, state, occ, player, cmd) {
  const b = ownBuilding(state, player, cmd.building);
  if (!b) return notYours(state, cmd.building);
  if (b.type === 'castle') return refuse('the castle is home to every unit');
  if (isDugOut(b)) return refuse('dug out');
  const ids = unitList(state, player, cmd.units);
  if (typeof ids === 'string') return refuse(ids);
  return setCrew(board, state, occ, b, ids);
}

/**
 * Give a building a target: an enemy building. An empty target clears it.
 * @param {GameState} state
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function aim(state, player, cmd) {
  const b = ownBuilding(state, player, cmd.building);
  if (!b) return notYours(state, cmd.building);
  if (cmd.target === '') {
    delete b.target;
    return { ok: true };
  }
  const t = typeof cmd.target === 'string' && Object.hasOwn(state.buildings, cmd.target) ? state.buildings[cmd.target] : null;
  if (!t || allied(state, t.owner, player)) return refuse('not an enemy');
  if (BUILDING_TYPES[b.type].speed) turnTo(b, t.id); // it sets off after the target at the next strike
  else b.target = t.id;
  return { ok: true };
}

/**
 * Build on open ground near one of your standing buildings, with a crew if
 * the command names one. Most buildings then go up as their crew raises
 * them (see `raise`); a band is ready at once.
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
  const type = BUILDING_TYPES[kind];
  for (const c of footprint(kind, at.q, at.r)) {
    const tile = tileAt(board, c.q, c.r);
    if (!(type.band ? tile?.passable : tile?.buildable)) return refuse('cannot build there');
    if (occ.buildingAt.has(key(c.q, c.r))) return refuse('cell taken');
  }
  if (!inBuildRange(state, player, kind, at)) return refuse(type.nearCastle ? 'too far from your castle' : 'too far from your buildings');
  const ids = unitList(state, player, cmd.units ?? []);
  if (typeof ids === 'string') return refuse(ids);
  if (type.band && !ids.length) return refuse('a band needs units');
  const stock = state.players[player];
  if (stock.stone < type.cost) return refuse('not enough stone');
  if (stock.metal < (type.metal ?? 0)) return refuse('not enough dark metal');

  /** @type {Building} */
  const b = { id: `b${state.nextId}`, owner: player, type: kind, grade: 1, q: at.q, r: at.r };
  if (type.raise) b.raised = 0;
  if (type.hp) b.hp = maxHp(state, b);
  if (type.work !== undefined) b.work = 0;
  if (type.depth !== undefined) b.dug = 0;
  // Crew the new building before it exists, so a crew that can't get there
  // leaves nothing behind.
  const planned = /** @type {GameState} */ ({ ...state, buildings: { ...state.buildings, [b.id]: b } });
  const staffed = setCrew(board, planned, occ, b, ids);
  if (!staffed.ok) return staffed;
  state.buildings[b.id] = b;
  state.nextId += 1;
  stock.stone -= type.cost;
  stock.metal -= type.metal ?? 0;
  return { ok: true };
}

/**
 * Whether a building of this kind may go on a cell: within building range of
 * the player's castle, for kinds built only there, or else of any of their
 * buildings that doesn't move.
 * @param {Pick<GameState, 'buildings'>} state
 * @param {number} player
 * @param {string} kind
 * @param {Axial} at
 */
export function inBuildRange(state, player, kind, at) {
  if (!BUILDING_TYPES[kind]?.nearCastle) return nearStanding(state, player, at);
  const castle = castleOf(state, player);
  return Boolean(castle) && footprint('castle', castle.q, castle.r).some((c) => distance(c, at) <= BUILD_RANGE);
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
 * Stone to upgrade a building from its grade now.
 * @param {Building} b
 */
export function upgradeCost(b) {
  return (BUILDING_TYPES[b.type].upgrade ?? 0) * b.grade;
}

/**
 * Upgrade a building, for stone: its crew then works on it (see `raise`),
 * and once they are done its grade is one higher: it holds more, and takes
 * more hits.
 * @param {GameState} state
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function upgrade(state, player, cmd) {
  const b = ownBuilding(state, player, cmd.building);
  if (!b) return notYours(state, cmd.building);
  const type = BUILDING_TYPES[b.type];
  if (isRising(b)) return refuse('still going up');
  if (b.upgrading !== undefined) return refuse('already upgrading');
  if (b.grade >= type.grades) return refuse('fully upgraded');
  const stock = state.players[player];
  const cost = upgradeCost(b);
  if (stock.stone < cost) return refuse('not enough stone');
  stock.stone -= cost;
  b.upgrading = 0;
  return { ok: true };
}

/**
 * Give up a building that is still going up: it is gone, and so is what it
 * cost. Its crew, inside or on the way, goes home. An upgrade, once paid
 * for, can't be given up.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {number} player
 * @param {Record<string, unknown>} cmd
 * @returns {Outcome}
 */
function abort(board, state, occ, player, cmd) {
  const b = ownBuilding(state, player, cmd.building);
  if (!b) return notYours(state, cmd.building);
  if (!isRising(b)) return refuse('it already stands');
  sendHome(board, state, occ, b);
  delete state.buildings[b.id];
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
  if (!b) return notYours(state, cmd.building);
  if (!BUILDING_TYPES[b.type].speed) return refuse('cannot move');
  if (isRising(b)) return refuse('still going up');
  const goal = commandCell(cmd);
  if (!goal || !tileAt(board, goal.q, goal.r)?.passable) return refuse('cannot go there');

  const rolling = b.until !== undefined && b.path?.length ? b.path[0] : null;
  const from = rolling ? { q: rolling[0], r: rolling[1] } : { q: b.q, r: b.r };
  const route = findPath(board, from, goal, wayFor(state, occ, b));
  if (!route) return refuse('no way there');

  const path = rolling ? [rolling, ...route] : route;
  if (path.length) b.path = path;
  else delete b.path;
  delete b.waiting;
  delete b.target; // driven by hand now
  return { ok: true };
}

// --- time --------------------------------------------------------------------

/**
 * Move the game on by one tick.
 * @param {Board} board
 * @param {GameState} state
 */
export function advance(board, state) {
  if (state.over !== undefined) return; // the clock has stopped
  state.tick += 1;
  if (state.tick % COMBAT_PERIOD === 0) fight(board, state, occupancy(state));
  for (const b of Object.values(state.buildings)) if (/** @type {number} */ (b.hp) <= 0) collapse(state, b);
  settle(state);
  if (state.tick % RAID_PERIOD === 0) raid(board, state);
  if (state.tick >= HORDE_START && (state.tick - HORDE_START) % HORDE_PERIOD === 0) summon(board, state);
  if (state.tick % FOOD_PERIOD === 0) {
    harvest(state);
    for (const p of state.players) eat(state, p);
  }
  for (const b of Object.values(state.buildings)) {
    if (BUILDING_TYPES[b.type].band && !crewOf(state, b.id).length) delete state.buildings[b.id];
  }
  const occ = occupancy(state);
  if (state.tick % COMBAT_PERIOD === 0) roam(board, state, occ);
  work(board, state, occ);
  rollWagons(board, state, occ);
  marchUnits(board, state, occ);
}

/**
 * The game ends once no more than one team has a castle or lair standing:
 * that team wins (or nobody, if none has). Raiders don't count.
 * @param {GameState} state
 */
function settle(state) {
  const contenders = state.players.filter((p) => !SIDES[p.side]?.wild);
  const teams = new Set(contenders.map((p) => p.team));
  const standing = new Set(contenders.filter((p) => p.lost === undefined).map((p) => p.team));
  if (teams.size < 2 || standing.size > 1) return;
  state.over = state.tick;
  if (standing.size === 1) state.winner = [...standing][0];
}

/**
 * Now and then a raider turns up on open ground away from the castles and
 * lairs, while there are few enough. See RAID_PERIOD in rules.js.
 * @param {Board} board
 * @param {GameState} state
 */
function raid(board, state) {
  const wild = state.players.find((p) => SIDES[p.side]?.wild);
  if (!wild) return;
  const raiders = Object.values(state.buildings).filter((b) => b.owner === wild.id).length;
  if (raiders >= RAID_MAX + seatsOf(state) || random(state) >= RAID_CHANCE) return;
  const taken = occupancy(state).buildingAt;
  const lives = Object.values(state.buildings).filter((b) => BUILDING_TYPES[b.type].life);
  for (let tries = 0; tries < 20; tries++) {
    const t = board.list[Math.floor(random(state) * board.list.length)];
    if (!t.passable || taken.has(key(t.q, t.r)) || lives.some((b) => distance(b, t) < RAID_CLEAR)) continue;
    const id = newId(state, 'b');
    state.buildings[id] = { id, owner: wild.id, type: 'raider', grade: 1, q: t.q, r: t.r, hp: BUILDING_TYPES.raider.hp };
    return;
  }
}

/**
 * Raiders at rest now and then set off for somewhere nearby, at random.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function roam(board, state, occ) {
  for (const b of Object.values(state.buildings)) {
    if (b.path || !SIDES[state.players[b.owner]?.side]?.wild || random(state) >= 0.5) continue;
    const dq = Math.floor(random(state) * (2 * RAID_ROAM + 1)) - RAID_ROAM;
    const dr = Math.floor(random(state) * (2 * RAID_ROAM + 1)) - RAID_ROAM;
    const to = { q: b.q + dq, r: b.r + dr };
    if (!tileAt(board, to.q, to.r)?.passable) continue;
    const route = findPath(board, b, to, takenCells(occ, b.id));
    if (route?.length) b.path = route;
  }
}

/**
 * A building with no hit points left falls down. Whoever was inside is left
 * standing on its cell; whoever was heading there stops where the way ends.
 * @param {GameState} state
 * @param {Building} b
 */
function collapse(state, b) {
  for (const u of Object.values(state.units)) {
    if (u.in !== b.id) continue;
    delete u.in;
    u.q = b.q;
    u.r = b.r;
  }
  delete state.buildings[b.id];
  if (BUILDING_TYPES[b.type].life) state.players[b.owner].lost = state.tick;
}

/**
 * A round of fighting. Everyone strikes the nearest enemy in reach, its
 * building's target first: the units inside a building or band (close
 * combat if one is next to them, else ranged), buildings that strike by
 * themselves, and units out walking, who strike as they go without
 * stopping. See COMBAT_PERIOD in rules.js.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function fight(board, state, occ) {
  /** @type {Array<{ cells: Axial[], owner: number, building?: Building, unit?: Unit }>} */
  const targets = [];
  const bandOf = (/** @type {Unit} */ u) => (u.in !== undefined && BUILDING_TYPES[state.buildings[u.in].type].band ? state.buildings[u.in] : null);
  for (const b of Object.values(state.buildings)) {
    if (b.hp !== undefined) targets.push({ cells: footprint(b.type, b.q, b.r), owner: b.owner, building: b });
  }
  for (const u of Object.values(state.units)) {
    const band = bandOf(u);
    if (u.in === undefined) targets.push({ cells: [{ q: /** @type {number} */ (u.q), r: /** @type {number} */ (u.r) }], owner: u.owner, unit: u });
    else if (band) targets.push({ cells: [{ q: band.q, r: band.r }], owner: u.owner, unit: u });
  }

  /**
   * Enemies within `reach` of these cells, the aimed-at first, then the
   * nearest; the list order breaks ties.
   * @param {Axial[]} from
   * @param {number} owner
   * @param {number} reach
   * @param {string} [aim] A target building: it, or the units of a band.
   */
  const inReach = (from, owner, reach, aim) => targets
    .filter((t) => !allied(state, t.owner, owner))
    .map((t) => ({ t, d: Math.min(...t.cells.flatMap((c) => from.map((f) => distance(c, f)))) }))
    .filter(({ d }) => d <= reach)
    .sort((x, y) => aimedAt(y.t, aim) - aimedAt(x.t, aim) || x.d - y.d);
  const aimedAt = (/** @type {typeof targets[number]} */ t, /** @type {string | undefined} */ aim) => Number(
    aim !== undefined && (t.building?.id === aim || t.unit?.in === aim),
  );
  const standing = (/** @type {{ t: typeof targets[number] }} */ { t }) => (t.building
    ? /** @type {number} */ (t.building.hp) > 0 && Boolean(state.buildings[t.building.id])
    : Boolean(state.units[t.unit?.id ?? '']));

  /**
   * One strike: `damage` off a building (unless it gets through to a unit
   * inside), or a kill roll as a striker of `skill` against a unit. Bringing
   * down a building with loot, or bought with dark metal, gives the
   * striker's side its loot or a share of its price. One of the
   * horde turns on the building that struck it.
   * @param {{ t: typeof targets[number] }} target
   * @param {number} owner The striker's side.
   * @param {number} damage
   * @param {number} skill
   * @param {string} [from] The building striking, or whose units strike.
   * @returns {boolean} Whether it brought a building down or killed.
   */
  const strike = ({ t }, owner, damage, skill, from) => {
    const hit = t.building;
    // Some strikes on a building get through to a unit inside.
    const sheltered = hit ? /** @type {string[]} */ (occ.inside.get(hit.id) ?? []).filter((x) => state.units[x]) : [];
    // A building going up covers nobody.
    const cover = !hit ? 0 : isRising(hit) ? 1 : BUILDING_TYPES[hit.type].through ?? 0;
    const through = hit && sheltered.length && random(state) < cover;
    if (hit && !through) {
      hit.hp = Math.max(0, /** @type {number} */ (hit.hp) - damage);
      if (from !== undefined && from !== hit.target && BUILDING_TYPES[hit.type].hunts) turnTo(hit, from);
      if (hit.hp > 0) return false;
      const { loot, metal = 0 } = BUILDING_TYPES[hit.type];
      state.players[owner].metal += loot ?? Math.floor(metal * SALVAGE);
      return true;
    }
    const foe = hit ? state.units[sheltered[Math.floor(random(state) * sheltered.length)]] : /** @type {Unit} */ (t.unit);
    const killed = random(state) * 100 < killChance(skill, foe.level);
    if (killed) delete state.units[foe.id];
    return killed;
  };

  /**
   * A unit strikes the first enemy standing in the list that it can reach.
   * @param {Unit} u
   * @param {Array<{ t: typeof targets[number], d: number }>} near
   * @param {number} reach
   * @param {string} [from] The building it strikes from.
   */
  const unitStrikes = (u, near, reach, from) => {
    const target = near.find((x) => x.d <= reach && standing(x));
    if (!target) return false;
    const melee = target.d <= MELEE_RANGE;
    const skill = melee ? 'melee' : 'ranged';
    const killed = strike(target, u.owner, (melee ? MELEE_DAMAGE : RANGED_DAMAGE) + u.skills[skill], u.skills[skill], from);
    practise(u, skill, killed ? KILL_XP : 0);
    return true;
  };

  for (const b of Object.values(state.buildings)) {
    if (b.target !== undefined && state.buildings[b.target]?.owner === undefined) delete b.target;
    const type = BUILDING_TYPES[b.type];
    if (type.hunts && b.target === undefined) hunt(state, b);
    if (type.speed && b.target !== undefined && !isRising(b)) chase(board, state, occ, b);
    const inside = /** @type {string[]} */ (occ.inside.get(b.id));
    if (!inside.length && !type.attack) continue;
    const unitReach = RANGED_RANGE + (isRising(b) ? 0 : type.reach ?? 0);
    const near = inReach(footprint(b.type, b.q, b.r), b.owner, Math.max(unitReach, type.attack?.reach ?? 0), b.target);
    if (type.attack) {
      const target = near.find((x) => x.d <= /** @type {{ reach: number }} */ (type.attack).reach && standing(x));
      if (target) strike(target, b.owner, type.attack.damage, type.attack.skill, b.id);
    }
    for (const id of inside) {
      const u = state.units[id];
      if (u && !unitStrikes(u, near, unitReach, b.id)) break;
    }
  }
  for (const u of Object.values(state.units)) {
    if (u.in !== undefined || !state.units[u.id]) continue;
    const here = { q: /** @type {number} */ (u.q), r: /** @type {number} */ (u.r) };
    unitStrikes(u, inReach([here], u.owner, RANGED_RANGE), RANGED_RANGE);
  }
}

/**
 * A wagon or band with a target and nowhere to go heads for it, and stops
 * once it is close enough for close combat. One of the horde with no way
 * there turns on the nearest other enemy building, which is likely what
 * stands in its way.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Building} b
 */
function chase(board, state, occ, b) {
  if (b.path) return;
  const t = state.buildings[/** @type {string} */ (b.target)];
  const cells = footprint(t.type, t.q, t.r);
  const near = (/** @type {Axial} */ c) => cells.some((x) => distance(x, c) <= MELEE_RANGE);
  if (near(b)) return;
  const goals = new Set(cells.map((c) => key(c.q, c.r)));
  const blocked = wayFor(state, occ, b);
  const route = findPath(board, b, t, (k) => !goals.has(k) && blocked(k));
  if (!route) {
    const other = BUILDING_TYPES[b.type].hunts && nearestEnemy(state, b, (x) => x.id !== t.id && x.hp !== undefined);
    if (other) turnTo(b, other.id);
    return;
  }
  const stop = route.findIndex(([q, r]) => near({ q, r }));
  const path = route.slice(0, stop + 1);
  if (path.length) b.path = path;
}

/**
 * Point a moving building at a new target. It finishes the step it is
 * taking, then goes after it.
 * @param {Building} b
 * @param {string} target
 */
function turnTo(b, target) {
  b.target = target;
  if (b.until !== undefined && b.path?.length) b.path = [b.path[0]];
  else delete b.path;
  delete b.waiting;
}

/**
 * The enemy building nearest to one of the horde, of those `which` takes.
 * @param {GameState} state
 * @param {Building} b
 * @param {(t: Building) => boolean} which
 * @returns {Building | null}
 */
function nearestEnemy(state, b, which) {
  let best = null;
  let bestDistance = Infinity;
  for (const t of Object.values(state.buildings)) {
    if (allied(state, t.owner, b.owner) || !which(t)) continue;
    const d = Math.min(...footprint(t.type, t.q, t.r).map((c) => distance(c, b)));
    if (d < bestDistance) {
      best = t;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * One of the horde with nothing to go for picks the nearest enemy farm, or
 * castle once no farm is left.
 * @param {GameState} state
 * @param {Building} b
 */
function hunt(state, b) {
  const prey = nearestEnemy(state, b, (t) => t.type === 'farm') ?? nearestEnemy(state, b, (t) => t.type === 'castle');
  if (prey) turnTo(b, prey.id);
}

/**
 * The Dark Lord's lair sends out a wave of his horde, each bigger than the
 * last (see HORDE_START in rules.js), onto open cells around it, while he
 * has fewer than HORDE_MAX out.
 * @param {Board} board
 * @param {GameState} state
 */
function summon(board, state) {
  const lord = state.players.find((p) => p.side === DARK_LORD && p.lost === undefined);
  const lair = lord && Object.values(state.buildings).find((b) => b.owner === lord.id && b.type === 'lair');
  if (!lord || !lair) return;
  const wave = (state.tick - HORDE_START) / HORDE_PERIOD + 1;
  const more = (/** @type {number} */ n) => Math.round(n * Math.sqrt(lordScale(state))); // twice at eight players
  const out = Object.values(state.buildings).filter((b) => b.owner === lord.id && BUILDING_TYPES[b.type].hunts).length;
  const kinds = [...Array(more(Math.ceil(wave / 2))).fill('ghoul'), ...Array(more(Math.floor(wave / 3))).fill('ogre')]
    .slice(0, Math.max(0, more(HORDE_MAX) - out));
  const taken = occupancy(state).buildingAt;
  const free = board.list.filter((t) => t.passable && !taken.has(key(t.q, t.r)) && distance(t, lair) >= 2 && distance(t, lair) <= 3);
  for (const kind of kinds) {
    if (!free.length) return;
    const [cell] = free.splice(Math.floor(random(state) * free.length), 1);
    const id = newId(state, 'b');
    /** @type {Building} */
    const b = { id, owner: lord.id, type: kind, grade: 1, q: cell.q, r: cell.r, hp: 0 };
    b.hp = maxHp(state, b);
    state.buildings[id] = b;
  }
}

/**
 * Food that comes without work, every FOOD_PERIOD: a castle's, for half the
 * units it can hold, and each farm's base.
 * @param {GameState} state
 */
function harvest(state) {
  for (const b of Object.values(state.buildings)) {
    if (b.type === 'castle') addFood(state, b.owner, Math.floor(capacityOf(b) / 2) * FOOD_PER_UNIT);
    else if (!isRising(b)) addFood(state, b.owner, BUILDING_TYPES[b.type].base ?? 0);
  }
}

/**
 * Put food in a side's store; what doesn't fit spoils.
 * @param {GameState} state
 * @param {number} owner
 * @param {number} food
 */
function addFood(state, owner, food) {
  const stock = state.players[owner];
  stock.food = Math.max(stock.food, Math.min(stock.food + food, foodStore(state, owner)));
}

/**
 * A side's meal: each unit eats FOOD_PER_UNIT, or an even share of what
 * there is, and what doesn't share evenly waits for the next meal. A share
 * under HUNGER_LINE makes the side hungrier, one over it less so. At
 * MAX_HUNGER, units may starve, the weak more likely than the seasoned.
 * @param {GameState} state
 * @param {Player} p
 */
function eat(state, p) {
  const units = Object.values(state.units).filter((u) => u.owner === p.id);
  if (!units.length) return;
  const share = Math.min(FOOD_PER_UNIT, Math.floor(p.food / units.length));
  p.food -= share * units.length;
  p.hunger = Math.max(0, Math.min(MAX_HUNGER, p.hunger + HUNGER_LINE - share));
  if (p.hunger < MAX_HUNGER) return;
  for (const u of units) if (random(state) < starveChance(u.level)) delete state.units[u.id];
}

/**
 * Whether a building is a pit dug as deep as it goes.
 * @param {Building} b
 */
export function isDugOut(b) {
  const { depth } = BUILDING_TYPES[b.type];
  return depth !== undefined && depthOf(b) >= depth;
}

/**
 * Damaged buildings are mended by the units inside, a hit point per
 * REPAIR_WORK of their work, which trains their building skill.
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function mend(state, occ) {
  for (const b of Object.values(state.buildings)) {
    const inside = /** @type {string[]} */ (occ.inside.get(b.id));
    if (b.hp === undefined || b.hp <= 0 || b.hp >= maxHp(state, b) || !inside.length) continue;
    let done = b.mend ?? 0;
    for (const id of inside) {
      const u = state.units[id];
      if (!u) continue;
      done += WORK_BASE + u.skills.build;
      practise(u, 'build');
    }
    b.hp = Math.min(maxHp(state, b), b.hp + Math.floor(done / REPAIR_WORK));
    if (b.hp < maxHp(state, b)) b.mend = done % REPAIR_WORK;
    else delete b.mend;
  }
}

/**
 * Buildings going up, or being upgraded, are worked on by the units inside,
 * which trains their building skill: the crew has to get there first, and
 * does no other work meanwhile. Once raised, a building takes its full hit
 * points and starts its work; once upgraded, it goes up a grade, with the
 * room and hit points that come with it. Like any work, it waits while the
 * building needs mending.
 * @param {GameState} state
 * @param {Occupancy} occ
 * @returns {Set<string>} The buildings whose crews did this work this tick.
 */
function raise(state, occ) {
  /** @type {Set<string>} */
  const busy = new Set();
  for (const b of Object.values(state.buildings)) {
    const rising = isRising(b);
    if (!rising && b.upgrading === undefined) continue;
    const inside = /** @type {string[]} */ (occ.inside.get(b.id));
    if (!inside.length || /** @type {number} */ (b.hp) < maxHp(state, b)) continue;
    busy.add(b.id);
    let done = /** @type {number} */ (rising ? b.raised : b.upgrading);
    for (const id of inside) {
      const u = state.units[id];
      if (!u) continue;
      done += WORK_BASE + u.skills.build;
      practise(u, 'build');
    }
    if (done < raiseWork(b)) {
      if (rising) b.raised = done;
      else b.upgrading = done;
      continue;
    }
    if (rising) {
      const half = maxHp(state, b);
      delete b.raised;
      b.hp = /** @type {number} */ (b.hp) + maxHp(state, b) - half;
    } else {
      delete b.upgrading;
      b.grade += 1;
      b.hp = /** @type {number} */ (b.hp) + BUILDING_TYPES[b.type].hp;
    }
  }
  return busy;
}

/**
 * Ticks for a band to enter a cell: its slowest member's.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Building} b
 * @param {Cell} cell
 */
function bandTicks(board, state, occ, b, cell) {
  const riders = /** @type {string[]} */ (occ.inside.get(b.id)).map((id) => state.units[id]).filter(Boolean);
  if (!riders.length) return stepTicks(board, WALK_TICKS, cell);
  return Math.max(...riders.map((u) => walkTicks(board, u, cell)));
}

/**
 * Buildings where units work get a tick of it from each unit inside: more
 * units, and more skilled ones, get there sooner. The work trains them. A
 * castle's units raise a new unit while it has room and its side is under
 * the unit limit, and it does a little of that work by itself, even with
 * nobody at home, while damaged or while upgraded; a pit's crew digs a
 * stone, and goes home once the pit is dug out; a farm's crew grows a food.
 * A crew raising or upgrading its building does no other work, though it
 * still mends it first, and fights.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function work(board, state, occ) {
  mend(state, occ);
  const busy = raise(state, occ); // a crew that just finished starts next tick
  for (const b of Object.values(state.buildings)) {
    const type = BUILDING_TYPES[b.type];
    if (type.work === undefined || isRising(b) || isDugOut(b)) continue;
    const inside = /** @type {string[]} */ (occ.inside.get(b.id));
    if (type.yields === 'unit' && (inside.length >= capacityOf(b) || occ.unitCount[b.owner] >= UNIT_LIMIT)) continue;
    // Its units mend it while it is damaged and work on an upgrade while
    // there is one; what it does by itself goes on.
    const elsewhere = b.upgrading !== undefined || busy.has(b.id) || (b.hp !== undefined && b.hp < maxHp(state, b));
    const workers = elsewhere ? [] : inside;
    if (!workers.length && !type.idleWork) continue;

    let done = /** @type {number} */ (b.work) + (type.idleWork ?? 0);
    for (const id of workers) {
      const u = state.units[id];
      done += WORK_BASE + u.skills[type.skill];
      practise(u, type.skill);
    }
    if (done < type.work) {
      b.work = done;
      continue;
    }
    b.work = Math.min(done - type.work, type.work - 1);

    const stock = state.players[b.owner];
    if (type.yields === 'unit') {
      inside.push(newUnit(state, b.owner, b.id));
      occ.unitCount[b.owner] += 1;
    } else if (type.yields === 'food') {
      addFood(state, b.owner, 1);
    } else {
      stock.stone += 1;
      b.dug = /** @type {number} */ (b.dug) + 1;
      if (isDugOut(b)) {
        b.work = 0;
        sendHome(board, state, occ, b);
      }
    }
  }
}

/**
 * A building's crew goes home, a tick apart. One that has no way home steps
 * out and stays where it is.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Building} b
 */
function sendHome(board, state, occ, b) {
  const home = castleOf(state, b.owner);
  crewOf(state, b.id).forEach((id, i) => {
    const u = state.units[id];
    const route = home ? routeFor(board, state, occ, u, home) : null;
    if (home && route) {
      dispatch(board, state, u, home, route, state.tick + i * DEPART_GAP);
      return;
    }
    delete u.to;
    if (u.in === undefined) return;
    delete u.in;
    u.q = b.q;
    u.r = b.r;
  });
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

    const { band } = BUILDING_TYPES[b.type];
    if (b.until !== undefined) {
      if (state.tick < b.until) continue;
      if (!band) occ.buildingAt.delete(key(b.q, b.r));
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
    if (band || !occ.buildingAt.has(nk)) {
      if (!band) occ.buildingAt.set(nk, b.id);
      b.since = state.tick;
      b.until = state.tick + (band ? bandTicks(board, state, occ, b, next) : stepTicks(board, speed, next));
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
 * Units step from cell to cell, which trains their running, and go inside
 * when they reach the building they are heading for. If it is full they
 * wait at the door; if it has moved they follow it; if it is gone they stay
 * where they are.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 */
function marchUnits(board, state, occ) {
  for (const u of Object.values(state.units)) {
    if (u.in !== undefined) continue;
    if (u.path?.length) {
      if (state.tick <= /** @type {number} */ (u.since)) continue;
      practise(u, 'running');
      if (state.tick < /** @type {number} */ (u.until)) continue;
      [u.q, u.r] = /** @type {Cell} */ (u.path.shift());
      if (u.path.length) {
        u.since = u.until;
        u.until = /** @type {number} */ (u.since) + walkTicks(board, u, u.path[0]);
        continue;
      }
      delete u.path;
      delete u.since;
      delete u.until;
    }
    if (u.to !== undefined) arrive(board, state, occ, u);
    else goHome(board, state, occ, u);
  }
}

/**
 * A unit out with nowhere to go sets off for its castle, if there is a way.
 * @param {Board} board
 * @param {GameState} state
 * @param {Occupancy} occ
 * @param {Unit} u
 */
function goHome(board, state, occ, u) {
  const home = castleOf(state, u.owner);
  const route = home ? routeFor(board, state, occ, u, home) : null;
  if (!home || !route) return;
  u.to = home.id;
  if (route.length) {
    u.path = route;
    setOff(board, u, state.tick);
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
    // A castle takes in all its side's units, however many; elsewhere, a
    // unit waits at the door until there is room.
    if (target.type !== 'castle' && inside.length >= capacityOf(target)) return;
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
  const isCount = (/** @type {unknown} */ n, /** @type {number} */ below) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < below;
  if (!Array.isArray(state.players) || !state.players.every((p, i) => p?.id === i) || state.players.length > MAX_PLAYERS + 2) { // the players, the Dark Lord, the raiders
    return [...problems, 'bad players'];
  }
  if (!Object.hasOwn(MODES, state.mode)) fail('bad mode');
  if (state.over !== undefined && !isCount(state.over, Infinity)) fail('bad over');
  if (state.winner !== undefined && (state.over === undefined || !Number.isInteger(state.winner))) fail('bad winner');
  state.players.forEach((p, i) => {
    if (!Number.isInteger(p.team)) fail(`side ${i}: bad team`);
    if (!Number.isInteger(p.side) || !SIDES[p.side]) fail(`side ${i}: bad palette`);
    if (!isCount(p.stone, Infinity) || !isCount(p.food, Infinity) || !isCount(p.metal, Infinity)) fail(`side ${i}: bad stock`);
    if (!isCount(p.hunger, MAX_HUNGER + 1)) fail(`side ${i}: bad hunger`);
    if (p.lost !== undefined && !isCount(p.lost, state.tick + 1)) fail(`side ${i}: bad lost`);
  });
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
    if (type.work === undefined ? b.work !== undefined : !isCount(b.work, type.work)) fail(`building ${id}: bad work`);
    const deepest = /** @type {number} */ (type.depth) * /** @type {number} */ (type.perDepth);
    if (type.depth === undefined ? b.dug !== undefined : !isCount(b.dug, deepest + 1)) fail(`building ${id}: bad dug`);
    if (b.raised !== undefined && !(type.raise && isCount(b.raised, type.raise))) fail(`building ${id}: bad raised`);
    if (b.upgrading !== undefined && !(type.raise && b.raised === undefined && b.grade < type.grades && isCount(b.upgrading, raiseWork(b)))) {
      fail(`building ${id}: bad upgrading`);
    }
    if (type.hp ? !(Number.isSafeInteger(b.hp) && b.hp >= 1 && b.hp <= maxHp(state, b)) : b.hp !== undefined) {
      fail(`building ${id}: bad hp`);
    }
    if (b.mend !== undefined && !(type.hp && isCount(b.mend, REPAIR_WORK))) fail(`building ${id}: bad mend`);
    if (b.target !== undefined && typeof b.target !== 'string') fail(`building ${id}: bad target`);
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
  const crews = new Map(Object.keys(state.buildings).map((id) => [id, 0]));
  const counts = state.players.map(() => 0);
  const isSkillSet = (/** @type {unknown} */ v, /** @type {number} */ below) => isRecord(v)
    && Object.keys(/** @type {object} */ (v)).length === SKILL_NAMES.length
    && SKILL_NAMES.every((s) => isCount(/** @type {Record<string, unknown>} */ (v)[s], below));
  for (const [id, u] of Object.entries(state.units)) {
    if (!u || u.id !== id || !issued(id, 'u')) { fail(`unit ${id}: bad id`); continue; }
    if (!isOwner(u.owner)) { fail(`unit ${id}: bad owner`); continue; }
    counts[u.owner] += 1;
    if (typeof u.name !== 'string' || !u.name || u.name.length > 40) fail(`unit ${id}: bad name`);
    if (!Number.isInteger(u.level) || u.level < 1 || u.level > MAX_LEVEL) {
      fail(`unit ${id}: bad level`);
    } else {
      if (!isCount(u.xp, u.level === MAX_LEVEL ? 1 : levelXp(u.level))) fail(`unit ${id}: bad xp`);
      if (!isSkillSet(u.skills, u.level + 1)) fail(`unit ${id}: bad skills`);
      if (!isSkillSet(u.practice, SKILL_XP + 1)) fail(`unit ${id}: bad practice`);
    }
    for (const b of [u.in, u.to]) if (typeof b === 'string' && crews.has(b)) crews.set(b, /** @type {number} */ (crews.get(b)) + 1);

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
    const b = state.buildings[id];
    if (!Object.hasOwn(BUILDING_TYPES, b?.type) || !Number.isInteger(b.grade)) continue; // reported above
    if (b.type !== 'castle' && n > capacityOf(b)) fail(`building ${id}: ${n} inside, more than it holds`);
    const crewSize = /** @type {number} */ (crews.get(id));
    // Everyone comes home to the castle, so only other buildings' crews are limited.
    if (b.type !== 'castle' && crewSize > capacityOf(b)) fail(`building ${id}: a crew of ${crewSize}, more than it holds`);
    if (crewSize && isDugOut(b)) fail(`building ${id}: dug out, but still has a crew`);
  }
  counts.forEach((n, owner) => { if (n > UNIT_LIMIT) fail(`side ${owner} has ${n} units`); });
  return problems;
}

/** @param {unknown} v */
function isRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * What players are shown of a state: all of it, except the random seed, the
 * id counter and units' experience points, with each route cut to its next
 * cell. That is all a screen needs to draw movement and levels, and it keeps
 * updates small: a unit's record changes once per cell it crosses and per
 * level, not every tick it works. Hidden information, such as fog of war,
 * would be filtered here, per side.
 * @param {GameState} state
 */
export function publicView(state) {
  /**
   * @template {Building | Unit} E
   * @param {E} e
   * @returns {E}
   */
  const cut = (e) => (e.path ? { ...e, path: e.path.slice(0, 1) } : e);
  const units = Object.values(state.units).map(({ xp: _xp, practice: _practice, ...shown }) => cut(shown));
  return {
    version: state.version,
    mode: state.mode,
    ...(state.over !== undefined ? { over: state.over } : {}),
    ...(state.winner !== undefined ? { winner: state.winner } : {}),
    seed: state.seed,
    tick: state.tick,
    players: state.players,
    buildings: Object.fromEntries(Object.entries(state.buildings).map(([id, b]) => [id, cut(b)])),
    units: Object.fromEntries(units.map((u) => [u.id, u])),
  };
}
