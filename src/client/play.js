/**
 * The game view: board, input, HUD and controls, around a game on the
 * server. The server runs the game; this draws what it sends and passes the
 * player's clicks on as commands.
 */

import { bounds, key, pixelToAxial } from '../core/hex.js';
import { BOARD_OPTIONS, TERRAIN, createBoard, tileAt } from '../core/board.js';
import {
  capacityOf, castleOf, crewOf, depthOf, foodStore, isDugOut, maxHp, nearStanding, occupancy, upgradeCost,
} from '../core/game.js';
import { BUILDING_TYPES, SIDES, SKILLS, TICKS_PER_SECOND, UNIT_LIMIT } from '../core/rules.js';
import { serverBase } from './api.js';
import { Camera } from './camera.js';
import { BoardRenderer } from './render.js';

/** @param {number} tick */
function formatTime(tick) {
  const s = Math.floor(tick / TICKS_PER_SECOND);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** @typedef {import('../core/game.js').Building} Building */

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
    stone: document.getElementById('stone'),
    food: document.getElementById('food'),
    hunger: document.getElementById('hunger'),
    selection: document.getElementById('selection'),
    tile: document.getElementById('tile'),
    viewers: document.getElementById('viewers'),
  };
  const seatButton = /** @type {HTMLButtonElement} */ (document.getElementById('seat-button'));
  const upgradeButton = /** @type {HTMLButtonElement} */ (document.getElementById('upgrade'));
  const crewButton = /** @type {HTMLButtonElement} */ (document.getElementById('crew-button'));
  const returnButton = /** @type {HTMLButtonElement} */ (document.getElementById('return-button'));
  const attackButton = /** @type {HTMLButtonElement} */ (document.getElementById('attack-button'));
  const crewDialog = /** @type {HTMLDialogElement} */ (document.getElementById('crew'));
  const crewParts = {
    title: /** @type {HTMLElement} */ (document.getElementById('crew-title')),
    hint: /** @type {HTMLElement} */ (document.getElementById('crew-hint')),
    list: /** @type {HTMLElement} */ (document.getElementById('crew-list')),
    count: /** @type {HTMLElement} */ (document.getElementById('crew-count')),
    ok: /** @type {HTMLButtonElement} */ (document.getElementById('crew-ok')),
  };
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
  /** The building whose target is being chosen, after pressing Attack. */
  /** @type {string | null} */
  let aiming = null;
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
      const { band } = BUILDING_TYPES[placing];
      for (const t of board.list) {
        const k = key(t.q, t.r);
        const ground = band ? t.passable : t.buildable;
        if (ground && !occ.buildingAt.has(k) && nearStanding(/** @type {any} */ (view), seat, t)) highlights.add(k);
      }
    }
    needsDraw = true;
  }

  function updateHud() {
    const seat = net.seat();
    const paused = !net.running();

    if (hud.time) {
      const fallen = view?.players.find((p) => p.lost !== undefined);
      const outcome = !fallen ? '' : seat === null
        ? ` · ${SIDES[1 - fallen.id]?.name ?? ''} won`
        : fallen.id === seat ? ' · you lost' : ' · you won';
      hud.time.textContent = `${formatTime(view?.tick ?? 0)}${paused ? ' · paused' : ''}${outcome}`;
      hud.time.title = paused ? 'The game waits until both players are here' : '';
    }
    if (hud.seat) {
      hud.seat.textContent = `${me.name} · ${seat === null ? 'Spectator' : SIDES[seat].name}`;
      hud.seat.style.color = seat === null ? '' : SIDES[seat].accent;
    }
    if (hud.units) {
      hud.units.textContent = seat !== null && occ ? `${occ.unitCount[seat] ?? 0} / ${UNIT_LIMIT}` : '—';
    }
    const stock = seat !== null ? view?.players[seat] : null;
    if (hud.stone) hud.stone.textContent = stock ? String(stock.stone) : '—';
    if (hud.food) hud.food.textContent = stock && view && seat !== null ? `${stock.food} / ${foodStore(view, seat)}` : '—';
    if (hud.hunger) hud.hunger.textContent = stock ? `${stock.hunger}%` : '—';
    if (hud.selection) {
      const b = selected ? view?.buildings[selected] : null;
      if (b) {
        hud.selection.textContent = describe(b);
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
    const mine = Boolean(can && b && isMine(selected));
    const upgradable = Boolean(mine && b && b.grade < BUILDING_TYPES[b.type].grades);
    upgradeButton.disabled = !upgradable;
    upgradeButton.textContent = upgradable && b && upgradeCost(b) ? `Upgrade · ${upgradeCost(b)}` : 'Upgrade';
    const crewed = Boolean(mine && b && b.type !== 'castle' && !isDugOut(b));
    crewButton.disabled = !crewed;
    returnButton.disabled = !(crewed && view && b && crewOf(view, b.id).length > 0);
    attackButton.disabled = !mine;
    attackButton.setAttribute('aria-pressed', String(aiming !== null && aiming === selected));
  }

  /**
   * A building, as the HUD describes it: its units, and how its work is going.
   * @param {Building} b
   */
  function describe(b) {
    const type = BUILDING_TYPES[b.type];
    const parts = [type.grades > 1 ? `${type.name} (grade ${b.grade})` : type.name];
    const done = `${Math.floor((100 * (b.work ?? 0)) / (type.work ?? 1))}%`;
    if (b.type === 'castle') {
      parts.push(`${occ?.inside.get(b.id)?.length ?? 0}/${capacityOf(b)} at home`, `next unit ${done}`);
    } else {
      parts.push(`crew ${view ? crewOf(view, b.id).length : 0}/${capacityOf(b)}`);
    }
    if (type.depth !== undefined) parts.push(isDugOut(b) ? 'dug out' : `depth ${depthOf(b)}/${type.depth}, ${b.dug} stone`);
    if (type.yields === 'food') parts.push(`next food ${done}`);
    if (b.hp !== undefined) parts.push(`HP ${b.hp}/${maxHp(b)}`);
    const target = b.target ? view?.buildings[b.target] : null;
    if (target) parts.push(`attacking the ${BUILDING_TYPES[target.type].name.toLowerCase()}`);
    return parts.join(' · ');
  }

  /**
   * Where a unit is, for the crew list.
   * @param {import('./net.js').GameView['units'][string]} u
   * @param {string | null} target The building whose crew is being chosen.
   */
  function whereIs(u, target) {
    const id = u.in ?? u.to;
    const b = id && view ? view.buildings[id] : null;
    if (!b) return 'outside';
    if (id === target) return u.in ? 'here' : 'on the way here';
    if (b.type === 'castle') return u.in ? 'at home' : 'going home';
    const name = BUILDING_TYPES[b.type].name.toLowerCase();
    return u.in ? `in a ${name}` : `going to a ${name}`;
  }

  /**
   * Let the player choose a crew: a list of their units, with the current
   * crew ticked, or for a new building the ones at home best at its work.
   * @param {object} options
   * @param {string} options.title
   * @param {string} options.hint
   * @param {string} options.action The confirm button's label.
   * @param {string} options.kind The building's type, whose skill ranks the units.
   * @param {number} options.limit How many it takes.
   * @param {string | null} options.target The building, or null for a new one.
   * @returns {Promise<string[] | null>} The chosen unit ids, or null if cancelled.
   */
  function chooseCrew({ title, hint, action, kind, limit, target }) {
    const seat = net.seat();
    if (!view || seat === null) return Promise.resolve(null);
    const { skill } = BUILDING_TYPES[kind];
    const home = castleOf(view, seat)?.id;
    const units = Object.values(view.units).filter((u) => u.owner === seat);
    /** @param {typeof units[number]} a @param {typeof units[number]} b */
    const better = (a, b) => b.skills[skill] - a.skills[skill] || b.level - a.level || a.name.localeCompare(b.name);
    const chosen = new Set(target
      ? crewOf(view, target)
      : units.filter((u) => u.in === home).sort(better).slice(0, limit).map((u) => u.id));
    const rank = (/** @type {typeof units[number]} */ u) => (chosen.has(u.id) ? 0 : u.in === home ? 1 : 2);
    units.sort((a, b) => rank(a) - rank(b) || better(a, b));

    crewParts.title.textContent = title;
    crewParts.hint.textContent = hint;
    crewParts.ok.textContent = action;
    crewParts.list.replaceChildren(...units.map((u) => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = u.id;
      box.checked = chosen.has(u.id);
      const name = document.createElement('span');
      name.textContent = u.name;
      const stats = document.createElement('span');
      stats.className = 'stats';
      stats.textContent = `Lv ${u.level} · ${SKILLS[skill]} ${u.skills[skill]}`;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = whereIs(u, target);
      const label = document.createElement('label');
      label.append(box, name, stats, where);
      const li = document.createElement('li');
      li.append(label);
      return li;
    }));
    const sync = () => {
      crewParts.count.textContent = `${chosen.size} of ${limit}`;
      for (const box of crewParts.list.querySelectorAll('input')) box.disabled = !box.checked && chosen.size >= limit;
    };
    crewParts.list.onchange = (e) => {
      const box = /** @type {HTMLInputElement} */ (e.target);
      if (box.checked) chosen.add(box.value);
      else chosen.delete(box.value);
      sync();
    };
    sync();

    crewDialog.returnValue = '';
    crewDialog.showModal();
    return new Promise((resolve) => {
      crewDialog.addEventListener('close', () => {
        resolve(crewDialog.returnValue === 'ok' ? units.filter((u) => chosen.has(u.id)).map((u) => u.id) : null);
      }, { once: true });
    });
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
   * - In build mode: build there. A building that needs a crew (a pit,
   *   farm or band) gets one chosen first.
   * - On any building: select it, or unselect it.
   * - With one of your wagons selected, anywhere else: drive it there.
   * - Anywhere else: unselect.
   * @param {{ q: number, r: number }} at
   */
  async function act(at) {
    if (!view || !occ) return;
    if (placing) {
      if (!canCommand()) return;
      const kind = placing;
      const type = BUILDING_TYPES[kind];
      /** @type {string[]} */
      let units = [];
      // Only for a cell it can go on: anywhere else, the server says why not.
      if ((type.work !== undefined || type.band) && highlights.has(key(at.q, at.r))) {
        const chosen = await chooseCrew({
          title: `New ${type.name.toLowerCase()}`,
          hint: type.band
            ? `Choose who goes, up to ${type.capacity}. The best fighters at home are ticked.`
            : `Choose its crew, up to ${type.capacity}. The best at home for the work are ticked.`,
          action: 'Build',
          kind,
          limit: type.capacity,
          target: null,
        });
        if (!chosen) return;
        units = chosen;
      }
      if (await give({ type: 'build', kind, q: at.q, r: at.r, ...(units.length ? { units } : {}) }, 'build there')) placing = null;
      refreshHighlights();
      updateHud();
      return;
    }

    const here = occ.buildingAt.get(key(at.q, at.r)) ?? null;
    if (aiming) {
      // After Attack: an enemy building becomes the target; anywhere else clears it.
      const from = aiming;
      aiming = null;
      const enemy = here !== null && !isMine(here);
      if (canCommand() && (enemy || view.buildings[from]?.target)) {
        await give({ type: 'target', building: from, target: enemy ? here : '' }, 'attack that');
      }
      updateHud();
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
    // Escape in the crew chooser closes just the chooser.
    if (e.key !== 'Escape' || crewDialog.open || (!placing && !selected && !aiming)) return;
    aiming = null;
    placing = null;
    selected = null;
    refreshHighlights();
    updateHud();
  });

  for (const button of buildButtons) {
    const { name, cost } = BUILDING_TYPES[button.dataset.kind ?? ''];
    button.textContent = cost ? `${name} · ${cost}` : name;
    button.title = cost ? `${cost} stone` : 'Free';
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

  crewButton.addEventListener('click', async () => {
    const b = selected ? view?.buildings[selected] : null;
    if (!b) return;
    const type = BUILDING_TYPES[b.type];
    const units = await chooseCrew({
      title: `${type.name} crew`,
      hint: `Up to ${capacityOf(b)}. Those you untick go home; those you tick come from wherever they are.`,
      action: 'Send',
      kind: b.type,
      limit: capacityOf(b),
      target: b.id,
    });
    if (units) give({ type: 'crew', building: b.id, units }, 'send that crew');
  });

  attackButton.addEventListener('click', () => {
    aiming = aiming ? null : selected;
    if (aiming) flash('Click an enemy building to attack; anywhere else clears the target.');
    updateHud();
  });

  returnButton.addEventListener('click', () => {
    if (selected) give({ type: 'crew', building: selected, units: [] }, 'send them home');
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
      get aiming() { return aiming; },
      get highlights() { return [...highlights]; },
      get peers() { return peers; },
      net,
      camera,
      forceDraw: () => { needsDraw = true; },
    },
  });
}
