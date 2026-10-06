import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LANGUAGE_NAMES, RUSSIAN_KEYS, autoLanguage, chosenLanguage, keyCandidates, loginLanguage } from '../src/client/language.js';
import { WORDS, fill, say, shortPoints } from '../src/client/words.js';
import { TERRAIN } from '../src/core/board.js';
import { LANGUAGES } from '../src/core/player.js';
import { BUILDING_TYPES, SIDES, SKILLS } from '../src/core/rules.js';

test('the page offers each language a player may choose, by its own name', () => {
  assert.deepEqual(Object.keys(LANGUAGE_NAMES), LANGUAGES.filter((l) => l !== 'auto'));
  assert.deepEqual(LANGUAGE_NAMES, { en: 'English', ru: 'Русский', lv: 'Latviešu', fi: 'Suomi' });
});

test('Auto, once signed in: Russian for a name in Cyrillic letters, whatever the browser says', () => {
  assert.equal(autoLanguage(['en-US', 'en'], 'Анна'), 'ru');
  assert.equal(autoLanguage([], 'Jānis Ёлкин'), 'ru', 'one Cyrillic letter is enough');
  assert.equal(autoLanguage(['de'], 'Иван 2'), 'ru');
});

test('Auto, once signed in: else the first of the browser\'s languages the page has', () => {
  assert.equal(autoLanguage(['ru-RU', 'ru', 'en-US', 'en']), 'ru');
  assert.equal(autoLanguage(['de', 'ru', 'en'], ''), 'ru');
  assert.equal(autoLanguage(['de', 'en-GB', 'ru'], 'Jānis'), 'en');
  assert.equal(autoLanguage(['lv', 'ru', 'en'], 'Jānis'), 'lv');
  assert.equal(autoLanguage(['fi-FI', 'sv'], 'Aino'), 'fi');
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
  assert.equal(loginLanguage(['de', 'ru', 'en'], ''), 'ru');
  assert.equal(loginLanguage(['lv', 'ru', 'en'], 'Анна'), 'lv');
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

test('a key press stands for the character typed, then the Latin and the Russian letter on its key', () => {
  assert.deepEqual(keyCandidates({ key: 't', code: 'KeyT' }), ['t', 'е']);
  assert.deepEqual(keyCandidates({ key: 'T', code: 'KeyT' }), ['t', 'е']);
  assert.deepEqual(keyCandidates({ key: 'е', code: 'KeyT' }), ['е', 't'], 'keyboard set to Russian');
  assert.deepEqual(keyCandidates({ key: 'б', code: 'Comma' }), ['б', ',']);
  assert.deepEqual(keyCandidates({ key: ',', code: 'Comma' }), [',', 'б'], 'Б on a keyboard set to English');
  assert.deepEqual(keyCandidates({ key: 'a', code: 'KeyQ' }), ['a', 'q', 'й'], 'AZERTY: the letter typed first');
  assert.deepEqual(keyCandidates({ key: 'Enter', code: 'Enter' }), ['enter']);
});

test('each button\'s key is a letter of its label, on a key of its own; English keys work in Russian too', () => {
  const buttons = Object.keys(WORDS.en).filter((w) => /^key[A-Z]/.test(w));
  assert.equal(buttons.length, 9);
  /** @param {string} w keyTower */
  const labelOf = (w) => /** @type {keyof typeof WORDS.en} */ (w[3].toLowerCase() + w.slice(4));
  for (const [language, words] of Object.entries(WORDS)) {
    const keys = buttons.map((w) => String(words[/** @type {keyof typeof WORDS.en} */ (w)]).toLowerCase());
    assert.equal(new Set(keys).size, keys.length, `${language}: two buttons share a key`);
    buttons.forEach((w, i) => assert.ok(String(words[labelOf(w)]).toLowerCase().includes(keys[i]), `${language}.${w} is not in its label`));
  }
  // A key sits where its button's English key is, or on a key the English
  // ones leave free: a Russian letter on its ЙЦУКЕН key, a Latin one on its
  // own (Latvian and Finnish keyboards have them where English ones do).
  const keyOf = Object.fromEntries(Object.entries(RUSSIAN_KEYS).map(([latin, russian]) => [russian, latin]));
  const english = Object.fromEntries(buttons.map((w) => [String(WORDS.en[/** @type {keyof typeof WORDS.en} */ (w)]).toLowerCase(), w]));
  for (const [language, words] of Object.entries(WORDS)) {
    for (const w of buttons) {
      const key = String(words[/** @type {keyof typeof WORDS.en} */ (w)]).toLowerCase();
      const at = /^[a-z]$/.test(key) ? key : keyOf[key];
      assert.ok(at, `${language}.${w} is on no key`);
      assert.ok(!english[at] || english[at] === w, `${language}.${w} sits on ${english[at]}'s English key`);
    }
  }
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
  const waiting = (/** @type {import('../src/client/language.js').PageLanguage} */ language, /** @type {number} */ n) => say(language, { word: 'tooManyWaiting', values: { n } });
  assert.deepEqual([1, 3].map((n) => waiting('en', n)), ['1 game of yours waiting for a player', '3 games of yours waiting for a player']);
  assert.deepEqual([1, 3, 5, 21, 22, 25].map((n) => waiting('ru', n)), [
    '1 ваша ждёт игрока', '3 ваши ждут игрока', '5 ваших ждут игрока',
    '21 ваша ждёт игрока', '22 ваши ждут игрока', '25 ваших ждут игрока',
  ]);
  assert.equal(say('ru', { word: 'tooManySeated', values: { n: 3 } }), 'вы играете в 3 идущих играх');
  assert.deepEqual([1, 3, 10, 21].map((n) => waiting('lv', n)), [
    '1 jūsu spēle gaida spēlētāju', '3 jūsu spēles gaida spēlētāju', '10 jūsu spēles gaida spēlētāju', '21 jūsu spēle gaida spēlētāju',
  ]);
  assert.deepEqual([1, 3].map((n) => waiting('fi', n)), ['1 pelisi odottaa pelaajaa', '3 peliäsi odottaa pelaajaa']);
  assert.equal(say('fi', { word: 'stoneCost', values: { n: 60 } }), '60 kiveä');
});

test('the page\'s texts name words that exist, in their English; How to play and About are in every language', () => {
  const page = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8');
  const named = [...page.matchAll(/<\w+[^>]*\bdata-word="(\w+)"[^>]*>([^<]*)</g)];
  assert.ok(named.some(([, word]) => word === 'newGame'), 'finds the lobby\'s texts');
  for (const [, word, text] of named) {
    assert.ok(Object.hasOwn(WORDS.en, word), `no word "${word}"`);
    assert.equal(text.replace(/\s+/g, ' ').trim(), WORDS.en[/** @type {keyof typeof WORDS.en} */ (word)], word);
  }
  // Tooltips and labels for screen readers, likewise.
  for (const [attribute, named] of [['title', 'data-word-title'], ['aria-label', 'data-word-label']]) {
    const tags = [...page.matchAll(new RegExp(`<\\w+[^>]*\\b${named}="(\\w+)"[^>]*>`, 'g'))];
    assert.ok(tags.length > 0, named);
    for (const [tag, word] of tags) {
      assert.ok(Object.hasOwn(WORDS.en, word), `no word "${word}"`);
      assert.equal(new RegExp(`\\s${attribute}="([^"]*)"`).exec(tag)?.[1], WORDS.en[/** @type {keyof typeof WORDS.en} */ (word)], word);
    }
  }
  for (const id of ['lobby-how-section', 'lobby-about-section']) {
    const section = page.slice(page.indexOf(`id="${id}"`), page.indexOf('</details>', page.indexOf(`id="${id}"`)));
    const blocks = [...section.matchAll(/<div lang="(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(blocks, Object.keys(LANGUAGE_NAMES), id);
  }
});

test('the game\'s panels have a word for every terrain, building type, skill and side', () => {
  const sideKey = (/** @type {string} */ name) => name.replace(/ (\w)/g, (_, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase());
  const skillKey = (/** @type {string} */ skill) => `skill${skill[0].toUpperCase()}${skill.slice(1)}`;
  const keys = [...Object.keys(TERRAIN), ...Object.keys(BUILDING_TYPES), ...Object.keys(SKILLS).map(skillKey), ...SIDES.map((s) => sideKey(s.name))];
  for (const key of keys) assert.ok(Object.hasOwn(WORDS.en, key), `no word "${key}"`);
  assert.equal(say('ru', { word: 'heroesCount', values: { n: 3, total: 12 } }), '3 героя из 12');
  assert.equal(say('ru', { word: 'fallenCount', values: { n: 5 } }), '5 павших');
  assert.equal(say('fi', { word: 'depthLine', values: { n: 1, max: 3, stone: say('fi', { word: 'stoneCost', values: { n: 40 } }) } }), 'syvyys 1/3, 40 kiveä');
});

test('points from 10000 on show rounded to thousands, with a "k"', () => {
  assert.deepEqual([0, 432, 9999, 10000, 10499, 10500, 12345, 999999, 1234567].map(shortPoints),
    ['0', '432', '9999', '10k', '10k', '11k', '12k', '1000k', '1235k']);
});
