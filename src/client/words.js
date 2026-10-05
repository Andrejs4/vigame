/**
 * The page's words in each language: so far the login page's and the
 * settings page's. Each is about as long as the English, so the page keeps
 * its shape; `{…}` is filled in.
 */

export const WORDS = {
  en: {
    // The login page and the settings page.
    name: 'Your name',
    namePlaceholder: 'Visible name ({max})',
    language: 'Language',
    auto: 'Auto',
    badName: 'Use 1–{max} letters or digits. Spaces and - _ . \' may go between them.',
    refused: 'The server said no ({why}).',
    offline: 'Could not reach the game server.',
    // The login page.
    play: 'Play',
    loading: 'Loading the question…',
    question: 'What is {sum}?',
    noQuestion: 'Could not load the question. Press Play to try again.',
    wrongAnswer: 'That’s not it. Try this one.',
    // The settings page.
    settings: 'Settings',
    back: 'Back',
    save: 'Save',
  },
  ru: {
    name: 'Ваше имя',
    namePlaceholder: 'Имя в игре ({max})',
    language: 'Язык',
    auto: 'Авто',
    badName: 'От 1 до {max} букв или цифр. Между ними можно пробел и - _ . \'',
    refused: 'Сервер отказал ({why}).',
    offline: 'Нет связи с игровым сервером.',
    play: 'Играть',
    loading: 'Загружаем вопрос…',
    question: 'Сколько будет {sum}?',
    noQuestion: 'Вопрос не загрузился. Нажмите «Играть» ещё раз.',
    wrongAnswer: 'Неверно. Вот другой пример.',
    settings: 'Настройки',
    back: 'Назад',
    save: 'Сохранить',
  },
};

/** @typedef {keyof typeof WORDS.en} Word */
/** @typedef {{ word: Word, values?: Record<string, string | number> }} Said A text to show, and what fills it in. */

/**
 * A text with its `{placeholders}` filled in; one with no value stays as it is.
 * @param {string} text
 * @param {Record<string, string | number>} [values]
 */
export function fill(text, values = {}) {
  return text.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));
}

/**
 * A text in a language.
 * @param {import('./language.js').PageLanguage} language
 * @param {Said} said
 */
export function say(language, { word, values }) {
  return fill(WORDS[language][word], values);
}
