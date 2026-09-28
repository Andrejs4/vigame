/**
 * The login page: a name and the answer to the server's sum. It signs this
 * browser's token in, or gives it a new name.
 */

import { PLAYER_NAME_MAX, cleanPlayerName } from '../core/player.js';
import { getJson, post, reason, saveName, savedName } from './api.js';

/**
 * Show the login page until the server accepts a name and an answer.
 * @param {string} token
 * @returns {Promise<import('./api.js').Player>}
 */
export function showLogin(token) {
  const page = /** @type {HTMLElement} */ (document.getElementById('login'));
  const form = /** @type {HTMLFormElement} */ (page.querySelector('form'));
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('login-name'));
  const answerInput = /** @type {HTMLInputElement} */ (document.getElementById('login-answer'));
  const question = /** @type {HTMLElement} */ (document.getElementById('login-question'));
  const error = /** @type {HTMLElement} */ (document.getElementById('login-error'));
  const submit = /** @type {HTMLButtonElement} */ (document.getElementById('login-submit'));

  /** The challenge on screen, or null while there is none. */
  /** @type {string | null} */
  let challenge = null;

  async function newQuestion() {
    challenge = null;
    answerInput.value = '';
    question.textContent = 'Loading the question…';
    try {
      const next = await getJson('api/challenge');
      challenge = String(next.id);
      question.textContent = `What is ${next.question}?`;
    } catch {
      question.textContent = 'Could not load the question. Press Play to try again.';
    }
  }

  nameInput.value = savedName();
  error.textContent = '';
  page.hidden = false;
  newQuestion();
  (nameInput.value ? answerInput : nameInput).focus();

  return new Promise((resolve) => {
    const done = new AbortController();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      const name = cleanPlayerName(nameInput.value);
      if (!name) {
        error.textContent = `Use 1–${PLAYER_NAME_MAX} letters or digits. Spaces and - _ . ' may go between them.`;
        nameInput.focus();
        return;
      }
      if (!challenge) {
        await newQuestion();
        return;
      }
      submit.disabled = true;
      error.textContent = '';
      try {
        const res = await post('api/players', { token, name, challenge, answer: answerInput.value.trim() });
        if (res.ok) {
          const player = await res.json();
          saveName(player.name);
          done.abort();
          page.hidden = true;
          resolve(player);
          return;
        }
        const why = await reason(res);
        error.textContent = why === 'wrong answer' ? 'That’s not it. Try this one.' : `The server said no (${why}).`;
      } catch {
        error.textContent = 'Could not reach the game server.';
      } finally {
        submit.disabled = false;
      }
      // Every answer, right or wrong, uses its sum up.
      await newQuestion();
      answerInput.focus();
    }, { signal: done.signal });
  });
}
