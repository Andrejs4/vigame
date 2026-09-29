/**
 * What the board shows of the fighting. The server sends the game as it
 * stands, not what happened in it, so the page works out what happened by
 * comparing each update with the one before: a building with fewer hit
 * points was hit, a building gone fell (unless it was a site given up, or a
 * band that broke up), and a unit gone died, in battle or of hunger.
 *
 * Effects play in real time, briefly, and the board redraws every frame
 * only while one plays. Drawing them is the renderer's job (render.js);
 * this keeps the list.
 */

import { isRising } from '../core/game.js';
import { BUILDING_TYPES, TICKS_PER_SECOND } from '../core/rules.js';

/** How long each kind of effect plays, in milliseconds. */
export const EFFECT_TIME = Object.freeze({ hit: 900, fall: 1200, death: 800 });

/** How long a building flashes when hit, in milliseconds. */
export const FLASH_TIME = 250;

/**
 * Updates further apart than this, in ticks, are a jump (a reconnect, a
 * page that was asleep), not something to play out.
 */
const JUMP = 3 * TICKS_PER_SECOND;

/**
 * A site gone within this many ticks of a hit fell; one gone otherwise was
 * given up by its owner.
 */
const UNDER_FIRE = 2 * TICKS_PER_SECOND;

/** The most effects kept at once; past it the oldest go. */
const MAX_EFFECTS = 200;

/**
 * @typedef {import('../core/game.js').Building} Building
 * @typedef {import('../core/game.js').Unit} Unit
 * @typedef {import('./net.js').GameView} GameView
 *
 * @typedef {object} Effect
 * @property {'hit' | 'fall' | 'death'} kind
 * @property {number} start When it began (performance.now()).
 * @property {number} end When it is over.
 * @property {number} seq Counts effects, to spread out ones that would overlap.
 * @property {number} clock The game tick it was seen at, for where a moving
 *   thing was.
 * @property {Building} [building] A hit's building as it was hit, a fallen
 *   building as last seen, or the building a unit died in.
 * @property {number} [damage] A hit's hit points lost.
 * @property {Unit} [unit] A unit that died out on the map.
 * @property {number} [count] How many died together in `building`.
 */

/**
 * Whether two updates are too far apart to play out what happened between
 * them: the first one, another game, or a jump in time.
 * @param {GameView | null} prev
 * @param {GameView} next
 * @returns {boolean}
 */
export function jumped(prev, next) {
  return !prev || prev.seed !== next.seed || next.tick < prev.tick || next.tick - prev.tick > JUMP;
}

/**
 * Whether a building gone from the game fell, rather than being given up
 * (only a site can be) or breaking up (a band, whose crew all left it).
 * @param {Building} b As last seen.
 * @param {number | undefined} hitAt The tick it was last seen hit.
 * @param {number} tick
 */
function fell(b, hitAt, tick) {
  const type = BUILDING_TYPES[b.type];
  if (!type || type.band || b.hp === undefined) return false;
  if (b.hp <= 0 || !isRising(b)) return true;
  return hitAt !== undefined && tick - hitAt <= UNDER_FIRE;
}

export class Effects {
  constructor() {
    /** Effects playing or yet to be pruned, oldest first. */
    /** @type {Effect[]} */
    this.list = [];
    /** The tick each building was last seen hit. */
    /** @type {Map<string, number>} */
    this.hitAt = new Map();
    this.seq = 0;
  }

  /**
   * Start the effects that the change from one update to the next shows.
   * @param {GameView | null} prev
   * @param {GameView} next
   * @param {number} now performance.now()
   * @returns {Effect[]} The effects it started.
   */
  update(prev, next, now) {
    if (jumped(prev, next)) {
      this.hitAt.clear();
      return [];
    }
    const first = this.seq;
    const tick = next.tick;
    for (const b of Object.values(next.buildings)) {
      const before = prev.buildings[b.id]?.hp;
      if (before === undefined || b.hp === undefined || b.hp >= before) continue;
      this.hitAt.set(b.id, tick);
      this.add('hit', now, tick, { building: b, damage: before - b.hp });
    }
    for (const b of Object.values(prev.buildings)) {
      if (next.buildings[b.id]) continue;
      if (fell(b, this.hitAt.get(b.id), tick)) this.add('fall', now, tick, { building: b });
      this.hitAt.delete(b.id);
    }
    /** Units that died inside each building, which show as one. */
    /** @type {Map<string, number>} */
    const inside = new Map();
    for (const u of Object.values(prev.units)) {
      if (next.units[u.id]) continue;
      if (u.in === undefined) this.add('death', now, tick, { unit: u, count: 1 });
      else if (prev.buildings[u.in]) inside.set(u.in, (inside.get(u.in) ?? 0) + 1);
    }
    for (const [id, count] of inside) {
      this.add('death', now, tick, { building: next.buildings[id] ?? prev.buildings[id], count });
    }
    return this.list.filter((e) => e.seq >= first);
  }

  /**
   * @param {Effect['kind']} kind
   * @param {number} now
   * @param {number} clock
   * @param {Partial<Effect>} details
   */
  add(kind, now, clock, details) {
    this.list.push({ kind, start: now, end: now + EFFECT_TIME[kind], seq: this.seq++, clock, ...details });
    if (this.list.length > MAX_EFFECTS) this.list.splice(0, this.list.length - MAX_EFFECTS);
  }

  /**
   * Drop the effects that are over, and say whether any still play.
   * @param {number} now
   */
  playing(now) {
    this.list = this.list.filter((e) => e.end > now);
    return this.list.length > 0;
  }

  /**
   * How strongly a building flashes from being hit, from 0 to 1.
   * @param {string} id
   * @param {number} now
   */
  flash(id, now) {
    let strength = 0;
    for (const e of this.list) {
      if (e.kind !== 'hit' || e.building?.id !== id) continue;
      const age = Math.max(0, now - e.start);
      if (age < FLASH_TIME) strength = Math.max(strength, 1 - age / FLASH_TIME);
    }
    return strength;
  }
}
