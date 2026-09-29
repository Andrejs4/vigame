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

/**
 * The sides' names and colours. A player's side has the palette of their
 * seat; the Dark Lord, the game's own side in cooperation games, has the
 * last one. A game's `players` records say which each owner number uses.
 */
export const SIDES = [
  { id: 0, name: 'Blue',      color: '#3d7fd8', accent: '#9ec5ff' },
  { id: 1, name: 'Crimson',   color: '#c8473f', accent: '#ffb3ad' },
  { id: 2, name: 'Green',     color: '#3f9e56', accent: '#a6e3b5' },
  { id: 3, name: 'Gold',      color: '#c99a1e', accent: '#f5d98a' },
  { id: 4, name: 'Teal',      color: '#249a97', accent: '#9de0dd' },
  { id: 5, name: 'Orange',    color: '#d9722a', accent: '#f8c49a' },
  { id: 6, name: 'Rose',      color: '#c9508f', accent: '#f5b3d6' },
  { id: 7, name: 'Silver',    color: '#8e9aa6', accent: '#dfe5eb' },
  { id: 8, name: 'Dark Lord', color: '#6a3fa0', accent: '#cdb0ff', npc: true },
  { id: 9, name: 'Raiders',   color: '#4a4038', accent: '#d8b08c', npc: true, wild: true },
];

/** The Dark Lord's palette. */
export const DARK_LORD = 8;
/**
 * The raiders' palette: wandering hostile wagons, in every game, against
 * everyone. They neither win nor lose.
 */
export const RAIDERS = 9;

/** Players a game may seat. */
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;
export const DEFAULT_PLAYERS = 2;

/**
 * Game modes. In cooperation the players are one team against the Dark
 * Lord; in free for all, each against the others (two players at least).
 */
export const MODES = { coop: 'Cooperation', ffa: 'Free for all' };
export const DEFAULT_MODE = 'coop';

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
 * Food and hunger. Every FOOD_PERIOD a castle yields enough food for half the
 * units it can hold, and a farm yields its `base` even with nobody working
 * it; then the side eats. Each unit eats FOOD_PER_UNIT if there is enough,
 * or an even share if not, and what can't be shared evenly waits for the
 * next meal. A side stores at most FOOD_STORE periods' food for its castle's
 * full house; the rest spoils.
 *
 * A side's hunger, from 0 to MAX_HUNGER, rises by however far the share
 * fell short of HUNGER_LINE, and falls by however far it went over. At
 * MAX_HUNGER each unit may starve at each meal: a level 1 unit with a
 * STARVE_CHANCE chance, less the higher its level, down to none at 100.
 */
export const FOOD_PERIOD = 60 * TICKS_PER_SECOND;
export const FOOD_PER_UNIT = 10;
export const FOOD_STORE = 10;
export const HUNGER_LINE = 5;
export const MAX_HUNGER = 100;
export const STARVE_CHANCE = 0.05;

/**
 * Fighting. Every COMBAT_PERIOD, each unit inside a building or a band
 * strikes the nearest enemy in reach: close combat at MELEE_RANGE if there
 * is one, else ranged at RANGED_RANGE plus the building's `reach`. A strike
 * on a building takes its base damage plus the skill used off its hit
 * points, except that a building's `through` share of strikes passes to a
 * unit inside, picked at random. A unit out in the open or in a band is
 * always open to strikes. A strike on a unit kills it with a chance that
 * depends on the striker's skill less the target's level: KILL_EVEN percent
 * when they match, rising toward KILL_MAX, and falling below 1% once the
 * target is 50 levels ahead (a stand-in for the dice to come). The strike
 * that brings down a building or kills a unit earns KILL_XP.
 *
 * A building may be given a target, an enemy building. One that can't move
 * strikes it while it is in reach, and the nearest enemy otherwise; a wagon
 * or band goes after it until it is close enough for close combat.
 */
export const COMBAT_PERIOD = TICKS_PER_SECOND;
export const MELEE_RANGE = 1;
export const RANGED_RANGE = 3;
export const MELEE_DAMAGE = 6;
export const RANGED_DAMAGE = 3;
/** Percents. */
export const KILL_EVEN = 10;
export const KILL_MAX = 50;
/** How much each level of difference multiplies the odds of a kill. */
export const KILL_STEP = 1.06;

/**
 * Raiders. Every RAID_PERIOD, with a RAID_CHANCE chance, a raider appears on
 * open ground at least RAID_CLEAR cells from any castle or lair, while there
 * are fewer than RAID_MAX plus one per player. It wanders at random and
 * strikes whatever comes near; bringing one down yields its `loot` of dark
 * metal to the side that struck the blow.
 */
export const RAID_PERIOD = 90 * TICKS_PER_SECOND;
export const RAID_CHANCE = 0.6;
export const RAID_MAX = 2;
export const RAID_CLEAR = 6;
/** How far a raider wanders at a time, in cells. */
export const RAID_ROAM = 4;

/**
 * The Dark Lord's horde. From HORDE_START, every HORDE_PERIOD his lair sends
 * out a wave, each bigger than the last: wave n is ceil(n / 2) ghouls and
 * floor(n / 3) ogres, as long as he has fewer than HORDE_MAX out. With more
 * than two players, waves and HORDE_MAX grow by the square root of
 * players / 2: twice as big at eight. They cost
 * him nothing, and hunt by themselves (`hunts` on a building type).
 */
export const HORDE_START = 2 * 60 * TICKS_PER_SECOND;
export const HORDE_PERIOD = 60 * TICKS_PER_SECOND;
export const HORDE_MAX = 24;

/**
 * Bringing down a building bought with dark metal (a wagon) yields the
 * striker's side this share of its price.
 */
export const SALVAGE = 0.5;

/** Dark metal each side starts with. */
export const START_METAL = 0;

/**
 * Repair: while a building is damaged, the units inside mend it instead of
 * their usual work, a hit point for every REPAIR_WORK of work, which trains
 * their building skill.
 */
export const REPAIR_WORK = 100;

/**
 * @typedef {object} BuildingType
 * @property {string} name
 * @property {1 | 7} size Cells covered: 1, or 7 (a cell and its six neighbours).
 * @property {number} capacity Units it holds at grade 1; each grade adds as much again.
 *   A castle takes in all its side's units, and stops breeding while it
 *   holds this many or more.
 * @property {number} grades Highest grade.
 * @property {number} hp Hit points at grade 1; each grade adds as many again.
 *   At none left, the building collapses at once, and whoever was inside is
 *   left standing on its cell. A band has none: it protects nobody.
 * @property {boolean} [band] A band: a group of units, free, that moves like
 *   a wagon but holds no cell, so it blocks nothing, and breaks up once it
 *   has nobody.
 * @property {boolean} build Whether players may build it.
 * @property {number} [raise] Work to raise it, from its crew once they are
 *   inside, a WORK_BASE plus their building skill each a tick: one unskilled
 *   unit alone takes raise / WORK_BASE ticks. Until then it has half its hit
 *   points, gives no cover, adds no reach, and neither works nor moves. An
 *   upgrade takes as much work again times its grade before, and comes with
 *   the next grade's room and hit points once done. (A castle is never
 *   raised, only upgraded.)
 * @property {number} [idleWork] Work it does by itself each tick, crewed or
 *   not: a castle raises a unit now and then even with nobody at home.
 * @property {number} cost Stone to build it.
 * @property {number} [metal] Dark metal to build it.
 * @property {boolean} [nearCastle] Built only within BUILD_RANGE of the castle.
 * @property {number} [loot] Dark metal for the side that brings it down;
 *   without it, a share of its price in dark metal (SALVAGE).
 * @property {number} [upgrade] Stone to upgrade it, times its grade before.
 * @property {Skill} skill The skill its units use there.
 * @property {number} [work] Work, from the units inside, for each thing it
 *   yields: a castle a new unit, a pit a stone, a farm a food.
 * @property {'unit' | 'stone' | 'food'} [yields]
 * @property {number} [base] Food a farm yields every FOOD_PERIOD, worked or not.
 * @property {number} [perDepth] Stone a pit yields for each grade of depth.
 * @property {number} [depth] A pit's last grade of depth. Once there it is
 *   dug out, and its crew goes home.
 * @property {number} [speed] Ticks per cell on open ground. Only moving buildings have one;
 *   a band goes at its slowest member's walking pace instead.
 * @property {number} [reach] Cells it adds to its units' ranged reach.
 * @property {number} [through] The share of strikes on it that reach a unit
 *   inside instead: none for a castle, tower or wagon.
 * @property {boolean} [life] Its side's life: when it falls, the side has lost.
 * @property {boolean} [scales] The Dark Lord's: its hit points grow with the
 *   number of players, by players / 2 (never less than for two), so four
 *   times at eight (`lordScale` in game.js).
 * @property {boolean} [hunts] One of the Dark Lord's horde, which moves and
 *   fights by itself: it goes for the nearest enemy farm, or castle once no
 *   farm is left; it turns on any building that strikes it, and on the
 *   nearest enemy building when its way is blocked.
 * @property {{ damage: number, skill: number, reach: number }} [attack] A
 *   building that strikes by itself, once every COMBAT_PERIOD: `damage` off a
 *   building, or a kill roll as a striker of `skill` against a unit, at the
 *   nearest enemy within `reach` cells.
 */

/** @type {Record<string, BuildingType>} */
export const BUILDING_TYPES = {
  castle: {
    name: 'Castle', size: 7, capacity: 60, grades: 3, hp: 2000, build: false, cost: 0, upgrade: 200, reach: 1, life: true,
    skill: 'breeding', work: 12000, yields: 'unit', idleWork: 10, raise: 36000,
  },
  tower: {
    name: 'Tower', size: 1, capacity: 20, grades: 3, hp: 500, build: true, cost: 60, upgrade: 60, reach: 2, skill: 'ranged',
    raise: 12000,
  },
  wagon: {
    name: 'Wagon', size: 1, capacity: 15, grades: 1, hp: 300, build: true, cost: 0, metal: 15, nearCastle: true,
    skill: 'melee', speed: 2 * TICKS_PER_SECOND, raise: 9000,
  },
  pit: {
    name: 'Pit', size: 1, capacity: 8, grades: 1, hp: 800, build: true, cost: 0,
    skill: 'build', work: 2400, yields: 'stone', perDepth: 20, depth: 5, through: 0.25, raise: 3000,
  },
  farm: {
    name: 'Farm', size: 1, capacity: 6, grades: 1, hp: 200, build: true, cost: 30,
    skill: 'farming', work: 300, yields: 'food', base: 20, through: 0.5, raise: 6000,
  },
  lair: {
    name: 'Lair', size: 7, capacity: 0, grades: 1, hp: 6000, build: false, cost: 0,
    skill: 'melee', life: true, attack: { damage: 20, skill: 30, reach: 4 }, scales: true,
  },
  raider: {
    name: 'Raider', size: 1, capacity: 0, grades: 1, hp: 300, build: false, cost: 0,
    skill: 'melee', speed: 3 * TICKS_PER_SECOND, attack: { damage: 10, skill: 20, reach: 2 }, loot: 10,
  },
  ghoul: {
    name: 'Ghoul', size: 1, capacity: 0, grades: 1, hp: 120, build: false, cost: 0,
    skill: 'melee', speed: TICKS_PER_SECOND, attack: { damage: 6, skill: 10, reach: 1 }, loot: 2, hunts: true, scales: true,
  },
  ogre: {
    name: 'Ogre', size: 1, capacity: 0, grades: 1, hp: 600, build: false, cost: 0,
    skill: 'melee', speed: 4 * TICKS_PER_SECOND, attack: { damage: 25, skill: 30, reach: 1 }, loot: 6, hunts: true, scales: true,
  },
  band: {
    name: 'Band', size: 1, capacity: 30, grades: 1, hp: 0, build: true, cost: 0,
    skill: 'melee', speed: WALK_TICKS, band: true,
  },
};
