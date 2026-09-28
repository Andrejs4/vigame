/**
 * Game data: the clock, the sides, units' skills and levels, and the
 * building types.
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

/** Units each castle starts with. */
export const START_UNITS = 12;

/** How far from one of your standing buildings you may build, in cells. */
export const BUILD_RANGE = 3;

/** Ticks between units leaving a building, so a group goes out as a column. */
export const DEPART_GAP = 1;

/** How long a blocked wagon waits before looking for another way, in ticks. */
export const WAGON_PATIENCE = 3 * TICKS_PER_SECOND;

/**
 * Ticks a unit takes to cross a cell of open ground with no running skill.
 * Running takes time off, down to half at running 100: one second, the
 * fastest anything moves.
 */
export const WALK_TICKS = 2 * TICKS_PER_SECOND;

/**
 * What units can get good at, with the names players see. Each skill goes
 * from 0 up to the unit's level.
 */
export const SKILLS = {
  breeding: 'Breeding',
  ranged: 'Ranged attack',
  melee: 'Close combat',
  build: 'Building', // building, repairing and digging
  farming: 'Farming',
  running: 'Running',
};

/** @typedef {keyof typeof SKILLS} Skill */

/** The highest level a unit can reach. */
export const MAX_LEVEL = 100;

/**
 * Experience. Every tick a unit works, its skill in use gets a point, the
 * same for every skill, and a skill level takes SKILL_XP points. The unit's
 * level gets LEVEL_RATE points for the work, from the gentle (breeding) to
 * the fierce (close combat), and a killing blow is worth KILL_XP at once.
 * Its first level-up takes LEVEL_XP points and each next one LEVEL_GROWTH
 * times as many, so the last levels are all but out of reach: level 10
 * takes about 27 minutes of breeding or 5 of fighting, level 50 about 35
 * hours or 6, and level 100 half a year or a month. Skills come faster than
 * levels, whatever the work, until they reach the unit's level and wait.
 */
export const LEVEL_XP = 1200;
export const LEVEL_GROWTH = 1.1;
export const SKILL_XP = 150;
/** @type {Record<Skill, number>} */
export const LEVEL_RATE = { breeding: 1, running: 2, farming: 3, build: 4, ranged: 5, melee: 6 };
/** Not used until there is combat. */
export const KILL_XP = 600;

/** Work a unit does in a tick with the skill at 0; each skill level adds one. */
export const WORK_BASE = 20;

/** Stone each side starts with. */
export const START_STONE = 200;

/**
 * Food. A unit will eat one a minute (hunger comes later). Every minute a
 * castle yields enough for half the units it can hold, and a farm yields its
 * `base` even with nobody working it.
 */
export const FOOD_PERIOD = 60 * TICKS_PER_SECOND;

/**
 * @typedef {object} BuildingType
 * @property {string} name
 * @property {1 | 7} size Cells covered: 1, or 7 (a cell and its six neighbours).
 * @property {number} capacity Units it holds at grade 1; each grade adds as much again.
 * @property {number} grades Highest grade.
 * @property {number} hp Hit points at grade 1; each grade adds as many again.
 *   At none left, the building collapses at once, and whoever was inside is
 *   left standing on its cell.
 * @property {boolean} build Whether players may build it.
 * @property {number} cost Stone to build it.
 * @property {number} [upgrade] Stone to upgrade it, times its grade before.
 * @property {Skill} skill The skill its units use there.
 * @property {number} [work] Work, from the units inside, for each thing it
 *   yields: a castle a new unit, a pit a stone, a farm a food.
 * @property {'unit' | 'stone' | 'food'} [yields]
 * @property {number} [base] Food a farm yields every FOOD_PERIOD, worked or not.
 * @property {number} [perDepth] Stone a pit yields for each grade of depth.
 * @property {number} [depth] A pit's last grade of depth. Once there it is
 *   dug out, and its crew goes home.
 * @property {number} [speed] Ticks per cell on open ground. Only moving buildings have one.
 */

/** @type {Record<string, BuildingType>} */
export const BUILDING_TYPES = {
  castle: {
    name: 'Castle', size: 7, capacity: 60, grades: 3, hp: 2000, build: false, cost: 0, upgrade: 200,
    skill: 'breeding', work: 12000, yields: 'unit',
  },
  tower: { name: 'Tower', size: 1, capacity: 20, grades: 3, hp: 500, build: true, cost: 60, upgrade: 60, skill: 'ranged' },
  wagon: {
    name: 'Wagon', size: 1, capacity: 10, grades: 1, hp: 300, build: true, cost: 0,
    skill: 'melee', speed: 2 * TICKS_PER_SECOND,
  },
  pit: {
    name: 'Pit', size: 1, capacity: 8, grades: 1, hp: 800, build: true, cost: 0,
    skill: 'build', work: 2400, yields: 'stone', perDepth: 20, depth: 5,
  },
  farm: {
    name: 'Farm', size: 1, capacity: 6, grades: 1, hp: 200, build: true, cost: 30,
    skill: 'farming', work: 3000, yields: 'food', base: 2,
  },
};
