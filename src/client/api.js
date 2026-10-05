/**
 * Talking to the game server over HTTP, and this browser's identity.
 *
 * Every address is relative to the page's own folder (`serverBase`), so a
 * proxy can serve the whole game under a subfolder such as `/vigame/`.
 */

/**
 * @typedef {{ pid: string, name: string }} Player A player as other players
 *   see them, such as in a seat.
 * @typedef {Player & { language: import('../core/player.js').Language }} Me
 *   The player this browser signed in as, with their settings.
 */

/**
 * @typedef {object} GameSummary A game as the lobby lists it.
 * @property {string} id
 * @property {string} mode A key of MODES.
 * @property {string | null} name What its players call it (null only for a
 *   game saved before games had names).
 * @property {number | null} over The tick it ended, or null while it's on.
 * @property {number | null} winner The team that won, if one did.
 * @property {number} tick
 * @property {Array<Player | null>} seats Who holds each seat.
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const TOKEN_KEY = 'vigame.token';
const NAME_KEY = 'vigame.name';

/**
 * Where the game server is, as seen from this page: the page's own folder.
 * Behind a proxy that serves the game under a subfolder, that folder is the
 * server's root, so every request is made relative to it.
 */
export function serverBase() {
  return new URL('.', location.href);
}

/**
 * This browser's secret player token, kept across visits so a returning
 * player keeps their name and seats. Anyone holding it can play as this
 * browser, so it never leaves the page except to the server.
 */
export function playerToken() {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved && /^[0-9a-f]{32}$/.test(saved)) return saved;
  } catch { /* storage blocked: a token for this visit only */ }
  // getRandomValues, not randomUUID: the latter needs a secure context, and a
  // server on the local network is plain http.
  const token = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* as above */ }
  return token;
}

/** The name this browser last signed in with, to fill the form with. */
export function savedName() {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}

/** @param {string} name */
export function saveName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* asked again next visit */ }
}

/**
 * POST JSON to the game server.
 * @param {string} path Relative to the server's base, such as 'api/games'.
 * @param {object} body
 */
export function post(path, body) {
  return fetch(new URL(path, serverBase()), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * GET JSON from the game server.
 * @param {string} path
 */
export async function getJson(path) {
  const res = await fetch(new URL(path, serverBase()), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/**
 * The error a failed response gives, or its status.
 * @param {Response} res
 */
export async function reason(res) {
  const body = await res.json().catch(() => ({}));
  return String(body.error ?? res.status);
}

/**
 * Who this token belongs to, or null if it hasn't signed in (or the server
 * no longer knows it). Throws when the server can't be reached.
 * @param {string} token
 * @returns {Promise<Me | null>}
 */
export async function whoAmI(token) {
  const res = await post('api/me', { token });
  if (!res.ok) throw new Error(`api/me: ${res.status}`);
  return res.json();
}
