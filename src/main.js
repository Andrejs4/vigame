/**
 * Entry point: wires board, game, camera, renderer, input and networking.
 *
 * Runs in two modes. Offline (no Artifact runtime) it is hotseat: one browser,
 * two players, everything local. Online it syncs authoritative game state
 * through a shared document and everyone's current selection through presence,
 * so both players see each other's highlights live.
 */

import { bounds, key, pixelToAxial } from './hex.js';
import { TERRAIN, createBoard, tileAt } from './board.js';
import { PLAYERS, createGame, endTurn, moveUnit, reachable, unitAt } from './game.js';
import { Camera } from './camera.js';
import { applyState, createArtifactNet, createLocalNet, serialize } from './net.js';
import { BoardRenderer } from './render.js';

const SEED = 1337;
const BOARD_OPTIONS = { shape: 'rectangle', width: 18, height: 12, hexSize: 34 };

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
const releaseButton = document.getElementById('release-seat');

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
 * Whether this viewer may act right now. Hotseat always may; online, only the
 * player whose turn it is, and only if they hold that seat.
 */
function canAct() {
  if (net.mode === 'local') return true;
  const seat = net.seat();
  return seat !== null && seat === game.currentPlayer;
}

/** Push the current authoritative state to the transport. */
function commit() {
  net.commit(serialize(board, game));
}

function refreshReach() {
  const unit = game.selectedUnitId ? game.units.get(game.selectedUnitId) : null;
  reach = unit && unit.owner === game.currentPlayer && canAct()
    ? reachable(board, game, unit)
    : new Map();
}

function updateHud() {
  const player = PLAYERS[game.currentPlayer];
  if (hud.turn) hud.turn.textContent = String(game.turn);
  if (hud.player) {
    hud.player.textContent = player.name;
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
  if (releaseButton) releaseButton.hidden = !online || net.seat() === null;

  if (online) {
    const seat = net.seat();
    if (hud.seat) {
      hud.seat.textContent = seat === null ? 'Spectator' : PLAYERS[seat].name;
      hud.seat.style.color = seat === null ? '' : PLAYERS[seat].accent;
    }
    if (hud.viewers) {
      const n = net.viewers();
      hud.viewers.textContent = net.connected() ? String(n) : 'offline';
    }
  }

  if (endTurnButton) {
    const allowed = canAct();
    endTurnButton.disabled = !allowed;
    endTurnButton.title = allowed
      ? ''
      : net.seat() === null
        ? 'Spectating \u2014 both seats are taken'
        : `Waiting for ${PLAYERS[game.currentPlayer].name}`;
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

let dragging = false;
let dragMoved = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (dragging) {
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
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (dragMoved) return; // a drag is a pan, not a click

  const rect = canvas.getBoundingClientRect();
  const h = hexAtScreen(e.clientX - rect.left, e.clientY - rect.top);
  if (!tileAt(board, h.q, h.r)) return;

  // Everyone shares what they picked, including spectators and the player
  // whose turn it is not. Highlights are not a lock.
  net.select({ q: h.q, r: h.r });

  const clicked = unitAt(game, h.q, h.r);
  let moved = false;

  if (clicked && clicked.owner === game.currentPlayer && canAct()) {
    game.selectedUnitId = clicked.id === game.selectedUnitId ? null : clicked.id;
  } else if (game.selectedUnitId && canAct() && reach.has(key(h.q, h.r))) {
    moved = moveUnit(board, game, game.selectedUnitId, h.q, h.r);
  } else if (!clicked) {
    game.selectedUnitId = null;
  }

  refreshReach();
  updateHud();
  needsDraw = true;
  if (moved) commit();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  camera.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
  needsDraw = true;
}, { passive: false });

endTurnButton?.addEventListener('click', () => {
  if (!canAct()) return;
  endTurn(game);
  net.select(null);
  refreshReach();
  updateHud();
  needsDraw = true;
  commit();
});

releaseButton?.addEventListener('click', () => {
  net.releaseSeat?.();
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
  if (needsDraw) {
    renderer.draw({ camera, game, hover, reachable: reach, peers });
    needsDraw = false;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/**
 * Try to upgrade to online play. The page is already fully playable by the
 * time this runs; if the runtime never answers, nothing changes.
 */
async function goOnline() {
  const claude = /** @type {any} */ (globalThis).claude;
  if (!claude?.use) return;

  const [db, room, user] = await Promise.all([
    claude.use('db').catch(() => null),
    claude.use('room').catch(() => null),
    claude.use('user').catch(() => null),
  ]);
  if (!db) return; // without shared state there is no online game

  const online = await createArtifactNet({
    db, room, user, initial: serialize(board, game),
  });

  net = online;
  online.onState(onRemoteState);
  online.onPeers((list) => {
    peers = list;
    needsDraw = true;
    updateHud();
  });
  online.onSeat(() => { refreshReach(); updateHud(); needsDraw = true; });

  await online.ready();
  refreshReach();
  updateHud();
  needsDraw = true;

  // Keep the viewer count honest as people come and go.
  setInterval(updateHud, 4000);
}

goOnline().catch(() => { /* stay hotseat */ });

// Dev aid: '#select' preselects the current player's first unit, so the
// movement-range overlay can be verified in a headless screenshot.
if (true) {
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
    camera,
    forceDraw: () => { needsDraw = true; },
    /** Inject fake peers to check the shared-selection rendering offline. */
    setPeers(list) { peers = list; needsDraw = true; },
  },
});
