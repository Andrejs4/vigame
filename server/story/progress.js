/**
 * Story mode on the server: each player's place in the story (the
 * `stories` table), starting or going back to the act they are on, and
 * moving on when an act ends. One story per player: lost, it starts again
 * from the first act; the last act won, it is complete.
 */

import { randomBytes } from 'node:crypto';

import { ACTS, newStoryGame } from '../../src/story/acts.js';

/**
 * A player's place in the story, with an act's game that is gone, or over,
 * no longer counted as under way.
 * @param {import('../storage.js').Storage} storage
 * @param {string} pid
 */
export function progressOf(storage, pid) {
  const progress = storage.storyOf(pid);
  if (progress.gameId === null) return progress;
  const game = storage.loadGame(progress.gameId);
  const going = game !== null && /** @type {any} */ (game.state)?.over === undefined;
  return going ? progress : { ...progress, gameId: null };
}

/**
 * The game of the act the player is on: the one under way, or a new one.
 * @param {import('../storage.js').Storage} storage
 * @param {string} pid
 * @returns {string | null} Its id, or null once the story is complete.
 */
export function playStory(storage, pid) {
  const progress = progressOf(storage, pid);
  if (progress.complete) return null;
  if (progress.gameId !== null) return progress.gameId;
  const { seed, state } = newStoryGame(Math.min(progress.act, ACTS.length - 1));
  const id = randomBytes(6).toString('base64url');
  storage.createGame({ id, seed, state, seats: [pid], creator: pid });
  storage.saveStory(pid, { ...progress, gameId: id });
  return id;
}

/**
 * An act's game is over: won, the player goes on to the next act, or the
 * story is complete after the last; lost (or given up), it starts again
 * from the first act. A game that isn't the player's act now changes nothing.
 * @param {import('../storage.js').Storage} storage
 * @param {string} pid
 * @param {string} gameId
 * @param {{ winner?: number }} game
 */
export function storyEnded(storage, pid, gameId, game) {
  const progress = storage.storyOf(pid);
  if (progress.gameId !== gameId) return;
  const won = game.winner !== undefined;
  const last = progress.act >= ACTS.length - 1;
  storage.saveStory(pid, {
    act: !won ? 0 : last ? progress.act : progress.act + 1,
    gameId: null,
    complete: won && last,
  });
}

/**
 * The story's routes: where the player is in it, and playing on.
 * @param {import('express').Express} app
 * @param {import('../storage.js').Storage} storage
 * @param {{ signedIn: (storage: any, token: unknown) => boolean, playerId: (token: string) => string }} auth
 */
export function storyRoutes(app, storage, { signedIn, playerId }) {
  // `{ act, first, playing, complete }`: the act's id, whether it is the
  // first, and whether its game is under way.
  app.post('/api/story/status', (req, res) => {
    const token = req.body?.token;
    if (!signedIn(storage, token)) return void res.status(401).json({ error: 'sign in first' });
    const progress = progressOf(storage, playerId(token));
    res.json({
      act: ACTS[Math.min(progress.act, ACTS.length - 1)].id,
      first: progress.act === 0,
      playing: progress.gameId !== null,
      complete: progress.complete,
    });
  });
  // Start the story, or go back to it: `{ id }` of the act's game.
  app.post('/api/story', (req, res) => {
    const token = req.body?.token;
    if (!signedIn(storage, token)) return void res.status(401).json({ error: 'sign in first' });
    const id = playStory(storage, playerId(token));
    if (id === null) return void res.status(409).json({ error: 'the story is complete' });
    res.status(201).json({ id });
  });
}
