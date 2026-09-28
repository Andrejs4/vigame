/**
 * The game server: Colyseus for play over WebSocket, plus a little HTTP.
 *
 *   GET  /                      the game page (?game=<id> joins that game)
 *   GET  /vendor/colyseus.js    the Colyseus browser client the page uses
 *   GET  /api/challenge         a sum to answer when signing in -> { id, question }
 *   POST /api/players           sign in: { token, name, challenge, answer } -> { pid, name }
 *   POST /api/games             start a game: { token } -> 201 { id }
 *   GET  /api/games             recently active games (a lobby)
 *   GET  /api/games/:id         one game's snapshot and seats
 *   GET  /api/games/:id/commands  its command log (history, replays)
 *   /monitor                    Colyseus monitor, only with a monitor password
 *   /playground                 Colyseus playground, only in dev mode
 *   /matchmake/…                Colyseus matchmaking (joinOrCreate etc.)
 */

import { randomBytes, randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { Server, basicAuth } from '@colyseus/core';
import { monitor } from '@colyseus/monitor';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';

import { build } from '../scripts/build.js';
import { BOARD_OPTIONS, createBoard } from '../src/board.js';
import { newGame } from '../src/game.js';
import { cleanPlayerName } from '../src/player.js';
import { SIDES, TICKS_PER_SECOND } from '../src/rules.js';
import { createChallenges } from './challenge.js';
import { gameRoom, isToken, playerId, signedIn } from './room.js';
import { openStorage } from './storage.js';

const require = createRequire(import.meta.url);
const SDK_BUNDLE = join(dirname(require.resolve('@colyseus/sdk/package.json')), 'dist', 'colyseus.js');

/** What game ids look like, so a malformed one is a 404 without a lookup. */
const GAME_ID = /^[\w-]{1,64}$/;

/**
 * Start a new game and store it.
 * @param {import('./storage.js').Storage} storage
 * @param {{ seed?: number }} [options]
 * @returns {string} The new game's id.
 */
export function startGame(storage, { seed = randomInt(1, 2 ** 31) } = {}) {
  const id = randomBytes(6).toString('base64url');
  const state = newGame(createBoard({ ...BOARD_OPTIONS, seed }));
  storage.createGame({ id, seed, state, seats: SIDES.map(() => null) });
  return id;
}

/**
 * The game page: the bundled page with the Colyseus client loaded first. The
 * page sees `window.Colyseus` and plays through this server.
 *
 * The page uses only relative addresses, here and in main.js, so a proxy can
 * serve the whole game under a subfolder.
 */
function page() {
  return build({ preamble: '<script src="vendor/colyseus.js"></script>\n' });
}

/**
 * @param {object} [options]
 * @param {number} [options.port=2567] 0 picks a free port.
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.db=':memory:'] SQLite file.
 * @param {string} [options.monitorPassword] Mounts /monitor behind this password (user "admin").
 * @param {boolean} [options.dev=false] Rebuild the page on every request and mount /playground.
 * @param {boolean} [options.handleSignals=false] Shut down gracefully on SIGINT/SIGTERM.
 * @param {object} [options.logger] Where Colyseus logs; console by default.
 * @param {number} [options.tickRate] Game ticks per real second. Tests speed it up.
 */
export async function startGameServer({
  port = 2567,
  host = '127.0.0.1',
  db = ':memory:',
  monitorPassword,
  dev = false,
  handleSignals = false,
  logger,
  tickRate = TICKS_PER_SECOND,
} = {}) {
  const storage = openStorage(db);
  const challenges = createChallenges();
  const playground = dev ? (await import('@colyseus/playground')).playground : null;
  const cachedPage = dev ? null : page();

  const server = new Server({
    transport: new WebSocketTransport(),
    greet: false,
    gracefullyShutdown: handleSignals,
    auth: false,
    logger,
    express: (app) => {
      app.get('/', (_req, res) => {
        res.set('cache-control', 'no-store').type('html').send(cachedPage ?? page());
      });
      app.get('/vendor/colyseus.js', (_req, res) => { res.sendFile(SDK_BUNDLE); });
      // For stepping into the client in DevTools.
      app.get('/vendor/colyseus.js.map', (_req, res) => { res.sendFile(`${SDK_BUNDLE}.map`); });

      // Request bodies are a few short fields.
      app.use('/api', express.json({ limit: '2kb' }));

      app.get('/api/challenge', (_req, res) => {
        res.set('cache-control', 'no-store').json(challenges.issue());
      });
      // Signing in, and changing name: both answer a new sum.
      app.post('/api/players', (req, res) => {
        const { token, name, challenge, answer } = req.body ?? {};
        if (!isToken(token)) return void res.status(400).json({ error: 'bad token' });
        const clean = cleanPlayerName(name);
        // Checked before the sum, so a bad name doesn't use up the challenge.
        if (!clean) return void res.status(400).json({ error: 'bad name' });
        if (!challenges.check(challenge, answer)) return void res.status(403).json({ error: 'wrong answer' });
        const pid = playerId(token);
        storage.savePlayer(pid, clean);
        res.json({ pid, name: clean });
      });

      app.post('/api/games', (req, res) => {
        if (!signedIn(storage, req.body?.token)) return void res.status(401).json({ error: 'sign in first' });
        res.status(201).json({ id: startGame(storage) });
      });
      app.get('/api/games', (_req, res) => { res.json(storage.listGames()); });
      app.get('/api/games/:id', (req, res) => {
        const saved = GAME_ID.test(req.params.id) ? storage.loadGame(req.params.id) : null;
        if (!saved) return void res.status(404).json({ error: 'no such game' });
        res.json(saved);
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

  server.define('game', gameRoom(storage), { storage, tickRate }).filterBy(['gameId']);
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
