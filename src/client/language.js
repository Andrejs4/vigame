/**
 * The page's language: the one the player chose, or for Auto, the one their
 * browser and name suggest. The words themselves are in words.js.
 */

/** The languages the page offers, each by its own name. */
export const LANGUAGE_NAMES = { en: 'English', ru: 'Русский' };

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
