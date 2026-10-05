/**
 * The page's language: the one the player chose in their settings, or for
 * Auto, the one their name and browser suggest. Nothing is translated yet:
 * the choice is kept, and Auto says which language it would pick.
 */

/** The languages the page offers, each by its own name. */
export const LANGUAGE_NAMES = { en: 'English', ru: 'Русский' };

/** @typedef {keyof typeof LANGUAGE_NAMES} PageLanguage */

/**
 * The language Auto stands for: Russian for a name in Cyrillic letters; else
 * the first of the browser's languages that the page has; else English. On
 * the registration page, before a name is typed, only the browser counts.
 * @param {readonly string[]} browser The browser's languages, most wanted
 *   first, as tags such as 'ru-RU' (`navigator.languages`).
 * @param {string} [name] The player's name.
 * @returns {PageLanguage}
 */
export function autoLanguage(browser, name = '') {
  if (/\p{Script=Cyrillic}/u.test(name)) return 'ru';
  for (const tag of browser) {
    const code = String(tag).toLowerCase().split('-')[0];
    if (Object.hasOwn(LANGUAGE_NAMES, code)) return /** @type {PageLanguage} */ (code);
  }
  return 'en';
}

/** This browser's languages, most wanted first. */
function browserLanguages() {
  return navigator.languages?.length ? navigator.languages : [navigator.language ?? ''];
}

/**
 * A language chooser (Auto, then each language), whose Auto option says
 * which language it stands for, following the name typed beside it.
 * @param {HTMLSelectElement} select
 * @param {HTMLInputElement} nameInput
 * @param {AbortSignal} [signal] Ends the following.
 */
export function showAutoLanguage(select, nameInput, signal) {
  const auto = /** @type {HTMLOptionElement} */ (select.querySelector('option[value="auto"]'));
  const update = () => {
    auto.textContent = `Auto (${LANGUAGE_NAMES[autoLanguage(browserLanguages(), nameInput.value)]})`;
  };
  nameInput.addEventListener('input', update, { signal });
  update();
}
