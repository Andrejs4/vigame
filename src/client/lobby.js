/**
 * The lobby: the player's own games under way, games waiting for a player,
 * the last few finished (to see their points again), and starting a new one. Opening a game goes to `?game=<id>`, the same address
 * an invitation link has.
 */

import { MODES, SIDES, TICKS_PER_SECOND } from '../core/rules.js';
import { getJson, post, reason } from './api.js';
import { showLogin } from './login.js';

/** How often the lists refresh while the lobby is open. */
const REFRESH_MS = 5000;

/** How many finished games the lobby lists. */
const RECENT_DONE = 5;

/**
 * The address of a game, relative to the lobby's.
 * @param {string} id
 */
export function gameHref(id) {
  return `?game=${encodeURIComponent(id)}`;
}

/** @param {number} tick */
function gameTime(tick) {
  const s = Math.floor((tick || 0) / TICKS_PER_SECOND);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * How a finished game came out, in a few words.
 * @param {import('./api.js').GameSummary} game
 */
function result(game) {
  if (game.winner === null) return 'over, nobody won';
  if (game.mode === 'coop') return game.winner === 0 ? 'won' : 'the Dark Lord won';
  return `${SIDES[game.winner]?.name ?? '?'} won`;
}

/**
 * One game as a list row: who plays which side, how far it has got, and a
 * button to open it.
 * @param {import('./api.js').GameSummary} game
 * @param {string} action The button's label.
 */
function row(game, action) {
  const li = document.createElement('li');
  const who = document.createElement('span');
  who.className = 'who';
  // Teammates with "&", rivals with "vs".
  const between = game.mode === 'coop' ? ' & ' : ' vs ';
  game.seats.forEach((holder, i) => {
    if (i) who.append(between);
    const name = document.createElement('span');
    name.textContent = holder ? holder.name || '?' : '—';
    name.style.color = holder ? SIDES[i]?.accent ?? '' : '';
    who.append(name);
  });
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = `${MODES[/** @type {keyof typeof MODES} */ (game.mode)] ?? ''} · ${gameTime(game.tick)}${game.over === null ? '' : ` · ${result(game)}`}`;
  who.append(when);

  const open = document.createElement('a');
  open.className = 'button';
  open.href = gameHref(game.id);
  open.textContent = action;
  li.append(who, open);
  return li;
}

/**
 * Show the lobby. It stays up until the player opens a game, which loads
 * that game's address.
 * @param {string} token
 * @param {import('./api.js').Player} me
 * @param {{ notice?: string }} [options] Something to say first, such as why
 *   the game they asked for isn't open.
 */
export function showLobby(token, me, { notice } = {}) {
  const page = /** @type {HTMLElement} */ (document.getElementById('lobby'));
  const nameOut = /** @type {HTMLElement} */ (document.getElementById('lobby-name'));
  const noticeOut = /** @type {HTMLElement} */ (document.getElementById('lobby-notice'));
  const mine = /** @type {HTMLElement} */ (document.getElementById('lobby-mine'));
  const open = /** @type {HTMLElement} */ (document.getElementById('lobby-open'));
  const done = /** @type {HTMLElement} */ (document.getElementById('lobby-done'));
  const doneEmpty = /** @type {HTMLElement} */ (document.getElementById('lobby-done-empty'));
  const mineEmpty = /** @type {HTMLElement} */ (document.getElementById('lobby-mine-empty'));
  const openEmpty = /** @type {HTMLElement} */ (document.getElementById('lobby-open-empty'));
  const newButton = /** @type {HTMLButtonElement} */ (document.getElementById('lobby-new'));
  const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('lobby-mode'));
  const playersSelect = /** @type {HTMLSelectElement} */ (document.getElementById('lobby-players'));
  const rename = /** @type {HTMLElement} */ (document.getElementById('lobby-rename'));

  /** @param {string} [text] */
  function say(text) {
    noticeOut.textContent = text ?? '';
    noticeOut.hidden = !text;
  }

  async function refresh() {
    /** @type {import('./api.js').GameSummary[]} */
    let games;
    try {
      games = await getJson('api/games');
    } catch {
      say('Could not reach the game server.');
      return;
    }
    const isMine = (/** @type {import('./api.js').GameSummary} */ g) => g.seats.some((s) => s?.pid === me.pid);
    const mineList = games.filter((g) => isMine(g) && g.over === null);
    const openList = games.filter((g) => !isMine(g) && g.over === null && g.seats.some((s) => s === null));
    // Anyone's, most recent first: opening one shows its table of points.
    const doneList = games.filter((g) => g.over !== null).slice(0, RECENT_DONE);
    mine.replaceChildren(...mineList.map((g) => row(g, 'Open')));
    open.replaceChildren(...openList.map((g) => row(g, 'Join')));
    done.replaceChildren(...doneList.map((g) => row(g, 'Scores')));
    mineEmpty.hidden = mineList.length > 0;
    openEmpty.hidden = openList.length > 0;
    doneEmpty.hidden = doneList.length > 0;
  }

  nameOut.textContent = me.name;
  say(notice);
  page.hidden = false;
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);

  newButton.onclick = async () => {
    newButton.disabled = true;
    try {
      const res = await post('api/games', { token, mode: modeSelect.value, players: Number(playersSelect.value) });
      if (!res.ok) throw new Error(await reason(res));
      const { id } = await res.json();
      location.search = gameHref(id);
    } catch (e) {
      say(`Could not start a game (${/** @type {Error} */ (e).message}).`);
      newButton.disabled = false;
    }
  };

  rename.onclick = async (e) => {
    e.preventDefault();
    clearInterval(timer);
    page.hidden = true;
    const renamed = await showLogin(token);
    showLobby(token, renamed);
  };
}
