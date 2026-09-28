import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { openStorage } from '../server/storage.js';

const STATE = { seed: 7, turn: 1, currentPlayer: 0, units: [] };

test('a game is stored, read back, and its moves logged in order', () => {
  const storage = openStorage();
  storage.createGame({ id: 'g1', seed: 7, state: STATE, seats: [null, null] });

  const saved = storage.loadGame('g1');
  assert.deepEqual({ ...saved, createdAt: 0, updatedAt: 0 }, {
    id: 'g1', seed: 7, state: STATE, seats: [null, null], createdAt: 0, updatedAt: 0,
  });
  assert.equal(storage.loadGame('nope'), null);

  const after = { ...STATE, currentPlayer: 1 };
  assert.equal(storage.recordMove('g1', { player: 0, command: { type: 'endTurn' }, state: after }), 1);
  assert.equal(storage.recordMove('g1', { player: 1, command: { type: 'endTurn' }, state: STATE }), 2);
  assert.deepEqual(storage.loadGame('g1').state, STATE);
  assert.deepEqual(storage.listMoves('g1').map(({ seq, player, command }) => ({ seq, player, command })), [
    { seq: 1, player: 0, command: { type: 'endTurn' } },
    { seq: 2, player: 1, command: { type: 'endTurn' } },
  ]);
  storage.close();
});

test('a move for a game that does not exist is refused whole', () => {
  const storage = openStorage();
  assert.throws(() => storage.recordMove('ghost', { player: 0, command: {}, state: STATE }));
  assert.deepEqual(storage.listMoves('ghost'), []);
  assert.throws(() => storage.saveSeats('ghost', [null, null]));
  storage.close();
});

test('seats are saved, and unreadable seat entries count as free', () => {
  const storage = openStorage();
  storage.createGame({ id: 'g1', seed: 7, state: STATE, seats: [null, null] });
  storage.saveSeats('g1', ['alice', null]);
  assert.deepEqual(storage.loadGame('g1').seats, ['alice', null]);

  storage.createGame({ id: 'g2', seed: 7, state: STATE, seats: /** @type {any} */ ([5, '']) });
  assert.deepEqual(storage.loadGame('g2').seats, [null, null]);
  storage.close();
});

test('the lobby lists the most recently active games first', () => {
  const storage = openStorage();
  storage.createGame({ id: 'old', seed: 1, state: STATE, seats: [null, null] });
  storage.createGame({ id: 'new', seed: 2, state: { ...STATE, turn: 3 }, seats: ['a', 'b'] });
  storage.recordMove('new', { player: 0, command: { type: 'endTurn' }, state: { ...STATE, turn: 4, currentPlayer: 1 } });

  const games = storage.listGames();
  assert.deepEqual(games.map(({ id, turn, currentPlayer, seatsTaken }) => ({ id, turn, currentPlayer, seatsTaken })), [
    { id: 'new', turn: 4, currentPlayer: 1, seatsTaken: 2 },
    { id: 'old', turn: 1, currentPlayer: 0, seatsTaken: 0 },
  ]);
  assert.equal(storage.listGames({ limit: 1 }).length, 1);
  storage.close();
});

test('a database file keeps games across restarts, with write-ahead logging on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigame-'));
  try {
    const file = join(dir, 'vigame.db');
    const first = openStorage(file);
    assert.equal(first.journalMode(), 'wal');
    first.createGame({ id: 'g1', seed: 7, state: STATE, seats: [null, null] });
    first.recordMove('g1', { player: 0, command: { type: 'endTurn' }, state: { ...STATE, currentPlayer: 1 } });
    first.close();

    const second = openStorage(file);
    assert.equal(second.loadGame('g1').state.currentPlayer, 1);
    assert.equal(second.listMoves('g1').length, 1);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('players are stored by public id, and signing in again renames them', () => {
  const storage = openStorage();
  assert.equal(storage.loadPlayer('p1'), null);
  storage.savePlayer('p1', 'Ann');
  const first = storage.loadPlayer('p1');
  assert.equal(first.name, 'Ann');
  storage.savePlayer('p1', 'Anna');
  const renamed = storage.loadPlayer('p1');
  assert.equal(renamed.name, 'Anna');
  assert.equal(renamed.createdAt, first.createdAt);
  storage.close();
});

test('a database from before players existed is upgraded, games intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigame-'));
  try {
    const file = join(dir, 'vigame.db');
    // The version 1 tables, as the first release of the server made them.
    const old = new Database(file);
    old.exec(`
      CREATE TABLE games (id TEXT PRIMARY KEY, seed INTEGER NOT NULL, state TEXT NOT NULL,
        seats TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX games_by_update ON games (updated_at);
      CREATE TABLE moves (game_id TEXT NOT NULL REFERENCES games (id), seq INTEGER NOT NULL,
        player INTEGER NOT NULL, command TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (game_id, seq));
      PRAGMA user_version = 1;
    `);
    old.prepare('INSERT INTO games VALUES (?, ?, ?, ?, 1, 1)').run('g1', 7, JSON.stringify(STATE), '["p1",null]');
    old.close();

    const storage = openStorage(file);
    assert.deepEqual(storage.loadGame('g1').seats, ['p1', null]);
    storage.savePlayer('p1', 'Ann');
    assert.equal(storage.loadPlayer('p1').name, 'Ann');
    storage.close();

    const check = new Database(file, { readonly: true });
    assert.equal(check.pragma('user_version', { simple: true }), 2);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
