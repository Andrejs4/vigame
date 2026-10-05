/**
 * The lobby: the player's own games under way, games waiting for a player,
 * other people's under way (to watch), the finished ones (to see their
 * points again), and starting a new one. Opening a game goes to
 * `?game=<id>`, the same address an invitation link has.
 */

import { hasLord } from '../core/game.js';
import { MODES, SIDES, TICKS_PER_SECOND } from '../core/rules.js';
import { getJson, post, reason } from './api.js';

/** How often the lists refresh while the lobby is open. */
const REFRESH_MS = 5000;

/** How many of other people's games under way the lobby lists. */
const ONGOING_SHOWN = 10;

/** Where the browser keeps which of the lobby's lists are open. */
const OPEN_KEY = 'vigame.lobbyOpen';

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
  if (hasLord(game.mode)) return game.winner === 0 ? 'won' : 'the Dark Lord won';
  return `${SIDES[game.winner]?.name ?? '?'} won`;
}

/**
 * One game as a list row: its name, who plays which side, how far it has
 * got, and a button to open it.
 * @param {import('./api.js').GameSummary} game
 * @param {string} action The button's label.
 */
function row(game, action) {
  const li = document.createElement('li');
  const who = document.createElement('span');
  who.className = 'who';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = game.name ?? 'A game';
  who.append(title);
  // Teammates with "&", rivals with "vs".
  const between = hasLord(game.mode) ? ' & ' : ' vs ';
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
  const actions = document.createElement('span');
  actions.className = 'actions';
  actions.append(open);
  li.append(who, actions);
  return li;
}

/**
 * Fill one of the lobby's lists, with its count in its heading, or its note
 * when it has none.
 * @param {string} name
 * @param {import('./api.js').GameSummary[]} games
 * @param {string} action The buttons' label.
 */
function fill(name, games, action) {
  const byId = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  byId(`lobby-${name}`).replaceChildren(...games.map((g) => row(g, action)));
  byId(`lobby-${name}-empty`).hidden = games.length > 0;
  byId(`lobby-${name}-count`).textContent = games.length ? String(games.length) : '';
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
  const newButton = /** @type {HTMLButtonElement} */ (document.getElementById('lobby-new'));
  const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('lobby-mode'));
  const playersSelect = /** @type {HTMLSelectElement} */ (document.getElementById('lobby-players'));

  // Each list, and How to play and About, stays open or shut as the player
  // last left it, in this browser.
  const sections = /** @type {HTMLDetailsElement[]} */ ([...page.querySelectorAll('details.games-list')]);
  try {
    const kept = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
    for (const s of sections) if (typeof kept[s.id] === 'boolean') s.open = kept[s.id];
  } catch { /* nothing kept: as the page has them */ }
  for (const s of sections) {
    s.ontoggle = () => {
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(Object.fromEntries(sections.map((x) => [x.id, x.open]))));
      } catch { /* not kept */ }
    };
  }

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
    const going = games.filter((g) => g.over === null);
    const others = going.filter((g) => !isMine(g));
    fill('mine', going.filter(isMine), 'Open');
    fill('open', others.filter((g) => g.seats.some((s) => s === null)), 'Join');
    // Every seat taken, most recently active first: opening one watches it.
    fill('playing', others.filter((g) => g.seats.every((s) => s !== null)).slice(0, ONGOING_SHOWN), 'Watch');
    // Anyone's, all of them, most recent first: opening one shows its table of points.
    fill('done', games.filter((g) => g.over !== null), 'Scores');
  }

  nameOut.textContent = me.name;
  say(notice);
  page.hidden = false;
  refresh();
  setInterval(refresh, REFRESH_MS);

  const limit = /** @type {HTMLElement} */ (document.getElementById('lobby-limit'));
  limit.hidden = true;

  /**
   * A button that takes a game off the player's hands, after asking: deletes
   * one of theirs nobody else plays, or gives up their seat in one.
   * @param {import('./api.js').GameSummary} game
   * @param {'delete' | 'leave'} how
   */
  function clearButton(game, how) {
    const button = document.createElement('button');
    const name = game.name ?? 'this game';
    button.textContent = how === 'delete' ? 'Delete' : 'Leave';
    button.title = how === 'delete' ? 'Delete it for good: nobody else plays it' : 'Give up your seat, for someone else to take';
    button.onclick = async () => {
      const ask = how === 'delete' ? `Delete “${name}” for good?` : `Leave “${name}”? Your seat goes to whoever comes next.`;
      if (!confirm(ask)) return;
      button.disabled = true;
      try {
        const res = await post(`api/games/${encodeURIComponent(game.id)}/${how}`, { token });
        if (!res.ok) throw new Error(await reason(res));
        limit.hidden = true;
        say(how === 'delete' ? `Deleted “${name}”.` : `Left “${name}”.`);
        refresh();
      } catch (e) {
        say(`Could not ${how === 'delete' ? 'delete' : 'leave'} “${name}” (${/** @type {Error} */ (e).message}).`);
        button.disabled = false;
      }
    };
    return button;
  }
  newButton.onclick = async () => {
    newButton.disabled = true;
    limit.hidden = true;
    try {
      const res = await post('api/games', { token, mode: modeSelect.value, players: Number(playersSelect.value) });
      // Too many games on the go: the server says which, to go back to.
      if (res.status === 409) {
        const { error, games } = await res.json();
        /** @type {HTMLElement} */ (document.getElementById('lobby-limit-text')).textContent = error;
        const isMine = (/** @type {import('./api.js').GameSummary} */ g) => g.seats.some((s) => s?.pid === me.pid);
        /** @type {HTMLElement} */ (document.getElementById('lobby-limit-games')).replaceChildren(
          ...(/** @type {Array<import('./api.js').GameSummary & { clear: 'delete' | 'leave' | null }>} */ (games)).map((g) => {
            const li = row(g, isMine(g) ? 'Open' : 'Join');
            if (g.clear) li.querySelector('.actions')?.prepend(clearButton(g, g.clear));
            return li;
          }));
        limit.hidden = false;
        newButton.disabled = false;
        return;
      }
      if (!res.ok) throw new Error(await reason(res));
      const { id } = await res.json();
      location.search = gameHref(id);
    } catch (e) {
      say(`Could not start a game (${/** @type {Error} */ (e).message}).`);
      newButton.disabled = false;
    }
  };
}
