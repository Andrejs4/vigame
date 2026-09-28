/**
 * Entry point: wires board, camera, renderer, input and networking around the
 * game core.
 *
 * Runs in two modes. Served by the Vigame game server (which loads the
 * Colyseus client first), it plays the game named in `?game=` through that
 * server. Anywhere else it runs the game core itself, and the one person at
 * the screen can play either side.
 */

import { bounds, key, pixelToAxial } from './hex.js';
import { BOARD_OPTIONS, TERRAIN, createBoard, tileAt } from './board.js';
import { capacityOf, nearStanding, newGame, occupancy } from './game.js';
import { BUILDING_TYPES, SIDES, TICKS_PER_SECOND, UNIT_LIMIT } from './rules.js';
import { Camera } from './camera.js';
import { createLocalNet, createServerNet } from './net.js';
import { PLAYER_NAME_MAX, cleanPlayerName } from './player.js';
import { BoardRenderer } from './render.js';

const SEED = 1337;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
const hud = {
  time: document.getElementById('time'),
  seat: document.getElementById('seat'),
  units: document.getElementById('units'),
  selection: document.getElementById('selection'),
  tile: document.getElementById('tile'),
  viewers: document.getElementById('viewers'),
};
const viewersRow = document.getElementById('viewers-row');
const seatButton = document.getElementById('seat-button');
const upgradeButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('upgrade'));
const sendAmountButton = document.getElementById('send-amount');
const buildButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('button[data-kind]')]);
const notice = document.getElementById('notice');
const message = document.getElementById('message');
const signinDialog = /** @type {HTMLDialogElement | null} */ (document.getElementById('signin'));

let board = createBoard({ ...BOARD_OPTIONS, seed: SEED });
const camera = new Camera();
let renderer = new BoardRenderer(canvas, board);

/** The game as last reported by the transport. */
/** @type {import('./net.js').GameView | null} */
let view = null;
/** What is where in `view`. */
/** @type {import('./game.js').Occupancy | null} */
let occ = null;
/** Whether anything is on the move, so the board must be redrawn every frame. */
let moving = false;

/** @type {{ q: number, r: number } | null} */
let hover = null;
/** @type {Array<import('./net.js').NetPeer>} */
let peers = [];
/** The selected building's id. */
/** @type {string | null} */
let selected = null;
/** The kind of building being placed, while in build mode. */
/** @type {string | null} */
let placing = null;
/** Whether a send takes every unit inside, or half. */
let sendAll = false;
/** @type {Set<string>} */
let highlights = new Set();
let showCoords = false;
let needsDraw = true;

/** Until the game server answers, or when there is none, the game runs here. */
const local = createLocalNet({ board, state: newGame(board) });
/** @type {ReturnType<typeof createLocalNet> | Awaited<ReturnType<typeof createServerNet>>} */
let net = local;

// --- state -----------------------------------------------------------------

/**
 * Rebuild the board for a different seed, keeping the camera where it is.
 * @param {number} seed
 */
function rebuildBoard(seed) {
  board = createBoard({ ...BOARD_OPTIONS, seed });
  renderer = new BoardRenderer(canvas, board);
  renderer.showCoords = showCoords;
}

/**
 * Take in the game as the transport reports it.
 * @param {import('./net.js').GameView} next
 */
function onState(next) {
  if (next.seed !== board.seed) rebuildBoard(next.seed);
  view = next;
  occ = occupancy(next);
  moving = Object.values(next.units).some((u) => u.path) || Object.values(next.buildings).some((b) => b.path);
  if (selected && !next.buildings[selected]) selected = null;
  refreshHighlights();
  updateHud();
  needsDraw = true;
}

/** Whether this viewer can give commands right now. */
function canCommand() {
  return net.seat() !== null && net.running();
}

/**
 * Whether a building is this viewer's own.
 * @param {string | null} id
 */
function isMine(id) {
  const seat = net.seat();
  return id !== null && seat !== null && view?.buildings[id]?.owner === seat;
}

/** In build mode, light up the cells where the building could go. */
function refreshHighlights() {
  const seat = net.seat();
  highlights = new Set();
  if (placing && view && occ && seat !== null) {
    for (const t of board.list) {
      const k = key(t.q, t.r);
      if (t.buildable && !occ.buildingAt.has(k) && nearStanding(/** @type {any} */ (view), seat, t)) highlights.add(k);
    }
  }
  needsDraw = true;
}

/** @param {number} tick */
function formatTime(tick) {
  const s = Math.floor(tick / TICKS_PER_SECOND);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateHud() {
  const seat = net.seat();
  const online = net.mode === 'online';

  if (hud.time) {
    const paused = online && !net.running();
    hud.time.textContent = `${formatTime(view?.tick ?? 0)}${paused ? ' · paused' : ''}`;
    hud.time.title = paused ? 'The game waits until both players are here' : '';
  }
  if (hud.seat) {
    const role = seat === null ? 'Spectator' : SIDES[seat].name;
    const me = peers.find((p) => p.isMe)?.name;
    hud.seat.textContent = me ? `${me} · ${role}` : role;
    hud.seat.style.color = seat === null ? '' : SIDES[seat].accent;
  }
  if (hud.units) {
    hud.units.textContent = seat !== null && occ ? `${occ.unitCount[seat] ?? 0} / ${UNIT_LIMIT}` : '—';
  }
  if (hud.selection) {
    const b = selected ? view?.buildings[selected] : null;
    if (b && occ) {
      const type = BUILDING_TYPES[b.type];
      const inside = occ.inside.get(b.id)?.length ?? 0;
      hud.selection.textContent = `${type.name} (grade ${b.grade}) · ${inside}/${capacityOf(b)}`;
      hud.selection.style.color = SIDES[b.owner]?.accent ?? '';
    } else {
      hud.selection.textContent = 'none';
      hud.selection.style.color = '';
    }
  }
  if (hud.tile) {
    const t = hover ? tileAt(board, hover.q, hover.r) : null;
    const rule = t && !t.passable ? ' — impassable' : t && !t.buildable ? ' — no building' : '';
    hud.tile.textContent = t ? `${TERRAIN[t.terrain].label} (${t.q}, ${t.r})${rule}` : '—';
  }

  if (viewersRow) viewersRow.hidden = !online;
  if (hud.viewers) hud.viewers.textContent = net.connected() ? String(net.viewers()) : 'offline';

  if (seatButton) {
    if (!online) {
      seatButton.hidden = false;
      seatButton.textContent = `Play ${SIDES[((seat ?? 0) + 1) % SIDES.length].name}`;
    } else {
      seatButton.hidden = seat === null && !net.canClaimSeat();
      seatButton.textContent = seat === null ? 'Take seat' : 'Release seat';
    }
  }

  const can = canCommand();
  for (const button of buildButtons) {
    button.disabled = !can;
    button.setAttribute('aria-pressed', String(placing === button.dataset.kind));
  }
  if (upgradeButton) {
    const b = selected ? view?.buildings[selected] : null;
    upgradeButton.disabled = !(can && b && isMine(selected) && b.grade < BUILDING_TYPES[b.type].grades);
  }
  if (sendAmountButton) sendAmountButton.textContent = sendAll ? 'Send all' : 'Send half';
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let messageTimer;

/**
 * Say briefly why something didn't happen.
 * @param {string} text
 */
function flash(text) {
  if (!message) return;
  message.textContent = text;
  message.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { message.hidden = true; }, 3000);
}

/**
 * Give a command, and say so if it is refused.
 * @param {Record<string, unknown>} cmd
 * @param {string} what What it was, for the message: "Can't {what}: {reason}."
 */
async function give(cmd, what) {
  const outcome = await net.send(cmd);
  if (!outcome.ok) flash(`Can't ${what}: ${outcome.reason}.`);
  return outcome.ok;
}

/**
 * The player clicked or tapped a cell.
 *
 * - In build mode: build there.
 * - With one of your buildings selected, on another of yours: send units
 *   there (half of those inside, or all).
 * - On any building: select it, or unselect it.
 * - With one of your wagons selected, anywhere else: drive it there.
 * - Anywhere else: unselect.
 * @param {{ q: number, r: number }} at
 */
async function act(at) {
  if (!view || !occ) return;
  if (placing) {
    if (!canCommand()) return;
    if (await give({ type: 'build', kind: placing, q: at.q, r: at.r }, 'build there')) placing = null;
    refreshHighlights();
    updateHud();
    return;
  }

  const here = occ.buildingAt.get(key(at.q, at.r)) ?? null;
  if (selected && here && here !== selected && isMine(selected) && isMine(here) && canCommand()) {
    const inside = occ.inside.get(selected)?.length ?? 0;
    await give({ type: 'send', from: selected, to: here, count: Math.max(1, sendAll ? inside : Math.ceil(inside / 2)) }, 'send units');
    return;
  }
  if (here) {
    selected = here === selected ? null : here;
  } else if (selected && isMine(selected) && BUILDING_TYPES[view.buildings[selected].type].speed && canCommand()) {
    await give({ type: 'move', building: selected, q: at.q, r: at.r }, 'go there');
    return;
  } else {
    selected = null;
  }
  updateHud();
  needsDraw = true;
}

// --- input -----------------------------------------------------------------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  needsDraw = true;
}

/**
 * Which hex is under a screen-space point.
 * @param {number} sx
 * @param {number} sy
 */
function hexAtScreen(sx, sy) {
  const world = camera.toWorld(sx, sy);
  return pixelToAxial(world.x, world.y, board.hexSize);
}

/** The pointer that is panning. A second finger must not hijack the drag. */
/** @type {number | null} */
let dragPointer = null;
let dragMoved = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (dragPointer !== null) return;
  dragPointer = e.pointerId;
  dragMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (e.pointerId === dragPointer) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
    camera.pan(dx, dy);
    lastX = e.clientX;
    lastY = e.clientY;
    needsDraw = true;
  }

  const h = hexAtScreen(sx, sy);
  const next = tileAt(board, h.q, h.r) ? h : null;
  if ((next && (!hover || next.q !== hover.q || next.r !== hover.r)) || (!next && hover)) {
    hover = next;
    needsDraw = true;
    updateHud();
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== dragPointer) return;
  dragPointer = null;
  canvas.releasePointerCapture(e.pointerId);
  if (dragMoved) return; // a drag is a pan, not a click

  const rect = canvas.getBoundingClientRect();
  const h = hexAtScreen(e.clientX - rect.left, e.clientY - rect.top);
  if (!tileAt(board, h.q, h.r)) return;

  // Touch has no hover, so the tapped hex stands in for it: outlined, and
  // described in the HUD's Tile row.
  if (e.pointerType !== 'mouse') hover = { q: h.q, r: h.r };

  // Everyone shares what they picked, spectators included.
  net.select({ q: h.q, r: h.r });
  act(h);
});

// The browser took the pointer over (a system gesture, a palm): end the drag
// rather than leave it stuck on.
canvas.addEventListener('pointercancel', (e) => {
  if (e.pointerId === dragPointer) dragPointer = null;
});

// A mouse that leaves the board is no longer over any hex. A finger "leaves"
// every time it lifts, and there the last tapped hex should stay in the HUD.
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse' || dragPointer !== null || !hover) return;
  hover = null;
  needsDraw = true;
  updateHud();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  camera.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
  needsDraw = true;
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || (!placing && !selected)) return;
  placing = null;
  selected = null;
  refreshHighlights();
  updateHud();
});

for (const button of buildButtons) {
  button.addEventListener('click', () => {
    const kind = button.dataset.kind ?? null;
    placing = placing === kind ? null : kind;
    refreshHighlights();
    updateHud();
  });
}

upgradeButton?.addEventListener('click', () => {
  if (selected) give({ type: 'upgrade', building: selected }, 'upgrade');
});

sendAmountButton?.addEventListener('click', () => {
  sendAll = !sendAll;
  updateHud();
});

seatButton?.addEventListener('click', () => {
  if (net === local) local.switchSide();
  else if (net.seat() !== null) net.releaseSeat();
  else net.claimSeat();
});

document.getElementById('toggle-coords')?.addEventListener('click', (e) => {
  showCoords = !showCoords;
  renderer.showCoords = showCoords;
  /** @type {HTMLElement} */ (e.currentTarget).setAttribute('aria-pressed', String(showCoords));
  needsDraw = true;
});

/**
 * Zoom about the centre of the viewport, for the on-screen buttons. Touch
 * devices have no wheel and pinch is not wired up yet.
 * @param {number} factor
 */
function zoomCentre(factor) {
  const rect = canvas.getBoundingClientRect();
  camera.zoomAt(factor, rect.width / 2, rect.height / 2);
  needsDraw = true;
}

document.getElementById('zoom-in')?.addEventListener('click', () => zoomCentre(1.25));
document.getElementById('zoom-out')?.addEventListener('click', () => zoomCentre(1 / 1.25));

document.getElementById('recenter')?.addEventListener('click', () => {
  const rect = canvas.getBoundingClientRect();
  camera.fit(bounds(board.list, board.hexSize), rect.width, rect.height);
  needsDraw = true;
});

window.addEventListener('resize', resize);

// --- boot ------------------------------------------------------------------

resize();
{
  const rect = canvas.getBoundingClientRect();
  camera.fit(bounds(board.list, board.hexSize), rect.width, rect.height);
}
local.onState(onState);
local.onSeat(() => { selected = null; refreshHighlights(); updateHud(); });

function frame() {
  // Queue the next frame first, so one frame that throws cannot stop the
  // board from ever redrawing again.
  requestAnimationFrame(frame);
  if (!needsDraw && !moving) return;
  needsDraw = false;
  renderer.draw({ camera, view, clock: net.clock(), selected, highlights, hover, peers });
}
requestAnimationFrame(frame);

/**
 * Say something about the connection in the status panel.
 * @param {string} text
 * @param {{ href: string, text: string }} [link]
 */
function showNotice(text, link) {
  if (!notice) return;
  notice.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    notice.append(' ', a);
  }
  notice.hidden = false;
}

/**
 * This browser's secret player token for the game server, kept across visits
 * so a returning player gets their seat back. Anyone holding it can play as
 * this browser, so it never leaves the page except to the server.
 */
function playerToken() {
  const KEY = 'vigame.token';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[0-9a-f]{32}$/.test(saved)) return saved;
  } catch { /* storage blocked: a token for this visit only */ }
  // getRandomValues, not randomUUID: the latter needs a secure context, and a
  // server on the local network is plain http.
  const token = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(KEY, token); } catch { /* as above */ }
  return token;
}

/**
 * Where the game server is, as seen from this page: the page's own folder.
 * Behind a proxy that serves the game under a subfolder (say `/vigame/`),
 * that folder is the server's root, so every request is made relative to it.
 */
function serverBase() {
  return new URL('.', location.href);
}

/** The name this browser last signed in with, if any. */
function savedName() {
  try { return localStorage.getItem('vigame.name'); } catch { return null; }
}

/**
 * POST JSON to the game server.
 * @param {string} path Relative to the server's base.
 * @param {object} body
 */
function post(path, body) {
  return fetch(new URL(path, serverBase()), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Ask for a name and the answer to the server's sum, and sign this browser's
 * token in with them. The dialog stays up until the server accepts.
 * @param {string} token
 * @returns {Promise<void>}
 */
function signIn(token) {
  const dialog = signinDialog;
  if (!dialog) return Promise.reject(new Error('no sign-in form'));
  const form = /** @type {HTMLFormElement} */ (dialog.querySelector('form'));
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('signin-name'));
  const answerInput = /** @type {HTMLInputElement} */ (document.getElementById('signin-answer'));
  const question = /** @type {HTMLElement} */ (document.getElementById('signin-question'));
  const error = /** @type {HTMLElement} */ (document.getElementById('signin-error'));
  const submit = /** @type {HTMLButtonElement} */ (document.getElementById('signin-submit'));

  /** The challenge on screen, or null while there is none. */
  /** @type {string | null} */
  let challenge = null;

  async function newQuestion() {
    challenge = null;
    answerInput.value = '';
    question.textContent = 'Loading the question…';
    try {
      const res = await fetch(new URL('api/challenge', serverBase()), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const next = await res.json();
      challenge = String(next.id);
      question.textContent = `What is ${next.question}?`;
    } catch {
      question.textContent = 'Could not load the question. Press Play to try again.';
    }
  }

  nameInput.value = savedName() ?? nameInput.value;
  const done = new AbortController();
  return new Promise((resolve) => {
    // The game needs a name: Escape doesn't dismiss the form.
    dialog.addEventListener('cancel', (e) => e.preventDefault(), { signal: done.signal });
    dialog.addEventListener('close', () => dialog.showModal(), { signal: done.signal });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      const name = cleanPlayerName(nameInput.value);
      if (!name) {
        error.textContent = `Use 1–${PLAYER_NAME_MAX} letters or digits. Spaces and - _ . ' may go between them.`;
        nameInput.focus();
        return;
      }
      if (!challenge) {
        await newQuestion();
        return;
      }
      submit.disabled = true;
      error.textContent = '';
      try {
        const res = await post('api/players', { token, name, challenge, answer: answerInput.value.trim() });
        if (res.ok) {
          try { localStorage.setItem('vigame.name', name); } catch { /* asked again next visit */ }
          done.abort();
          dialog.close();
          resolve();
          return;
        }
        const why = (await res.json().catch(() => ({}))).error;
        error.textContent = why === 'wrong answer' ? 'That’s not it. Try this one.' : `The server said no (${why ?? res.status}).`;
      } catch {
        error.textContent = 'Could not reach the game server.';
      } finally {
        submit.disabled = false;
      }
      // Every answer, right or wrong, uses its sum up.
      await newQuestion();
      answerInput.focus();
    }, { signal: done.signal });

    dialog.showModal();
    newQuestion();
    (nameInput.value ? answerInput : nameInput).focus();
  });
}

/**
 * Join the game in `?game=` on the server that served this page, starting a
 * new one first if the address names none.
 * @param {any} Client The Colyseus client class.
 * @param {string} token
 */
async function openServerGame(Client, token) {
  const params = new URLSearchParams(location.search);
  let gameId = params.get('game');
  if (!gameId) {
    const res = await post('api/games', { token });
    if (!res.ok) {
      const why = (await res.json().catch(() => ({}))).error;
      throw new Error(`starting a game failed: ${why ?? res.status}`);
    }
    gameId = String((await res.json()).id);
    params.set('game', gameId);
    // The address is now the invitation: send it to the other player.
    history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
  }
  return createServerNet({ client: new Client(serverBase().href), gameId, token });
}

/**
 * Sign in if this browser hasn't yet, then join the server's game.
 * @param {any} Client The Colyseus client class.
 */
async function joinServerGame(Client) {
  const token = playerToken();
  if (!savedName()) await signIn(token);
  try {
    return await openServerGame(Client, token);
  } catch (e) {
    // The server doesn't know this browser after all (a new database, say).
    if (!/sign in first/.test(String(/** @type {any} */ (e)?.message))) throw e;
    await signIn(token);
    return openServerGame(Client, token);
  }
}

/**
 * Switch to the game server's game, when the game server served this page.
 * Until then, and if that fails, the game runs on this screen.
 */
async function goOnline() {
  const g = /** @type {any} */ (globalThis);
  if (!g.Colyseus?.Client) return;
  /** @type {Awaited<ReturnType<typeof createServerNet>>} */
  let online;
  try {
    online = await joinServerGame(g.Colyseus.Client);
  } catch (e) {
    const missing = /no game/.test(String(/** @type {any} */ (e)?.message));
    showNotice(
      `${missing ? 'There is no game at this address.' : 'Could not reach the game server.'} Playing on this screen only.`,
      { href: serverBase().pathname, text: 'Start a new game' },
    );
    return;
  }
  // Closing or reloading the page is leaving, not a dropped connection the
  // server should hold a place open for.
  addEventListener('pagehide', () => { online.leave(); });
  // A page restored from the back-forward cache has lost its connection.
  addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

  local.stop();
  net = online;
  view = null;
  occ = null;
  selected = null;
  placing = null;
  online.onState(onState);
  online.onPeers((list) => {
    peers = list;
    needsDraw = true;
    updateHud();
  });
  online.onSeat(() => { refreshHighlights(); updateHud(); });
  await online.ready();
  updateHud();

  // Keep the viewer count and paused state honest as people come and go.
  setInterval(updateHud, 1000);
}

goOnline().catch(() => { /* stay on this screen */ });

// Exposed for console poking and for the headless render check.
Object.assign(globalThis, {
  __vigame: {
    get board() { return board; },
    get view() { return view; },
    get occ() { return occ; },
    get net() { return net; },
    get selected() { return selected; },
    get placing() { return placing; },
    get highlights() { return [...highlights]; },
    get peers() { return peers; },
    camera,
    forceDraw: () => { needsDraw = true; },
    /** Inject fake peers to check the shared-selection rendering offline. */
    setPeers(/** @type {any} */ list) { peers = list; needsDraw = true; },
  },
});
