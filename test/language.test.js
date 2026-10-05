import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LANGUAGE_NAMES, autoLanguage, chosenLanguage, loginLanguage } from '../src/client/language.js';
import { WORDS, fill, say } from '../src/client/words.js';
import { LANGUAGES } from '../src/core/player.js';

test('the page offers each language a player may choose, by its own name', () => {
  assert.deepEqual(Object.keys(LANGUAGE_NAMES), LANGUAGES.filter((l) => l !== 'auto'));
  assert.deepEqual(LANGUAGE_NAMES, { en: 'English', ru: 'Русский' });
});

test('Auto, once signed in: Russian for a name in Cyrillic letters, whatever the browser says', () => {
  assert.equal(autoLanguage(['en-US', 'en'], 'Анна'), 'ru');
  assert.equal(autoLanguage([], 'Jānis Ёлкин'), 'ru', 'one Cyrillic letter is enough');
  assert.equal(autoLanguage(['de'], 'Иван 2'), 'ru');
});

test('Auto, once signed in: else the first of the browser\'s languages the page has', () => {
  assert.equal(autoLanguage(['ru-RU', 'ru', 'en-US', 'en']), 'ru');
  assert.equal(autoLanguage(['lv', 'ru', 'en'], ''), 'ru');
  assert.equal(autoLanguage(['lv', 'en-GB', 'ru'], 'Jānis'), 'en');
  assert.equal(autoLanguage(['RU'], 'Ann'), 'ru', 'tags in any case');
});

test('Auto, once signed in: else English', () => {
  assert.equal(autoLanguage([]), 'en');
  assert.equal(autoLanguage(['de-DE', 'fr'], 'Ann'), 'en');
  assert.equal(autoLanguage([''], '李小龍'), 'en');
  assert.equal(autoLanguage(['uk'], 'Ann'), 'en');
});

test('Auto on the login page: the browser first, then the name typed, then English', () => {
  assert.equal(loginLanguage(['en-US', 'en'], 'Анна'), 'en');
  assert.equal(loginLanguage(['ru-RU'], 'Ann'), 'ru');
  assert.equal(loginLanguage(['lv', 'ru', 'en'], ''), 'ru');
  assert.equal(loginLanguage(['de'], 'Анна'), 'ru');
  assert.equal(loginLanguage(['de'], 'Ann'), 'en');
  assert.equal(loginLanguage([]), 'en');
});

test('the page is in the language chosen, or for Auto, what Auto stands for there', () => {
  assert.equal(chosenLanguage('ru', 'en'), 'ru');
  assert.equal(chosenLanguage('en', 'ru'), 'en');
  assert.equal(chosenLanguage('auto', 'ru'), 'ru');
  assert.equal(chosenLanguage('toString', 'en'), 'en');
});

test('fill puts values in a text\'s {placeholders}, and leaves one with no value', () => {
  assert.equal(fill('What is {sum}?', { sum: '3 + 4' }), 'What is 3 + 4?');
  assert.equal(fill('Use 1–{max} of {max}', { max: 15 }), 'Use 1–15 of 15');
  assert.equal(fill('{why} {else}', { why: 'no' }), 'no {else}');
  assert.equal(fill('Play'), 'Play');
});

test('every language has every word, with the same {placeholders}, about as long as the English', () => {
  assert.deepEqual(Object.keys(WORDS), Object.keys(LANGUAGE_NAMES));
  const placeholders = (/** @type {string} */ text) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
  /** @param {string | Record<string, string>} entry The text, or the one for many. */
  const plain = (entry) => (typeof entry === 'string' ? entry : entry.other);
  for (const [language, words] of Object.entries(WORDS)) {
    assert.deepEqual(Object.keys(words).sort(), Object.keys(WORDS.en).sort(), language);
    for (const [key, entry] of Object.entries(words)) {
      const english = plain(WORDS.en[/** @type {keyof typeof WORDS.en} */ (key)]);
      // A word with plural forms has one for every plural kind of its language.
      const forms = typeof entry === 'string' ? [entry] : Object.values(entry);
      if (typeof entry !== 'string') {
        assert.deepEqual(Object.keys(entry).sort(), new Intl.PluralRules(language).resolvedOptions().pluralCategories.sort(), `${language}.${key}`);
      }
      for (const text of forms) {
        assert.deepEqual(placeholders(text), placeholders(english), `${language}.${key}`);
        // Half again as long at most, or five letters more for a short word.
        const most = Math.max(Math.ceil(english.length * 1.5), english.length + 5);
        assert.ok(text.length <= most, `${language}.${key} is much longer than the English: ${text}`);
      }
    }
  }
  assert.equal(say('en', { word: 'namePlaceholder', values: { max: 15 } }), 'Visible name (15)');
  assert.equal(say('ru', { word: 'refused', values: { why: 'bad name' } }), 'Сервер отказал (bad name).');
});

test('a word that goes with a count takes the form its language uses for it', () => {
  const waiting = (/** @type {'en' | 'ru'} */ language, /** @type {number} */ n) => say(language, { word: 'tooManyWaiting', values: { n } });
  assert.deepEqual([1, 3].map((n) => waiting('en', n)), ['1 game of yours waiting for a player', '3 games of yours waiting for a player']);
  assert.deepEqual([1, 3, 5, 21, 22, 25].map((n) => waiting('ru', n)), [
    '1 ваша ждёт игрока', '3 ваши ждут игрока', '5 ваших ждут игрока',
    '21 ваша ждёт игрока', '22 ваши ждут игрока', '25 ваших ждут игрока',
  ]);
  assert.equal(say('ru', { word: 'tooManySeated', values: { n: 3 } }), 'вы играете в 3 идущих играх');
});

test('the page\'s texts name words that exist, in their English; How to play and About are in every language', () => {
  const page = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8');
  const named = [...page.matchAll(/<\w+[^>]*\bdata-word="(\w+)"[^>]*>([^<]*)</g)];
  assert.ok(named.some(([, word]) => word === 'newGame'), 'finds the lobby\'s texts');
  for (const [, word, text] of named) {
    assert.ok(Object.hasOwn(WORDS.en, word), `no word "${word}"`);
    assert.equal(text.replace(/\s+/g, ' ').trim(), WORDS.en[/** @type {keyof typeof WORDS.en} */ (word)], word);
  }
  for (const id of ['lobby-how-section', 'lobby-about-section']) {
    const section = page.slice(page.indexOf(`id="${id}"`), page.indexOf('</details>', page.indexOf(`id="${id}"`)));
    const blocks = [...section.matchAll(/<div lang="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(blocks, Object.keys(LANGUAGE_NAMES), id);
  }
});
