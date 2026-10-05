/**
 * Entry point: decide which view to show.
 *
 *   not signed in            the login page, then on as below
 *   ?game=<id>               that game
 *   ?settings                the player's name and language
 *   anything else            the lobby
 *
 * Views switch with a page load (the lobby opens `?game=<id>`, the game's
 * Lobby button goes back to the bare address), so leaving a game always
 * leaves its room.
 */

import { playerToken, serverBase, whoAmI } from './api.js';
import { showLobby } from './lobby.js';
import { showLogin } from './login.js';
import { createServerNet } from './net.js';
import { startGame } from './play.js';
import { showSettings } from './settings.js';

/** @param {string} text */
function showProblem(text) {
  /** @type {HTMLElement} */ (document.getElementById('problem-text')).textContent = text;
  /** @type {HTMLElement} */ (document.getElementById('problem')).hidden = false;
}

/**
 * Join a game and play it.
 * @param {string} token
 * @param {import('./api.js').Me} me
 * @param {string} gameId
 */
async function openGame(token, me, gameId) {
  const Colyseus = /** @type {any} */ (globalThis).Colyseus;
  let net;
  try {
    net = await createServerNet({ client: new Colyseus.Client(serverBase().href), gameId, token });
  } catch (e) {
    const why = String(/** @type {any} */ (e)?.message);
    // The server forgot this browser between checking and joining (a new
    // database, say): sign in again and retry.
    if (/sign in first/.test(why)) return openGame(token, await showLogin(token), gameId);
    history.replaceState(null, '', serverBase().pathname);
    return showLobby(token, me, { notice: { word: /no game/.test(why) ? 'noSuchGame' : 'notOpened' } });
  }
  // Closing or reloading the page is leaving, not a dropped connection the
  // server should hold a place open for.
  addEventListener('pagehide', () => { net.leave(); });
  // A page restored from the back-forward cache has lost its connection.
  addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  return startGame(net, me);
}

async function main() {
  const token = playerToken();
  let me;
  try {
    me = await whoAmI(token);
  } catch {
    showProblem('Could not reach the game server.');
    return;
  }
  me ??= await showLogin(token);

  const address = new URLSearchParams(location.search);
  const gameId = address.get('game');
  if (gameId) await openGame(token, me, gameId);
  else if (address.has('settings')) showSettings(token, me);
  else showLobby(token, me);
}

main().catch((e) => showProblem(`Something went wrong: ${e?.message ?? e}`));
