/**
 * The game view: board, input, HUD and controls, around a game on the
 * server. The server runs the game; this draws what it sends and passes the
 * player's clicks on as commands.
 */

import { axialToPixel, bounds, distance, key, pixelToAxial } from '../core/hex.js';
import { BOARD_OPTIONS, TERRAIN, createBoard, tileAt } from '../core/board.js';
import {
  buildCost, capacityOf, castleOf, crewOf, depthOf, foodStore, fullMeal, inBuildRange, isDugOut, isRising, maxHp, occupancy, pointsOf, purseOf,
  raiseWork, seatsOf, sharesStock, shortOf, sideOf, upgradeCost,
} from '../core/game.js';
import { GAME_NAME_MAX, cleanGameName } from '../core/player.js';
import { BUILDING_TYPES, POINTS, SKILL_SHORT, SKILLS, TICKS_PER_SECOND, UNIT_LIMIT } from '../core/rules.js';
import { getJson, serverBase } from './api.js';
import { Camera } from './camera.js';
import { Effects, fallenHeroes, fallenHeroesNote } from './effects.js';
import { Minimap } from './minimap.js';
import { BoardRenderer, COUNT_ZOOM } from './render.js';
import { Sounds, soundsFor } from './sounds.js';
import { Tokens } from './tokens.js';

/** @param {number} tick */
function formatTime(tick) {
  const s = Math.floor(tick / TICKS_PER_SECOND);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A percentage three digits wide, padded with figure spaces (as wide as a
 * digit, and kept by HTML), so the text around it holds still as it counts.
 * @param {number} part
 * @param {number} whole
 */
function percent(part, whole) {
  return `${String(Math.floor((100 * part) / whole)).padStart(3, '\u2007')}%`;
}

/** Recenter's zoom at least: close enough to read how many are in each building. */
const HOME_ZOOM = COUNT_ZOOM + 0.15;

/**
 * The columns of the table at a game's end: a line of a side's tally (see
 * POINTS in rules.js), its heading, and what it counts.
 * @type {Array<[keyof typeof POINTS, string, string]>}
 */
const SCORE_LINES = [
  ['kills', 'Kills', 'enemy units killed'],
  ['damage', 'Damage', 'hit points taken off enemy buildings'],
  ['felled', 'Felled', 'enemy buildings brought down'],
  ['castles', 'Castles', 'enemy castles and lairs brought down'],
  ['born', 'Born', 'units born'],
  ['stone', 'Stone', 'stone dug'],
  ['food', 'Food', 'food grown by crews'],
  ['built', 'Built', 'buildings finished'],
  ['upgrades', 'Upgrades', 'grades reached by upgrading'],
  ['won', 'Win', 'for the winning team'],
];

/**
 * What a line of the tally is worth, in words.
 * @param {keyof typeof POINTS} line
 */
function worth(line) {
  const each = POINTS[line];
  return each >= 1 ? `${each} points each` : `a point per ${Math.round(1 / each)}`;
}

/** Stone and dark metal the HUD shows in bold: enough for a tower, and for a wagon's upgrade. */
const PLENTY = { stone: 60, metal: 30 };

/**
 * Set a button's label with its first letter in bold: the key that presses it.
 * @param {HTMLElement} button
 * @param {string} label
 */
function keyLabel(button, label) {
  if (button.textContent === label && button.firstChild?.nodeName === 'B') return;
  const key = document.createElement('b');
  key.textContent = label[0];
  button.replaceChildren(key, label.slice(1));
}

/** Where the browser keeps whether "How to play" is open. */
const HOW_TO_KEY = 'vigame.howToPlay';

/** @typedef {import('../core/game.js').Building} Building */

/**
 * Show the game and play it.
 * @param {Awaited<ReturnType<typeof import('./net.js').createServerNet>>} net A joined game.
 * @param {import('./api.js').Player} me
 */
export async function startGame(net, me) {
  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board'));
  const mapCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('minimap-canvas'));
  const mapFrame = /** @type {HTMLElement} */ (document.getElementById('minimap-frame'));
  const controls = /** @type {HTMLElement} */ (document.getElementById('controls'));
  const hud = {
    gameName: document.getElementById('game-name'),
    time: document.getElementById('time'),
    seat: document.getElementById('seat'),
    units: document.getElementById('units'),
    stone: document.getElementById('stone'),
    metal: document.getElementById('metal'),
    food: document.getElementById('food'),
    foodCount: document.getElementById('food-count'),
    foodRest: document.getElementById('food-rest'),
    selection: document.getElementById('selection'),
    tile: document.getElementById('tile'),
    players: document.getElementById('players'),
    observers: document.getElementById('observers'),
  };
  const seatButton = /** @type {HTMLButtonElement} */ (document.getElementById('seat-button'));
  const upgradeButton = /** @type {HTMLButtonElement} */ (document.getElementById('upgrade'));
  const crewButton = /** @type {HTMLButtonElement} */ (document.getElementById('crew-button'));
  const heroesButton = /** @type {HTMLButtonElement} */ (document.getElementById('heroes-button'));
  const returnButton = /** @type {HTMLButtonElement} */ (document.getElementById('return-button'));
  const abortButton = /** @type {HTMLButtonElement} */ (document.getElementById('abort-button'));
  const attackButton = /** @type {HTMLButtonElement} */ (document.getElementById('attack-button'));
  const muteButton = /** @type {HTMLButtonElement} */ (document.getElementById('mute-button'));
  const scoresButton = /** @type {HTMLButtonElement} */ (document.getElementById('scores-button'));
  const scoresDialog = /** @type {HTMLDialogElement} */ (document.getElementById('scores'));
  const gameId = new URLSearchParams(location.search).get('game') ?? '';
  const crewDialog = /** @type {HTMLDialogElement} */ (document.getElementById('crew'));
  const renameDialog = /** @type {HTMLDialogElement} */ (document.getElementById('rename'));
  const heroesDialog = /** @type {HTMLDialogElement} */ (document.getElementById('heroes'));
  const heroesList = /** @type {HTMLElement} */ (document.getElementById('heroes-list'));
  const heroesCount = /** @type {HTMLElement} */ (document.getElementById('heroes-count'));
  const renameButton = /** @type {HTMLButtonElement} */ (document.getElementById('rename-button'));
  const renameInput = /** @type {HTMLInputElement} */ (document.getElementById('rename-input'));
  const renameError = /** @type {HTMLElement} */ (document.getElementById('rename-error'));
  const renameOk = /** @type {HTMLButtonElement} */ (document.getElementById('rename-ok'));
  const crewParts = {
    title: /** @type {HTMLElement} */ (document.getElementById('crew-title')),
    hint: /** @type {HTMLElement} */ (document.getElementById('crew-hint')),
    list: /** @type {HTMLElement} */ (document.getElementById('crew-list')),
    count: /** @type {HTMLElement} */ (document.getElementById('crew-count')),
    ok: /** @type {HTMLButtonElement} */ (document.getElementById('crew-ok')),
    sorts: /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('#crew-sort button')]),
  };
  const buildButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('button[data-kind]')]);
  const message = /** @type {HTMLElement} */ (document.getElementById('message'));
  /** @type {HTMLAnchorElement} */ (document.getElementById('to-lobby')).href = serverBase().pathname;

  stage.hidden = false;

  let board = createBoard({ ...BOARD_OPTIONS, seed: 0 });
  let boardPlayers = 0;
  const camera = new Camera();
  // The pictures arrive after the first draws; each one redraws the board.
  const tokens = new Tokens(() => { needsDraw = true; });
  let renderer = new BoardRenderer(canvas, board, tokens);
  let minimap = new Minimap(mapCanvas, mapFrame, board);
  /** The main view's size, in CSS pixels. */
  let viewW = 0;
  let viewH = 0;

  /** The game as the server last reported it. */
  /** @type {import('./net.js').GameView | null} */
  let view = null;
  /** What is where in `view`. */
  /** @type {import('../core/game.js').Occupancy | null} */
  let occ = null;
  /** Whether anything is on the move, so the board must be redrawn every frame. */
  let moving = false;
  /**
   * Whether the last frame drew things on the move. Only while the clock
   * runs: paused, a unit halfway along a path stays where it is, so the
   * board is still, and a frame after the clock stops draws it there.
   */
  let animating = false;
  /** Boards drawn, for the smoke check that a still board isn't redrawn. */
  let draws = 0;
  /** Hits, falls and deaths, worked out from each update and the one before. */
  const effects = new Effects();
  /** Whether an effect played last frame, so the frame after the last one clears it. */
  let playing = false;
  const sounds = new Sounds();
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
  /** The building the open crew chooser is for (null for a new one). */
  /** @type {string | null} */
  let crewTarget = null;
  /** @type {Set<string>} */
  let highlights = new Set();
  let showCoords = false;
  let needsDraw = true;
  /** Whether Recenter has looked at this viewer's own castle yet. */
  let homed = false;

  // --- state ---------------------------------------------------------------

  /** Frame the whole board. */
  function recenter() {
    const rect = canvas.getBoundingClientRect();
    camera.fit(bounds(board.list, board.hexSize), rect.width, rect.height);
    // A player looks at their own castle, close enough to read the unit
    // counts even when the whole map would be too small for them.
    const seat = net.seat();
    const home = view && seat !== null ? castleOf(view, seat) : null;
    if (home) {
      camera.zoom = Math.min(camera.maxZoom, Math.max(camera.zoom, HOME_ZOOM));
      const at = axialToPixel(home.q, home.r, board.hexSize);
      camera.centreOn(at.x, at.y, rect.width, rect.height);
    }
    homed = Boolean(home);
    needsDraw = true;
  }

  /**
   * Take in the game as the server reports it.
   * @param {import('./net.js').GameView} next
   */
  function onState(next) {
    const players = seatsOf(next);
    if (next.seed !== board.seed || players !== boardPlayers) {
      boardPlayers = players;
      board = createBoard({ ...BOARD_OPTIONS, seed: next.seed, players });
      renderer = new BoardRenderer(canvas, board, tokens);
      renderer.showCoords = showCoords;
      minimap = new Minimap(mapCanvas, mapFrame, board);
      recenter();
    }
    const fresh = effects.update(view, next, performance.now());
    // The player's heroes who died meanwhile, said where refusals are.
    const lost = fallenHeroesNote(fallenHeroes(view, next, net.seat()));
    if (lost) flash(lost);
    for (const { name, pan } of soundsFor({ prev: view, next, fresh, seat: net.seat(), where: panOf })) sounds.play(name, pan);
    if (view) letGo(view, next, fresh);
    view = next;
    // A player's first sight of the game is their own castle.
    if (!homed && net.seat() !== null) recenter();
    minimap.show(next);
    occ = occupancy(next);
    moving = Object.values(next.units).some((u) => u.path) || Object.values(next.buildings).some((b) => b.path);
    if (selected && !next.buildings[selected]) selected = null;
    refreshHighlights();
    updateHud();
    needsDraw = true;
    // The table of points, once, when the game is over (or opens over).
    if (next.over !== undefined && !scoresSeen) {
      scoresSeen = true;
      showScores();
    }
  }

  /** Whether the table of points has come up since the game was over. */
  let scoresSeen = false;
  /** Seat holders' names, by seat, for the table: those who have left too. */
  /** @type {string[]} */
  let seatNames = [];

  /** Show the table of points, and fetch every seat holder's name for it. */
  async function showScores() {
    if (!view || view.over === undefined) return;
    fillScores();
    if (!scoresDialog.open) scoresDialog.showModal();
    try {
      /** @type {Array<{ name: string } | null>} */
      const seats = await getJson(`api/games/${encodeURIComponent(gameId)}/seats`);
      seatNames = seats.map((s) => s?.name ?? '');
      fillScores();
    } catch {
      // The sides' names will do.
    }
  }

  /** Fill the table of points: a row a side, winners first, then by points. */
  function fillScores() {
    if (!view || view.over === undefined) return;
    const { players, winner } = view;
    const seat = net.seat();
    const winners = players.filter((p) => p.team === winner && !sideOf(view, p.id).wild);
    /** @type {HTMLElement} */ (document.getElementById('scores-title')).textContent = winner === undefined
      ? 'Game over' : seat === null ? 'Game over' : players[seat]?.team === winner ? 'You won' : 'You lost';
    /** @type {HTMLElement} */ (document.getElementById('scores-outcome')).textContent = `${formatTime(view.over)} · ${
      winner === undefined ? 'nobody won' : `${winners.map((p) => sideOf(view, p.id).name).join(' and ')} won`}`;

    const cell = (/** @type {'th' | 'td'} */ tag, /** @type {string} */ text, /** @type {string} */ title = '') => {
      const c = document.createElement(tag);
      c.textContent = text;
      if (title) c.title = title;
      return c;
    };
    /** @type {HTMLElement} */ (document.getElementById('scores-head')).replaceChildren(
      cell('th', 'Side'),
      ...SCORE_LINES.map(([line, heading, what]) => cell('th', heading, `${heading}: ${what}, ${worth(line)}`)),
      Object.assign(cell('th', 'Total'), { className: 'total' }),
    );
    const rows = players
      .filter((p) => p.tally && !sideOf(view, p.id).wild)
      .map((p) => ({ p, side: sideOf(view, p.id), points: pointsOf(/** @type {any} */ (p.tally)), won: p.team === winner }))
      .sort((a, b) => Number(b.won) - Number(a.won) || b.points.total - a.points.total);
    /** @type {HTMLElement} */ (document.getElementById('scores-body')).replaceChildren(...rows.map(({ p, side, points, won }) => {
      const tr = document.createElement('tr');
      if (won) tr.className = 'won';
      const name = seatNames[p.id] ? `${seatNames[p.id]} · ${side.name}` : side.name;
      const who = cell('td', name);
      who.style.color = side.accent;
      tr.append(who, ...SCORE_LINES.map(([line]) => cell('td', String(points.lines[line]))),
        Object.assign(cell('td', String(points.total)), { className: 'total' }));
      return tr;
    }));
  }

  /**
   * When the building the player has selected, is aiming with, or is
   * choosing a crew for is gone, let go of it (the selection itself clears
   * in onState) and say what became of it.
   * @param {import('./net.js').GameView} prev
   * @param {import('./net.js').GameView} next
   * @param {import('./effects.js').Effect[]} fresh What the effects made of the change.
   */
  function letGo(prev, next, fresh) {
    const held = [selected, aiming, crewDialog.open ? crewTarget : null];
    const gone = held.find((id) => id !== null && prev.buildings[id] && !next.buildings[id]);
    if (!gone) return;
    if (aiming !== null && !next.buildings[aiming]) aiming = null;
    if (crewDialog.open && crewTarget !== null && !next.buildings[crewTarget]) {
      // The dialog tells of its closing a moment later; let go of it now.
      crewTarget = null;
      crewDialog.close('');
    }
    const b = prev.buildings[gone];
    const type = BUILDING_TYPES[b.type];
    const side = sideOf(prev, b.owner).name;
    const whose = b.owner === net.seat() ? 'Your' : `${side}${side.endsWith('s') ? "'" : "'s"}`;
    const fate = fresh.some((e) => e.kind === 'fall' && e.building?.id === gone) ? 'was destroyed' : type.band ? 'broke up' : 'is gone';
    flash(`${whose} ${type.name.toLowerCase()} ${fate}.`);
  }

  /**
   * Where a cell is across the board's view, from -1 (left) to 1 (right),
   * or null when it is out of view: for the sounds.
   * @param {number} q
   * @param {number} r
   */
  function panOf(q, r) {
    const w = axialToPixel(q, r, board.hexSize);
    const p = camera.toScreen(w.x, w.y);
    if (p.x < 0 || p.y < 0 || p.x > viewW || p.y > viewH) return null;
    return (p.x / viewW) * 2 - 1;
  }

  /** Whether this viewer can give commands right now. */
  const canCommand = () => net.seat() !== null && net.running();

  /** Whether this viewer may rename the game: a player still in it, paused or not. */
  function canRename() {
    const seat = net.seat();
    return seat !== null && view !== null && view.over === undefined && view.players[seat]?.lost === undefined;
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
      const { band } = BUILDING_TYPES[placing];
      for (const t of board.list) {
        const k = key(t.q, t.r);
        const ground = band ? t.passable : t.buildable;
        if (ground && !occ.buildingAt.has(k) && inBuildRange(/** @type {any} */ (view), seat, placing, t)) highlights.add(k);
      }
    }
    needsDraw = true;
  }

  /** Whether the next meal falls short (`fullMeal`), checked once a game second. */
  let meal = { second: -1, seat: /** @type {number | null} */ (null), short: false };

  function updateHud() {
    const seat = net.seat();
    const paused = !net.running();

    if (hud.gameName) hud.gameName.textContent = view?.name ?? '—';
    if (view?.name && document.title !== `${view.name} · Vigame`) document.title = `${view.name} · Vigame`;
    renameButton.hidden = !canRename();
    if (hud.time) {
      const players = view?.players ?? [];
      const over = view?.over !== undefined;
      const winners = view?.winner;
      const names = players.filter((p) => p.team === winners).map((p) => sideOf({ players }, p.id).name).join(' and ');
      const outcome = !over ? '' : winners === undefined ? ' · over, nobody won' : seat === null
        ? ` · over: ${names} won`
        : players[seat]?.team === winners ? ' · over: you won' : ' · over: you lost';
      hud.time.textContent = `${formatTime(view?.tick ?? 0)}${paused && !over ? ' · paused' : ''}${outcome}`;
      hud.time.title = paused && !over ? 'The game waits until every player is here' : '';
    }
    if (hud.seat) {
      const mine = seat !== null && view ? sideOf(view, seat) : null;
      hud.seat.textContent = `${me.name} · ${mine ? mine.name : 'Spectator'}`;
      hud.seat.style.color = mine ? mine.accent : '';
    }
    if (hud.units) {
      hud.units.textContent = seat !== null && occ ? `${occ.unitCount[seat] ?? 0} / ${UNIT_LIMIT}` : '—';
    }
    // The stock this side lives off: its own, or its team's when they share.
    const stock = seat !== null && view ? purseOf(view, seat) : null;
    const team = Boolean(view && sharesStock(view.mode));
    for (const [id, label] of [['stone-label', 'Stone'], ['metal-label', 'Dark metal'], ['food-label', 'Food']]) {
      const dt = document.getElementById(id);
      const text = team ? `Team ${label.toLowerCase()}` : label;
      if (dt && dt.textContent !== text) dt.textContent = text;
    }
    if (hud.stone) {
      hud.stone.textContent = stock ? String(stock.stone) : '—';
      hud.stone.classList.toggle('marked', (stock?.stone ?? 0) >= PLENTY.stone);
    }
    if (hud.metal) {
      hud.metal.textContent = stock ? String(stock.metal) : '—';
      hud.metal.classList.toggle('marked', (stock?.metal ?? 0) >= PLENTY.metal);
    }
    if (hud.food && hud.foodCount && hud.foodRest) {
      const second = Math.floor((view?.tick ?? 0) / TICKS_PER_SECOND);
      if (view && stock && seat !== null && (second !== meal.second || seat !== meal.seat)) {
        meal = { second, seat, short: !fullMeal(view, seat) };
      }
      hud.foodCount.textContent = stock ? String(stock.food) : '—';
      hud.foodCount.classList.toggle('marked', Boolean(stock) && meal.seat === seat && meal.short);
      hud.foodRest.textContent = stock && view && seat !== null ? ` / ${foodStore(view, seat)} · hunger ${stock.hunger}%` : '';
      hud.food.style.color = stock?.hunger ? 'var(--amber)' : '';
    }
    if (hud.selection) {
      const b = selected ? view?.buildings[selected] : null;
      if (b) {
        hud.selection.textContent = describe(b);
        hud.selection.style.color = view ? sideOf(view, b.owner).accent : '';
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
    if (hud.players) {
      // Seated players who are here, of the seats; it blinks while the game waits.
      const here = new Set(peers.filter((p) => p.seat !== null).map((p) => p.seat)).size;
      hud.players.textContent = view ? `${here}/${seatsOf(view)}` : '—';
      hud.players.classList.toggle('waiting', paused && view?.over === undefined);
    }
    if (hud.observers) {
      const watching = peers.filter((p) => p.seat === null);
      hud.observers.textContent = net.connected() ? String(watching.length) : 'offline';
      hud.observers.title = watching.map((p) => p.name).filter(Boolean).join(', ');
    }

    // Once it is over, a seat keeps its holder's name in the table of points.
    const over = view?.over !== undefined;
    seatButton.hidden = over || (seat === null && !net.canClaimSeat());
    scoresButton.hidden = !over;
    seatButton.textContent = seat === null ? 'Take seat' : 'Release seat';

    const can = canCommand();
    for (const button of buildButtons) {
      button.disabled = !can;
      button.setAttribute('aria-pressed', String(placing === button.dataset.kind));
    }
    const b = selected ? view?.buildings[selected] : null;
    const mine = Boolean(can && b && isMine(selected));
    const upgradable = Boolean(mine && b && !isRising(b) && b.upgrading === undefined && b.grade < BUILDING_TYPES[b.type].grades);
    upgradeButton.disabled = !upgradable;
    const price = upgradable && b ? upgradeCost(b) : null;
    const priced = [price?.stone ? String(price.stone) : '', price?.metal ? `${price.metal}◆` : ''].filter(Boolean);
    keyLabel(upgradeButton, priced.length ? `Upgrade · ${priced.join(' + ')}` : 'Upgrade');
    const crewed = Boolean(mine && b && b.type !== 'castle' && !isDugOut(b));
    crewButton.disabled = !crewed;
    // Your castle has no crew (everyone at home is in it): Heroes takes its place.
    const castle = Boolean(b && b.type === 'castle' && isMine(selected));
    crewButton.hidden = castle;
    heroesButton.hidden = !castle;
    returnButton.disabled = !(crewed && view && b && crewOf(view, b.id).length > 0);
    abortButton.disabled = !(mine && b && isRising(b));
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
    const done = percent(b.work ?? 0, type.work ?? 1);
    if (b.type === 'castle') {
      parts.push(`${occ?.inside.get(b.id)?.length ?? 0}/${capacityOf(b)} at home`, `next unit ${done}`);
    } else if (type.capacity) {
      parts.push(`crew ${view ? crewOf(view, b.id).length : 0}/${capacityOf(b)}`);
    }
    // The lair, raiders and the horde fight by themselves, at a level of their own.
    if (type.attack) parts.push(`level ${type.attack.skill}`);
    const toward = (/** @type {number} */ sofar) => percent(sofar, raiseWork(b));
    if (b.upgrading !== undefined) parts.push(`upgrading ${toward(b.upgrading)}`);
    if (isRising(b)) {
      parts.push(`going up ${toward(b.raised ?? 0)}`);
    } else {
      if (type.depth !== undefined) {
        // The stone left to dig before it is a grade deeper.
        const per = type.perDepth ?? 1;
        parts.push(isDugOut(b) ? 'dug out' : `depth ${depthOf(b)}/${type.depth}, ${per - ((b.dug ?? 0) % per)} stone`);
      }
      if (type.yields === 'food') parts.push(`next food ${done}`);
    }
    if (b.hp !== undefined && view) parts.push(`HP ${b.hp}/${maxHp(view, b)}`);
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
   * A unit's age, in whole minutes of the game's time.
   * @param {{ born?: number }} u
   */
  function minutesOld(u) {
    return view ? Math.max(0, Math.floor((view.tick - (u.born ?? view.tick)) / (60 * TICKS_PER_SECOND))) : 0;
  }

  /**
   * Show the player's heroes alive now, highest level first, to read: each
   * with its level, age and whereabouts as the crew chooser has them, and
   * every skill's level. Levels take three places ("Lv  8", "Lv 15",
   * "Lv100"), so the skills line up from row to row.
   */
  function showHeroes() {
    const seat = net.seat();
    if (!view || seat === null) return;
    const units = Object.values(view.units).filter((u) => u.owner === seat);
    const heroes = units.filter((u) => u.hero).sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
    const skills = /** @type {[import('../core/rules.js').Skill, string][]} */ (Object.entries(SKILL_SHORT));
    const lv = (/** @type {number} */ n) => `Lv${String(n).padStart(3)}`;
    heroesList.replaceChildren(...heroes.map((u) => {
      const name = document.createElement('span');
      name.textContent = u.name;
      const years = document.createElement('span');
      years.className = 'hero';
      years.textContent = `${minutesOld(u)}m`;
      const stats = document.createElement('span');
      stats.className = 'stats';
      stats.append(`${lv(u.level)} · `, years);
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = whereIs(u, null);
      const levels = document.createElement('span');
      levels.className = 'skills';
      levels.append(...skills.map(([skill, short]) => {
        const level = document.createElement('span');
        level.textContent = `${short} ${lv(u.skills[skill])}`;
        level.title = SKILLS[skill];
        return level;
      }));
      const li = document.createElement('li');
      li.dataset.unit = u.id;
      li.append(name, stats, where, levels);
      return li;
    }));
    if (!heroes.length) {
      const none = document.createElement('li');
      none.className = 'none';
      none.textContent = 'None yet: about one unit in ten is born a hero.';
      heroesList.append(none);
    }
    heroesCount.textContent = `${heroes.length} of your ${units.length} units`;
    heroesDialog.showModal();
    heroesList.scrollTop = 0;
  }

  /**
   * Let the player choose a crew: a list of their units, with the current
   * crew ticked, or for a new building the ones at home best at its work, up
   * to half of those at home, so the castle keeps some to breed.
   * @param {object} options
   * @param {string} options.title
   * @param {string} options.hint
   * @param {string} options.action The confirm button's label.
   * @param {string} options.kind The building's type, whose skill ranks the units.
   * @param {number} options.limit How many it takes.
   * @param {string | null} options.target The building, or null for a new one.
   * @param {string} options.key The letter that confirms it, besides Enter: the
   *   one that opened it.
   * @param {{ q: number, r: number }} options.site Where the crew goes, for the
   *   Nearest order.
   * @returns {Promise<string[] | null>} The chosen unit ids, or null if cancelled.
   */
  function chooseCrew({ title, hint, action, kind, limit, target, key, site }) {
    const seat = net.seat();
    if (!view || seat === null) return Promise.resolve(null);
    const { skill, extra } = BUILDING_TYPES[kind];
    const home = castleOf(view, seat)?.id;
    const units = Object.values(view.units).filter((u) => u.owner === seat);
    /** @param {typeof units[number]} a @param {typeof units[number]} b */
    const better = (a, b) => b.skills[skill] - a.skills[skill] || b.level - a.level || a.name.localeCompare(b.name);
    const atHome = units.filter((u) => u.in === home);
    const chosen = new Set(target
      ? crewOf(view, target)
      : atHome.sort(better).slice(0, Math.min(limit, Math.floor(atHome.length / 2))).map((u) => u.id));
    const rank = (/** @type {typeof units[number]} */ u) => (chosen.has(u.id) ? 0 : u.in === home ? 1 : 2);
    units.sort((a, b) => rank(a) - rank(b) || better(a, b));

    crewParts.title.textContent = title;
    crewParts.hint.textContent = hint;
    crewParts.ok.textContent = action;
    crewParts.ok.title = `${action} (Enter or ${key})`;
    /** Each unit's row, by id. */
    /** @type {Map<string, HTMLElement>} */
    const rows = new Map();
    crewParts.list.replaceChildren(...units.map((u) => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = u.id;
      box.checked = chosen.has(u.id);
      const name = document.createElement('span');
      name.textContent = u.name;
      const stats = document.createElement('span');
      stats.className = 'stats';
      // A hero's age shows in gold: it levels up about three times as high.
      const years = document.createElement('span');
      years.textContent = `${minutesOld(u)}m`;
      if (u.hero) {
        years.className = 'hero';
        years.title = 'A hero: levels up faster than the rest';
      }
      stats.append(`Lv ${u.level} · ${SKILLS[skill]} ${u.skills[skill]} · `, years);
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = extra ? `${whereIs(u, target)} · ${SKILLS[extra]} ${u.skills[extra]}` : whereIs(u, target);
      const label = document.createElement('label');
      label.append(box, name, stats, where);
      const li = document.createElement('li');
      li.append(label);
      rows.set(u.id, li);
      return li;
    }));

    // The default order, or by level, or by how far each is from the site.
    // A reorder moves the rows themselves, so every tick stays as it was.
    const placeOf = (/** @type {typeof units[number]} */ u) => (u.in && view.buildings[u.in]) || u;
    /** @type {Record<string, typeof units>} */
    const orders = {
      default: [...units],
      skill: [...units].sort(better),
      hero: [...units].sort((a, b) => Number(Boolean(b.hero)) - Number(Boolean(a.hero)) || b.level - a.level || better(a, b)),
      level: [...units].sort((a, b) => b.level - a.level || better(a, b)),
      near: [...units].sort((a, b) => distance(placeOf(a), site) - distance(placeOf(b), site) || better(a, b)),
    };
    const order = (/** @type {string} */ name) => {
      crewParts.list.append(.../** @type {HTMLElement[]} */ (orders[name].map((u) => rows.get(u.id))));
      crewParts.list.scrollTop = 0;
      for (const button of crewParts.sorts) button.setAttribute('aria-pressed', String(button.dataset.sort === name));
    };
    const bySkill = /** @type {HTMLButtonElement} */ (document.getElementById('crew-sort-skill'));
    // A crew that fights is chosen for its attack: close combat comes too late.
    bySkill.textContent = skill === 'ranged' ? 'Attack' : SKILLS[skill];
    bySkill.title = `Best at ${SKILLS[skill].toLowerCase()} first`;
    for (const button of crewParts.sorts) button.onclick = () => order(button.dataset.sort ?? 'default');
    order('default');
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

    // With a mouse, a press on a row ticks or unticks it, and dragging on
    // does the same to every row it passes over. On a touch screen a drag
    // scrolls the list, so there it is a tap a row.
    /** Tick or untick a box as a click would, within the limit. */
    const setBox = (/** @type {HTMLInputElement} */ box, /** @type {boolean} */ on) => {
      if (box.checked === on || (on && box.disabled)) return;
      box.checked = on;
      if (on) chosen.add(box.value);
      else chosen.delete(box.value);
      sync();
    };
    const boxAt = (/** @type {EventTarget | null} */ t) => (
      t instanceof Element ? t.closest('label')?.querySelector('input') ?? null : null);
    /** While the mouse drags: whether it ticks (true) or unticks. */
    /** @type {boolean | null} */
    let painting = null;
    /** The press did what its click would, so that click does nothing. */
    let pressed = false;
    crewParts.list.onpointerdown = (e) => {
      const box = boxAt(e.target);
      if (e.pointerType !== 'mouse' || e.button !== 0 || !box || box.disabled) return;
      painting = !box.checked;
      pressed = true;
      setBox(box, painting);
    };
    crewParts.list.onpointerover = (e) => {
      if (painting === null) return;
      // The button came up somewhere else.
      if (!(e.buttons & 1)) painting = null;
      else if (boxAt(e.target)) setBox(/** @type {HTMLInputElement} */ (boxAt(e.target)), painting);
    };
    crewParts.list.onpointerup = () => { painting = null; };
    crewParts.list.onclick = (e) => {
      // Clicks from the keyboard (space on a box) carry no detail and go ahead.
      if (pressed && e.detail > 0) e.preventDefault();
      pressed = false;
    };

    // Enter confirms, as does the letter that opened it; Enter on a button
    // still presses that button, and Escape cancels.
    crewDialog.onkeydown = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const confirms = e.key === 'Enter' ? !(e.target instanceof HTMLButtonElement) : e.key.toLowerCase() === key.toLowerCase();
      if (!confirms) return;
      e.preventDefault();
      crewParts.ok.click();
    };

    crewDialog.returnValue = '';
    crewTarget = target;
    crewDialog.showModal();
    // The first unit, not the first order button, so Enter sends the crew.
    crewParts.list.querySelector('input')?.focus({ preventScroll: true });
    return new Promise((resolve) => {
      crewDialog.addEventListener('close', () => {
        crewTarget = null;
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
    sounds.play(outcome.ok ? 'ok' : 'no');
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
      // Short of its price now (a teammate may have spent it), say so
      // before a crew is chosen for nothing.
      const seat = net.seat();
      const short = seat !== null ? shortOf(view, seat, buildCost(kind)) : null;
      if (short) {
        flash(`Can't build a ${type.name.toLowerCase()}: ${short}.`);
        sounds.play('no');
        placing = null;
        refreshHighlights();
        updateHud();
        return;
      }
      // Only for a cell it can go on: anywhere else, the server says why not.
      if (highlights.has(key(at.q, at.r))) {
        const chosen = await chooseCrew({
          title: `New ${type.name.toLowerCase()}`,
          hint: type.band
            ? `Choose who goes, up to ${type.capacity}. The best fighters at home are ticked, up to half of those at home.`
            : `Choose its crew, up to ${type.capacity}: they build it once they get there, then work it. `
              + 'The best at home for the work are ticked, up to half of those at home.',
          action: 'Build',
          kind,
          limit: type.capacity,
          target: null,
          key: type.name[0],
          site: at,
        });
        if (!chosen) return;
        units = chosen;
      }
      if (await give({ type: 'build', kind, q: at.q, r: at.r, ...(units.length ? { units } : {}) }, 'build there')) placing = null;
      refreshHighlights();
      updateHud();
      return;
    }

    // Bands hold no cell, so they are found by where they stand.
    const here = occ.buildingAt.get(key(at.q, at.r))
      ?? Object.values(view.buildings).find((b) => BUILDING_TYPES[b.type].band && b.q === at.q && b.r === at.r)?.id
      ?? null;
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
      if (selected) sounds.play('select');
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
    viewW = rect.width;
    viewH = rect.height;
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

  // Pressing or dragging on the minimap looks there, at the same zoom.
  /** @type {number | null} */
  let mapPointer = null;
  /** @param {PointerEvent} e */
  const lookAt = (e) => {
    const w = minimap.worldAt(e.clientX, e.clientY);
    camera.centreOn(w.x, w.y, viewW, viewH);
    needsDraw = true;
  };
  mapCanvas.addEventListener('pointerdown', (e) => {
    if (mapPointer !== null) return;
    mapPointer = e.pointerId;
    mapCanvas.setPointerCapture(e.pointerId);
    lookAt(e);
  });
  mapCanvas.addEventListener('pointermove', (e) => {
    if (e.pointerId === mapPointer) lookAt(e);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    mapCanvas.addEventListener(type, (e) => {
      if (/** @type {PointerEvent} */ (e).pointerId === mapPointer) mapPointer = null;
    });
  }

  // On a phone the minimap sits just above the controls, whose height
  // depends on how their buttons wrap.
  new ResizeObserver(() => {
    stage.style.setProperty('--controls-height', `${controls.offsetHeight}px`);
  }).observe(controls);
  // The legend keeps below the status panel, however tall that grows.
  const statusPanel = /** @type {HTMLElement} */ (document.getElementById('status'));
  new ResizeObserver(() => {
    stage.style.setProperty('--status-height', `${statusPanel.offsetHeight}px`);
  }).observe(statusPanel);

  addEventListener('keydown', (e) => {
    // Escape in the crew chooser closes just the chooser.
    if (e.key !== 'Escape' || crewDialog.open || heroesDialog.open || scoresDialog.open || renameDialog.open || (!placing && !selected && !aiming)) return;
    aiming = null;
    placing = null;
    selected = null;
    refreshHighlights();
    updateHud();
  });

  // A letter presses the button it is bold on (its aria-keyshortcuts),
  // unless typing or in a dialog, or a dialog just took it to close (it
  // shuts before the key gets here, so it must not open again).
  const shortcuts = new Map([...controls.querySelectorAll('button[aria-keyshortcuts]')]
    .map((button) => [button.getAttribute('aria-keyshortcuts')?.toLowerCase(), /** @type {HTMLButtonElement} */ (button)]));
  addEventListener('keydown', (e) => {
    const button = shortcuts.get(e.key.toLowerCase());
    if (!button || button.disabled || button.hidden) return;
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (crewDialog.open || heroesDialog.open || scoresDialog.open || renameDialog.open) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    button.click();
  });

  for (const button of buildButtons) {
    const { name, cost, metal } = BUILDING_TYPES[button.dataset.kind ?? ''];
    keyLabel(button, cost ? `${name} · ${cost}` : metal ? `${name} · ${metal}◆` : name);
    button.title = `${name} (${name[0]}): ${cost ? `${cost} stone` : metal ? `${metal} dark metal, near your castle` : 'free'}`;
    button.addEventListener('click', () => {
      const kind = button.dataset.kind ?? null;
      // Short of its price, say so now, not after a cell and a crew are chosen.
      const seat = net.seat();
      const short = kind && placing !== kind && view && seat !== null ? shortOf(view, seat, buildCost(kind)) : null;
      if (short) {
        flash(`Can't build a ${name.toLowerCase()}: ${short}.`);
        sounds.play('no');
        return;
      }
      placing = placing === kind ? null : kind;
      refreshHighlights();
      updateHud();
    });
  }

  // Renaming the game: the name as the lobby will show it, checked as the
  // server will check it. Enter renames, Escape leaves it be.
  const renameHint = /** @type {HTMLElement} */ (document.getElementById('rename-hint'));
  renameHint.textContent = `What the lobby calls it, for everyone: up to ${GAME_NAME_MAX} letters, digits and spaces.`;
  renameInput.maxLength = 2 * GAME_NAME_MAX; // counted in UTF-16; cleanGameName counts letters
  renameButton.addEventListener('click', () => {
    renameInput.value = view?.name ?? '';
    renameError.textContent = '';
    renameDialog.returnValue = '';
    renameDialog.showModal();
    renameInput.select();
  });
  renameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    renameOk.click();
  });
  renameOk.addEventListener('click', (e) => {
    const name = cleanGameName(renameInput.value);
    if (name === null) {
      e.preventDefault();
      renameError.textContent = `Use 1–${GAME_NAME_MAX} letters, digits and spaces; - _ . ' may go between them.`;
      return;
    }
    if (name !== view?.name) give({ type: 'rename', name }, 'rename the game');
  });

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
      key: 'C',
      site: b,
    });
    if (units) give({ type: 'crew', building: b.id, units }, 'send that crew');
  });

  // The heroes list: H, as well as Enter or Escape, closes it again.
  /** @type {HTMLElement} */ (document.getElementById('heroes-hint')).textContent = `Yours alive now, highest level first, with each skill's level: ${
    Object.entries(SKILL_SHORT).map(([skill, short]) => `${short} ${SKILLS[/** @type {import('../core/rules.js').Skill} */ (skill)].toLowerCase()}`).join(', ')}.`;
  heroesButton.addEventListener('click', showHeroes);
  heroesDialog.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'h' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    heroesDialog.close();
  });

  attackButton.addEventListener('click', () => {
    aiming = aiming ? null : selected;
    if (aiming) flash('Click an enemy building to attack; anywhere else clears the target.');
    updateHud();
  });

  abortButton.addEventListener('click', () => {
    if (selected) give({ type: 'abort', building: selected }, 'give it up');
  });

  returnButton.addEventListener('click', () => {
    if (selected) give({ type: 'crew', building: selected, units: [] }, 'send them home');
  });

  scoresButton.addEventListener('click', () => { showScores(); });
  /** @type {HTMLElement} */ (document.getElementById('scores-close')).addEventListener('click', () => scoresDialog.close());
  /** @type {HTMLAnchorElement} */ (document.getElementById('scores-leave')).href = serverBase().pathname;

  // Browsers let a page start its audio only once the player clicks or presses a key.
  addEventListener('pointerdown', () => sounds.wake(), { capture: true });
  addEventListener('keydown', () => sounds.wake(), { capture: true });
  muteButton.setAttribute('aria-pressed', String(sounds.muted));
  muteButton.addEventListener('click', () => {
    sounds.setMuted(!sounds.muted);
    muteButton.setAttribute('aria-pressed', String(sounds.muted));
  });

  // "How to play" stays as the player last left it, open or closed, in this browser.
  const howTo = /** @type {HTMLDetailsElement} */ (document.getElementById('how-to-play'));
  try {
    if (localStorage.getItem(HOW_TO_KEY) === 'closed') howTo.open = false;
  } catch {
    // Open, then.
  }
  howTo.addEventListener('toggle', () => {
    try {
      localStorage.setItem(HOW_TO_KEY, howTo.open ? 'open' : 'closed');
    } catch {
      // Not remembered, then.
    }
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

  /** @param {number} time */
  function frame(time) {
    // Queue the next frame first, so one frame that throws cannot stop the
    // board from ever redrawing again.
    requestAnimationFrame(frame);
    minimap.paint(time);
    const played = playing;
    playing = effects.playing(time);
    const animated = animating;
    animating = moving && net.running();
    if (!needsDraw && !animating && !animated && !playing && !played) return;
    needsDraw = false;
    draws += 1;
    renderer.draw({ camera, view, clock: net.clock(), selected, highlights, hover, peers, effects, now: time });
    minimap.frameView(camera, viewW, viewH);
  }

  resize();
  net.onState(onState);
  net.onPeers((list) => {
    peers = list;
    needsDraw = true;
    updateHud();
  });
  net.onSeat(() => {
    // The first time this viewer has a castle, look at it.
    if (!homed && net.seat() !== null) recenter();
    refreshHighlights();
    updateHud();
  });
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
      get crewTarget() { return crewTarget; },
      get scoresOpen() { return scoresDialog.open; },
      get highlights() { return [...highlights]; },
      get peers() { return peers; },
      get minimap() { return minimap; },
      get facingLeft() { return [...renderer.facingLeft]; },
      get draws() { return draws; },
      effects,
      tokens,
      sounds,
      net,
      camera,
      forceDraw: () => { needsDraw = true; },
    },
  });
}
