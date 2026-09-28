/**
 * The game view: board, input, HUD and controls, around a game on the
 * server. The server runs the game; this draws what it sends and passes the
 * player's clicks on as commands.
 */

import { bounds, key, pixelToAxial } from '../core/hex.js';
import { BOARD_OPTIONS, TERRAIN, createBoard, tileAt } from '../core/board.js';
import { capacityOf, nearStanding, occupancy } from '../core/game.js';
import { BUILDING_TYPES, SIDES, TICKS_PER_SECOND, UNIT_LIMIT } from '../core/rules.js';
import { serverBase } from './api.js';
import { Camera } from './camera.js';
import { BoardRenderer } from './render.js';

/** @param {number} tick */
function formatTime(tick) {
  const s = Math.floor(tick / TICKS_PER_SECOND);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Show the game and play it.
 * @param {Awaited<ReturnType<typeof import('./net.js').createServerNet>>} net A joined game.
 * @param {import('./api.js').Player} me
 */
export async function startGame(net, me) {
  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
  const hud = {
    time: document.getElementById('time'),
    seat: document.getElementById('seat'),
    units: document.getElementById('units'),
    selection: document.getElementById('selection'),
    tile: document.getElementById('tile'),
    viewers: document.getElementById('viewers'),
  };
  const seatButton = /** @type {HTMLButtonElement} */ (document.getElementById('seat-button'));
  const upgradeButton = /** @type {HTMLButtonElement} */ (document.getElementById('upgrade'));
  const sendAmountButton = /** @type {HTMLButtonElement} */ (document.getElementById('send-amount'));
  const buildButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('button[data-kind]')]);
  const message = /** @type {HTMLElement} */ (document.getElementById('message'));
  /** @type {HTMLAnchorElement} */ (document.getElementById('to-lobby')).href = serverBase().pathname;

  stage.hidden = false;

  let board = createBoard({ ...BOARD_OPTIONS, seed: 0 });
  const camera = new Camera();
  let renderer = new BoardRenderer(canvas, board);

  /** The game as the server last reported it. */
  /** @type {import('./net.js').GameView | null} */
  let view = null;
  /** What is where in `view`. */
  /** @type {import('../core/game.js').Occupancy | null} */
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

  // --- state ---------------------------------------------------------------

  /** Frame the whole board. */
  function recenter() {
    const rect = canvas.getBoundingClientRect();
    camera.fit(bounds(board.list, board.hexSize), rect.width, rect.height);
    needsDraw = true;
  }

  /**
   * Take in the game as the server reports it.
   * @param {import('./net.js').GameView} next
   */
  function onState(next) {
    if (next.seed !== board.seed) {
      board = createBoard({ ...BOARD_OPTIONS, seed: next.seed });
      renderer = new BoardRenderer(canvas, board);
      renderer.showCoords = showCoords;
      recenter();
    }
    view = next;
    occ = occupancy(next);
    moving = Object.values(next.units).some((u) => u.path) || Object.values(next.buildings).some((b) => b.path);
    if (selected && !next.buildings[selected]) selected = null;
    refreshHighlights();
    updateHud();
    needsDraw = true;
  }

  /** Whether this viewer can give commands right now. */
  const canCommand = () => net.seat() !== null && net.running();

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

  function updateHud() {
    const seat = net.seat();
    const paused = !net.running();

    if (hud.time) {
      hud.time.textContent = `${formatTime(view?.tick ?? 0)}${paused ? ' · paused' : ''}`;
      hud.time.title = paused ? 'The game waits until both players are here' : '';
    }
    if (hud.seat) {
      hud.seat.textContent = `${me.name} · ${seat === null ? 'Spectator' : SIDES[seat].name}`;
      hud.seat.style.color = seat === null ? '' : SIDES[seat].accent;
    }
    if (hud.units) {
      hud.units.textContent = seat !== null && occ ? `${occ.unitCount[seat] ?? 0} / ${UNIT_LIMIT}` : '—';
    }
    if (hud.selection) {
      const b = selected ? view?.buildings[selected] : null;
      if (b && occ) {
        const inside = occ.inside.get(b.id)?.length ?? 0;
        hud.selection.textContent = `${BUILDING_TYPES[b.type].name} (grade ${b.grade}) · ${inside}/${capacityOf(b)}`;
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
    if (hud.viewers) {
      hud.viewers.textContent = net.connected() ? String(net.viewers()) : 'offline';
      hud.viewers.title = peers.map((p) => p.name).filter(Boolean).join(', ');
    }

    seatButton.hidden = seat === null && !net.canClaimSeat();
    seatButton.textContent = seat === null ? 'Take seat' : 'Release seat';

    const can = canCommand();
    for (const button of buildButtons) {
      button.disabled = !can;
      button.setAttribute('aria-pressed', String(placing === button.dataset.kind));
    }
    const b = selected ? view?.buildings[selected] : null;
    upgradeButton.disabled = !(can && b && isMine(selected) && b.grade < BUILDING_TYPES[b.type].grades);
    sendAmountButton.textContent = sendAll ? 'Send all' : 'Send half';
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let messageTimer;

  /**
   * Say briefly why something didn't happen.
   * @param {string} text
   */
  function flash(text) {
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

  // --- input ---------------------------------------------------------------

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
    if (e.pointerId === dragPointer) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      camera.pan(dx, dy);
      lastX = e.clientX;
      lastY = e.clientY;
      needsDraw = true;
    }

    const h = hexAtScreen(e.clientX - rect.left, e.clientY - rect.top);
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

  // The browser took the pointer over (a system gesture, a palm): end the
  // drag rather than leave it stuck on.
  canvas.addEventListener('pointercancel', (e) => {
    if (e.pointerId === dragPointer) dragPointer = null;
  });

  // A mouse that leaves the board is no longer over any hex. A finger
  // "leaves" every time it lifts, and there the last tapped hex should stay
  // in the HUD.
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

  upgradeButton.addEventListener('click', () => {
    if (selected) give({ type: 'upgrade', building: selected }, 'upgrade');
  });

  sendAmountButton.addEventListener('click', () => {
    sendAll = !sendAll;
    updateHud();
  });

  seatButton.addEventListener('click', () => {
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
  document.getElementById('recenter')?.addEventListener('click', recenter);
  addEventListener('resize', resize);

  // --- run -----------------------------------------------------------------

  function frame() {
    // Queue the next frame first, so one frame that throws cannot stop the
    // board from ever redrawing again.
    requestAnimationFrame(frame);
    if (!needsDraw && !moving) return;
    needsDraw = false;
    renderer.draw({ camera, view, clock: net.clock(), selected, highlights, hover, peers });
  }

  resize();
  net.onState(onState);
  net.onPeers((list) => {
    peers = list;
    needsDraw = true;
    updateHud();
  });
  net.onSeat(() => { refreshHighlights(); updateHud(); });
  await net.ready();
  requestAnimationFrame(frame);
  // Keep the viewer count and paused state honest as people come and go.
  setInterval(updateHud, 1000);

  // Exposed for console poking and for the headless browser check.
  Object.assign(globalThis, {
    __vigame: {
      get board() { return board; },
      get view() { return view; },
      get occ() { return occ; },
      get selected() { return selected; },
      get placing() { return placing; },
      get highlights() { return [...highlights]; },
      get peers() { return peers; },
      net,
      camera,
      forceDraw: () => { needsDraw = true; },
    },
  });
}
