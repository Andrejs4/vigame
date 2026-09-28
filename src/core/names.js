/**
 * Medieval names for units. Pure: the dice come from the caller, so a game
 * names its units the same way in every replay.
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
