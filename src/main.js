/**
 * Entry point: wires board, game, camera, renderer, input and networking.
 *
 * Runs in three modes. Served by the Vigame game server (which loads the
 * Colyseus client first), it plays the game named in `?game=` through that
 * server. Inside claude.ai it syncs through the Artifact runtime: game state
 * in a shared document, everyone's selection as presence. Anywhere else it is
 * hotseat: one browser, two players, everything local.
 */

import { bounds, key, pixelToAxial } from './hex.js';
import { BOARD_OPTIONS, TERRAIN, createBoard, tileAt } from './board.js';
import { PLAYERS, applyCommand, createGame, reachable, unitAt } from './game.js';
import { Camera } from './camera.js';
import { applyState, createArtifactNet, createLocalNet, createServerNet, serialize } from './net.js';
import { PLAYER_NAME_MAX, cleanPlayerName } from './player.js';
import { BoardRenderer } from './render.js';

const SEED = 1337;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
const hud = {
  turn: document.getElementById('turn'),
  player: document.getElementById('player'),
  selection: document.getElementById('selection'),
  tile: document.getElementById('tile'),
  seat: document.getElementById('seat'),
  viewers: document.getElementById('viewers'),
};
const endTurnButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('end-turn'));
const seatRow = document.getElementById('seat-row');
const viewersRow = document.getElementById('viewers-row');
const seatButton = document.getElementById('seat-button');
const notice = document.getElementById('notice');
const signinDialog = /** @type {HTMLDialogElement | null} */ (document.getElementById('signin'));

let board = createBoard({ ...BOARD_OPTIONS, seed: SEED });
let game = createGame(board);
const camera = new Camera();
let renderer = new BoardRenderer(canvas, board);

/** @type {{ q: number, r: number } | null} */
let hover = null;
/** @type {Map<string, number>} */
let reach = new Map();
/** @type {Array<import('./net.js').NetPeer>} */
let peers = [];
let needsDraw = true;

/** The transport. Starts as hotseat and is replaced if the runtime answers. */
let net = createLocalNet();

// --- board / state ---------------------------------------------------------

/**
 * Rebuild the board for a different seed, keeping the camera where it is.
 * Only happens online, when the shared state was seeded by someone else.
 * @param {number} seed
 */
function rebuildBoard(seed) {
  board = createBoard({ ...BOARD_OPTIONS, seed });
  renderer = new BoardRenderer(canvas, board);
  renderer.showCoords = showCoords;
  needsDraw = true;
}

let showCoords = false;

/**
 * Online, whether the shared game has arrived. Until it has, the board shows
 * the local opening position, and a move made on that would be committed over
 * the real game.
 */
let synced = false;

/**
 * Whether this viewer may act right now. Hotseat always may; online, only the
 * player whose turn it is, and only if they hold that seat.
 */
function canAct() {
  if (net.mode === 'local') return true;
  const seat = net.seat();
  return synced && seat !== null && seat === game.currentPlayer;
}

/** Why End turn is disabled, for its tooltip. */
function waitingReason() {
  if (net.mode === 'online' && !synced) return 'Connecting\u2026';
  if (net.seat() === null) {
    return net.canClaimSeat() ? 'Take a seat to play' : 'Spectating \u2014 both seats are taken';
  }
  return `Waiting for ${PLAYERS[game.currentPlayer].name}`;
}

/**
 * Hand a command this page has just applied to the transport, along with the
 * state it produced.
 * @param {import('./game.js').Command} command
 */
function commit(command) {
  net.commit(serialize(board, game), command);
}

function refreshReach() {
  const unit = game.selectedUnitId ? game.units.get(game.selectedUnitId) : null;
  reach = unit && unit.owner === game.currentPlayer && canAct()
    ? reachable(board, game, unit)
    : new Map();
}

/**
 * The name of whoever holds `seat`, while they are here and have one.
 * @param {number} seat
 */
function seatHolderName(seat) {
  return peers.find((p) => p.seat === seat && p.name)?.name ?? '';
}

function updateHud() {
  const player = PLAYERS[game.currentPlayer];
  if (hud.turn) hud.turn.textContent = String(game.turn);
  if (hud.player) {
    const holder = seatHolderName(game.currentPlayer);
    hud.player.textContent = holder ? `${player.name} \u00b7 ${holder}` : player.name;
    hud.player.style.color = player.accent;
  }
  if (hud.selection) {
    const unit = game.selectedUnitId ? game.units.get(game.selectedUnitId) : null;
    hud.selection.textContent = unit
      ? `${unit.name} \u2014 ${unit.move}/${unit.moveMax} MP`
      : 'none';
  }
  if (hud.tile) {
    const t = hover ? tileAt(board, hover.q, hover.r) : null;
    hud.tile.textContent = t
      ? `${TERRAIN[t.terrain].label} (${t.q}, ${t.r})${t.passable ? '' : ' \u2014 impassable'}`
      : '\u2014';
  }

  const online = net.mode === 'online';
  if (seatRow) seatRow.hidden = !online;
  if (viewersRow) viewersRow.hidden = !online;
  if (seatButton) {
    const seated = net.seat() !== null;
    seatButton.hidden = !online || (!seated && !net.canClaimSeat());
    seatButton.textContent = seated ? 'Release seat' : 'Take seat';
  }

  if (online) {
    const seat = net.seat();
    if (hud.seat) {
      const role = seat === null ? 'Spectator' : PLAYERS[seat].name;
      const me = peers.find((p) => p.isMe)?.name;
      hud.seat.textContent = me ? `${me} \u00b7 ${role}` : role;
      hud.seat.style.color = seat === null ? '' : PLAYERS[seat].accent;
    }
    if (hud.viewers) {
      const n = net.viewers();
      hud.viewers.textContent = net.connected() ? String(n) : 'offline';
      hud.viewers.title = peers.map((p) => p.name).filter(Boolean).join(', ');
    }
  }

  if (endTurnButton) {
    const allowed = canAct();
    endTurnButton.disabled = !allowed;
    endTurnButton.title = allowed ? '' : waitingReason();
  }
}

/**
 * Adopt authoritative state from the transport.
 * @param {import('./net.js').GameState} state
 */
function onRemoteState(state) {
  if (typeof state.seed === 'number' && state.seed !== board.seed) rebuildBoard(state.seed);
  applyState(game, state);
  refreshReach();
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

  // Everyone shares what they picked, including spectators and the player
  // whose turn it is not. Highlights are not a lock.
  net.select({ q: h.q, r: h.r });

  const clicked = unitAt(game, h.q, h.r);
  /** @type {import('./game.js').Command | null} */
  let command = null;

  if (clicked && clicked.owner === game.currentPlayer && canAct()) {
    game.selectedUnitId = clicked.id === game.selectedUnitId ? null : clicked.id;
  } else if (game.selectedUnitId && canAct() && reach.has(key(h.q, h.r))) {
    command = { type: 'move', unit: game.selectedUnitId, q: h.q, r: h.r };
    if (!applyCommand(board, game, game.currentPlayer, command)) command = null;
  } else if (!clicked) {
    game.selectedUnitId = null;
  }

  refreshReach();
  updateHud();
  needsDraw = true;
  if (command) commit(command);
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

endTurnButton?.addEventListener('click', () => {
  if (!canAct()) return;
  /** @type {import('./game.js').Command} */
  const command = { type: 'endTurn' };
  applyCommand(board, game, game.currentPlayer, command);
  net.select(null);
  refreshReach();
  updateHud();
  needsDraw = true;
  commit(command);
});

seatButton?.addEventListener('click', () => {
  if (net.seat() !== null) net.releaseSeat();
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
updateHud();

function frame() {
  // Queue the next frame first, so one frame that throws cannot stop the
  // board from ever redrawing again.
  requestAnimationFrame(frame);
  if (!needsDraw) return;
  needsDraw = false;
  renderer.draw({ camera, game, hover, reachable: reach, peers });
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
    question.textContent = 'Loading the question\u2026';
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
        error.textContent = `Use 1\u2013${PLAYER_NAME_MAX} letters or digits. Spaces and - _ . ' may go between them.`;
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
        error.textContent = why === 'wrong answer' ? 'That\u2019s not it. Try this one.' : `The server said no (${why ?? res.status}).`;
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
 * Join through the claude.ai Artifact runtime.
 * @param {any} claude
 */
async function joinArtifactGame(claude) {
  const [db, room, user] = await Promise.all([
    claude.use('db').catch(() => null),
    claude.use('room').catch(() => null),
    claude.use('user').catch(() => null),
  ]);
  if (!db) return null; // without shared state there is no online game
  return createArtifactNet({ db, room, user, initial: serialize(board, game) });
}

/**
 * Try to upgrade to online play. The page is already fully playable by the
 * time this runs; if no transport answers, it stays hotseat.
 */
async function goOnline() {
  const g = /** @type {any} */ (globalThis);
  let online = null;
  if (g.Colyseus?.Client) {
    try {
      online = await joinServerGame(g.Colyseus.Client);
      const leaving = online;
      // Closing or reloading the page is leaving, not a dropped connection
      // the server should hold a place open for.
      addEventListener('pagehide', () => { leaving.leave(); });
      // A page restored from the back-forward cache has lost its connection.
      addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
    } catch (e) {
      const missing = /no game/.test(String(/** @type {any} */ (e)?.message));
      showNotice(
        `${missing ? 'There is no game at this address.' : 'Could not reach the game server.'} Playing on this screen only.`,
        { href: serverBase().pathname, text: 'Start a new game' },
      );
      return;
    }
  } else if (g.claude?.use) {
    online = await joinArtifactGame(g.claude);
  }
  if (!online) return;

  net = online;
  online.onState(onRemoteState);
  online.onPeers((list) => {
    peers = list;
    needsDraw = true;
    updateHud();
  });
  online.onSeat(() => { refreshReach(); updateHud(); needsDraw = true; });

  await online.ready();
  synced = true;
  refreshReach();
  updateHud();
  needsDraw = true;

  // Keep the viewer count honest as people come and go.
  setInterval(updateHud, 4000);
}

goOnline().catch(() => { /* stay hotseat */ });

// Dev aid: '#select' preselects the current player's first unit, so the
// movement-range overlay can be verified in a headless screenshot.
if (location.hash === '#select') {
  const first = [...game.units.values()].find((u) => u.owner === game.currentPlayer);
  if (first) {
    game.selectedUnitId = first.id;
    hover = { q: first.q, r: first.r };
    refreshReach();
    updateHud();
  }
}

// Exposed for console poking and for the headless render check.
Object.assign(globalThis, {
  __vigame: {
    get board() { return board; },
    get game() { return game; },
    get net() { return net; },
    get reach() { return reach; },
    get peers() { return peers; },
    camera,
    forceDraw: () => { needsDraw = true; },
    /** Inject fake peers to check the shared-selection rendering offline. */
    setPeers(list) { peers = list; needsDraw = true; },
  },
});
