import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  for (const [language, words] of Object.entries(WORDS)) {
    assert.deepEqual(Object.keys(words).sort(), Object.keys(WORDS.en).sort(), language);
    for (const [key, text] of Object.entries(words)) {
      const english = WORDS.en[/** @type {keyof typeof WORDS.en} */ (key)];
      assert.deepEqual(placeholders(text), placeholders(english), `${language}.${key}`);
      // Half again as long at most, or five letters more for a short word.
      const most = Math.max(Math.ceil(english.length * 1.5), english.length + 5);
      assert.ok(text.length <= most, `${language}.${key} is much longer than the English`);
    }
  }
  assert.equal(say('en', { word: 'namePlaceholder', values: { max: 15 } }), 'Visible name (15)');
  assert.equal(say('ru', { word: 'refused', values: { why: 'bad name' } }), 'Сервер отказал (bad name).');
});
