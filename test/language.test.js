import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LANGUAGE_NAMES, autoLanguage } from '../src/client/language.js';
import { LANGUAGES } from '../src/core/player.js';

test('the page offers each language a player may choose, by its own name', () => {
  assert.deepEqual(Object.keys(LANGUAGE_NAMES), LANGUAGES.filter((l) => l !== 'auto'));
  assert.deepEqual(LANGUAGE_NAMES, { en: 'English', ru: 'Русский' });
});

test('Auto: Russian for a name in Cyrillic letters, whatever the browser says', () => {
  assert.equal(autoLanguage(['en-US', 'en'], 'Анна'), 'ru');
  assert.equal(autoLanguage([], 'Jānis Ёлкин'), 'ru', 'one Cyrillic letter is enough');
  assert.equal(autoLanguage(['de'], 'Иван 2'), 'ru');
});

test('Auto: else the first of the browser\'s languages the page has', () => {
  // The registration page, before a name is typed.
  assert.equal(autoLanguage(['ru-RU', 'ru', 'en-US', 'en']), 'ru');
  assert.equal(autoLanguage(['lv', 'ru', 'en'], ''), 'ru');
  assert.equal(autoLanguage(['lv', 'en-GB', 'ru'], 'Jānis'), 'en');
  assert.equal(autoLanguage(['RU'], 'Ann'), 'ru', 'tags in any case');
});

test('Auto: else English', () => {
  assert.equal(autoLanguage([]), 'en');
  assert.equal(autoLanguage(['de-DE', 'fr'], 'Ann'), 'en');
  assert.equal(autoLanguage([''], '李小龍'), 'en');
  assert.equal(autoLanguage(['uk'], 'Ann'), 'en');
});
