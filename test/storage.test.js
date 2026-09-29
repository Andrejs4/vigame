import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { openStorage } from '../server/storage.js';

/** Storage doesn't look inside states; any JSON does. */
const STATE = { version: 1, seed: 7, tick: 0, units: {} };

test('a game is stored and read back, and its commands logged in order with their ticks', () => {
  const storage = openStorage();
  storage.createGame({ id: 'g1', seed: 7, state: STATE, seats: [null, null] });

  const saved = storage.loadGame('g1');
  assert.deepEqual({ ...saved, createdAt: 0, updatedAt: 0 }, {
    id: 'g1', seed: 7, state: STATE, seq: 0, seats: [null, null], createdAt: 0, updatedAt: 0,
  });
  assert.equal(storage.loadGame('nope'), null);

  assert.equal(storage.recordCommand('g1', { tick: 5, player: 0, command: { type: 'upgrade', building: 'b1' } }), 1);
  assert.equal(storage.recordCommand('g1', { tick: 5, player: 1, command: { type: 'upgrade', building: 'b2' } }), 2);
  assert.equal(storage.recordCommand('g1', { tick: 9, player: 0, command: { type: 'upgrade', building: 'b1' } }), 3);
  assert.deepEqual(storage.listCommands('g1').map(({ seq, tick, player }) => [seq, tick, player]), [[1, 5, 0], [2, 5, 1], [3, 9, 0]]);
  assert.deepEqual(storage.listCommands('g1', { after: 2 }).map(({ seq }) => seq), [3]);
  assert.deepEqual(storage.listCommands('g1')[1].command, { type: 'upgrade', building: 'b2' });
  storage.close();
});

test('a snapshot replaces the saved state and records the last command it includes', () => {
  const storage = openStorage();
  storage.createGame({ id: 'g1', seed: 7, state: STATE, seats: [null, null] });
  storage.recordCommand('g1', { tick: 1, player: 0, command: {} });
  storage.saveSnapshot('g1', { state: { ...STATE, tick: 40 }, seq: 1 });
  const saved = storage.loadGame('g1');
  assert.deepEqual([saved.state.tick, saved.seq], [40, 1]);
  assert.throws(() => storage.saveSnapshot('ghost', { state: STATE, seq: 0 }), /no game/);
  storage.close();
});

test('a command for a game that does not exist is refused whole', () => {
  const storage = openStorage();
  assert.throws(() => storage.recordCommand('ghost', { tick: 0, player: 0, command: {} }), /no game/);
  assert.deepEqual(storage.listCommands('ghost'), []);
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

test('the lobby lists the most recently active games first', async () => {
  const storage = openStorage();
  storage.createGame({ id: 'old', seed: 1, state: STATE, seats: [null, null] });
  storage.createGame({ id: 'new', seed: 2, state: { ...STATE, tick: 30 }, seats: ['a', 'b'] });
  await new Promise((res) => setTimeout(res, 5));
  storage.recordCommand('new', { tick: 30, player: 0, command: {} });

  const games = storage.listGames();
  assert.deepEqual(games.map(({ id, tick, seats }) => ({ id, tick, seats })), [
    { id: 'new', tick: 30, seats: ['a', 'b'] },
    { id: 'old', tick: 0, seats: [null, null] },
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
    first.recordCommand('g1', { tick: 3, player: 0, command: {} });
    first.saveSnapshot('g1', { state: { ...STATE, tick: 3 }, seq: 1 });
    first.close();

    const second = openStorage(file);
    assert.equal(second.loadGame('g1').state.tick, 3);
    assert.equal(second.listCommands('g1').length, 1);
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

test('an older database is upgraded: turn-based games are dropped, players kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigame-'));
  try {
    const file = join(dir, 'vigame.db');
    // The version 2 tables, as the turn-based server made them.
    const old = new Database(file);
    old.exec(`
      CREATE TABLE games (id TEXT PRIMARY KEY, seed INTEGER NOT NULL, state TEXT NOT NULL,
        seats TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX games_by_update ON games (updated_at);
      CREATE TABLE moves (game_id TEXT NOT NULL REFERENCES games (id), seq INTEGER NOT NULL,
        player INTEGER NOT NULL, command TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (game_id, seq));
      CREATE TABLE players (pid TEXT PRIMARY KEY, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      PRAGMA user_version = 2;
    `);
    old.prepare('INSERT INTO games VALUES (?, ?, ?, ?, 1, 1)').run('g1', 7, '{"turn":3}', '["p1",null]');
    old.prepare('INSERT INTO moves VALUES (?, 1, 0, ?, 1)').run('g1', '{"type":"endTurn"}');
    old.prepare('INSERT INTO players VALUES (?, ?, 1, 1)').run('p1', 'Ann');
    old.close();

    const storage = openStorage(file);
    assert.equal(storage.loadGame('g1'), null);
    assert.deepEqual(storage.listGames(), []);
    assert.equal(storage.loadPlayer('p1')?.name, 'Ann');
    storage.createGame({ id: 'g2', seed: 1, state: STATE, seats: [null, null] });
    assert.equal(storage.recordCommand('g2', { tick: 0, player: 0, command: {} }), 1);
    storage.close();

    const check = new Database(file, { readonly: true });
    assert.equal(check.pragma('user_version', { simple: true }), 11);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version 3 database drops its games, whose commands these rules no longer have', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigame-'));
  try {
    const file = join(dir, 'vigame.db');
    const storage = openStorage(file);
    storage.savePlayer('p1', 'Ann');
    storage.createGame({ id: 'g1', seed: 1, state: STATE, seats: ['p1', null] });
    storage.recordCommand('g1', { tick: 0, player: 0, command: { type: 'send', from: 'b1', to: 'b2', count: 1 } });
    storage.close();
    // The tables are the same as version 3's; only the version number differs.
    const old = new Database(file);
    old.pragma('user_version = 3');
    old.close();

    const upgraded = openStorage(file);
    assert.equal(upgraded.loadGame('g1'), null);
    assert.deepEqual(upgraded.listCommands('g1'), []);
    assert.equal(upgraded.loadPlayer('p1')?.name, 'Ann');
    upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
