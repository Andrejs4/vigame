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
 * seat (SEAT_SIDES); the Dark Lord, the game's own side in cooperation
 * games, and the raiders have theirs. A game's `players` records say which
 * each owner number uses. Seats 9 to 16 came later, after the Dark Lord and
 * the raiders, so that games saved before keep their colours.
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
  { id: 10, name: 'Azure',    color: '#3fa9e6', accent: '#b4e2fa' },
  { id: 11, name: 'Lime',     color: '#8bc43a', accent: '#d5f1a6' },
  { id: 12, name: 'Indigo',   color: '#4c4ec4', accent: '#b9baf5' },
  { id: 13, name: 'Cherry',   color: '#962a45', accent: '#eba4b6' },
  { id: 14, name: 'Olive',    color: '#7e7c2c', accent: '#e0dd9c' },
  { id: 15, name: 'Coral',    color: '#ec7c66', accent: '#ffcabd' },
  { id: 16, name: 'White',    color: '#e2ddd0', accent: '#ffffff' },
  { id: 17, name: 'Mint',     color: '#4fd0a2', accent: '#bdf3df' },
];

/** The Dark Lord's palette. */
export const DARK_LORD = 8;
/**
 * The raiders' palette: wandering hostile wagons, in every game, against
 * everyone. They neither win nor lose.
 */
export const RAIDERS = 9;

/** The palette of each seat's side, an index into SIDES, by seat. */
export const SEAT_SIDES = [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17];

/** Players a game may seat. */
export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 16;
export const DEFAULT_PLAYERS = 1;

/**
 * Game modes. In cooperation the players are one team against the Dark
 * Lord; Easy Lord is the same against a weaker one; Very Easy Lord is Easy
 * Lord with castles that raise units twice as fast (BREED_RATE); Shared
 * Easy Lord is Easy Lord with one stock for the whole team (SHARED_STOCK);
 * in free for all, each against the others (two players at least).
 */
export const MODES = {
  coop: 'Cooperation', easy: 'Easy Lord', veryEasy: 'Very Easy Lord', shared: 'Shared Easy Lord', ffa: 'Free for all',
};
export const DEFAULT_MODE = 'coop';

/**
 * The modes with a Dark Lord, and his buildings' hit points in each (his
 * lair's and his horde's), as a share of the usual.
 * @type {Record<string, number>}
 */
export const LORD_HP = { coop: 1, easy: 0.5, veryEasy: 0.5, shared: 0.5 };

/**
 * How fast castles raise new units in a mode, as a multiple of the usual:
 * their units' work and what they do by themselves both count this many
 * times. One in any mode not listed.
 * @type {Record<string, number>}
 */
export const BREED_RATE = { veryEasy: 2 };

/**
 * The Dark Lord grows stronger with the players (`lordScale` in game.js) up
 * to this many; more make him no stronger.
 */
export const LORD_PLAYERS_MAX = 8;

/**
 * The modes whose teams share one stock: stone, dark metal and food, and so
 * hunger, kept on the team's first side. A team starts with what each of its
 * sides would have had, together.
 * @type {string[]}
 */
export const SHARED_STOCK = ['shared'];

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

/**
 * Each skill's short name, for a line of them all (the Heroes list), in the
 * order shown there: fighting first.
 * @type {Record<Skill, string>}
 */
export const SKILL_SHORT = { ranged: 'Att', melee: 'Mel', build: 'Bld', farming: 'Frm', breeding: 'Brd', running: 'Run' };

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
/**
 * Heroes: a unit is one, from birth, with a HERO_SHARE chance (the first
 * units too). Its levels cost HERO_LEVEL_XP at first, then HERO_LEVEL_GROWTH
 * times as much each, so for the same work it stands about three times as
 * high as an ordinary unit, whenever you look: 12 to its 5, 27 to its 10, 58
 * to its 20. It reaches MAX_LEVEL about when an ordinary unit would be 34.
 */
export const HERO_SHARE = 0.1;
export const HERO_LEVEL_XP = 390;
export const HERO_LEVEL_GROWTH = 1.032;
export const SKILL_XP = 150;
/**
 * Points a skill gets for each tick of work, or strike, with it: 1 unless
 * listed. Units strike only once a COMBAT_PERIOD, so fighting skills get more.
 * @type {Partial<Record<Skill, number>>}
 */
export const SKILL_RATE = { ranged: 5, melee: 5 };
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
 * A side's hunger, from 0 to MAX_HUNGER, follows how short its meals fall:
 * at each meal it moves HUNGER_PULL of the way (rounded away from where it
 * is) toward the share's shortfall, none for a full meal, half for half
 * rations, MAX_HUNGER for nothing at all. At MAX_HUNGER each unit may
 * starve at each meal: a level 1 unit with a STARVE_CHANCE chance, less the
 * higher its level, down to none at 100.
 */
export const FOOD_PERIOD = 60 * TICKS_PER_SECOND;
export const FOOD_PER_UNIT = 10;
export const FOOD_STORE = 10;
export const HUNGER_PULL = 0.25;
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
 * are fewer than RAID_PER_PLAYER for each player. It wanders at random and
 * strikes whatever comes near; bringing one down yields its `loot` of dark
 * metal to the side that struck the blow.
 */
export const RAID_PERIOD = 90 * TICKS_PER_SECOND;
export const RAID_CHANCE = 0.6;
export const RAID_PER_PLAYER = 2;
export const RAID_CLEAR = 6;
/** How far a raider wanders at a time, in cells. */
export const RAID_ROAM = 4;

/**
 * The Dark Lord's horde. From HORDE_START, every HORDE_PERIOD his lair sends
 * out a wave, each bigger than the last: wave n is ceil(n / 2) ghouls and
 * floor(n / 3) ogres, as long as he has fewer than HORDE_MAX out. With more
 * than two players, waves and HORDE_MAX grow by the square root of
 * players / 2: twice as big at eight, and no bigger with more
 * (LORD_PLAYERS_MAX). They cost him nothing, and hunt by themselves
 * (`hunts` on a building type).
 */
export const HORDE_START = 2 * 60 * TICKS_PER_SECOND;
export const HORDE_PERIOD = 60 * TICKS_PER_SECOND;
export const HORDE_MAX = 24;

/**
 * Points, for the table at a game's end: what each thing in a side's tally
 * (see Player in game.js) is worth, rounded down in each line. Enemy units
 * killed; hit points taken off enemy buildings; enemy buildings brought
 * down, and enemy castles and lairs; units born; stone dug; food grown by
 * crews; buildings finished; grades reached by upgrading (a castle's third
 * grade counts 3); and winning.
 */
export const POINTS = Object.freeze({
  kills: 10, damage: 0.1, felled: 50, castles: 500, born: 5, stone: 1, food: 0.1, built: 20, upgrades: 50, won: 500,
});

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
 * their building skill; but not while they have an enemy in reach, whom
 * they fight instead. An unskilled unit mends 0.4 hit points a second.
 */
export const REPAIR_WORK = 500;

/**
 * @typedef {object} BuildingType
 * @property {string} name
 * @property {1 | 7} size Cells covered: 1, or 7 (a cell and its six neighbours).
 * @property {number} capacity Units it holds at grade 1; each grade adds as much again,
 *   or `perGrade` if it has that.
 *   A castle takes in all its side's units, and stops breeding while it
 *   holds this many or more.
 * @property {number} grades Highest grade.
 * @property {number} [perGrade] Units each grade after the first adds to its room.
 * @property {number} hp Hit points at grade 1; each grade adds as many again,
 *   or `hpPerGrade` if it has that.
 * @property {number} [hpPerGrade] Hit points each grade after the first adds.
 *   At none left, the building collapses at once, and whoever was inside is
 *   left standing on its cell. A band has none: it protects nobody.
 * @property {number} [ticked] For a new one, the most its crew chooser ticks
 *   (the best at home, up to half of them), if fewer than its room: a band
 *   holds more than a tower at its last grade, but sets out with fewer.
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
 * @property {number} [hunger] Hunger it adds to its side when built, up to
 *   MAX_HUNGER: a pit costs no stone, so it costs this instead, and can't be
 *   put down by the dozen for nothing. At MAX_HUNGER it is free.
 * @property {number} [metal] Dark metal to build it.
 * @property {boolean} [nearCastle] Built only within BUILD_RANGE of the castle.
 * @property {number} [loot] Dark metal for the side that brings it down;
 *   without it, a share of its price in dark metal (SALVAGE).
 * @property {number} [upgrade] Stone to upgrade it, times its grade before.
 * @property {number} [upgradeMetal] Dark metal to upgrade it, the same at each grade.
 * @property {Skill} skill The skill its units use there: the one their work
 *   trains, or for a crew that fights, its main one, ranged attack (a unit
 *   strikes at range, and in close combat only an enemy right next to it).
 *   The crew chooser ranks units by it.
 * @property {Skill} [extra] Another skill its crew uses, shown beside `skill`
 *   when choosing one: close combat, for the crews that fight.
 * @property {number} [work] Work, from the units inside, for each thing it
 *   yields: a castle a new unit, a pit a stone, a farm a food.
 * @property {'unit' | 'stone' | 'food'} [yields]
 * @property {number} [base] Food a farm yields every FOOD_PERIOD, worked or not.
 * @property {number} [perDepth] Stone a pit yields for each grade of depth.
 * @property {number} [hpPerDepth] Hit points each grade of depth adds to a
 *   pit, gained as it gets there.
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
 *   times at eight, and no more past eight (`lordScale` in game.js).
 * @property {boolean} [hunts] One of the Dark Lord's horde, which moves and
 *   fights by itself: it goes for the nearest enemy farm, or castle once no
 *   farm is left; it turns on any building that strikes it, and on the
 *   nearest enemy building when its way is blocked.
 * @property {{ damage: number, skill: number, reach: number }} [attack] A
 *   building that strikes by itself, once every COMBAT_PERIOD: `damage` off a
 *   building, or a kill roll against a unit as a unit of level `skill` would
 *   strike (the level it fights at; damage is set apart from it), at the
 *   nearest enemy within `reach` cells.
 */

/** @type {Record<string, BuildingType>} */
export const BUILDING_TYPES = {
  castle: {
    name: 'Castle', size: 7, capacity: 40, perGrade: 10, grades: 3, hp: 2000, build: false, cost: 0, upgrade: 200, reach: 1, life: true,
    skill: 'breeding', work: 24000, yields: 'unit', idleWork: 10, raise: 36000,
  },
  tower: {
    name: 'Tower', size: 1, capacity: 20, grades: 3, hp: 500, build: true, cost: 60, upgrade: 60, reach: 2, skill: 'ranged', extra: 'melee',
    raise: 12000,
  },
  wagon: {
    // Upgrades armour it: each adds 500 hit points (three times) and no room.
    name: 'Wagon', size: 1, capacity: 15, perGrade: 0, grades: 4, hp: 300, hpPerGrade: 500, build: true, cost: 0, metal: 15, nearCastle: true,
    upgradeMetal: 50, skill: 'ranged', extra: 'melee', speed: 2 * TICKS_PER_SECOND, raise: 9000,
  },
  pit: {
    name: 'Pit', size: 1, capacity: 8, grades: 1, hp: 250, build: true, cost: 0, hunger: 1,
    skill: 'build', work: 9600, yields: 'stone', perDepth: 40, hpPerDepth: 150, depth: 3, through: 0.25, raise: 3000,
  },
  farm: {
    name: 'Farm', size: 1, capacity: 6, grades: 1, hp: 200, build: true, cost: 30,
    skill: 'farming', work: 600, yields: 'food', base: 10, through: 0.5, raise: 6000,
  },
  lair: {
    name: 'Lair', size: 7, capacity: 0, grades: 1, hp: 36000, build: false, cost: 0,
    skill: 'melee', life: true, attack: { damage: 40, skill: 60, reach: 4 }, scales: true,
  },
  raider: {
    name: 'Raider', size: 1, capacity: 0, grades: 1, hp: 500, build: false, cost: 0,
    skill: 'melee', speed: 3 * TICKS_PER_SECOND, attack: { damage: 20, skill: 20, reach: 2 }, loot: 10,
  },
  ghoul: {
    name: 'Ghoul', size: 1, capacity: 0, grades: 1, hp: 1200, build: false, cost: 0,
    skill: 'melee', speed: TICKS_PER_SECOND, attack: { damage: 12, skill: 10, reach: 1 }, loot: 2, hunts: true, scales: true,
  },
  ogre: {
    name: 'Ogre', size: 1, capacity: 0, grades: 1, hp: 6000, build: false, cost: 0,
    skill: 'melee', speed: 4 * TICKS_PER_SECOND, attack: { damage: 50, skill: 35, reach: 1 }, loot: 6, hunts: true, scales: true,
  },
  band: {
    name: 'Band', size: 1, capacity: 80, ticked: 30, grades: 1, hp: 0, build: true, cost: 0,
    skill: 'ranged', extra: 'melee', speed: WALK_TICKS, band: true,
  },
};
