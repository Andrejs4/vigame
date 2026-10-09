/**
 * NPC players: what one does next, worked out from the game as it is. The
 * game server asks for each seat an NPC plays, every NPC.think ticks, and
 * gives what comes back as that seat's commands, logged like a player's: so
 * a replay needs none of this, and NPCs may change from one version to the
 * next without touching saved games.
 *
 * An NPC keeps a few notes between moves (`NpcMemory`, plain data the room
 * holds and loses on a restart, which only delays it a little): when it
 * first saw each threat, where a command was refused, and when its wagons
 * set off. It never draws on the game's dice.
 *
 * What it does, most pressing first (the numbers are NPC in rules.js):
 * answers threats it has seen for a while (enemy bands, wagons, raiders and
 * the horde near its buildings, and manned towers that reach one) with a
 * band; builds a farm when the next meal falls short; fills its buildings'
 * crews; upgrades its castle, then towers; from twelve minutes in, builds
 * and upgrades wagons behind its castle with dark metal, sends them once the
 * metal is spent, and soon after goes all in with everyone at home; builds
 * pits, farms and towers in turn; and sends bands out against the nearest
 * enemy (against the Dark Lord, his horde and raiders near it).
 */

import {
  BUILDING_TYPES, BUILD_RANGE, NPC,
} from './rules.js';
import {
  allied, buildCost, capacityOf, castleOf, crewOf, crewReach, footprint, fullMeal, hasLord, inBuildRange, isDugOut,
  isRising, occupancy, purseOf, shortOf, upgradeCost,
} from './game.js';
import { distance, hexagon, key } from './hex.js';
import { tileAt } from './board.js';

/** @typedef {import('./game.js').GameState} GameState */
/** @typedef {import('./game.js').Building} Building */
/** @typedef {import('./game.js').Command} Command */
/** @typedef {import('./board.js').Board} Board */
/** @typedef {import('./hex.js').Axial} Axial */

/**
 * @typedef {object} NpcMemory What an NPC remembers between moves.
 * @property {Record<string, number>} seen The tick it first saw each threat, by building id.
 * @property {Record<string, number>} refused The tick a command was refused, by `refusalKey`.
 * @property {Record<string, { target: string, at: number }>} orders What each
 *   band it just formed is for, by the band's cell, until it is sent.
 * @property {number} [wagonsSent] The tick its wagons last set off.
 * @property {number} [allIn] The `wagonsSent` it went all in after.
 */

/** @returns {NpcMemory} */
export function npcMemory() {
  return { seen: {}, refused: {}, orders: {} };
}

/**
 * What a refused command is remembered by: its kind and its place, or the
 * building it was for.
 * @param {Command} command
 */
export function refusalKey(command) {
  const c = /** @type {Record<string, unknown>} */ (command);
  return [c.type, c.kind ?? '', c.building ?? '', c.q ?? '', c.r ?? ''].join(':');
}

/**
 * Note that the game refused a command, so it isn't tried again soon.
 * @param {NpcMemory} memory
 * @param {Command} command
 * @param {number} tick
 */
export function npcRefused(memory, command, tick) {
  memory.refused[refusalKey(command)] = tick;
}

/**
 * The next command for the NPC playing this seat, or null for none now. Its
 * memory is updated as it decides. Ask again after giving the command, as
 * the room does up to NPC.perThink times.
 * @param {Board} board
 * @param {GameState} state
 * @param {number} seat
 * @param {NpcMemory} memory
 * @returns {Command | null}
 */
export function npcMove(board, state, seat, memory) {
  if (state.over !== undefined || state.tick < NPC.start || state.players[seat]?.lost !== undefined) return null;
  const castle = castleOf(state, seat);
  if (!castle) return null;
  const me = new Npc(board, state, seat, castle, memory);
  return me.send() ?? me.defend() ?? me.feed() ?? me.staff() ?? me.upgrade() ?? me.wagons() ?? me.grow() ?? me.attack() ?? me.regroup();
}

class Npc {
  /**
   * @param {Board} board
   * @param {GameState} state
   * @param {number} seat
   * @param {Building} castle
   * @param {NpcMemory} memory
   */
  constructor(board, state, seat, castle, memory) {
    this.board = board;
    this.state = state;
    this.seat = seat;
    this.castle = castle;
    this.memory = memory;
    this.occ = occupancy(state);
    this.mine = Object.values(state.buildings).filter((b) => b.owner === seat);
    this.enemies = Object.values(state.buildings).filter((b) => !allied(state, b.owner, seat) && (b.hp === undefined || b.hp > 0));
    // Those at home and staying there, the best at the work first when picked.
    this.home = (this.occ.inside.get(castle.id) ?? []).filter((id) => state.units[id].to === undefined);
    for (const [id, at] of Object.entries(memory.refused)) if (state.tick - at >= NPC.retry) delete memory.refused[id];
    for (const [at, order] of Object.entries(memory.orders)) if (state.tick - order.at >= NPC.retry) delete memory.orders[at];
  }

  /** Send a band it has just formed after what it formed it for. */
  send() {
    for (const b of this.mine) {
      const order = this.memory.orders[key(b.q, b.r)];
      if (!order || !BUILDING_TYPES[b.type].band || b.target !== undefined) continue;
      delete this.memory.orders[key(b.q, b.r)];
      if (Object.hasOwn(this.state.buildings, order.target)) return this.may({ type: 'target', building: b.id, target: order.target });
    }
    return null;
  }

  /** Units at home it may send out, keeping NPC.keepHome. */
  get spare() {
    return Math.max(0, this.home.length - NPC.keepHome);
  }

  /**
   * Up to `n` of those at home, the best at a skill first; taken, so the
   * next command this turn doesn't count them again.
   * @param {number} n
   * @param {import('./rules.js').Skill} skill
   */
  take(n, skill) {
    const units = this.state.units;
    const picked = [...this.home].sort((a, b) => units[b].skills[skill] - units[a].skills[skill] || (a < b ? -1 : 1)).slice(0, n);
    const taken = new Set(picked);
    this.home = this.home.filter((id) => !taken.has(id));
    return picked;
  }

  /**
   * A command it may give: not one refused lately.
   * @param {Command} command
   * @returns {Command | null}
   */
  may(command) {
    return Object.hasOwn(this.memory.refused, refusalKey(command)) ? null : command;
  }

  /** Its buildings' cells, for what is near them. */
  get cells() {
    return this.mine.filter((b) => b.hp !== undefined).flatMap((b) => footprint(b.type, b.q, b.r));
  }

  /**
   * Whether one of its bands or wagons already goes for a building.
   * @param {string} id
   */
  answered(id) {
    return this.mine.some((b) => b.target === id) || Object.values(this.memory.orders).some((o) => o.target === id);
  }

  /**
   * Answer the threats it has seen for NPC.react: a band of what it can
   * spare, at most NPC.bandMax, at each one not answered yet.
   * @returns {Command | null}
   */
  defend() {
    const cells = this.cells;
    const threats = this.enemies.filter((e) => {
      const type = BUILDING_TYPES[e.type];
      const at = footprint(e.type, e.q, e.r);
      if (type.speed) return at.some((c) => cells.some((x) => distance(c, x) <= NPC.near));
      // A tower that can strike one of its buildings, while someone is in it.
      return e.type === 'tower' && (this.occ.inside.get(e.id)?.length ?? 0) > 0
        && at.some((c) => cells.some((x) => distance(c, x) <= crewReach(e)));
    });
    const seen = this.memory.seen;
    const now = new Set(threats.map((e) => e.id));
    for (const id of Object.keys(seen)) if (!now.has(id)) delete seen[id];
    for (const e of threats) seen[e.id] ??= this.state.tick;
    const due = threats
      .filter((e) => this.state.tick - seen[e.id] >= NPC.react && !this.answered(e.id))
      .sort((a, b) => distance(a, this.castle) - distance(b, this.castle) || (a.id < b.id ? -1 : 1));
    for (const e of due) {
      const command = this.band(Math.min(this.spare, NPC.bandMax), e);
      if (command) return command;
    }
    return null;
  }

  /** A farm, when the next meal falls short. */
  feed() {
    if (fullMeal(this.state, this.seat) || this.rising('farm')) return null;
    return this.build('farm');
  }

  /**
   * Whether one of its buildings of this kind is still going up.
   * @param {string} kind
   */
  rising(kind) {
    return this.mine.some((b) => b.type === kind && isRising(b));
  }

  /** Fill a pit's, farm's or tower's crew up to NPC.crews from home. */
  staff() {
    for (const b of this.mine) {
      const want = /** @type {Record<string, number>} */ (NPC.crews)[b.type];
      if (!want || b.type === 'wagon' || isDugOut(b)) continue;
      const crew = crewOf(this.state, b.id);
      const more = Math.min(want, capacityOf(b)) - crew.length;
      if (more <= 0 || this.spare <= 0) continue;
      const command = this.may({ type: 'crew', building: b.id, units: [...crew, ...this.take(Math.min(more, this.spare), BUILDING_TYPES[b.type].skill)] });
      if (command) return command;
    }
    return null;
  }

  /** Its castle once it has NPC.castleUpgradeAt stone, then towers, keeping NPC.stoneReserve. */
  upgrade() {
    const stone = this.purse.stone;
    const ready = (/** @type {Building} */ b) => !isRising(b) && b.upgrading === undefined && b.grade < BUILDING_TYPES[b.type].grades;
    if (ready(this.castle) && stone >= Math.max(NPC.castleUpgradeAt, upgradeCost(this.castle).stone)) {
      return this.may({ type: 'upgrade', building: this.castle.id });
    }
    for (const b of this.mine) {
      if (b.type !== 'tower' || !ready(b) || stone < upgradeCost(b).stone + NPC.stoneReserve) continue;
      const command = this.may({ type: 'upgrade', building: b.id });
      if (command) return command;
    }
    return null;
  }

  /** What it has in store: its own, or its team's in a game that shares one. */
  get purse() {
    return purseOf(this.state, this.seat);
  }

  /**
   * From NPC.wagonsFrom: wagons behind the castle and their upgrades while
   * there is dark metal; once it is spent, the wagons at home attack, and
   * NPC.allInAfter later everyone at home does.
   * @returns {Command | null}
   */
  wagons() {
    const { state, memory } = this;
    if (state.tick < NPC.wagonsFrom) return null;
    const goal = this.goal(true);
    // All in, a while after the wagons set off: bands of everyone at home.
    if (memory.wagonsSent !== undefined && memory.allIn !== memory.wagonsSent && state.tick - memory.wagonsSent >= NPC.allInAfter) {
      if (goal && this.home.length >= NPC.bandMin) {
        const command = this.band(Math.min(this.home.length, BUILDING_TYPES.band.capacity), goal, true);
        if (command) return command;
      }
      memory.allIn = memory.wagonsSent;
    }
    const wagons = this.mine.filter((b) => b.type === 'wagon');
    const parked = wagons.filter((b) => b.target === undefined && !b.path?.length);
    const ready = parked.filter((b) => !isRising(b) && b.upgrading === undefined);
    const metal = this.purse.metal;
    const upgradable = ready.find((b) => b.grade < BUILDING_TYPES.wagon.grades && metal >= upgradeCost(b).metal);
    if (upgradable) return this.may({ type: 'upgrade', building: upgradable.id });
    if (metal >= buildCost('wagon').metal) return this.build('wagon');
    // The metal is spent: once none is going up or being upgraded, fill
    // their crews and send them.
    if (!ready.length || parked.length > ready.length || !goal) return null;
    // An attack waits for NPC.wagonsMin; one setting off sends them all.
    const setting = memory.wagonsSent !== undefined && state.tick - memory.wagonsSent < NPC.allInAfter;
    if (!setting && ready.length < NPC.wagonsMin) return null;
    for (const b of ready) {
      const crew = crewOf(state, b.id);
      const more = capacityOf(b) - crew.length;
      if (more > 0 && this.home.length) {
        const command = this.may({ type: 'crew', building: b.id, units: [...crew, ...this.take(Math.min(more, this.home.length), 'ranged')] });
        if (command) return command;
      }
    }
    const wagon = ready[0];
    if (crewOf(state, wagon.id).length === 0) return null;
    memory.wagonsSent = state.tick;
    return this.may({ type: 'target', building: wagon.id, target: goal.id });
  }

  /** The next of NPC.order, while nothing it builds is going up. */
  grow() {
    if (['pit', 'farm', 'tower'].some((kind) => this.rising(kind))) return null;
    const built = this.mine.filter((b) => ['pit', 'farm', 'tower'].includes(b.type) && !isDugOut(b)).length;
    return this.build(NPC.order[built % NPC.order.length]);
  }

  /**
   * Send a band against the nearest enemy, from NPC.bandFrom at home: a
   * share of them, NPC.bandShare, at most NPC.bandMax.
   */
  attack() {
    if (this.home.length < NPC.bandFrom) return null;
    const goal = this.goal(false);
    if (!goal) return null;
    return this.band(Math.min(NPC.bandMax, Math.floor(this.home.length * NPC.bandShare)), goal);
  }

  /** A band or wagon whose target is gone goes for the next, or its units come home. */
  regroup() {
    for (const b of this.mine) {
      const type = BUILDING_TYPES[b.type];
      if (!type.speed || isRising(b) || b.target !== undefined || b.path?.length) continue;
      const crew = crewOf(this.state, b.id);
      if (type.band) {
        // Against the Dark Lord, an idle band goes for the lair only all in.
        const goal = this.goal(false);
        const command = goal ? this.may({ type: 'target', building: b.id, target: goal.id }) : null;
        if (command) return command;
        if (crew.length) return this.may({ type: 'home', units: crew });
      } else if (this.memory.wagonsSent !== undefined && crew.length) {
        // A wagon back from an attack, while there is one to go on with.
        const goal = this.goal(true);
        if (goal && distance(b, this.castle) > BUILD_RANGE + 1) return this.may({ type: 'target', building: b.id, target: goal.id });
      }
    }
    return null;
  }

  /**
   * Whom its bands go for. Against the Dark Lord: his horde and raiders
   * within NPC.hunt of its castle, or, all in, his lair. Otherwise the
   * nearest enemy castle, or the nearest enemy building once none is left.
   * @param {boolean} allIn
   * @returns {Building | null}
   */
  goal(allIn) {
    const from = this.castle;
    const byDistance = (/** @type {Building[]} */ list) => list
      .sort((a, b) => distance(a, from) - distance(b, from) || (a.id < b.id ? -1 : 1))[0] ?? null;
    if (hasLord(this.state.mode)) {
      const hunted = byDistance(this.enemies.filter((e) => (BUILDING_TYPES[e.type].hunts || e.type === 'raider') && distance(e, from) <= NPC.hunt));
      if (hunted || !allIn) return hunted;
      return byDistance(this.enemies.filter((e) => e.type === 'lair'));
    }
    const players = this.enemies.filter((e) => e.type !== 'raider');
    return byDistance(players.filter((e) => e.type === 'castle')) ?? byDistance(players);
  }

  /**
   * A band of `n` from home, the best fighters first, beside the castle on
   * the side of its target, which it goes for.
   * @param {number} n
   * @param {Building} target
   * @param {boolean} [anyone] Send it even below NPC.bandMin.
   * @returns {Command | null}
   */
  band(n, target, anyone = false) {
    if (n < (anyone ? 1 : NPC.bandMin)) return null;
    const spot = this.spots('band', target, true)[0];
    if (!spot) return null;
    const command = this.may({ type: 'build', kind: 'band', q: spot.q, r: spot.r, units: this.take(n, 'ranged') });
    if (command) this.memory.orders[key(spot.q, spot.r)] = { target: target.id, at: this.state.tick };
    return command;
  }

  /**
   * Build one of these, with its NPC.crews crew, or at least half of it
   * (filled up later): towers toward the enemy, the rest behind the castle.
   * @param {string} kind
   * @returns {Command | null}
   */
  build(kind) {
    if (shortOf(this.state, this.seat, buildCost(kind))) return null;
    const want = Math.min(/** @type {Record<string, number>} */ (NPC.crews)[kind] ?? 0, this.spare);
    if (want < Math.ceil((/** @type {Record<string, number>} */ (NPC.crews)[kind] ?? 0) / 2)) return null;
    const enemy = this.goal(true) ?? this.goal(false);
    for (const spot of this.spots(kind, enemy, kind === 'tower')) {
      const command = this.may({ type: 'build', kind, q: spot.q, r: spot.r, units: [] });
      if (!command) continue;
      return { ...command, units: this.take(want, BUILDING_TYPES[kind].skill) };
    }
    return null;
  }

  /**
   * Open cells a building of this kind may go on, near the castle: the
   * nearest to `toward` first, or with `front` false the farthest from it
   * (behind the castle). Buildings keep the ring around the castle free, so
   * units and bands can get out; a band starts on it.
   * @param {string} kind
   * @param {Axial | null} toward
   * @param {boolean} front
   * @returns {Axial[]}
   */
  spots(kind, toward, front) {
    const type = BUILDING_TYPES[kind];
    const { q, r } = this.castle;
    const ring = type.band ? [2] : [3, 4, 5];
    const open = hexagon(Math.max(...ring)).map((o) => ({ q: q + o.q, r: r + o.r }))
      .filter((c) => ring.includes(distance(c, this.castle)))
      .filter((c) => {
        const tile = tileAt(this.board, c.q, c.r);
        return Boolean(type.band ? tile?.passable : tile?.buildable) && !this.occ.buildingAt.has(key(c.q, c.r))
          && inBuildRange(this.state, this.seat, kind, c)
          && !Object.hasOwn(this.memory.refused, refusalKey({ type: 'build', kind, q: c.q, r: c.r }));
      });
    const aim = toward ?? this.castle;
    const sign = front ? 1 : -1;
    return open.sort((a, b) => sign * (distance(a, aim) - distance(b, aim)) || distance(a, this.castle) - distance(b, this.castle)
      || a.q - b.q || a.r - b.r);
  }
}
