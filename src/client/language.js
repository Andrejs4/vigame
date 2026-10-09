/**
 * The page's language: the one the player chose, or for Auto, the one their
 * browser and name suggest. The words themselves are in words.js.
 */

/** The languages the page offers, each by its own name. */
export const LANGUAGE_NAMES = { en: 'English', ru: 'Русский', lv: 'Latviešu', fi: 'Suomi' };

/** @typedef {keyof typeof LANGUAGE_NAMES} PageLanguage */

/**
 * The first of the browser's languages that the page has, if any.
 * @param {readonly string[]} browser
 * @returns {PageLanguage | null}
 */
function fromBrowser(browser) {
  for (const tag of browser) {
    const code = String(tag).toLowerCase().split('-')[0];
    if (Object.hasOwn(LANGUAGE_NAMES, code)) return /** @type {PageLanguage} */ (code);
  }
  return null;
}

/**
 * Letters only one of the page's languages has, and that language: Cyrillic
 * for Russian, the Latvian long vowels and soft consonants, the Finnish
 * ä, ö and å.
 */
const NAME_LETTERS = /** @type {Array<[RegExp, PageLanguage]>} */ ([
  [/\p{Script=Cyrillic}/u, 'ru'],
  [/[āčēģīķļņšūž]/iu, 'lv'],
  [/[äöå]/iu, 'fi'],
]);

/**
 * The language a name's letters suggest: that of the last letter in it
 * only one language has (in "Jānis Ёлкин" Russian, in "Ёлкин Jānis"
 * Latvian), or none.
 * @param {string} name
 * @returns {PageLanguage | null}
 */
function fromName(name) {
  for (const letter of [...name].reverse()) {
    const found = NAME_LETTERS.find(([letters]) => letters.test(letter));
    if (found) return found[1];
  }
  return null;
}

/**
 * The language Auto stands for, on the login page as the name is typed and
 * once signed in: the one the name's letters suggest (`fromName`); else the
 * first of the browser's languages that the page has; else English.
 * @param {readonly string[]} browser The browser's languages, most wanted
 *   first, as tags such as 'ru-RU' (`navigator.languages`).
 * @param {string} [name] The player's name.
 * @returns {PageLanguage}
 */
export function autoLanguage(browser, name = '') {
  return fromName(name) ?? fromBrowser(browser) ?? 'en';
}

/** This browser's languages, most wanted first. */
export function browserLanguages() {
  return navigator.languages?.length ? navigator.languages : [navigator.language ?? ''];
}

/**
 * The page's language for a setting: the language chosen, or for Auto, what
 * Auto stands for on that page.
 * @param {string} setting 'auto', or a language.
 * @param {PageLanguage} auto
 * @returns {PageLanguage}
 */
export function chosenLanguage(setting, auto) {
  return Object.hasOwn(LANGUAGE_NAMES, setting) ? /** @type {PageLanguage} */ (setting) : auto;
}

/**
 * The standard Russian keyboard (ЙЦУКЕН): the Cyrillic letter on each key,
 * by the Latin letter or sign on the same key.
 */
export const RUSSIAN_KEYS = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю', '`': 'ё',
};

/** The Latin sign on each key that isn't a letter, by its `KeyboardEvent.code`. */
const SIGN_KEYS = { BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Backquote: '`' };

/**
 * What a key press can stand for, lower case, the likeliest first: the
 * character typed, then the Latin and the Cyrillic letter on the same key of
 * a standard keyboard. So a game key works whichever layout is on: Б (the
 * comma key) with the keyboard set to English, T where it types "е".
 * @param {{ key: string, code: string }} e A keyboard event.
 * @returns {string[]}
 */
export function keyCandidates(e) {
  const latin = /^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase() ?? SIGN_KEYS[/** @type {keyof typeof SIGN_KEYS} */ (e.code)];
  const russian = latin ? RUSSIAN_KEYS[/** @type {keyof typeof RUSSIAN_KEYS} */ (latin)] : undefined;
  return [...new Set([e.key.toLowerCase(), latin, russian])].filter((k) => k !== undefined);
}
