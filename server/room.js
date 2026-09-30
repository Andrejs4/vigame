/**
 * One Colyseus room per game. The room is a thin adapter around the game
 * core (src/core/game.js): it runs the core's clock, feeds it players' commands,
 * saves what it takes to rebuild the game, and mirrors the core's state into
 * the room state that Colyseus syncs to every client.
 *
 * A command from a player:
 *
 *   1. check and apply it on a copy of the game   (applyCommand)
 *   2. log it, with its tick                      (storage.recordCommand)
 *   3. adopt the copy and mirror it               (syncGame)
 *
 * If step 2 fails the live game is untouched, so nothing happens that the
 * log doesn't have. The clock ticks ten times a second, only while every
 * seated player is here; a snapshot of the state is saved every ten seconds
 * and when the room closes. Since the core is deterministic, the latest
 * snapshot plus the commands logged after it rebuild the game exactly.
 *
 * A room lives while someone is connected. When the last viewer leaves it is
 * disposed, and the next viewer's room loads the game back from the database.
 */

import { createHash } from 'node:crypto';

import { ErrorCode, Room, ServerError, logger } from '@colyseus/core';

import { BOARD_OPTIONS, createBoard, tileAt } from '../src/core/board.js';
import { advance, applyCommand, checkState, newGame, publicView } from '../src/core/game.js';
import { DEFAULT_MODE, MODES, TICKS_PER_SECOND } from '../src/core/rules.js';
import { GameState, ViewerState, syncGame, syncSeats } from './schema.js';

/** What a player token must look like: long, random, URL-safe. */
const TOKEN = /^[\w-]{16,128}$/;

/** How long a dropped connection may take to come back as the same viewer. */
const RECONNECT_SECONDS = 20;

/** How often a running game's state is saved, in ticks. */
const SNAPSHOT_TICKS = 10 * TICKS_PER_SECOND;

/**
 * Games with a live room in this process. Matchmaking already routes
 * `joinOrCreate` for one game to one room; this also stops a client that asks
 * for `create` outright from opening a second room on the same game, which
 * would then play out two different histories.
 * @type {Set<string>}
 */
const liveGames = new Set();

/**
 * The public id for a secret player token. The token proves who a viewer is;
 * this id is what other viewers get to see.
 * @param {string} token
 */
export function playerId(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Play logged commands onto a game, each at the tick it was given, advancing
 * the clock in between.
 * @param {import('../src/core/board.js').Board} board
 * @param {import('../src/core/game.js').GameState} game Changed in place.
 * @param {import('./storage.js').SavedCommand[]} commands
 * @param {number} [seq] The last command the game already includes.
 * @returns {number} The last command it includes now.
 */
export function replay(board, game, commands, seq = 0) {
  let last = seq;
  for (const c of commands) {
    if (c.tick < game.tick) throw new Error(`command ${c.seq} is from tick ${c.tick}, before ${game.tick}`);
    while (game.tick < c.tick) advance(board, game);
    const outcome = applyCommand(board, game, c.player, c.command);
    if (!outcome.ok) throw new Error(`command ${c.seq} does not replay: ${outcome.reason}`);
    last = c.seq;
  }
  return last;
}

/**
 * The game as saved: its snapshot plus the commands logged after it, or its
 * whole log from the opening position if the snapshot is unsound. It resumes
 * at the snapshot's tick or the last command's, whichever is later.
 * @param {import('./storage.js').SavedGame} saved
 * @param {(after: number) => import('./storage.js').SavedCommand[]} commandsAfter
 */
export function restoreGame(saved, commandsAfter) {
  const board = createBoard({ ...BOARD_OPTIONS, seed: saved.seed, players: saved.seats.length });
  if (checkState(board, saved.state).length === 0) {
    const game = /** @type {import('../src/core/game.js').GameState} */ (saved.state);
    return { board, game, seq: replay(board, game, commandsAfter(saved.seq), saved.seq) };
  }
  const mode = /** @type {any} */ (saved.state)?.mode;
  const game = newGame(board, { mode: Object.hasOwn(MODES, mode) ? mode : DEFAULT_MODE });
  return { board, game, seq: replay(board, game, commandsAfter(0)) };
}

/**
 * The fields of a message, or none when it isn't an object.
 * @param {unknown} message
 * @returns {Record<string, unknown>}
 */
function fields(message) {
  return message && typeof message === 'object' && !Array.isArray(message)
    ? /** @type {Record<string, unknown>} */ (message)
    : {};
}

/** The longest list a command may carry, such as a crew's unit ids. */
const LIST_MAX = 64;

/**
 * A command as it will be logged, or null. The room doesn't know what
 * commands exist (the core does), only that they are small, flat objects of
 * short strings, numbers and short lists of short strings, so nothing large
 * or nested reaches the log.
 * @param {unknown} message
 * @returns {Record<string, string | number | string[]> | null}
 */
function flatCommand(message) {
  const entries = Object.entries(fields(message));
  if (!entries.length || entries.length > 8) return null;
  const short = (/** @type {unknown} */ v) => typeof v === 'string' && v.length <= 64;
  const small = entries.every(([k, v]) => k.length <= 32
    && (short(v) || (typeof v === 'number' && Number.isFinite(v))
      || (Array.isArray(v) && v.length <= LIST_MAX && v.every(short))));
  return small ? /** @type {Record<string, string | number | string[]>} */ (Object.fromEntries(entries)) : null;
}

/**
 * Whether a player token is well formed. It proves nothing on its own: see
 * `signedIn`.
 * @param {unknown} token
 * @returns {token is string}
 */
export function isToken(token) {
  return typeof token === 'string' && TOKEN.test(token);
}

/**
 * The player a token belongs to, if they have signed in (POST /api/players).
 * @param {import('./storage.js').Storage} storage
 * @param {unknown} token
 * @returns {{ pid: string, name: string } | null}
 */
export function signedIn(storage, token) {
  if (!isToken(token)) return null;
  const player = storage.loadPlayer(playerId(token));
  return player && { pid: player.pid, name: player.name };
}

/**
 * The room class for games kept in `storage`. Colyseus asks the class, not a
 * room, whether a client may join (`onAuth` runs before any room is found or
 * created) and passes it only what the client sent, so the class carries the
 * storage it checks players against.
 * @param {import('./storage.js').Storage} storage
 */
export function gameRoom(storage) {
  return class extends GameRoom {
    /**
     * @param {string} _authToken
     * @param {any} options
     */
    static onAuth(_authToken, options) {
      if (!isToken(options?.token)) return false;
      const player = signedIn(storage, options.token);
      // A ServerError's message reaches the page, which then asks for a name.
      if (!player) throw new ServerError(ErrorCode.AUTH_FAILED, 'sign in first');
      return player;
    }
  };
}

/** Use `gameRoom(storage)`, which checks who is joining. */
export class GameRoom extends Room {
  /** Tap-rate input; anything faster is a script, and gets disconnected. */
  maxMessagesPerSecond = 20;

  /** Without storage to check players against, nobody gets in. */
  static onAuth() {
    return false;
  }

  /**
   * @param {{ gameId?: unknown, storage: import('./storage.js').Storage, tickRate?: number, soloClock?: boolean }} options
   *   `storage`, `tickRate` and `soloClock` come from the room definition,
   *   which overrides anything a client sends under those names. `tickRate`
   *   is ticks per real second: TICKS_PER_SECOND, unless tests speed the
   *   clock up. `soloClock` runs the clock while any seated player is here.
   */
  async onCreate({ gameId, storage, tickRate = TICKS_PER_SECOND, soloClock = false }) {
    if (typeof gameId === 'string' && liveGames.has(gameId)) {
      // A closing room leaves matchmaking a moment before its onDispose lets
      // go of the game. Someone joining in between must not be turned away.
      await new Promise((res) => setImmediate(res));
    }

    // ServerErrors reach the client as the reason its join failed, and
    // Colyseus doesn't log them as server faults.
    const saved = typeof gameId === 'string' ? storage.loadGame(gameId) : null;
    if (!saved) throw new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, `no game "${String(gameId)}"`);
    if (liveGames.has(saved.id)) {
      throw new ServerError(ErrorCode.MATCHMAKE_INVALID_CRITERIA, `game "${saved.id}" is already open`);
    }
    liveGames.add(saved.id);

    this.storage = storage;
    this.soloClock = soloClock === true;
    this.gameId = saved.id;
    const { board, game, seq } = restoreGame(saved, (after) => storage.listCommands(saved.id, { after }));
    this.board = board;
    this.game = game;
    /** The last logged command the live game includes. */
    this.seq = seq;
    this.snapshotAt = game.tick;
    /** @type {Array<string | null>} */
    this.seats = saved.seats.map((pid) => pid ?? null);

    const state = new GameState();
    syncGame(state, publicView(game));
    syncSeats(state, this.seats);
    this.setState(state);

    this.onMessage('command', (client, message, ctx) => this.play(client, message, ctx));
    this.onMessage('claimSeat', (client, _message, ctx) => {
      const seat = this.takeSeat(client.auth.pid);
      return seat === null ? ctx?.reject('no free seat') : seat;
    });
    this.onMessage('releaseSeat', (client) => { this.releaseSeat(client.auth.pid); });
    this.onMessage('select', (client, message) => this.select(client, message));

    // Patches go out once per tick, after the tick has changed things.
    this.patchRate = 1000 / tickRate;
    this.setFixedTimestep(() => this.step(), tickRate);
  }

  /**
   * Whether the clock runs: only while every seat is held by someone here,
   * or with `soloClock`, while any seated player is here.
   */
  clockRuns() {
    if (this.game.over !== undefined) return false; // the game is over
    const here = new Set([...this.state.viewers.values()].map((v) => v.pid));
    const present = (/** @type {string | null} */ pid) => pid !== null && here.has(pid);
    return this.soloClock ? this.seats.some(present) : this.seats.every(present);
  }

  /** One tick of the game clock. */
  step() {
    const running = this.clockRuns();
    if (this.state.running !== running) this.state.running = running;
    if (!running) return;
    advance(this.board, this.game);
    if (this.game.tick - this.snapshotAt >= SNAPSHOT_TICKS) this.snapshot();
    syncGame(this.state, publicView(this.game));
  }

  /**
   * Save the game's state. A failed save loses nothing the log doesn't have,
   * so it is logged and the game goes on; the next one is due in ten seconds.
   */
  snapshot() {
    this.snapshotAt = this.game.tick;
    try {
      this.storage.saveSnapshot(this.gameId, { state: this.game, seq: this.seq });
    } catch (e) {
      logger.error(`game ${this.gameId}: saving a snapshot failed`, e);
    }
  }

  /**
   * Check, log, then apply one command from a seated player.
   * @param {import('@colyseus/core').Client} client
   * @param {unknown} message
   * @param {import('@colyseus/core').MessageContext | undefined} ctx
   */
  play(client, message, ctx) {
    const seat = this.seatOf(client.auth.pid);
    if (seat === null) return ctx?.reject('not seated');
    const command = flatCommand(message);
    if (!command) return ctx?.reject('not a command');
    // Renaming the game needs no clock: players waiting for the rest may.
    if (!this.state.running && command.type !== 'rename') return ctx?.reject('the game is paused');

    const next = structuredClone(this.game);
    const outcome = applyCommand(this.board, next, seat, command);
    if (!outcome.ok) return ctx?.reject(outcome.reason);

    // Throws if the write fails; the request is then answered with an error
    // and the live game is left as it was.
    this.seq = this.storage.recordCommand(this.gameId, { tick: this.game.tick, player: seat, command });

    this.game = next;
    syncGame(this.state, publicView(next));
    // The lobby reads names from the snapshot, which a paused game never takes.
    if (command.type === 'rename') this.snapshot();
    return this.seq;
  }

  /**
   * @param {string} pid
   * @returns {number | null}
   */
  seatOf(pid) {
    const seat = this.seats.indexOf(pid);
    return seat < 0 ? null : seat;
  }

  /**
   * Give the player the first free seat, unless they already have one.
   * @param {string} pid
   * @returns {number | null} Their seat, or null when every seat is taken.
   */
  takeSeat(pid) {
    const held = this.seatOf(pid);
    if (held !== null) return held;
    const free = this.seats.indexOf(null);
    if (free < 0) return null;
    this.saveSeats(this.seats.map((holder, i) => (i === free ? pid : holder)));
    return free;
  }

  /** @param {string} pid */
  releaseSeat(pid) {
    if (this.seatOf(pid) === null) return;
    this.saveSeats(this.seats.map((holder) => (holder === pid ? null : holder)));
  }

  /**
   * Seats are saved before they change, like commands: a seat the database
   * doesn't have is not handed out.
   * @param {Array<string | null>} seats
   */
  saveSeats(seats) {
    this.storage.saveSeats(this.gameId, seats);
    this.seats = seats;
    syncSeats(this.state, seats);
  }

  /**
   * Share the hex a viewer picked, or clear it.
   * @param {import('@colyseus/core').Client} client
   * @param {unknown} message `{ q, r }` or null.
   */
  select(client, message) {
    const viewer = this.state.viewers.get(client.sessionId);
    if (!viewer) return;
    const { q, r } = fields(message);
    const on = Number.isSafeInteger(q) && Number.isSafeInteger(r) && Boolean(tileAt(this.board, Number(q), Number(r)));
    viewer.hasSel = on;
    if (on) {
      viewer.q = Number(q);
      viewer.r = Number(r);
    }
  }

  /**
   * The first two players in take the seats.
   * @param {import('@colyseus/core').Client} client
   */
  onJoin(client) {
    const { pid, name } = client.auth;
    const seat = this.takeSeat(pid);
    this.state.viewers.set(client.sessionId, new ViewerState({ pid, name, seat: seat ?? -1 }));
  }

  /**
   * A connection dropped without saying goodbye: keep the viewer for a while
   * so a flaky network doesn't reshuffle anything, or pause the game.
   * Colyseus calls `onLeave` if they don't come back in time.
   * @param {import('@colyseus/core').Client} client
   */
  onDrop(client) {
    this.allowReconnection(client, RECONNECT_SECONDS);
  }

  /**
   * The viewer is gone. Their seat is not: it stays theirs until they release
   * it, however long they are away, and the game waits for them.
   * @param {import('@colyseus/core').Client} client
   */
  onLeave(client) {
    this.state.viewers.delete(client.sessionId);
  }

  onDispose() {
    // onDispose also runs when onCreate threw, before the game was ever opened.
    if (!this.gameId) return;
    if (this.game) this.snapshot();
    liveGames.delete(this.gameId);
  }
}
