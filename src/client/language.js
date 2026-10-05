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
 * Russian for a name with Cyrillic letters.
 * @param {string} name
 * @returns {PageLanguage | null}
 */
function fromName(name) {
  return /\p{Script=Cyrillic}/u.test(name) ? 'ru' : null;
}

/**
 * The language Auto stands for once the player has signed in: Russian for a
 * name in Cyrillic letters; else the first of the browser's languages that
 * the page has; else English.
 * @param {readonly string[]} browser The browser's languages, most wanted
 *   first, as tags such as 'ru-RU' (`navigator.languages`).
 * @param {string} [name] The player's name.
 * @returns {PageLanguage}
 */
export function autoLanguage(browser, name = '') {
  return fromName(name) ?? fromBrowser(browser) ?? 'en';
}

/**
 * The language Auto stands for on the login page: the browser comes first,
 * then the name being typed, then English.
 * @param {readonly string[]} browser As for `autoLanguage`.
 * @param {string} [name]
 * @returns {PageLanguage}
 */
export function loginLanguage(browser, name = '') {
  return fromBrowser(browser) ?? fromName(name) ?? 'en';
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
