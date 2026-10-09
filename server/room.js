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
import { ROOM_COMMANDS, advance, applyCommand, checkState, fallenMayMove, newGame, publicView } from '../src/core/game.js';
import { npcMemory, npcMove, npcRefused } from '../src/core/npc.js';
import { BREEDING, BUILDING_TYPES, DEFAULT_BREEDING, DEFAULT_MODE, END_ANYONE_TICKS, END_IDLE_MS, MODES, NPC, TICKS_PER_SECOND } from '../src/core/rules.js';
import { GameState, ViewerState, syncGame, syncSeats } from './schema.js';

/** What a player token must look like: long, random, URL-safe. */
const TOKEN = /^[\w-]{16,128}$/;

/** How long a dropped connection may take to come back as the same viewer. */
const RECONNECT_SECONDS = 20;

/** How often a running game's state is saved, in ticks. */
const SNAPSHOT_TICKS = 10 * TICKS_PER_SECOND;

/**
 * Games with a live room in this process, and their rooms. Matchmaking
 * already routes `joinOrCreate` for one game to one room; this also stops a
 * client that asks for `create` outright from opening a second room on the
 * same game, which would then play out two different histories. And it lets
 * the HTTP side reach a game's room: to free a seat, or close a deleted game.
 * @type {Map<string, any>}
 */
const liveGames = new Map();

/**
 * The live room of a game, if it has one in this process.
 * @param {string} gameId
 * @returns {{ releaseSeat(pid: string): void, abandon(): void } | null}
 */
export function liveRoom(gameId) {
  return liveGames.get(gameId) ?? null;
}

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
  const { mode, breeding, npcs } = /** @type {any} */ (saved.state) ?? {};
  const game = newGame(board, {
    mode: Object.hasOwn(MODES, mode) ? mode : DEFAULT_MODE,
    breeding: Object.hasOwn(BREEDING, breeding) ? breeding : DEFAULT_BREEDING,
    npcs: npcs === true,
  });
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

/**
 * The longest list a command may carry: a crew's unit ids, so as many as any
 * building holds at its last grade (a band's 80).
 */
const LIST_MAX = Math.max(...Object.values(BUILDING_TYPES)
  .map(({ capacity, perGrade = capacity, grades }) => capacity + perGrade * (grades - 1)));

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
    liveGames.set(saved.id, this);

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
    /** The player who started the game, who may start it without the players missing. */
    this.creator = saved.creator ?? null;
    /** When the game was created: a day on, an abandoned game may be ended. */
    this.createdAt = saved.createdAt;
    /**
     * What each NPC remembers between moves, by seat: kept while the room is
     * open; a new room starts each afresh.
     * @type {Map<number, import('../src/core/npc.js').NpcMemory>}
     */
    this.npcMemory = new Map();

    const state = new GameState();
    state.creator = this.creator ?? '';
    state.createdAt = this.createdAt;
    syncGame(state, publicView(game));
    syncSeats(state, this.seats);
    this.setState(state);

    this.onMessage('command', (client, message, ctx) => this.play(client, message, ctx));
    this.onMessage('claimSeat', (client, message, ctx) => {
      const { seat: wanted } = fields(message);
      const seat = this.claimSeat(client.auth.pid, typeof wanted === 'number' ? wanted : null);
      return seat === null ? ctx?.reject('no free seat') : seat;
    });
    this.onMessage('releaseSeat', (client) => { this.releaseSeat(client.auth.pid); });
    this.onMessage('startNow', (client, _message, ctx) => {
      const why = this.startNow(client.auth.pid);
      return why === null ? true : ctx?.reject(why);
    });
    this.onMessage('endGame', (client, _message, ctx) => {
      const why = this.endGame(client.auth.pid);
      return why === null ? true : ctx?.reject(why);
    });
    this.onMessage('select', (client, message) => this.select(client, message));

    // Patches go out once per tick, after the tick has changed things.
    this.patchRate = 1000 / tickRate;
    this.setFixedTimestep(() => this.step(), tickRate);
  }

  /** The players here, by player id. */
  here() {
    return new Set([...this.state.viewers.values()].map((v) => v.pid));
  }

  /**
   * Whether a seat's side is still in the game: its castle stands.
   * @param {number} seat
   */
  standing(seat) {
    return this.game.players[seat]?.lost === undefined;
  }

  /**
   * Whether an NPC plays a seat: in a game with NPCs, one nobody holds
   * whose castle stands.
   * @param {number} seat
   */
  npcSeat(seat) {
    return this.game.npcs === true && this.seats[seat] === null && this.standing(seat);
  }

  /**
   * The seats the game waits for: those still in the game, but for the ones
   * NPCs play, and those it goes on without while their players are away
   * (`away` in the core).
   * @returns {boolean[]}
   */
  awaited() {
    return this.seats.map((_, i) => this.standing(i) && !this.npcSeat(i) && this.game.players[i]?.away === undefined);
  }

  /**
   * Whether the clock runs: while every seat it waits for is held by someone
   * here, and someone is; or with `soloClock`, while any seated player is here.
   * A game NPCs play alone runs while anyone watches it.
   */
  clockRuns() {
    if (this.game.over !== undefined) return false; // the game is over
    const here = this.here();
    const present = (/** @type {string | null} */ pid) => pid !== null && here.has(pid);
    if (this.soloClock) return this.seats.some(present);
    const awaited = this.awaited();
    if (this.game.npcs && !awaited.some(Boolean) && this.seats.some((_, i) => this.npcSeat(i))) return here.size > 0;
    return this.seats.some((pid, i) => awaited[i] && present(pid)) && this.seats.every((pid, i) => !awaited[i] || present(pid));
  }

  /**
   * The game's creator has the game go on without the players missing: each
   * seat it waits for whose player isn't here is marked away in the game,
   * a command the room logs, until its player is back (`welcomeBack`).
   * @param {string} pid Who asks.
   * @returns {string | null} Why not, or null once done.
   */
  startNow(pid) {
    if (this.deleted) return 'the game is gone';
    if (pid !== this.creator) return 'not a game you started';
    if (this.game.over !== undefined) return 'the game is over';
    const here = this.here();
    const awaited = this.awaited();
    const present = this.seats.map((holder) => holder !== null && here.has(holder));
    if (!this.seats.some((_, i) => awaited[i] && present[i])) return 'no player is here';
    const missing = this.seats.flatMap((_, i) => (awaited[i] && !present[i] ? [i] : []));
    if (!missing.length) return 'nobody is missing';
    for (const seat of missing) this.commit(seat, { type: 'away' });
    return null;
  }

  /**
   * End the game for everyone, as a command the room logs: a seated player,
   * its creator at any time, anyone else after an hour of play
   * (END_ANYONE_TICKS). And once the game is a day old (END_IDLE_MS) with
   * none of its other players here, anyone viewing it, so an abandoned game
   * can be closed: a spectator's ending counts every seat as giving up
   * (`idle`); so does the creator's, watching a game with NPCs. Then it is
   * over (`finish`).
   * @param {string} pid Who asks.
   * @returns {string | null} Why not, or null once done.
   */
  endGame(pid) {
    if (this.deleted) return 'the game is gone';
    if (this.game.over !== undefined) return 'the game is over';
    const seat = this.seatOf(pid);
    const here = this.here();
    const abandoned = Date.now() - this.createdAt >= END_IDLE_MS
      && !this.seats.some((holder) => holder !== null && holder !== pid && here.has(holder));
    const player = seat !== null && (pid === this.creator || this.game.tick >= END_ANYONE_TICKS || abandoned);
    const watching = seat === null && pid === this.creator && this.game.npcs === true;
    if (!player && !abandoned && !watching) {
      return seat === null ? 'only its players may end it, until it is a day old with none of them here' : 'only its creator may end it in its first hour';
    }
    const outcome = player ? this.commit(seat, { type: 'end' }) : this.commit(0, { type: 'end', idle: 1 });
    if (!outcome.ok) return outcome.reason;
    this.state.running = false;
    this.finish();
    return null;
  }

  /**
   * The game is over: save it at once, so the lobby lists it finished, and
   * keep each player's score in the high scores (once; a failed write is
   * logged, and the game is over all the same).
   */
  finish() {
    this.snapshot();
    if (this.deleted) return;
    try {
      // A side's score goes to its holder, else to whoever last held it.
      this.storage.recordScores({ ...this.game, id: this.gameId, seats: this.storage.namedSeats(this.gameId) });
    } catch (e) {
      logger.error(`game ${this.gameId}: keeping its scores failed`, e);
    }
  }

  /**
   * Players marked away who are here again are back, and the game waits for
   * them once more. A failed write is logged; they stay marked away.
   */
  welcomeBack() {
    if (this.deleted || this.game.over !== undefined) return;
    const here = this.here();
    this.seats.forEach((holder, seat) => {
      if (holder === null || !here.has(holder) || this.game.players[seat]?.away === undefined) return;
      try {
        this.commit(seat, { type: 'back' });
      } catch (e) {
        logger.error(`game ${this.gameId}: logging seat ${seat} back failed`, e);
      }
    });
  }

  /** One tick of the game clock. */
  step() {
    const running = this.clockRuns();
    if (this.state.running !== running) this.state.running = running;
    if (!running) return;
    advance(this.board, this.game);
    if (this.game.over === undefined) this.playNpcs();
    if (this.game.over !== undefined) this.finish();
    else if (this.game.tick - this.snapshotAt >= SNAPSHOT_TICKS) this.snapshot();
    syncGame(this.state, publicView(this.game));
  }

  /**
   * Each NPC thinks every NPC.think ticks, the seats a few ticks apart, and
   * gives up to NPC.perThink commands, logged as its seat's. One the game
   * had gone on without, marked away, is back first. A refused command is
   * noted, so it isn't tried again soon; a failed write is logged, and the
   * NPC tries again next time.
   */
  playNpcs() {
    this.seats.forEach((_, seat) => {
      if (!this.npcSeat(seat) || (this.game.tick + seat * 3) % NPC.think !== 0) return;
      let memory = this.npcMemory.get(seat);
      if (!memory) this.npcMemory.set(seat, memory = npcMemory());
      try {
        if (this.game.players[seat]?.away !== undefined) this.commit(seat, { type: 'back' });
        for (let i = 0; i < NPC.perThink; i++) {
          const command = npcMove(this.board, this.game, seat, memory);
          if (!command) break;
          const outcome = this.commit(seat, /** @type {Record<string, string | number | string[]>} */ (command));
          if (!outcome.ok) {
            npcRefused(memory, command, this.game.tick);
            break;
          }
        }
      } catch (e) {
        logger.error(`game ${this.gameId}: the NPC in seat ${seat} failed`, e);
      }
    });
  }

  /**
   * Save the game's state. A failed save loses nothing the log doesn't have,
   * so it is logged and the game goes on; the next one is due in ten seconds.
   */
  snapshot() {
    if (this.deleted) return;
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
    if (this.deleted) return ctx?.reject('the game is gone');
    const seat = this.seatOf(client.auth.pid);
    if (seat === null) return ctx?.reject('not seated');
    const command = flatCommand(message);
    if (!command) return ctx?.reject('not a command');
    // Only the room says who is away.
    if (ROOM_COMMANDS.includes(String(command.type))) return ctx?.reject('unknown command');
    // Renaming the game needs no clock: players waiting for the rest may.
    if (!this.state.running && command.type !== 'rename') return ctx?.reject('the game is paused');

    const outcome = this.commit(seat, command);
    if (!outcome.ok) return ctx?.reject(outcome.reason);
    // The lobby reads names from the snapshot, which a paused game never takes.
    if (command.type === 'rename') this.snapshot();
    return this.seq;
  }

  /**
   * Apply a command on a copy of the game, log it with its tick, then adopt
   * the copy. Throws if the write fails, leaving the live game as it was.
   * @param {number} seat The side giving it.
   * @param {Record<string, string | number | string[]>} command
   * @returns {import('../src/core/game.js').Outcome}
   */
  commit(seat, command) {
    const next = structuredClone(this.game);
    const outcome = applyCommand(this.board, next, seat, command);
    if (!outcome.ok) return outcome;
    this.seq = this.storage.recordCommand(this.gameId, { tick: this.game.tick, player: seat, command });
    this.game = next;
    syncGame(this.state, publicView(next));
    return outcome;
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
   * A free seat whose castle stands: the one wanted if it is, else the next
   * after the last seat anyone has held (or holds), round the ring of
   * castles, clockwise from the left. So seats fill in order (in two teams,
   * the first team's, then the second's), and one let go of comes round
   * again only after the others.
   * @param {number | null} [wanted]
   * @returns {number | null}
   */
  freeSeat(wanted = null) {
    const free = (/** @type {number} */ i) => this.seats[i] === null && this.standing(i);
    if (wanted !== null && Number.isInteger(wanted) && free(wanted)) return wanted;
    const last = this.storage.namedSeats(this.gameId).findLastIndex((pid) => pid !== null);
    const count = this.seats.length;
    for (let k = 1; k <= count; k++) {
      const seat = (last + k) % count;
      if (free(seat)) return seat;
    }
    return null;
  }

  /**
   * Give the player the next free seat whose castle stands (`freeSeat`),
   * unless they already have a seat.
   * @param {string} pid
   * @returns {number | null} Their seat, or null when no seat is free.
   */
  takeSeat(pid) {
    const held = this.seatOf(pid);
    if (held !== null) return held;
    if (this.barred(pid)) return null;
    return this.moveTo(pid, this.freeSeat());
  }

  /**
   * Whether a player may not take another seat: in a game of player
   * against player with NPCs, one whose castle fell (holding its seat or
   * the last to leave it) may only watch.
   * @param {string} pid
   */
  barred(pid) {
    if (fallenMayMove(this.game)) return false;
    return this.storage.namedSeats(this.gameId).some((holder, seat) => holder === pid && !this.standing(seat));
  }

  /**
   * A player asks for a seat: a free one, or, once their own side has lost,
   * a free one in its place. The one they want if it is free.
   * @param {string} pid
   * @param {number | null} wanted
   * @returns {number | null} Their seat, or null when no seat is free.
   */
  claimSeat(pid, wanted) {
    const held = this.seatOf(pid);
    if (held !== null && this.standing(held)) return held;
    if (this.game.over !== undefined || this.barred(pid)) return held;
    return this.moveTo(pid, this.freeSeat(wanted)) ?? held;
  }

  /**
   * Seat a player, freeing the seat they had; a player away from it is back.
   * @param {string} pid
   * @param {number | null} seat
   * @returns {number | null} The seat, or null for none.
   */
  moveTo(pid, seat) {
    if (seat === null) return null;
    this.npcMemory.delete(seat); // a player has it now; an NPC starts afresh if it gets it back
    this.saveSeats(this.seats.map((holder, i) => (i === seat ? pid : holder === pid ? null : holder)));
    this.welcomeBack();
    return seat;
  }

  /**
   * The game has been deleted: send everyone away, and save nothing more of
   * it, not even when the room closes.
   */
  abandon() {
    this.deleted = true;
    this.disconnect().catch((/** @type {unknown} */ e) => logger.error(`game ${this.gameId}: closing failed`, e));
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
   * Players who join take the free seats in turn round the ring, those
   * whose castles stand; one the game went on without is back.
   * @param {import('@colyseus/core').Client} client
   */
  onJoin(client) {
    const { pid, name } = client.auth;
    const seat = this.takeSeat(pid);
    this.state.viewers.set(client.sessionId, new ViewerState({ pid, name, seat: seat ?? -1 }));
    this.welcomeBack();
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
   * it, however long they are away, and the game waits for them, unless its
   * creator has it go on without them (`startNow`).
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
