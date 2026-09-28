/**
 * Durable storage for games and players: SQLite through better-sqlite3.
 *
 * All database access goes through this module, so moving to Postgres later
 * changes this file and nothing else. Calls are synchronous: a turn-based game
 * writes rarely, and a synchronous write means a move is on disk before the
 * room goes on to send it to anyone.
 *
 * Tables:
 *   games    one row per game: its seed, its current state and its seats.
 *   moves    every accepted command, in order, never updated or deleted, so
 *            any game can be replayed from its seed.
 *   players  everyone who has signed in: their public player id and name.
 *            The secret token behind the id is never stored.
 */

import Database from 'better-sqlite3';

/** Bump when the tables change, and add the upgrade step to `migrate`. */
const SCHEMA_VERSION = 2;

/**
 * @typedef {{ id: string, seed: number, state: unknown, seats: Array<string | null>,
 *   createdAt: number, updatedAt: number }} SavedGame
 * @typedef {{ seq: number, player: number, command: unknown, at: number }} SavedMove
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
    INSERT INTO games (id, seed, state, seats, created_at, updated_at)
    VALUES (@id, @seed, @state, @seats, @now, @now)`);
  const selectGame = db.prepare('SELECT * FROM games WHERE id = ?');
  const updateState = db.prepare('UPDATE games SET state = ?, updated_at = ? WHERE id = ?');
  const updateSeats = db.prepare('UPDATE games SET seats = ?, updated_at = ? WHERE id = ?');
  const insertMove = db.prepare(`
    INSERT INTO moves (game_id, seq, player, command, at)
    VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM moves WHERE game_id = @id), @player, @command, @now)
    RETURNING seq`);
  const selectMoves = db.prepare('SELECT seq, player, command, at FROM moves WHERE game_id = ? ORDER BY seq');
  const selectRecent = db.prepare(`
    SELECT id, seats, created_at, updated_at,
           json_extract(state, '$.turn') AS turn,
           json_extract(state, '$.currentPlayer') AS current_player
    FROM games ORDER BY updated_at DESC, id LIMIT ?`);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (pid, name, created_at, updated_at) VALUES (@pid, @name, @now, @now)
    ON CONFLICT (pid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`);
  const selectPlayer = db.prepare('SELECT * FROM players WHERE pid = ?');

  /** One move and the state it led to land together or not at all. */
  const recordMoveTx = db.transaction((/** @type {string} */ id, /** @type {any} */ row) => {
    const { seq } = /** @type {{ seq: number }} */ (insertMove.get(row));
    if (updateState.run(row.state, row.now, id).changes !== 1) throw new Error(`no game "${id}"`);
    return seq;
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
        seats: parseSeats(row.seats),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    /**
     * Append an accepted command to the log and store the state it produced,
     * in one transaction.
     * @param {string} id
     * @param {{ player: number, command: unknown, state: unknown }} move
     * @returns {number} The move's sequence number, from 1.
     */
    recordMove(id, { player, command, state }) {
      return recordMoveTx(id, {
        id, player, command: JSON.stringify(command), state: JSON.stringify(state), now: Date.now(),
      });
    },

    /**
     * @param {string} id
     * @param {Array<string | null>} seats Player id per seat, null when free.
     */
    saveSeats(id, seats) {
      if (updateSeats.run(JSON.stringify(seats), Date.now(), id).changes !== 1) throw new Error(`no game "${id}"`);
    },

    /**
     * @param {string} id
     * @returns {SavedMove[]}
     */
    listMoves(id) {
      return selectMoves.all(id).map((/** @type {any} */ row) => ({
        seq: row.seq, player: row.player, command: parse(row.command), at: row.at,
      }));
    },

    /**
     * The most recently active games, for a lobby.
     * @param {{ limit?: number }} [options]
     */
    listGames({ limit = 50 } = {}) {
      return selectRecent.all(limit).map((/** @type {any} */ row) => ({
        id: row.id,
        turn: row.turn,
        currentPlayer: row.current_player,
        seatsTaken: parseSeats(row.seats).filter(Boolean).length,
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
    db.transaction(() => db.exec(`
      CREATE TABLE games (
        id         TEXT PRIMARY KEY,
        seed       INTEGER NOT NULL,
        state      TEXT NOT NULL,              -- JSON: { seed, turn, currentPlayer, units }
        seats      TEXT NOT NULL DEFAULT '[]', -- JSON: player id per seat, null when free
        created_at INTEGER NOT NULL,           -- ms since the epoch
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX games_by_update ON games (updated_at);
      CREATE TABLE moves (
        game_id TEXT NOT NULL REFERENCES games (id),
        seq     INTEGER NOT NULL,              -- 1, 2, 3… within a game
        player  INTEGER NOT NULL,              -- the seat that sent it
        command TEXT NOT NULL,                 -- JSON: a game.js Command
        at      INTEGER NOT NULL,
        PRIMARY KEY (game_id, seq)
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
