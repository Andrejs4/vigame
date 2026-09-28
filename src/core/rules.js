/**
 * Game data: the clock, the sides, and the building and unit types.
 *
 * The numbers are placeholders, gathered here so they are tuned in one place.
 * The rules in game.js read them and hold no numbers of their own. Pure data:
 * the game server imports this module unchanged.
 */

/**
 * Simulation steps per second. Every duration in the game is a whole number
 * of ticks, so the game is the same on every machine and in every replay.
 */
export const TICKS_PER_SECOND = 10;

/** The sides, indexed by owner number. */
export const SIDES = [
  { id: 0, name: 'Blue',    color: '#3d7fd8', accent: '#9ec5ff' },
  { id: 1, name: 'Crimson', color: '#c8473f', accent: '#ffb3ad' },
];

/** Most units one player may have at once, inside buildings or out. */
export const UNIT_LIMIT = 300;

/** How far from one of your standing buildings you may build, in cells. */
export const BUILD_RANGE = 3;

/** Ticks between units leaving a building, so a group goes out as a column. */
export const DEPART_GAP = 1;

/** How long a blocked wagon waits before looking for another way, in ticks. */
export const WAGON_PATIENCE = 3 * TICKS_PER_SECOND;

/**
 * @typedef {object} BuildingType
 * @property {string} name
 * @property {1 | 7} size Cells covered: 1, or 7 (a cell and its six neighbours).
 * @property {number} capacity Units it holds at grade 1; each grade adds as much again.
 * @property {number} grades Highest grade.
 * @property {boolean} build Whether players may build it.
 * @property {string} [produces] Unit type it makes, one every `every` ticks while there is room.
 * @property {number} [every]
 * @property {number} [speed] Ticks per cell on open ground. Only moving buildings have one.
 */

/** @type {Record<string, BuildingType>} */
export const BUILDING_TYPES = {
  castle: { name: 'Castle', size: 7, capacity: 60, grades: 3, build: false, produces: 'militia', every: 2 * TICKS_PER_SECOND },
  tower:  { name: 'Tower',  size: 1, capacity: 20, grades: 3, build: true },
  wagon:  { name: 'Wagon',  size: 1, capacity: 10, grades: 1, build: true, speed: 2 * TICKS_PER_SECOND },
};

/**
 * @typedef {object} UnitType
 * @property {string} name
 * @property {number} speed Ticks per cell on open ground. One second is the fastest.
 */

/** @type {Record<string, UnitType>} */
export const UNIT_TYPES = {
  militia: { name: 'Militia', speed: TICKS_PER_SECOND },
};
