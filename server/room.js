/**
 * One Colyseus room per game. The room holds the real game in memory, checks
 * every command with game.js, and saves each accepted one before anyone sees
 * its result:
 *
 *   1. check the command against the game          (applyCommand, on a copy)
 *   2. apply it                                    (the copy)
 *   3. write it to the database                    (storage.recordMove)
 *   4. adopt the copy and sync it to the room state; Colyseus sends the
 *      change to every client with its next patch
 *
 * If step 3 fails the live game is untouched, so no client ever sees a move
 * the database doesn't have.
 *
 * A room lives while someone is connected. When the last viewer leaves it is
 * disposed, and the next viewer's room loads the game back from the database.
 */

import { createHash } from 'node:crypto';

import { ErrorCode, Room, ServerError } from '@colyseus/core';

import { BOARD_OPTIONS, createBoard, tileAt } from '../src/board.js';
import { PLAYERS, applyCommand, createGame } from '../src/game.js';
import { applyState, sanitizeState, serialize } from '../src/net.js';
import { GameState, ViewerState, syncGame, syncSeats } from './schema.js';

/** What a player token must look like: long, random, URL-safe. */
const TOKEN = /^[\w-]{16,128}$/;

/** How long a dropped connection may take to come back as the same viewer. */
const RECONNECT_SECONDS = 20;

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
 * Rebuild a game by replaying its move log from the opening position.
 * @param {number} seed
 * @param {Array<{ seq: number, player: number, command: unknown }>} moves
 */
export function replay(seed, moves) {
  const board = createBoard({ ...BOARD_OPTIONS, seed });
  const game = createGame(board);
  for (const move of moves) {
    if (!applyCommand(board, game, move.player, move.command)) {
      throw new Error(`move ${move.seq} does not replay`);
    }
  }
  return { board, game };
}

/**
 * The game as saved, or rebuilt from its moves if the saved state is
 * unreadable.
 * @param {import('./storage.js').SavedGame} saved
 * @param {() => import('./storage.js').SavedMove[]} moves
 */
export function restoreGame(saved, moves) {
  const state = sanitizeState(saved.state);
  if (!state || state.seed !== saved.seed) return replay(saved.seed, moves());

  const board = createBoard({ ...BOARD_OPTIONS, seed: saved.seed });
  const game = createGame(board);
  applyState(game, state);
  return { board, game };
}

/**
 * A copy of the game that can be changed without touching the original.
 * @template {{ units: Map<string, object> }} G
 * @param {G} game
 * @returns {G}
 */
function cloneGame(game) {
  return { ...game, units: new Map([...game.units].map(([id, unit]) => [id, { ...unit }])) };
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
   * @param {{ gameId?: unknown, storage: import('./storage.js').Storage }} options
   *   `storage` comes from the room definition, which overrides anything a
   *   client sends under that name.
   */
  async onCreate({ gameId, storage }) {
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
    this.gameId = saved.id;
    const { board, game } = restoreGame(saved, () => storage.listMoves(saved.id));
    this.board = board;
    this.game = game;
    /** @type {Array<string | null>} */
    this.seats = PLAYERS.map((_, i) => saved.seats[i] ?? null);

    const state = new GameState();
    syncGame(state, board, game);
    syncSeats(state, this.seats);
    this.setState(state);

    this.onMessage('move', (client, message, ctx) => {
      const { unit, q, r } = fields(message);
      return this.play(client, { type: 'move', unit, q, r }, ctx);
    });
    this.onMessage('endTurn', (client, _message, ctx) => this.play(client, { type: 'endTurn' }, ctx));
    this.onMessage('claimSeat', (client, _message, ctx) => {
      const seat = this.takeSeat(client.auth.pid);
      return seat === null ? ctx?.reject('no free seat') : seat;
    });
    this.onMessage('releaseSeat', (client) => { this.releaseSeat(client.auth.pid); });
    this.onMessage('select', (client, message) => this.select(client, message));
  }

  /**
   * Check, apply, save, then share one command from a seated player.
   * @param {import('@colyseus/core').Client} client
   * @param {import('../src/game.js').Command} command
   * @param {import('@colyseus/core').MessageContext | undefined} ctx
   */
  play(client, command, ctx) {
    const seat = this.seatOf(client.auth.pid);
    if (seat === null) return ctx?.reject('not seated');
    if (seat !== this.game.currentPlayer) return ctx?.reject('not your turn');

    const next = cloneGame(this.game);
    if (!applyCommand(this.board, next, seat, command)) return ctx?.reject('illegal move');

    // Throws if the write fails; the request is then answered with an error
    // and the live game is left as it was.
    const seq = this.storage.recordMove(this.gameId, {
      player: seat, command, state: serialize(this.board, next),
    });

    this.game = next;
    syncGame(this.state, this.board, next);
    return seq;
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
   * Seats are saved before they change, like moves: a seat the database
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
   * The first two players in take the seats, as on the published page.
   * @param {import('@colyseus/core').Client} client
   */
  onJoin(client) {
    const { pid, name } = client.auth;
    const seat = this.takeSeat(pid);
    this.state.viewers.set(client.sessionId, new ViewerState({ pid, name, seat: seat ?? -1 }));
  }

  /**
   * A connection dropped without saying goodbye: keep the viewer for a while
   * so a flaky network doesn't reshuffle anything. Colyseus calls `onLeave`
   * if they don't come back in time.
   * @param {import('@colyseus/core').Client} client
   */
  onDrop(client) {
    this.allowReconnection(client, RECONNECT_SECONDS);
  }

  /**
   * The viewer is gone. Their seat is not: it stays theirs until they release
   * it, however long they are away.
   * @param {import('@colyseus/core').Client} client
   */
  onLeave(client) {
    this.state.viewers.delete(client.sessionId);
  }

  onDispose() {
    // onDispose also runs when onCreate threw, before the game was ever opened.
    if (this.gameId) liveGames.delete(this.gameId);
  }
}
