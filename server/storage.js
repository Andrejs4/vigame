/**
 * Durable storage for games and players: SQLite through better-sqlite3.
 *
 * All database access goes through this module, so moving to Postgres later
 * changes this file and nothing else. Calls are synchronous: a command is on
 * disk before the room applies it.
 *
 * A game runs in real time, so its state changes ten times a second: far too
 * often to write each change. Instead the database keeps what it takes to
 * rebuild the game exactly, since the game core is deterministic:
 *
 *   games     one row per game: its seed, its seats, and a snapshot of its
 *             state, taken every few seconds and when the game closes, with
 *             `seq`, the last command the snapshot includes.
 *   commands  every accepted command with the tick it was applied at, in
 *             order, never updated or deleted. The snapshot plus the commands
 *             after it rebuild the game up to the last command.
 *   players   everyone who has signed in: their public player id and name.
 *             The secret token behind the id is never stored.
 */

import Database from 'better-sqlite3';

/** Bump when the tables change, and add the upgrade step to `migrate`. */
const SCHEMA_VERSION = 16;

/**
 * @typedef {{ id: string, seed: number, state: unknown, seq: number, seats: Array<string | null>,
 *   createdAt: number, updatedAt: number }} SavedGame
 * @typedef {{ seq: number, tick: number, player: number, command: unknown, at: number }} SavedCommand
 * @typedef {{ pid: string, name: string, createdAt: number, updatedAt: number }} SavedPlayer
 */

/**
 * Open (or create) the database.
 * @param {string} [file=':memory:'] A path, or ':memory:' for a throwaway database.
 */
export function openStorage(file = ':memory:') {
  const db = new Database(file);

  // Write-ahead logging: reads don't wait for writes, and Litestream needs it.
  // An in-memory database answers 'memory' and carries on without it.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);

  const insertGame = db.prepare(`
    INSERT INTO games (id, seed, state, seq, seats, created_at, updated_at)
    VALUES (@id, @seed, @state, 0, @seats, @now, @now)`);
  const selectGame = db.prepare('SELECT * FROM games WHERE id = ?');
  const updateSnapshot = db.prepare('UPDATE games SET state = ?, seq = ?, updated_at = ? WHERE id = ?');
  const updateSeats = db.prepare('UPDATE games SET seats = ?, updated_at = ? WHERE id = ?');
  const touchGame = db.prepare('UPDATE games SET updated_at = ? WHERE id = ?');
  const insertCommand = db.prepare(`
    INSERT INTO commands (game_id, seq, tick, player, command, at)
    VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM commands WHERE game_id = @id), @tick, @player, @command, @now)
    RETURNING seq`);
  const selectCommands = db.prepare(`
    SELECT seq, tick, player, command, at FROM commands WHERE game_id = ? AND seq > ? ORDER BY seq`);
  const selectRecent = db.prepare(`
    SELECT id, seats, created_at, updated_at, json_extract(state, '$.tick') AS tick, json_extract(state, '$.mode') AS mode,
      json_extract(state, '$.over') AS over, json_extract(state, '$.winner') AS winner
    FROM games ORDER BY updated_at DESC, id LIMIT ?`);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (pid, name, created_at, updated_at) VALUES (@pid, @name, @now, @now)
    ON CONFLICT (pid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`);
  const selectPlayer = db.prepare('SELECT * FROM players WHERE pid = ?');

  /** A command is logged, and its game marked active, together or not at all. */
  const recordCommandTx = db.transaction((/** @type {string} */ id, /** @type {any} */ row) => {
    if (touchGame.run(row.now, id).changes !== 1) throw new Error(`no game "${id}"`);
    return /** @type {{ seq: number }} */ (insertCommand.get(row)).seq;
  });

  return {
    /**
     * Store a new game.
     * @param {{ id: string, seed: number, state: unknown, seats: Array<string | null> }} game
     */
    createGame({ id, seed, state, seats }) {
      insertGame.run({ id, seed, state: JSON.stringify(state), seats: JSON.stringify(seats), now: Date.now() });
    },

    /**
     * @param {string} id
     * @returns {SavedGame | null}
     */
    loadGame(id) {
      const row = /** @type {any} */ (selectGame.get(id));
      if (!row) return null;
      return {
        id: row.id,
        seed: row.seed,
        state: parse(row.state),
        seq: row.seq,
        seats: parseSeats(row.seats),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    /**
     * Append an accepted command to the log.
     * @param {string} id
     * @param {{ tick: number, player: number, command: unknown }} entry
     * @returns {number} The command's sequence number, from 1.
     */
    recordCommand(id, { tick, player, command }) {
      return recordCommandTx(id, { id, tick, player, command: JSON.stringify(command), now: Date.now() });
    },

    /**
     * Store a snapshot of the game's state.
     * @param {string} id
     * @param {{ state: unknown, seq: number }} snapshot `seq`: the last command it includes.
     */
    saveSnapshot(id, { state, seq }) {
      if (updateSnapshot.run(JSON.stringify(state), seq, Date.now(), id).changes !== 1) throw new Error(`no game "${id}"`);
    },

    /**
     * @param {string} id
     * @param {Array<string | null>} seats Player id per seat, null when free.
     */
    saveSeats(id, seats) {
      if (updateSeats.run(JSON.stringify(seats), Date.now(), id).changes !== 1) throw new Error(`no game "${id}"`);
    },

    /**
     * The game's commands in order, optionally only those after `after`.
     * @param {string} id
     * @param {{ after?: number }} [options]
     * @returns {SavedCommand[]}
     */
    listCommands(id, { after = 0 } = {}) {
      return selectCommands.all(id, after).map((/** @type {any} */ row) => ({
        seq: row.seq, tick: row.tick, player: row.player, command: parse(row.command), at: row.at,
      }));
    },

    /**
     * The most recently active games, for a lobby.
     * @param {{ limit?: number }} [options]
     */
    listGames({ limit = 50 } = {}) {
      return selectRecent.all(limit).map((/** @type {any} */ row) => ({
        id: row.id,
        mode: row.mode,
        over: row.over ?? null,
        winner: row.winner ?? null,
        tick: row.tick,
        seats: parseSeats(row.seats),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    /**
     * Record a player who has signed in, or give them a new name.
     * @param {string} pid
     * @param {string} name
     */
    savePlayer(pid, name) {
      upsertPlayer.run({ pid, name, now: Date.now() });
    },

    /**
     * @param {string} pid
     * @returns {SavedPlayer | null}
     */
    loadPlayer(pid) {
      const row = /** @type {any} */ (selectPlayer.get(pid));
      return row ? { pid: row.pid, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },

    /** Whether writes go through a write-ahead log. */
    journalMode: () => /** @type {string} */ (db.pragma('journal_mode', { simple: true })),

    close() { db.close(); },
  };
}

/** @typedef {ReturnType<typeof openStorage>} Storage */

/**
 * Create the tables, or upgrade older ones.
 * @param {import('better-sqlite3').Database} db
 */
function migrate(db) {
  const version = /** @type {number} */ (db.pragma('user_version', { simple: true }));
  if (version > SCHEMA_VERSION) {
    throw new Error(`database schema v${version} is newer than this server understands (v${SCHEMA_VERSION})`);
  }
  if (version < 1) {
    // The turn-based prototype's tables. Version 3 replaces them; they are
    // created here only so every database upgrades along the same steps.
    db.transaction(() => db.exec(`
      CREATE TABLE games (
        id TEXT PRIMARY KEY, seed INTEGER NOT NULL, state TEXT NOT NULL,
        seats TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX games_by_update ON games (updated_at);
      CREATE TABLE moves (
        game_id TEXT NOT NULL REFERENCES games (id), seq INTEGER NOT NULL, player INTEGER NOT NULL,
        command TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (game_id, seq)
      );
      PRAGMA user_version = 1;
    `))();
  }
  if (version < 2) {
    db.transaction(() => db.exec(`
      CREATE TABLE players (
        pid        TEXT PRIMARY KEY,           -- public player id, a hash of their token
        name       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `))();
  }
  if (version < 3) {
    // Real time. Games saved by the turn-based prototype can't be played by
    // these rules, so they are dropped; players keep their names.
    db.transaction(() => db.exec(`
      DROP TABLE moves;
      DROP TABLE games;
      CREATE TABLE games (
        id         TEXT PRIMARY KEY,
        seed       INTEGER NOT NULL,
        state      TEXT NOT NULL,              -- JSON snapshot: a src/core/game.js GameState
        seq        INTEGER NOT NULL DEFAULT 0, -- the last command the snapshot includes
        seats      TEXT NOT NULL DEFAULT '[]', -- JSON: player id per seat, null when free
        created_at INTEGER NOT NULL,           -- ms since the epoch
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX games_by_update ON games (updated_at);
      CREATE TABLE commands (
        game_id TEXT NOT NULL REFERENCES games (id),
        seq     INTEGER NOT NULL,              -- 1, 2, 3… within a game
        tick    INTEGER NOT NULL,              -- the game tick it was applied at
        player  INTEGER NOT NULL,              -- the seat that gave it
        command TEXT NOT NULL,                 -- JSON: a src/core/game.js Command
        at      INTEGER NOT NULL,              -- ms since the epoch
        PRIMARY KEY (game_id, seq)
      );
      PRAGMA user_version = 3;
    `))();
  }
  if (version < 4) {
    // Named units with skills, crews and pits. Earlier games' commands
    // (sending units) don't exist in these rules, so those games are dropped.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 4;
    `))();
  }
  if (version < 5) {
    // Stone, food and hit points: building now costs stone, so earlier
    // games' logs don't replay either.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 5;
    `))();
  }
  if (version < 6) {
    // Hunger, and food ten times as fine: earlier snapshots don't fit.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 6;
    `))();
  }
  if (version < 7) {
    // Combat, repair and a fallen castle's loss: earlier snapshots don't fit.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 7;
    `))();
  }
  if (version < 8) {
    // Game modes and teams: earlier snapshots don't fit.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 8;
    `))();
  }
  if (version < 9) {
    // Buildings go up and are upgraded over time, and castles breed by
    // themselves: earlier games don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 9;
    `))();
  }
  if (version < 10) {
    // Bigger maps: an earlier game's seed makes a different map now.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 10;
    `))();
  }
  if (version < 11) {
    // The lair and ogres fight units at higher levels: earlier games don't
    // replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 11;
    `))();
  }
  if (version < 12) {
    // A stronger Dark Lord, and slower repair that stops while fighting:
    // earlier games don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 12;
    `))();
  }
  if (version < 13) {
    // Smaller castles, slower breeding, farming and digging, and pits that
    // grow sturdier with depth: earlier games don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 13;
    `))();
  }
  if (version < 14) {
    // Castles hold 40 and 10 more a grade, and pits have fewer hit points:
    // earlier games don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 14;
    `))();
  }
  if (version < 15) {
    // Hunger follows the meals' shortfall, and fighting skills train
    // faster: earlier games don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 15;
    `))();
  }
  if (version < 16) {
    // Maps half as big again: an earlier game's seed makes a different map now.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 16;
    `))();
  }
}

/** @param {string} text */
function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param {string} text
 * @returns {Array<string | null>}
 */
function parseSeats(text) {
  const seats = parse(text);
  return Array.isArray(seats) ? seats.map((s) => (typeof s === 'string' && s ? s : null)) : [];
}
