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
 *   players   everyone who has signed in: their public player id, name and
 *             language. The secret token behind the id is never stored.
 */

import Database from 'better-sqlite3';

import { HIGH_SCORES, scoreRows } from './scores.js';

/** Bump when the tables change, and add the upgrade step to `migrate`. */
const SCHEMA_VERSION = 26;

/**
 * @typedef {{ id: string, seed: number, state: unknown, seq: number, seats: Array<string | null>,
 *   creator: string | null, createdAt: number, updatedAt: number }} SavedGame
 *   `creator`: the player who started it, which players aren't shown.
 * @typedef {{ seq: number, tick: number, player: number, command: unknown, at: number }} SavedCommand
 * @typedef {{ pid: string, name: string, language: import('../src/core/player.js').Language,
 *   createdAt: number, updatedAt: number }} SavedPlayer
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
    INSERT INTO games (id, seed, state, seq, seats, creator, created_at, updated_at)
    VALUES (@id, @seed, @state, 0, @seats, @creator, @now, @now)`);
  const selectGame = db.prepare('SELECT * FROM games WHERE id = ?');
  const updateSnapshot = db.prepare('UPDATE games SET state = ?, seq = ?, updated_at = ? WHERE id = ?');
  const updateSeats = db.prepare('UPDATE games SET seats = ?, former = ?, updated_at = ? WHERE id = ?');
  const selectSeats = db.prepare('SELECT seats, former FROM games WHERE id = ?');
  const touchGame = db.prepare('UPDATE games SET updated_at = ? WHERE id = ?');
  const deleteCommands = db.prepare('DELETE FROM commands WHERE game_id = ?');
  const deleteGameRow = db.prepare('DELETE FROM games WHERE id = ?');
  const insertCommand = db.prepare(`
    INSERT INTO commands (game_id, seq, tick, player, command, at)
    VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM commands WHERE game_id = @id), @tick, @player, @command, @now)
    RETURNING seq`);
  const selectCommands = db.prepare(`
    SELECT seq, tick, player, command, at FROM commands WHERE game_id = ? AND seq > ? ORDER BY seq`);
  const SUMMARY = `id, seats, former, creator, created_at, updated_at, json_extract(state, '$.tick') AS tick,
    json_extract(state, '$.mode') AS mode, json_extract(state, '$.breeding') AS breeding,
    json_extract(state, '$.npcs') AS npcs, json_extract(state, '$.name') AS name,
    json_extract(state, '$.over') AS over, json_extract(state, '$.winner') AS winner,
    (SELECT json_group_array(key) FROM json_each(state, '$.players') WHERE json_extract(value, '$.lost') IS NOT NULL) AS fallen`;
  const selectRecent = db.prepare(`SELECT ${SUMMARY} FROM games ORDER BY updated_at DESC, id LIMIT ?`);
  const selectBest = db.prepare(`
    SELECT s.*, EXISTS (SELECT 1 FROM games g WHERE g.id = s.game_id) AS open FROM scores s
    WHERE points > 0 ORDER BY points DESC, ended_at, game_id, seat LIMIT ?`);
  const selectGameScores = db.prepare('SELECT * FROM scores WHERE game_id = ? ORDER BY seat');
  const selectGoingOf = db.prepare(`
    SELECT ${SUMMARY} FROM games
    WHERE json_extract(state, '$.over') IS NULL
      AND (creator = @pid OR EXISTS (SELECT 1 FROM json_each(games.seats) WHERE value = @pid))
    ORDER BY updated_at DESC, id`);
  const upsertPlayer = db.prepare(`
    INSERT INTO players (pid, name, language, created_at, updated_at) VALUES (@pid, @name, @language, @now, @now)
    ON CONFLICT (pid) DO UPDATE SET name = excluded.name, language = excluded.language, updated_at = excluded.updated_at`);
  const selectPlayer = db.prepare('SELECT * FROM players WHERE pid = ?');

  /** A command is logged, and its game marked active, together or not at all. */
  const recordCommandTx = db.transaction((/** @type {string} */ id, /** @type {any} */ row) => {
    if (touchGame.run(row.now, id).changes !== 1) throw new Error(`no game "${id}"`);
    return /** @type {{ seq: number }} */ (insertCommand.get(row)).seq;
  });

  return {
    /**
     * Store a new game.
     * @param {{ id: string, seed: number, state: unknown, seats: Array<string | null>, creator?: string | null }} game
     *   `creator`: the player who started it, if one did.
     */
    createGame({ id, seed, state, seats, creator = null }) {
      insertGame.run({ id, seed, state: JSON.stringify(state), seats: JSON.stringify(seats), creator, now: Date.now() });
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
        creator: row.creator ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    /**
     * Delete a game and its commands, for good.
     * @param {string} id
     */
    deleteGame: db.transaction((/** @type {string} */ id) => {
      deleteCommands.run(id);
      if (deleteGameRow.run(id).changes !== 1) throw new Error(`no game "${id}"`);
    }),

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
      // A seat its player leaves (a move to another base, a release) keeps
      // their id as its former holder, for names and scores at the end.
      const row = /** @type {any} */ (selectSeats.get(id));
      if (!row) throw new Error(`no game "${id}"`);
      const before = parseSeats(row.seats);
      const former = parseSeats(row.former);
      const kept = seats.map((holder, i) => (before[i] && before[i] !== holder ? before[i] : former[i] ?? null));
      updateSeats.run(JSON.stringify(seats), JSON.stringify(kept), Date.now(), id);
    },

    /**
     * Who to name for each seat: its holder, else its former one, if any.
     * @param {string} id
     * @returns {Array<string | null>}
     */
    namedSeats(id) {
      const row = /** @type {any} */ (selectSeats.get(id));
      if (!row) return [];
      const former = parseSeats(row.former);
      return parseSeats(row.seats).map((holder, i) => holder ?? former[i] ?? null);
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
      return selectRecent.all(limit).map(summary);
    },

    /**
     * Keep the scores of a game that has ended, once: a second call for the
     * same game changes nothing.
     * @param {import('./scores.js').EndedGame} game
     * @param {number} [now]
     */
    recordScores(game, now = Date.now()) {
      saveScores(db, game, now);
    },

    /**
     * The best scores ever, highest first; of two the same, the one made
     * first. Totals of nothing don't count.
     * @param {number} [limit]
     */
    bestScores(limit = HIGH_SCORES) {
      return selectBest.all(limit).map((/** @type {any} */ row) => ({ ...scoreFrom(row), open: Boolean(row.open) }));
    },

    /**
     * A game's scores, by seat, kept when it ended.
     * @param {string} gameId
     */
    scoresOf(gameId) {
      return selectGameScores.all(gameId).map(scoreFrom);
    },

    /**
     * A player's games under way: those they started, and those they hold a
     * seat in, most recently active first. With who started each, which the
     * lobby's list leaves out.
     * @param {string} pid
     */
    gamesUnderWayOf(pid) {
      return selectGoingOf.all({ pid }).map((/** @type {any} */ row) => ({ ...summary(row), creator: row.creator ?? null }));
    },

    /**
     * Record a player who has signed in, or change their name or language.
     * @param {string} pid
     * @param {string} name
     * @param {import('../src/core/player.js').Language} [language]
     */
    savePlayer(pid, name, language = 'auto') {
      upsertPlayer.run({ pid, name, language, now: Date.now() });
    },

    /**
     * @param {string} pid
     * @returns {SavedPlayer | null}
     */
    loadPlayer(pid) {
      const row = /** @type {any} */ (selectPlayer.get(pid));
      return row ? {
        pid: row.pid, name: row.name, language: row.language, createdAt: row.created_at, updatedAt: row.updated_at,
      } : null;
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
  if (version < 17) {
    // The Dark Lord's lair and horde have twice the hit points: earlier
    // games don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 17;
    `))();
  }
  if (version < 18) {
    // Each side keeps a tally for its points: earlier snapshots don't fit.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 18;
    `))();
  }
  if (version < 19) {
    // A pit goes three grades deep, not five, with other hit points and
    // more stone:
    // earlier games don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 19;
    `))();
  }
  if (version < 20) {
    // Who started each game, so a player can't leave too many waiting.
    // Games from before have none. A table that has the column already (one
    // the tests age by hand) keeps it.
    const has = db.prepare("SELECT 1 FROM pragma_table_info('games') WHERE name = 'creator'").get();
    db.transaction(() => {
      if (!has) db.exec('ALTER TABLE games ADD COLUMN creator TEXT REFERENCES players (pid)');
      db.exec('PRAGMA user_version = 20');
    })();
  }
  if (version < 21) {
    // Some units are heroes, rolled as they are born, which moves every
    // later roll; raiders and wagon upgrades are tougher: earlier games
    // don't replay the same.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 21;
    `))();
  }
  if (version < 22) {
    // Each player's language for the page: 'auto', or a language of
    // LANGUAGES (src/core/player.js). Games are kept; players start on 'auto'. A
    // table that has the column already (one the tests age by hand) keeps it.
    const has = db.prepare("SELECT 1 FROM pragma_table_info('players') WHERE name = 'language'").get();
    db.transaction(() => {
      if (!has) db.exec("ALTER TABLE players ADD COLUMN language TEXT NOT NULL DEFAULT 'auto'");
      db.exec('PRAGMA user_version = 22');
    })();
  }
  if (version < 23) {
    // Up to sixteen players, players away, Very Easy Lord. The author's
    // choice: every game from before goes, finished ones and their points
    // too (test games). Players keep their names and languages.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 23;
    `))();
  }
  if (version < 24) {
    // The high scores, in a table of their own: written once when a game
    // ends, and kept when games are cleared. Games already over are counted in.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scores (
          game_id    TEXT NOT NULL,              -- no reference: the game may go, its scores stay
          seat       INTEGER NOT NULL,
          pid        TEXT NOT NULL,
          name       TEXT NOT NULL,              -- the player's name when the game ended
          points     INTEGER NOT NULL,
          won        INTEGER NOT NULL,
          game_name  TEXT,
          mode       TEXT NOT NULL,
          ended_at   INTEGER NOT NULL,
          details    TEXT NOT NULL,              -- JSON: side, quick-win times, the tick it ended, the tally
          PRIMARY KEY (game_id, seat)
        );
        CREATE INDEX IF NOT EXISTS scores_by_points ON scores (points DESC);
      `);
      const finished = db.prepare(`SELECT id, seats, updated_at, state FROM games WHERE json_extract(state, '$.over') IS NOT NULL`);
      for (const row of /** @type {any[]} */ (finished.all())) {
        const state = parse(row.state);
        if (!state) continue;
        saveScores(db, { ...state, id: row.id, seats: parseSeats(row.seats) }, row.updated_at);
      }
      db.exec('PRAGMA user_version = 24;');
    })();
  }
  if (version < 25) {
    // Each seat's former holder: whoever last left it, so a player who moved
    // to another base is still named on the side they played first.
    db.transaction(() => {
      const columns = /** @type {Array<{ name: string }>} */ (db.prepare('PRAGMA table_info(games)').all());
      if (!columns.some((c) => c.name === 'former')) db.exec(`ALTER TABLE games ADD COLUMN former TEXT NOT NULL DEFAULT '[]'`);
      db.exec('PRAGMA user_version = 25;');
    })();
  }
  if (version < 26) {
    // Very Easy Lord gave way to choosing how fast units are raised, in any
    // mode. The author's choice: games under way and finished go; the high
    // scores and the players stay.
    db.transaction(() => db.exec(`
      DELETE FROM commands;
      DELETE FROM games;
      PRAGMA user_version = 26;
    `))();
  }
}

/**
 * Write a game's scores, each with the name its player has now.
 * @param {import('better-sqlite3').Database} db
 * @param {import('./scores.js').EndedGame} game
 * @param {number} now
 */
function saveScores(db, game, now) {
  const nameOf = db.prepare('SELECT name FROM players WHERE pid = ?');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO scores (game_id, seat, pid, name, points, won, game_name, mode, ended_at, details)
    VALUES (@gameId, @seat, @pid, @name, @points, @won, @gameName, @mode, @endedAt, @details)`);
  for (const s of scoreRows(game)) {
    insert.run({
      gameId: game.id, seat: s.seat, pid: s.pid, name: /** @type {any} */ (nameOf.get(s.pid))?.name ?? '',
      points: s.points, won: s.won ? 1 : 0, gameName: game.name ?? null, mode: game.mode, endedAt: now,
      details: JSON.stringify(s.details),
    });
  }
}

/**
 * A score as the lobby shows it, from a row of the scores table.
 * @param {any} row
 * @returns {import('../src/client/api.js').HighScore}
 */
function scoreFrom(row) {
  return {
    name: row.name, seat: row.seat, points: row.points, won: Boolean(row.won),
    game: { id: row.game_id, name: row.game_name ?? null, mode: row.mode }, at: row.ended_at,
    details: parse(row.details) ?? {},
  };
}

/** @param {string} text */
function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * A game as a lobby lists it, from a row of SUMMARY.
 * @param {any} row
 */
function summary(row) {
  return {
    id: row.id,
    mode: row.mode,
    breeding: row.breeding ?? null,
    npcs: row.npcs === 1,
    name: row.name ?? null,
    over: row.over ?? null,
    winner: row.winner ?? null,
    tick: row.tick,
    seats: parseSeats(row.seats),
    former: parseSeats(row.former),
    fallen: parseFallen(row.fallen),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The sides whose castles have fallen, by owner number.
 * @param {unknown} text
 * @returns {number[]}
 */
function parseFallen(text) {
  try {
    const list = JSON.parse(String(text));
    return Array.isArray(list) ? list.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} text
 * @returns {Array<string | null>}
 */
function parseSeats(text) {
  const seats = parse(text);
  return Array.isArray(seats) ? seats.map((s) => (typeof s === 'string' && s ? s : null)) : [];
}
