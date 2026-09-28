/**
 * The game server: Colyseus for play over WebSocket, plus a little HTTP.
 *
 *   GET  /                      the game page (?game=<id> joins that game)
 *   GET  /vendor/colyseus.js    the Colyseus browser client the page uses
 *   POST /api/games             start a game          -> 201 { id }
 *   GET  /api/games             recently active games (a lobby)
 *   GET  /api/games/:id         one game's state and seats
 *   GET  /api/games/:id/moves   its move log (history, replays)
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

import { build } from '../scripts/build.js';
import { BOARD_OPTIONS, createBoard } from '../src/board.js';
import { PLAYERS, createGame } from '../src/game.js';
import { serialize } from '../src/net.js';
import { GameRoom } from './room.js';
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
export function newGame(storage, { seed = randomInt(1, 2 ** 31) } = {}) {
  const id = randomBytes(6).toString('base64url');
  const board = createBoard({ ...BOARD_OPTIONS, seed });
  storage.createGame({
    id,
    seed,
    state: serialize(board, createGame(board)),
    seats: PLAYERS.map(() => null),
  });
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
 */
export async function startGameServer({
  port = 2567,
  host = '127.0.0.1',
  db = ':memory:',
  monitorPassword,
  dev = false,
  handleSignals = false,
  logger,
} = {}) {
  const storage = openStorage(db);
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

      app.post('/api/games', (_req, res) => { res.status(201).json({ id: newGame(storage) }); });
      app.get('/api/games', (_req, res) => { res.json(storage.listGames()); });
      app.get('/api/games/:id', (req, res) => {
        const saved = GAME_ID.test(req.params.id) ? storage.loadGame(req.params.id) : null;
        if (!saved) return void res.status(404).json({ error: 'no such game' });
        res.json(saved);
      });
      app.get('/api/games/:id/moves', (req, res) => {
        const saved = GAME_ID.test(req.params.id) ? storage.loadGame(req.params.id) : null;
        if (!saved) return void res.status(404).json({ error: 'no such game' });
        res.json(storage.listMoves(saved.id));
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

  server.define('game', GameRoom, { storage }).filterBy(['gameId']);
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
