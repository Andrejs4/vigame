/**
 * The login page: a name, a language, and the answer to the server's sum.
 * It signs this browser's token in as a new player. The settings page
 * changes the name and language later.
 *
 * It is the one page translated so far: it shows in the language chosen on
 * it, or for Auto, the browser's (`loginLanguage`), and turns as soon as the
 * choice does.
 */

import { PLAYER_NAME_MAX, cleanPlayerName } from '../core/player.js';
import { getJson, post, reason, saveName, savedName } from './api.js';
import { LANGUAGE_NAMES, browserLanguages, fill, loginLanguage } from './language.js';

/**
 * The login page's words in each language, each about as long as the
 * English, so the page keeps its shape. `{…}` is filled in.
 */
export const LOGIN_WORDS = {
  en: {
    name: 'Your name',
    namePlaceholder: 'Visible name ({max})',
    language: 'Language',
    auto: 'Auto',
    play: 'Play',
    loading: 'Loading the question…',
    question: 'What is {sum}?',
    noQuestion: 'Could not load the question. Press Play to try again.',
    badName: 'Use 1–{max} letters or digits. Spaces and - _ . \' may go between them.',
    wrongAnswer: 'That’s not it. Try this one.',
    refused: 'The server said no ({why}).',
    offline: 'Could not reach the game server.',
  },
  ru: {
    name: 'Ваше имя',
    namePlaceholder: 'Имя в игре ({max})',
    language: 'Язык',
    auto: 'Авто',
    play: 'Играть',
    loading: 'Загружаем вопрос…',
    question: 'Сколько будет {sum}?',
    noQuestion: 'Вопрос не загрузился. Нажмите «Играть» ещё раз.',
    badName: 'От 1 до {max} букв или цифр. Между ними можно пробел и - _ . \'',
    wrongAnswer: 'Неверно. Вот другой пример.',
    refused: 'Сервер отказал ({why}).',
    offline: 'Нет связи с игровым сервером.',
  },
};

/** @typedef {keyof typeof LOGIN_WORDS.en} LoginWord */
/** @typedef {{ word: LoginWord, values?: Record<string, string | number> }} Said */

/**
 * Show the login page until the server accepts a name and an answer.
 * @param {string} token
 * @returns {Promise<import('./api.js').Me>}
 */
export function showLogin(token) {
  const page = /** @type {HTMLElement} */ (document.getElementById('login'));
  const form = /** @type {HTMLFormElement} */ (page.querySelector('form'));
  const nameLabel = /** @type {HTMLElement} */ (document.getElementById('login-name-label'));
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('login-name'));
  const languageLabel = /** @type {HTMLElement} */ (document.getElementById('login-language-label'));
  const languageSelect = /** @type {HTMLSelectElement} */ (document.getElementById('login-language'));
  const autoOption = /** @type {HTMLOptionElement} */ (languageSelect.querySelector('option[value="auto"]'));
  const answerInput = /** @type {HTMLInputElement} */ (document.getElementById('login-answer'));
  const question = /** @type {HTMLElement} */ (document.getElementById('login-question'));
  const error = /** @type {HTMLElement} */ (document.getElementById('login-error'));
  const submit = /** @type {HTMLButtonElement} */ (document.getElementById('login-submit'));
  // The rest of the page isn't translated: it gets its language back after.
  const pageLanguage = document.documentElement.lang;

  /** The challenge on screen, or null while there is none. */
  /** @type {string | null} */
  let challenge = null;
  /** What the question line says. */
  /** @type {Said} */
  let asked = { word: 'loading' };
  /** What the error line says, if anything. */
  /** @type {Said | null} */
  let problem = null;

  /** Every text on the page, in the language chosen, or for Auto, the browser's. */
  function show() {
    const auto = loginLanguage(browserLanguages(), nameInput.value);
    const chosen = languageSelect.value;
    const language = chosen === 'en' || chosen === 'ru' ? chosen : auto;
    const words = LOGIN_WORDS[language];
    const say = (/** @type {Said} */ { word, values }) => fill(words[word], values);
    document.documentElement.lang = language;
    nameLabel.textContent = words.name;
    nameInput.placeholder = say({ word: 'namePlaceholder', values: { max: PLAYER_NAME_MAX } });
    languageLabel.textContent = words.language;
    autoOption.textContent = `${words.auto} (${LANGUAGE_NAMES[auto]})`;
    submit.textContent = words.play;
    question.textContent = say(asked);
    error.textContent = problem ? say(problem) : '';
  }

  /** @param {Said | null} said */
  function sayProblem(said) {
    problem = said;
    show();
  }

  async function newQuestion() {
    challenge = null;
    answerInput.value = '';
    asked = { word: 'loading' };
    show();
    try {
      const next = await getJson('api/challenge');
      challenge = String(next.id);
      asked = { word: 'question', values: { sum: next.question } };
    } catch {
      asked = { word: 'noQuestion' };
    }
    show();
  }

  nameInput.value = savedName();
  show();
  page.hidden = false;
  newQuestion();
  (nameInput.value ? answerInput : nameInput).focus();

  return new Promise((resolve) => {
    const done = new AbortController();
    nameInput.addEventListener('input', show, { signal: done.signal });
    languageSelect.addEventListener('change', show, { signal: done.signal });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      const name = cleanPlayerName(nameInput.value);
      if (!name) {
        sayProblem({ word: 'badName', values: { max: PLAYER_NAME_MAX } });
        nameInput.focus();
        return;
      }
      if (!challenge) {
        await newQuestion();
        return;
      }
      submit.disabled = true;
      sayProblem(null);
      try {
        const res = await post('api/players', {
          token, name, language: languageSelect.value, challenge, answer: answerInput.value.trim(),
        });
        if (res.ok) {
          const player = await res.json();
          saveName(player.name);
          done.abort();
          page.hidden = true;
          document.documentElement.lang = pageLanguage;
          resolve(player);
          return;
        }
        const why = await reason(res);
        sayProblem(why === 'wrong answer' ? { word: 'wrongAnswer' } : { word: 'refused', values: { why } });
      } catch {
        sayProblem({ word: 'offline' });
      } finally {
        submit.disabled = false;
      }
      // Every answer, right or wrong, uses its sum up.
      await newQuestion();
      answerInput.focus();
    }, { signal: done.signal });
  });
}
