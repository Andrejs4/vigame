/**
 * Medieval names for units, and names that set a new game's mood. Pure: the
 * dice come from the caller, so a game names its units the same way in
 * every replay.
 */

const FIRST = [
  'Adela', 'Agnes', 'Alaric', 'Aldith', 'Amice', 'Ansel', 'Aveline', 'Baldwin',
  'Beatrice', 'Bertram', 'Cecily', 'Cedric', 'Clarice', 'Drogo', 'Edith', 'Edmund',
  'Elias', 'Elspeth', 'Emeric', 'Emma', 'Everard', 'Fulk', 'Geoffrey', 'Gervase',
  'Gisela', 'Godfrey', 'Guy', 'Hawise', 'Helewise', 'Hugh', 'Idonea', 'Isolde',
  'Ivo', 'Joan', 'Jocelyn', 'Lambert', 'Leofric', 'Mabel', 'Matilda', 'Maud',
  'Nigel', 'Odo', 'Osric', 'Oswin', 'Petronilla', 'Ralph', 'Reynard', 'Rohese',
  'Rowena', 'Sibyl', 'Simon', 'Thurstan', 'Tiphaine', 'Walter', 'Warin', 'Wymond',
];

const LAST = [
  'Ashdown', 'Atwood', 'Baker', 'Barker', 'Blackwood', 'Brewer', 'Bywater', 'Carter',
  'Chandler', 'Cooper', 'Crowther', 'Draper', 'Dyer', 'Fairweather', 'Fletcher', 'Fowler',
  'Fuller', 'Gage', 'Hayward', 'Holloway', 'Hawthorne', 'Mason', 'Marsh', 'Miller',
  'Pike', 'Reeve', 'Redgrave', 'Sawyer', 'Shepherd', 'Smith', 'Stone', 'Tanner',
  'Thatcher', 'Thornbury', 'Underhill', 'Warrener', 'Webb', 'Woodward', 'Wright', 'Yeoman',
];

/**
 * A "First Last" name.
 * @param {() => number} roll Dice: a number in [0, 1) each call.
 */
export function unitName(roll) {
  const first = FIRST[Math.floor(roll() * FIRST.length)];
  const last = LAST[Math.floor(roll() * LAST.length)];
  return `${first} ${last}`;
}

/**
 * The first names whose faces are on the women's sheet of portraits; the
 * rest are on the men's (Jocelyn was a man's name then).
 */
const WOMEN = [
  'Adela', 'Agnes', 'Aldith', 'Amice', 'Aveline', 'Beatrice', 'Cecily', 'Clarice',
  'Edith', 'Elspeth', 'Emma', 'Gisela', 'Hawise', 'Helewise', 'Idonea', 'Isolde',
  'Joan', 'Mabel', 'Matilda', 'Maud', 'Petronilla', 'Rohese', 'Rowena', 'Sibyl',
  'Tiphaine',
];

/** Each sheet's first names, in FIRST's order. */
const SHEET_NAMES = {
  men: FIRST.filter((name) => !WOMEN.includes(name)),
  women: FIRST.filter((name) => WOMEN.includes(name)),
};

/** A sheet of portraits is this many faces a side: 8 × 8, 64 a sheet. */
export const PORTRAIT_SIDE = 8;

/**
 * A name's portrait: the sheet, men's or women's by the first name, and the
 * face's number on it, from 0 at the top left, row by row. The surname picks
 * the row and the first name the column, so a name always has the same face
 * and every face on a sheet is someone's. Null for a name unitName can't
 * make.
 * @param {string} name
 * @returns {{ sheet: 'men' | 'women', face: number } | null}
 */
export function portraitOf(name) {
  const [first, last, ...more] = name.split(' ');
  const sheet = WOMEN.includes(first) ? 'women' : 'men';
  const column = SHEET_NAMES[sheet].indexOf(first);
  const row = LAST.indexOf(last);
  if (more.length || column < 0 || row < 0) return null;
  return { sheet, face: (row % PORTRAIT_SIDE) * PORTRAIT_SIDE + (column % PORTRAIT_SIDE) };
}

/**
 * The names a new game may start with, to set its mood; its players may
 * rename it. Each is a valid game name (cleanGameName in player.js).
 */
export const GAME_NAMES = [
  'Beautiful walk', 'Hangout', 'Pit party', 'Last stand', 'Rush', 'Western',
  'Tank wars', 'Two towers', 'Zebra', 'Massacre', 'Traveler', 'Lemming fights',
  'Blockage', 'Breeze',
  'Picnic', 'Tea time', 'Stone soup', 'Rock bottom', 'Big dig', 'Mud fight',
  'Food fight', 'Pillow fight', 'Barn dance', 'Housewarming', 'Family feud',
  'Land grab', 'Traffic jam', 'Bottleneck', 'Detour', 'Road trip', 'Dead end',
  'High noon', 'Standoff', 'Tumbleweed', 'Stone rush', 'Rush hour',
  'Ogre parade', 'Ogre ballet', 'Wagon wheels', 'Wagon race', 'Night watch',
  'Long night', 'Quiet evening', 'Sunday stroll', 'Rainy day', 'Harvest moon',
  'Hide and seek', 'Tug of war', 'Holdout', 'Ambush', 'Skirmish', 'Mayhem',
  'Bedlam', 'Crowd control', 'Wild goose chase', 'Home sweet home',
  'Welcome party', 'Grand opening', 'Ghost town', 'Crop circles',
  "Farmers' market", 'Dust bowl', 'Slow burn', 'Last orders', 'Happy hour',
  'Pitfall', 'Marathon', 'Stampede', 'Sitting ducks', 'Early birds',
  'Snail race', 'Cabin fever', "Fool's errand", 'Hold the line',
];

/**
 * A new game's name, from its map's seed, so a replay names it the same.
 * @param {number} seed
 */
export function gameName(seed) {
  return GAME_NAMES[(seed >>> 0) % GAME_NAMES.length];
}
