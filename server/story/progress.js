/**
 * Story mode on the server: each player's place in the story (the
 * `stories` table), starting or going back to the act they are on, and
 * moving on when an act ends. One story per player: lost, it starts again
 * from the first act; the last act won, it is complete, until an act is
 * added: a player's place is the act to play next, past the last one once
 * all are won, which a new act then is.
 */

import { randomBytes } from 'node:crypto';

import { ACTS, newStoryGame, veteransOf } from '../../src/story/acts.js';

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
  if (progress.gameId !== null) return progress.gameId;
  if (complete(progress)) return null;
  const { seed, state } = newStoryGame(progress.act, progress.heroes);
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
 * @param {import('../../src/core/game.js').GameState} game
 */
export function storyEnded(storage, pid, gameId, game) {
  const progress = storage.storyOf(pid);
  if (progress.gameId !== gameId) return;
  // Won only by the player's own team: given up with the Dark Lord about, he wins.
  const won = game.winner !== undefined && game.winner === game.players[0]?.team;
  // Won, its heroes go on to the next act; lost, the story starts again without them.
  storage.saveStory(pid, { act: won ? progress.act + 1 : 0, gameId: null, heroes: won ? veteransOf(game) : [] });
}

/**
 * Whether every act is won: true until an act is added.
 * @param {import('../storage.js').StoryProgress} progress
 */
export const complete = (progress) => progress.act >= ACTS.length;

/**
 * Start the story again from the first act, by the player's choice: an
 * act's game under way is deleted (its room, if open, closes), and the
 * heroes alive in it, and those still waiting, come along; with none
 * under way, those kept from the acts won do.
 * @param {import('../storage.js').Storage} storage
 * @param {string} pid
 * @param {(gameId: string) => { game: import('../../src/core/game.js').GameState, abandon(): void } | null} live
 *   A game's live room, if it has one: its game is newer than the last snapshot.
 */
export function resetStory(storage, pid, live) {
  const progress = progressOf(storage, pid);
  let heroes = progress.heroes;
  if (progress.gameId !== null) {
    const room = live(progress.gameId);
    const game = room?.game ?? /** @type {any} */ (storage.loadGame(progress.gameId))?.state;
    if (game?.story) heroes = veteransOf(game);
    room?.abandon();
    storage.deleteGame(progress.gameId);
  }
  storage.saveStory(pid, { act: 0, gameId: null, heroes });
}

/**
 * The story's routes: where the player is in it, playing on, and starting again.
 * @param {import('express').Express} app
 * @param {import('../storage.js').Storage} storage
 * @param {{ signedIn: (storage: any, token: unknown) => boolean, playerId: (token: string) => string,
 *   liveRoom: (gameId: string) => any }} deps
 */
export function storyRoutes(app, storage, { signedIn, playerId, liveRoom }) {
  // `{ act, first, playing, complete, players }`: the act's id, whether it
  // is the first, whether its game is under way, and how many players are
  // past the first act and have finished the story (`{ past, done }`).
  app.post('/api/story/status', (req, res) => {
    const token = req.body?.token;
    if (!signedIn(storage, token)) return void res.status(401).json({ error: 'sign in first' });
    const progress = progressOf(storage, playerId(token));
    res.json({
      act: ACTS[Math.min(progress.act, ACTS.length - 1)].id,
      first: progress.act === 0,
      playing: progress.gameId !== null,
      complete: complete(progress),
      players: storage.storyCounts(ACTS.length - 1),
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
  // Start the story again from the first act, with the heroes alive now.
  app.post('/api/story/reset', (req, res) => {
    const token = req.body?.token;
    if (!signedIn(storage, token)) return void res.status(401).json({ error: 'sign in first' });
    resetStory(storage, playerId(token), liveRoom);
    res.json({ ok: true });
  });
}
