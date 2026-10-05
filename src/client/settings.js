/**
 * The settings page (`?settings`): the player's name and language. Saving
 * goes back to the lobby.
 *
 * It shows in the language chosen on it, or for Auto, the one Auto stands
 * for once signed in (`autoLanguage`), and turns as soon as either changes.
 */

import { PLAYER_NAME_MAX, cleanPlayerName } from '../core/player.js';
import { post, reason, saveName, serverBase } from './api.js';
import { LANGUAGE_NAMES, autoLanguage, browserLanguages, chosenLanguage } from './language.js';
import { WORDS, say } from './words.js';

/**
 * Show the settings page. It stays up until the player saves or goes back,
 * both of which load the lobby.
 * @param {string} token
 * @param {import('./api.js').Me} me
 */
export function showSettings(token, me) {
  const page = /** @type {HTMLElement} */ (document.getElementById('settings'));
  const form = /** @type {HTMLFormElement} */ (page.querySelector('form'));
  const title = /** @type {HTMLElement} */ (document.getElementById('settings-title'));
  const nameLabel = /** @type {HTMLElement} */ (document.getElementById('settings-name-label'));
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('settings-name'));
  const languageLabel = /** @type {HTMLElement} */ (document.getElementById('settings-language-label'));
  const languageSelect = /** @type {HTMLSelectElement} */ (document.getElementById('settings-language'));
  const autoOption = /** @type {HTMLOptionElement} */ (languageSelect.querySelector('option[value="auto"]'));
  const error = /** @type {HTMLElement} */ (document.getElementById('settings-error'));
  const back = /** @type {HTMLElement} */ (document.getElementById('settings-back'));
  const save = /** @type {HTMLButtonElement} */ (document.getElementById('settings-save'));

  /** What the error line says, if anything. */
  /** @type {import('./words.js').Said | null} */
  let problem = null;

  /** Every text on the page, in the language chosen, or what Auto stands for. */
  function show() {
    const auto = autoLanguage(browserLanguages(), nameInput.value);
    const language = chosenLanguage(languageSelect.value, auto);
    const words = WORDS[language];
    document.documentElement.lang = language;
    title.textContent = words.settings;
    nameLabel.textContent = words.name;
    nameInput.placeholder = say(language, { word: 'namePlaceholder', values: { max: PLAYER_NAME_MAX } });
    languageLabel.textContent = words.language;
    autoOption.textContent = `${words.auto} (${LANGUAGE_NAMES[auto]})`;
    back.textContent = words.back;
    save.textContent = words.save;
    error.textContent = problem ? say(language, problem) : '';
  }

  /** @param {import('./words.js').Said | null} said */
  function sayProblem(said) {
    problem = said;
    show();
  }

  nameInput.value = me.name;
  languageSelect.value = me.language;
  show();
  page.hidden = false;
  nameInput.addEventListener('input', show);
  languageSelect.addEventListener('change', show);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const name = cleanPlayerName(nameInput.value);
    if (!name) {
      sayProblem({ word: 'badName', values: { max: PLAYER_NAME_MAX } });
      nameInput.focus();
      return;
    }
    save.disabled = true;
    sayProblem(null);
    try {
      const res = await post('api/settings', { token, name, language: languageSelect.value });
      if (res.ok) {
        saveName((await res.json()).name);
        location.href = serverBase().pathname;
        return;
      }
      sayProblem({ word: 'refused', values: { why: await reason(res) } });
    } catch {
      sayProblem({ word: 'offline' });
    }
    save.disabled = false;
  });
}
