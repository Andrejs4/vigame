import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChallenges } from '../server/challenge.js';
import { PLAYER_NAME_MAX, cleanPlayerName } from '../src/core/player.js';

test('player names: letters and digits in any script, up to 15 characters', () => {
  for (const name of ['Ann', 'Jānis', 'Ōtani 2', 'Анна-Мария', '李小龍', 'अनिल', "O'Neil", 'x_y.z', '7']) {
    assert.equal(cleanPlayerName(name), name, name);
  }
  assert.equal(cleanPlayerName('a'.repeat(PLAYER_NAME_MAX)), 'a'.repeat(PLAYER_NAME_MAX));
  assert.equal(cleanPlayerName('李'.repeat(PLAYER_NAME_MAX)), '李'.repeat(PLAYER_NAME_MAX), 'counts characters, not bytes');
});

test('player names are trimmed, spaced once, and normalised', () => {
  assert.equal(cleanPlayerName('  Ann \t  Lee  '), 'Ann Lee');
  assert.equal(cleanPlayerName('Ann\nLee'), 'Ann Lee');
  // "e" plus a combining acute accent becomes the single character é.
  assert.equal(cleanPlayerName('Rene\u0301'), 'René');
  assert.equal(cleanPlayerName('e\u0301'.repeat(PLAYER_NAME_MAX))?.length, PLAYER_NAME_MAX);
});

test('player names refuse symbols, emoji, invisible characters and odd shapes', () => {
  const refused = [
    '', '   ', 'a'.repeat(PLAYER_NAME_MAX + 1),
    '<b>', 'a&b', 'Ann 🙂', 'Ann\u200d', 'ab\u202ecd', '-Ann', ' .', '\u0301a',
    null, undefined, 42, ['Ann'],
  ];
  for (const name of refused) assert.equal(cleanPlayerName(name), null, JSON.stringify(name));
});

test('a challenge is a small sum, answered once', () => {
  const challenges = createChallenges();
  const { id, question } = challenges.issue();
  const [, a, b] = /^(\d) \+ (\d)$/.exec(question) ?? [];
  assert.ok(a && b, question);
  const answer = Number(a) + Number(b);

  assert.equal(challenges.check(id, answer), true);
  assert.equal(challenges.check(id, answer), false, 'used up');

  const second = challenges.issue();
  assert.equal(challenges.check(second.id, -1), false);
  assert.equal(challenges.size(), 0, 'a wrong answer uses it up too');

  const third = challenges.issue();
  const sum = third.question.split(' + ').map(Number).reduce((x, y) => x + y);
  assert.equal(challenges.check(third.id, ` ${sum} `), true, 'digits as text, as a form sends them');
  assert.equal(challenges.check('nope', 2), false);
  assert.equal(challenges.check(undefined, 2), false);
});

test('challenges expire, and only so many are held at once', () => {
  let clock = 0;
  const challenges = createChallenges({ ttlMs: 1000, max: 3, now: () => clock });
  const old = challenges.issue();
  clock = 1001;
  const sum = old.question.split(' + ').map(Number).reduce((x, y) => x + y);
  assert.equal(challenges.check(old.id, sum), false, 'expired');

  const issued = [1, 2, 3, 4, 5].map(() => challenges.issue());
  assert.equal(challenges.size(), 3);
  assert.equal(challenges.check(issued[0].id, 0), false);
  clock = 2002;
  challenges.issue();
  assert.equal(challenges.size(), 1, 'expired ones are dropped as new ones arrive');
});
