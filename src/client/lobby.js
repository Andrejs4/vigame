/**
 * The lobby: the player's own games under way, games waiting for a player,
 * other people's under way (to watch), the finished ones (to see their
 * points again), and starting a new one. Opening a game goes to
 * `?game=<id>`, the same address an invitation link has.
 *
 * It shows in the player's language: the one in their settings, or for
 * Auto, the one their name and browser suggest (`autoLanguage`).
 */

import { hasLord } from '../core/game.js';
import { MODES, SEAT_SIDES, SIDES, TICKS_PER_SECOND } from '../core/rules.js';
import { getJson, post, reason } from './api.js';
import { autoLanguage, browserLanguages, chosenLanguage } from './language.js';
import { WORDS, isWord, say, translate } from './words.js';

/** @typedef {import('./language.js').PageLanguage} PageLanguage */
/** @typedef {import('./words.js').Word} Word */

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
 * @param {PageLanguage} language
 */
function result(game, language) {
  if (game.winner === null) return say(language, { word: 'nobodyWon' });
  if (hasLord(game.mode)) return say(language, { word: game.winner === 0 ? 'won' : 'lordWon' });
  const side = SIDES[SEAT_SIDES[game.winner]]?.name.toLowerCase();
  return isWord(side) ? say(language, { word: 'sideWon', values: { side: say(language, { word: side }) } }) : '?';
}

/**
 * One game as a list row: its name, who plays which side, how far it has
 * got, and a button to open it.
 * @param {import('./api.js').GameSummary} game
 * @param {Word} action The button's label.
 * @param {PageLanguage} language
 */
function row(game, action, language) {
  const li = document.createElement('li');
  const who = document.createElement('span');
  who.className = 'who';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = game.name ?? say(language, { word: 'aGame' });
  who.append(title);
  // Teammates with "&", rivals with "vs".
  const between = hasLord(game.mode) ? ' & ' : ' vs ';
  game.seats.forEach((holder, i) => {
    if (i) who.append(between);
    const name = document.createElement('span');
    name.textContent = holder ? holder.name || '?' : '—';
    name.style.color = holder ? SIDES[SEAT_SIDES[i]]?.accent ?? '' : '';
    who.append(name);
  });
  const when = document.createElement('span');
  when.className = 'when';
  const mode = Object.hasOwn(MODES, game.mode) && isWord(game.mode) ? say(language, { word: game.mode }) : '';
  when.textContent = `${mode} · ${gameTime(game.tick)}${game.over === null ? '' : ` · ${result(game, language)}`}`;
  who.append(when);

  const open = document.createElement('a');
  open.className = 'button';
  open.href = gameHref(game.id);
  open.textContent = say(language, { word: action });
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
 * @param {Word} action The buttons' label.
 * @param {PageLanguage} language
 */
function fillList(name, games, action, language) {
  const byId = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  byId(`lobby-${name}`).replaceChildren(...games.map((g) => row(g, action, language)));
  byId(`lobby-${name}-empty`).hidden = games.length > 0;
  byId(`lobby-${name}-count`).textContent = games.length ? String(games.length) : '';
}

/**
 * Show the lobby. It stays up until the player opens a game, which loads
 * that game's address.
 * @param {string} token
 * @param {import('./api.js').Me} me
 * @param {{ notice?: import('./words.js').Said }} [options] Something to say
 *   first, such as why the game they asked for isn't open.
 */
export function showLobby(token, me, { notice } = {}) {
  const page = /** @type {HTMLElement} */ (document.getElementById('lobby'));
  const nameOut = /** @type {HTMLElement} */ (document.getElementById('lobby-name'));
  const noticeOut = /** @type {HTMLElement} */ (document.getElementById('lobby-notice'));
  const newButton = /** @type {HTMLButtonElement} */ (document.getElementById('lobby-new'));
  const modeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('lobby-mode'));
  const playersSelect = /** @type {HTMLSelectElement} */ (document.getElementById('lobby-players'));
  const language = chosenLanguage(me.language, autoLanguage(browserLanguages(), me.name));

  // Every text in the player's language; How to play and About are written
  // out in each, and only theirs shows.
  document.documentElement.lang = language;
  translate(page, language);
  for (const block of /** @type {NodeListOf<HTMLElement>} */ (page.querySelectorAll('.prose > [lang]'))) {
    block.hidden = block.lang !== language;
  }

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

  /** @param {import('./words.js').Said} [said] */
  function tell(said) {
    noticeOut.textContent = said ? say(language, said) : '';
    noticeOut.hidden = !said;
  }

  async function refresh() {
    /** @type {import('./api.js').GameSummary[]} */
    let games;
    try {
      games = await getJson('api/games');
    } catch {
      tell({ word: 'offline' });
      return;
    }
    const isMine = (/** @type {import('./api.js').GameSummary} */ g) => g.seats.some((s) => s?.pid === me.pid);
    const going = games.filter((g) => g.over === null);
    const others = going.filter((g) => !isMine(g));
    fillList('mine', going.filter(isMine), 'open', language);
    // A free seat whose castle stands; a fallen side's nobody can take.
    const open = (/** @type {import('./api.js').GameSummary} */ g) => g.seats.some((s, i) => s === null && !g.fallen?.includes(i));
    fillList('open', others.filter(open), 'join', language);
    // Every seat taken, most recently active first: opening one watches it.
    fillList('playing', others.filter((g) => !open(g)).slice(0, ONGOING_SHOWN), 'watch', language);
    // Anyone's, all of them, most recent first: opening one shows its table of points.
    fillList('done', games.filter((g) => g.over !== null), 'scores', language);
  }

  nameOut.textContent = me.name;
  tell(notice);
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
    const values = { game: game.name ?? say(language, { word: 'aGame' }) };
    const deleting = how === 'delete';
    button.textContent = say(language, { word: how });
    button.title = say(language, { word: deleting ? 'deleteTitle' : 'leaveTitle' });
    button.onclick = async () => {
      if (!confirm(say(language, { word: deleting ? 'askDelete' : 'askLeave', values }))) return;
      button.disabled = true;
      try {
        const res = await post(`api/games/${encodeURIComponent(game.id)}/${how}`, { token });
        if (!res.ok) throw new Error(await reason(res));
        limit.hidden = true;
        tell({ word: deleting ? 'deleted' : 'left', values });
        refresh();
      } catch (e) {
        tell({ word: deleting ? 'notDeleted' : 'notLeft', values: { ...values, why: /** @type {Error} */ (e).message } });
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
      // Too many games on the go: the server says how many and which, to go
      // back to.
      if (res.status === 409) {
        const { waiting, seated, games } = await res.json();
        const reasons = [
          ...(waiting ? [say(language, { word: 'tooManyWaiting', values: { n: waiting } })] : []),
          ...(seated ? [say(language, { word: 'tooManySeated', values: { n: seated } })] : []),
        ];
        /** @type {HTMLElement} */ (document.getElementById('lobby-limit-text')).textContent = say(language, {
          word: 'tooMany', values: { reasons: reasons.join(WORDS[language].and) },
        });
        const isMine = (/** @type {import('./api.js').GameSummary} */ g) => g.seats.some((s) => s?.pid === me.pid);
        /** @type {HTMLElement} */ (document.getElementById('lobby-limit-games')).replaceChildren(
          ...(/** @type {Array<import('./api.js').GameSummary & { clear: 'delete' | 'leave' | null }>} */ (games)).map((g) => {
            const li = row(g, isMine(g) ? 'open' : 'join', language);
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
      tell({ word: 'notStarted', values: { why: /** @type {Error} */ (e).message } });
      newButton.disabled = false;
    }
  };
}
