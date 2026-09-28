/**
 * The dev server's one-player clock (`npm run dev`). Its own file, because
 * Colyseus allows one game server per process and node:test runs each file
 * in its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@colyseus/sdk';

import { startGameServer } from '../server/app.js';
import { playerId } from '../server/room.js';

test('with soloClock, a game runs while any seated player is here', async () => {
  const quiet = () => {};
  const server = await startGameServer({
    port: 0, soloClock: true, tickRate: 100,
    logger: { debug: quiet, info: quiet, trace: quiet, warn: quiet, error: quiet },
  });
  try {
    const token = 'd'.repeat(32);
    server.storage.savePlayer(playerId(token), 'Dev');
    const res = await fetch(`${server.url}api/games`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const { id } = await res.json();

    const room = await new Client(server.url).joinOrCreate('game', { gameId: id, token });
    const end = Date.now() + 3000;
    const tick = () => Number(room.state.toJSON().fields?.tick ?? 0);
    while (tick() < 5) {
      assert.ok(Date.now() < end, 'the clock never started');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(room.state.toJSON().running, true);
    await room.leave();
  } finally {
    await server.close();
  }
});
