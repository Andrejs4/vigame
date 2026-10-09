/**
 * The game server: Colyseus for play over WebSocket, plus a little HTTP.
 *
 *   GET  /                      the page: login, lobby, and (?game=<id>) a game
 *   GET  /client/…, /core/…     the page's modules, as they are in src/
 *   GET  /vendor/colyseus.js    the Colyseus browser client the page uses
 *   GET  /api/challenge         a sum to answer when signing in -> { id, question }
 *   POST /api/players           sign in: { token, name, language, challenge, answer } -> { pid, name, language }
 *   POST /api/me                who a token belongs to: { token } -> { pid, name, language }, or null
 *   POST /api/settings          change name or language: { token, name?, language? } -> { pid, name, language }
 *   POST /api/games             start a game: { token } -> 201 { id }, or 409 { error, waiting, seated, games } with too many on the go
 *   GET  /api/games             recently active games, with who holds each seat (the lobby)
 *   GET  /api/scores            the ten best scores ever (the lobby's high scores)
 *   GET  /api/games/:id         one game's snapshot and seats
 *   GET  /api/games/:id/commands  its command log (history, replays)
 *   POST /api/games/:id/delete  delete a game you started that nobody else plays: { token }
 *   POST /api/games/:id/leave   give up your seat in a game under way: { token }
 *   /monitor                    Colyseus monitor, only with a monitor password
 *   /playground                 Colyseus playground, only in dev mode
 *   /matchmake/…                Colyseus matchmaking (joinOrCreate etc.)
 */

import { randomBytes, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server, basicAuth } from '@colyseus/core';
import { monitor } from '@colyseus/monitor';
import { Encoder } from '@colyseus/schema';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { newGame } from '../src/core/game.js';
import { cleanLanguage, cleanPlayerName } from '../src/core/player.js';
import { BREEDING, DEFAULT_BREEDING, DEFAULT_MODE, DEFAULT_PLAYERS, MAX_PLAYERS, MIN_PLAYERS, MODES, TICKS_PER_SECOND } from '../src/core/rules.js';
import { createChallenges } from './challenge.js';
import { gameRoom, isToken, liveRoom, playerId, signedIn } from './room.js';
import { openStorage } from './storage.js';

/**
 * Room to encode a game's whole state, as a joining player gets it. A
 * side's units take about 145 bytes each (300 of them about 42 KB), so this
 * fits games of up to about 900 units; Colyseus grows the buffer for bigger
 * ones by itself, warning in the log each time it does.
 */
export const STATE_BUFFER = 128 * 1024;
Encoder.BUFFER_SIZE = STATE_BUFFER;

const require = createRequire(import.meta.url);
const SDK_BUNDLE = join(dirname(require.resolve('@colyseus/sdk/package.json')), 'dist', 'colyseus.js');
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** What game ids look like, so a malformed one is a 404 without a lookup. */
const GAME_ID = /^[\w-]{1,64}$/;

/**
 * Start a new game and store it.
 * @param {import('./storage.js').Storage} storage
 * @param {{ seed?: number, mode?: string, breeding?: string, players?: number }} [options]
 * @returns {string} The new game's id.
 */
export function startGame(storage, {
  seed = randomInt(1, 2 ** 31), mode = DEFAULT_MODE, breeding = DEFAULT_BREEDING, players = DEFAULT_PLAYERS, creator = null,
} = {}) {
  const id = randomBytes(6).toString('base64url');
  const state = newGame(createBoard({ ...BOARD_OPTIONS, seed, players }), { mode, breeding });
  storage.createGame({ id, seed, state, seats: Array.from({ length: players }, () => null), creator });
  return id;
}

/** How many games a player may have on the go before starting another. */
export const GAMES_PER_PLAYER = 3;

/** A game nobody has played, joined or left for this long no longer counts. */
export const IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Whether a player has too many games on the go to start another: `limit`
 * of their own waiting for a player, or `limit` they hold a seat in, not
 * counting games idle for IDLE_MS. If so, why, in English and as counts
 * for the page to put in its own words (`waiting` and `seated`, 0 for one
 * that isn't a reason), and those games, so they can go back to one, or
 * clear it (`clearing`).
 * @template {{ creator: string | null, seats: Array<string | null>, fallen?: number[], updatedAt: number }} G
 * @param {G[]} games The player's games under way (`gamesUnderWayOf`).
 * @param {string} pid
 * @param {number} limit
 * @param {number} now
 * @returns {{ error: string, waiting: number, seated: number, games: G[] } | null}
 */
export function tooManyGames(games, pid, limit, now) {
  const fresh = games.filter((g) => now - g.updatedAt < IDLE_MS);
  // A free seat whose castle has fallen waits for nobody.
  const waiting = fresh.filter((g) => g.creator === pid && g.seats.some((s, i) => s === null && !g.fallen?.includes(i)));
  const seated = fresh.filter((g) => g.seats.includes(pid));
  const why = [
    ...(waiting.length >= limit ? [`${waiting.length} games of yours waiting for a player`] : []),
    ...(seated.length >= limit ? [`a seat in ${seated.length} games under way`] : []),
  ];
  if (!why.length) return null;
  const shown = fresh.filter((g) => (waiting.length >= limit && waiting.includes(g)) || (seated.length >= limit && seated.includes(g)));
  return {
    error: `You have ${why.join(', and ')}. Go back to one of them, or clear one, before starting another:`,
    waiting: waiting.length >= limit ? waiting.length : 0,
    seated: seated.length >= limit ? seated.length : 0,
    games: shown,
  };
}

/**
 * How a player can take a game under way off their hands: delete it, if
 * they started it and nobody else holds a seat; else leave it, if they hold
 * one; or neither.
 * @param {{ creator: string | null, seats: Array<string | null> }} game
 * @param {string} pid
 * @returns {'delete' | 'leave' | null}
 */
export function clearing(game, pid) {
  if (game.creator === pid && game.seats.every((s) => s === null || s === pid)) return 'delete';
  return game.seats.includes(pid) ? 'leave' : null;
}

/**
 * @param {object} [options]
 * @param {number} [options.port=2567] 0 picks a free port.
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.db=':memory:'] SQLite file.
 * @param {string} [options.monitorPassword] Mounts /monitor behind this password (user "admin").
 * @param {boolean} [options.dev=false] Mount /playground.
 * @param {boolean} [options.soloClock=false] Run a game's clock while any
 *   seated player is here, not only while both are: for trying things alone.
 * @param {boolean} [options.handleSignals=false] Shut down gracefully on SIGINT/SIGTERM.
 * @param {object} [options.logger] Where Colyseus logs; console by default.
 * @param {number} [options.tickRate] Game ticks per real second. Tests speed it up.
 * @param {number} [options.gamesPerPlayer] See `tooManyGames`; the tests that
 *   start many games for one player lift it.
 */
export async function startGameServer({
  port = 2567,
  host = '127.0.0.1',
  db = ':memory:',
  monitorPassword,
  dev = false,
  soloClock = false,
  handleSignals = false,
  logger,
  tickRate = TICKS_PER_SECOND,
  gamesPerPlayer = GAMES_PER_PLAYER,
} = {}) {
  const storage = openStorage(db);
  const challenges = createChallenges();
  const playground = dev ? (await import('@colyseus/playground')).playground : null;

  const server = new Server({
    transport: new WebSocketTransport(),
    greet: false,
    gracefullyShutdown: handleSignals,
    auth: false,
    logger,
    express: (app) => {
      // The page and its modules, straight from src/: no build step. Browsers
      // check back on every load (the default for static files), so an edit
      // shows up on reload.
      app.get('/', (_req, res) => {
        res.set('cache-control', 'no-cache').sendFile(join(SRC, 'client', 'index.html'));
      });
      app.use('/client', express.static(join(SRC, 'client'), { index: false }));
      app.use('/core', express.static(join(SRC, 'core'), { index: false }));
      app.get('/vendor/colyseus.js', (_req, res) => { res.sendFile(SDK_BUNDLE); });
      // For stepping into the client in DevTools.
      app.get('/vendor/colyseus.js.map', (_req, res) => { res.sendFile(`${SDK_BUNDLE}.map`); });

      // Request bodies are a few short fields.
      app.use('/api', express.json({ limit: '2kb' }));

      app.get('/api/challenge', (_req, res) => {
        res.set('cache-control', 'no-store').json(challenges.issue());
      });
      /**
       * The player a token belongs to as the page knows itself: id, name and
       * language. Null if it hasn't signed in.
       * @param {unknown} token
       */
      const me = (token) => {
        const player = isToken(token) ? storage.loadPlayer(playerId(token)) : null;
        return player && { pid: player.pid, name: player.name, language: player.language };
      };
      // Signing in answers a sum.
      app.post('/api/players', (req, res) => {
        const { token, name, language, challenge, answer } = req.body ?? {};
        if (!isToken(token)) return void res.status(400).json({ error: 'bad token' });
        const clean = cleanPlayerName(name);
        const lang = cleanLanguage(language);
        // Checked before the sum, so a bad name doesn't use up the challenge.
        if (!clean) return void res.status(400).json({ error: 'bad name' });
        // The login page always sends the language its script filled in (Auto
        // at least): a sign-in without one didn't come from the page, and
        // fails as a wrong answer does, using its sum up.
        if (language === undefined) {
          challenges.check(challenge, undefined);
          return void res.status(403).json({ error: 'wrong answer' });
        }
        if (!lang) return void res.status(400).json({ error: 'bad language' });
        if (!challenges.check(challenge, answer)) return void res.status(403).json({ error: 'wrong answer' });
        const pid = playerId(token);
        storage.savePlayer(pid, clean, lang);
        res.json({ pid, name: clean, language: lang });
      });
      // A POST, so the secret token travels in the body, not in the address.
      // Not signed in is an ordinary answer, null, not an error.
      app.post('/api/me', (req, res) => {
        res.set('cache-control', 'no-store').json(me(req.body?.token));
      });
      // The settings page: a new name, language, or both. No sum: the player
      // has signed in already.
      app.post('/api/settings', (req, res) => {
        const player = me(req.body?.token);
        if (!player) return void res.status(401).json({ error: 'sign in first' });
        // What isn't given stays as it is.
        const { name = player.name, language = player.language } = req.body;
        const clean = cleanPlayerName(name);
        const lang = cleanLanguage(language);
        if (!clean) return void res.status(400).json({ error: 'bad name' });
        if (!lang) return void res.status(400).json({ error: 'bad language' });
        storage.savePlayer(player.pid, clean, lang);
        res.json({ pid: player.pid, name: clean, language: lang });
      });

      app.post('/api/games', (req, res) => {
        if (!signedIn(storage, req.body?.token)) return void res.status(401).json({ error: 'sign in first' });
        const mode = req.body?.mode ?? DEFAULT_MODE;
        const breeding = req.body?.breeding ?? DEFAULT_BREEDING;
        const players = req.body?.players ?? DEFAULT_PLAYERS;
        if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode)) return void res.status(400).json({ error: 'unknown mode' });
        if (typeof breeding !== 'string' || !Object.hasOwn(BREEDING, breeding)) return void res.status(400).json({ error: 'unknown breeding' });
        if (!Number.isInteger(players) || players < MIN_PLAYERS || players > MAX_PLAYERS) {
          return void res.status(400).json({ error: `players must be ${MIN_PLAYERS} to ${MAX_PLAYERS}` });
        }
        if ((mode === 'ffa' || mode === 'teams') && players < 2) return void res.status(400).json({ error: `${MODES[mode].toLowerCase()} needs two players` });
        const creator = playerId(req.body.token);
        const crowded = tooManyGames(storage.gamesUnderWayOf(creator), creator, gamesPerPlayer, Date.now());
        if (crowded) {
          // Who started each stays on the server; the player learns only
          // what they may do with it.
          const games = crowded.games.map(({ creator: _creator, ...g }) => ({ ...g, clear: clearing({ creator: _creator, seats: g.seats }, creator) }));
          const { error, waiting, seated } = crowded;
          return void res.status(409).json({ error, waiting, seated, games: seatNames(games) });
        }
        res.status(201).json({ id: startGame(storage, { mode, breeding, players, creator }) });
      });
      /**
       * Games as the lobby lists them, with each seat's holder by name, and
       * its former holder's (who last left it), if any.
       * @template {{ seats: Array<string | null>, former?: Array<string | null> }} G
       * @param {G[]} games
       */
      const seatNames = (games) => {
        /** @type {Map<string, string>} */
        const names = new Map();
        const nameOf = (/** @type {string} */ pid) => {
          if (!names.has(pid)) names.set(pid, storage.loadPlayer(pid)?.name ?? '');
          return names.get(pid);
        };
        const named = (/** @type {string | null | undefined} */ pid) => (pid ? { pid, name: nameOf(pid) } : null);
        return games.map((g) => ({ ...g, seats: g.seats.map(named), former: (g.former ?? []).map(named) }));
      };
      app.get('/api/games', (_req, res) => {
        res.set('cache-control', 'no-store').json(seatNames(storage.listGames()));
      });
      app.get('/api/scores', (_req, res) => {
        res.set('cache-control', 'no-store').json(storage.bestScores());
      });
      app.get('/api/games/:id', (req, res) => {
        const saved = GAME_ID.test(req.params.id) ? storage.loadGame(req.params.id) : null;
        if (!saved) return void res.status(404).json({ error: 'no such game' });
        const { creator: _creator, ...shown } = saved;
        res.json(shown);
      });
      /**
       * A game under way that a signed-in player asks to clear, or why not.
       * @param {any} req
       * @param {any} res
       */
      const clearable = (req, res) => {
        if (!signedIn(storage, req.body?.token)) return void res.status(401).json({ error: 'sign in first' });
        const saved = GAME_ID.test(req.params.id) ? storage.loadGame(req.params.id) : null;
        if (!saved) return void res.status(404).json({ error: 'no such game' });
        if (/** @type {any} */ (saved.state)?.over !== undefined) return void res.status(409).json({ error: 'that game is over' });
        return { saved, pid: playerId(req.body.token) };
      };
      // Delete a game the player started, which nobody else plays: its room,
      // if open, closes, and the game and its commands are gone.
      app.post('/api/games/:id/delete', (req, res) => {
        const asked = clearable(req, res);
        if (!asked) return;
        const { saved, pid } = asked;
        if (saved.creator !== pid) return void res.status(403).json({ error: 'not a game you started' });
        if (clearing(saved, pid) !== 'delete') return void res.status(409).json({ error: 'someone else plays it' });
        liveRoom(saved.id)?.abandon();
        storage.deleteGame(saved.id);
        res.json({ ok: true });
      });
      // Give up the player's seat in a game, through its room if it is open,
      // so everyone there sees it free.
      app.post('/api/games/:id/leave', (req, res) => {
        const asked = clearable(req, res);
        if (!asked) return;
        const { saved, pid } = asked;
        if (!saved.seats.includes(pid)) return void res.status(409).json({ error: 'you have no seat there' });
        const room = liveRoom(saved.id);
        if (room) room.releaseSeat(pid);
        else storage.saveSeats(saved.id, saved.seats.map((s) => (s === pid ? null : s)));
        res.json({ ok: true });
      });
      // Who holds each seat, by name: for the table at a game's end, which
      // names players who have left as well as those still here, and those
      // who moved to another base on the side they left.
      app.get('/api/games/:id/seats', (req, res) => {
        const saved = GAME_ID.test(req.params.id) ? storage.loadGame(req.params.id) : null;
        if (!saved) return void res.status(404).json({ error: 'no such game' });
        // The holder, else whoever last held the seat (a player who moved to another base).
        res.set('cache-control', 'no-store').json(storage.namedSeats(saved.id).map((pid) => (pid ? { pid, name: storage.loadPlayer(pid)?.name ?? '' } : null)));
      });
      app.get('/api/games/:id/commands', (req, res) => {
        const saved = GAME_ID.test(req.params.id) ? storage.loadGame(req.params.id) : null;
        if (!saved) return void res.status(404).json({ error: 'no such game' });
        res.json(storage.listCommands(saved.id));
      });
      // Express's own error page carries a stack trace. A malformed request
      // gets a short answer instead, and a fault is logged here, not sent.
      app.use('/api', (/** @type {any} */ err, /** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ _next) => {
        const status = Number(err?.status ?? err?.statusCode);
        if (status >= 400 && status < 500) return void res.status(status).json({ error: 'bad request' });
        (logger ?? console).error(err);
        res.status(500).json({ error: 'server error' });
      });

      // The monitor shows every game's full state, and its API can call any
      // method on a live room: disconnect players, close rooms, move seats.
      // It exists only behind a password.
      if (monitorPassword) {
        app.use('/monitor', monitor({ use: [basicAuth({ users: { admin: monitorPassword }, realm: 'Vigame monitor' })] }));
      }
      if (playground) app.use('/playground', playground());
    },
  });

  server.define('game', gameRoom(storage), { storage, tickRate, soloClock }).filterBy(['gameId']);
  // Runs once every room is disposed, whether shutdown came from close() or,
  // with handleSignals, from Ctrl-C.
  server.onShutdown(() => storage.close());
  await server.listen(port, host);

  const address = /** @type {import('node:net').AddressInfo} */ (server.transport.server.address());

  return {
    url: `http://${host}:${address.port}/`,
    storage,
    /** Disconnect everyone, dispose every room, and close the database. */
    close: () => server.gracefullyShutdown(false),
  };
}
