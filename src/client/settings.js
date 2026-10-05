/**
 * The settings page (`?settings`): the player's name and language. Saving
 * goes back to the lobby.
 */

import { PLAYER_NAME_MAX, cleanPlayerName } from '../core/player.js';
import { post, reason, saveName, serverBase } from './api.js';
import { showAutoLanguage } from './language.js';

/**
 * Show the settings page. It stays up until the player saves or goes back,
 * both of which load the lobby.
 * @param {string} token
 * @param {import('./api.js').Me} me
 */
export function showSettings(token, me) {
  const page = /** @type {HTMLElement} */ (document.getElementById('settings'));
  const form = /** @type {HTMLFormElement} */ (page.querySelector('form'));
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('settings-name'));
  const languageSelect = /** @type {HTMLSelectElement} */ (document.getElementById('settings-language'));
  const error = /** @type {HTMLElement} */ (document.getElementById('settings-error'));
  const save = /** @type {HTMLButtonElement} */ (document.getElementById('settings-save'));

  nameInput.value = me.name;
  languageSelect.value = me.language;
  showAutoLanguage(languageSelect, nameInput);
  error.textContent = '';
  page.hidden = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const name = cleanPlayerName(nameInput.value);
    if (!name) {
      error.textContent = `Use 1–${PLAYER_NAME_MAX} letters or digits. Spaces and - _ . ' may go between them.`;
      nameInput.focus();
      return;
    }
    save.disabled = true;
    error.textContent = '';
    try {
      const res = await post('api/settings', { token, name, language: languageSelect.value });
      if (res.ok) {
        saveName((await res.json()).name);
        location.href = serverBase().pathname;
        return;
      }
      error.textContent = `The server said no (${await reason(res)}).`;
    } catch {
      error.textContent = 'Could not reach the game server.';
    }
    save.disabled = false;
  });
}
