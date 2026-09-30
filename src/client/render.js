/**
 * Canvas 2D renderer for the board.
 *
 * Buildings and units are tokens (tokens.js): round counters in their
 * side's colour with a picture on, or their letter until the pictures load.
 *
 * Kept behind a small interface (construct, then call draw each frame) so a
 * WebGL renderer such as PixiJS can be dropped in later without the rest of
 * the app caring. It draws a view of the game (see `publicView` in game.js)
 * at a moment in time, placing marching units and rolling wagons between
 * cells by the clock.
 */

import { DIRECTIONS, axialToPixel, corners, key } from '../core/hex.js';
import { depthOf, footprint, maxHp, occupancy, raiseWork, sideOf } from '../core/game.js';
import { BUILDING_TYPES } from '../core/rules.js';

/** Base colours per terrain, before per-tile tint. */
const TERRAIN_COLORS = {
  grass:  { h: 104, s: 32, l: 40 },
  meadow: { h: 88,  s: 38, l: 48 },
  scrub:  { h: 74,  s: 24, l: 34 },
  water:  { h: 203, s: 44, l: 40 },
};

/**
 * A cell's ground colour: its terrain's, shifted a little by the tile's tint.
 * @param {import('../core/board.js').Tile} tile
 */
export function groundColor(tile) {
  const base = TERRAIN_COLORS[tile.terrain];
  const lift = (tile.tint - 0.5) * 7;
  return hsl(base.h + (tile.tint - 0.5) * 8, base.s, base.l + lift);
}

/**
 * Which neighbour lies across each edge of a pointy-top hex, for the edge
 * from corner i to corner i + 1 (see `corners` in hex.js).
 */
const EDGE_NEIGHBOUR = [1, 0, 5, 4, 3, 2];

/**
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @param {number} [a=1]
 */
function hsl(h, s, l, a = 1) {
  return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

/**
 * How far something moving is between its cell and the next, from 0 to 1.
 * @param {{ since?: number, until?: number }} e
 * @param {number} clock
 */
function progress(e, clock) {
  if (e.since === undefined || e.until === undefined || e.until <= e.since) return 0;
  return Math.min(1, Math.max(0, (clock - e.since) / (e.until - e.since)));
}

/**
 * A number from a string, for looks that stay the same from frame to frame.
 * @param {string} id
 */
function hash(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761) >>> 0;
  return h;
}

/**
 * The next of a run of numbers from `hash`.
 * @param {number} h
 */
function scramble(h) {
  return Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
}

/**
 * A small fixed offset per unit, so units on one cell don't sit exactly on
 * top of each other.
 * @param {string} id
 */
function jitter(id) {
  const h = hash(id);
  return { x: ((h & 0xff) / 255 - 0.5) * 0.5, y: (((h >>> 8) & 0xff) / 255 - 0.5) * 0.5 };
}

/**
 * Fast, then settling: for things thrown out or rising.
 * @param {number} t From 0 to 1.
 */
function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

/** A hit point bar's colour, by the part of them left. */
const HP_COLORS = [
  { above: 0.6, color: '#62d26f' },
  { above: 0.3, color: '#f0c43c' },
  { above: -1, color: '#ef5a4a' },
];

/**
 * How wide a building's token is, in hexes: the castle and the lair span
 * their middle cell, the rest sit inside theirs.
 * @param {import('../core/rules.js').BuildingType} type
 * @param {boolean} rolling
 */
function tokenHexes(type, rolling) {
  return type.size === 7 ? 2.3 : rolling ? 1.05 : 1.2;
}

/** Zoomed out past this, buildings don't show how many units are inside. */
export const COUNT_ZOOM = 0.45;

/**
 * The pips under a building: one for each upgrade it has had, or for a pit
 * each grade it is dug deep; none for a new one.
 * @param {Pick<Building, 'type' | 'grade' | 'dug'>} b
 */
export function pipsOf(b) {
  return BUILDING_TYPES[b.type].depth !== undefined ? depthOf(b) : b.grade - 1;
}

/** A unit's token, in hexes; narrower than UNIT_TOKEN_MIN pixels, a dot. */
const UNIT_TOKEN = 0.42;
const UNIT_TOKEN_MIN = 11;

/** @typedef {import('../core/game.js').Building} Building */
/** @typedef {import('./effects.js').Effect} Effect */

export class BoardRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/board.js').Board} board
   * @param {import('./tokens.js').Tokens | null} [tokens] The pictures, once loaded.
   */
  constructor(canvas, board, tokens = null) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.board = board;
    this.tokens = tokens;
    this.cornerOffsets = corners(board.hexSize);
    this.showCoords = false;
  }

  /**
   * Trace a hex path centred at a screen point.
   * @param {number} cx Screen centre x.
   * @param {number} cy Screen centre y.
   * @param {number} zoom
   * @param {number} [scale=1] Shrinks the hex about its centre, for the
   *   concentric rings that let several viewers pick the same tile.
   */
  hexPath(cx, cy, zoom, scale = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const o = this.cornerOffsets[i];
      const x = cx + o.x * zoom * scale;
      const y = cy + o.y * zoom * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /**
   * Screen position of a cell's centre.
   * @param {import('./camera.js').Camera} camera
   * @param {number} q
   * @param {number} r
   */
  cellAt(camera, q, r) {
    const wp = axialToPixel(q, r, this.board.hexSize);
    return camera.toScreen(wp.x, wp.y);
  }

  /**
   * Where a building is drawn: on its anchor cell, or between cells while
   * it rolls, toward `rolling`.
   * @param {import('./camera.js').Camera} camera
   * @param {Building} b
   * @param {number} clock
   */
  place(camera, b, clock) {
    const rolling = BUILDING_TYPES[b.type]?.speed && b.path?.length ? b.path[0] : undefined;
    return { centre: this.between(camera, b.q, b.r, rolling, progress(b, clock)), rolling };
  }

  /**
   * Screen position of a point between two cells.
   * @param {import('./camera.js').Camera} camera
   * @param {number} q
   * @param {number} r
   * @param {[number, number] | undefined} next
   * @param {number} t 0 at (q, r), 1 at `next`.
   */
  between(camera, q, r, next, t) {
    const size = this.board.hexSize;
    const a = axialToPixel(q, r, size);
    const b = next ? axialToPixel(next[0], next[1], size) : a;
    return camera.toScreen(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }

  /**
   * Draw one frame.
   *
   * @param {object} state
   * @param {import('./camera.js').Camera} state.camera
   * @param {import('./net.js').GameView | null} state.view The game, or null before it arrives.
   * @param {number} state.clock Game time in ticks, with a fraction.
   * @param {string | null} state.selected The selected building's id.
   * @param {Set<string>} state.highlights Cell keys to highlight, such as where a building could go.
   * @param {{ q: number, r: number } | null} state.hover
   * @param {Array<import('./net.js').NetPeer>} [state.peers] Viewers' picked
   *   hexes, drawn as concentric rings so overlapping picks stay legible.
   * @param {import('./effects.js').Effects} [state.effects] Hits, falls and
   *   deaths playing out.
   * @param {number} [state.now] performance.now(), for the effects.
   */
  draw(state) {
    const { camera, view, clock, selected, highlights, hover } = state;
    const peers = state.peers ?? [];
    const effects = state.effects?.list ?? [];
    const now = state.now ?? 0;
    const age = (/** @type {Effect} */ e) => Math.min(1, Math.max(0, (now - e.start) / (e.end - e.start)));
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Sky/void behind the board.
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#171d18');
    bg.addColorStop(1, '#101410');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const zoom = camera.zoom;
    const size = this.board.hexSize;
    const margin = size * zoom * 2;
    const onScreen = (/** @type {{ x: number, y: number }} */ p) => (
      p.x >= -margin && p.x <= w + margin && p.y >= -margin && p.y <= h + margin
    );
    const cellScreen = (/** @type {number} */ q, /** @type {number} */ r) => this.cellAt(camera, q, r);

    // Cull anything outside the viewport before touching the path API.
    /** @type {Array<{ tile: import('../core/board.js').Tile, cx: number, cy: number }>} */
    const visible = [];
    for (const tile of this.board.list) {
      const sp = cellScreen(tile.q, tile.r);
      if (onScreen(sp)) visible.push({ tile, cx: sp.x, cy: sp.y });
    }

    // Pass 1: terrain fill.
    for (const { tile, cx, cy } of visible) {
      this.hexPath(cx, cy, zoom);
      ctx.fillStyle = groundColor(tile);
      ctx.fill();
    }

    // Pass 2: grid lines, drawn after all fills so no fill overlaps a line.
    ctx.lineWidth = Math.max(0.5, 1 * zoom);
    ctx.strokeStyle = 'rgba(12, 22, 12, 0.30)';
    for (const { cx, cy } of visible) {
      this.hexPath(cx, cy, zoom);
      ctx.stroke();
    }

    // Pass 3: highlighted cells, such as where a building could go.
    if (highlights.size) {
      for (const { tile, cx, cy } of visible) {
        if (!highlights.has(key(tile.q, tile.r))) continue;
        this.hexPath(cx, cy, zoom);
        ctx.fillStyle = 'rgba(150, 205, 255, 0.24)';
        ctx.fill();
        ctx.lineWidth = Math.max(1, 1.5 * zoom);
        ctx.strokeStyle = 'rgba(190, 228, 255, 0.5)';
        ctx.stroke();
      }
    }

    const occ = view ? occupancy(view) : null;

    // Pass 4: buildings that just fell, crumbling where they stood, under
    // whatever stands now.
    if (view) {
      for (const e of effects) if (e.kind === 'fall') this.drawFall(camera, view, e, age(e));
    }

    /** Hit point bars, drawn over the units once the buildings are done. */
    /** @type {Array<{ x: number, y: number, width: number, part: number }>} */
    const bars = [];

    // Pass 5: buildings. Standing ones fill their cells and outline the whole
    // shape, so a castle reads as one thing across its seven cells.
    if (view && occ) {
      for (const b of Object.values(view.buildings)) {
        const type = BUILDING_TYPES[b.type];
        const side = sideOf(view, b.owner);
        if (!type || !side) continue;
        const isSelected = b.id === selected;
        const { centre, rolling } = this.place(camera, b, clock);
        if (!onScreen(centre)) continue;

        // A building going up is pale, with a dashed outline. One just hit
        // flashes red.
        const rising = b.raised !== undefined;
        const flash = state.effects?.flash(b.id, now) ?? 0;
        const cells = rolling ? [{ q: b.q, r: b.r }] : footprint(b.type, b.q, b.r);
        const inShape = new Set(cells.map((c) => key(c.q, c.r)));
        for (const c of cells) {
          const sp = rolling ? centre : cellScreen(c.q, c.r);
          this.hexPath(sp.x, sp.y, zoom, rolling ? 0.8 : 1);
          ctx.fillStyle = side.color + (rising ? '2e' : rolling ? '55' : '66');
          ctx.fill();
          if (flash) {
            ctx.fillStyle = `rgba(255, 96, 72, ${(0.6 * flash).toFixed(3)})`;
            ctx.fill();
          }
        }
        ctx.lineWidth = Math.max(1.5, (isSelected ? 3.5 : 2) * zoom);
        ctx.strokeStyle = isSelected ? '#ffd84d' : side.accent;
        ctx.setLineDash(rising ? [5 * zoom, 4 * zoom] : []);
        ctx.beginPath();
        for (const c of cells) {
          const sp = rolling ? centre : cellScreen(c.q, c.r);
          const scale = rolling ? 0.8 : 1;
          for (let i = 0; i < 6; i++) {
            const d = DIRECTIONS[EDGE_NEIGHBOUR[i]];
            if (!rolling && inShape.has(key(c.q + d.q, c.r + d.r))) continue;
            const a = this.cornerOffsets[i];
            const z = this.cornerOffsets[(i + 1) % 6];
            ctx.moveTo(sp.x + a.x * zoom * scale, sp.y + a.y * zoom * scale);
            ctx.lineTo(sp.x + z.x * zoom * scale, sp.y + z.y * zoom * scale);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Its token (a site's fades in as it goes up; its letter until the
        // pictures arrive), its pips under it, and how many are inside.
        const across = size * zoom * tokenHexes(type, Boolean(rolling));
        const built = rising ? Math.min(1, (b.raised ?? 0) / Math.max(1, raiseWork(b))) : 1;
        const drawn = this.tokens?.draw(ctx, b.type, side.color, centre.x, centre.y, across, 0.3 + 0.7 * built);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (!drawn) {
          ctx.font = `600 ${Math.round(across * 0.45)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillText(type.name[0], centre.x, centre.y);
        }
        const pips = pipsOf(b);
        for (let g = 0; g < pips; g++) {
          ctx.beginPath();
          ctx.arc(centre.x + (g - (pips - 1) / 2) * 6 * zoom, centre.y + across / 2 + 3 * zoom, 1.8 * zoom, 0, Math.PI * 2);
          ctx.fill();
        }
        const count = occ.inside.get(b.id)?.length ?? 0;
        if (count && zoom > COUNT_ZOOM) {
          const label = String(count);
          ctx.font = `600 ${Math.round(10 * zoom)}px ui-monospace, monospace`;
          const bw = ctx.measureText(label).width + 8 * zoom;
          const bx = centre.x + across * 0.42;
          const by = centre.y - across * 0.42;
          ctx.fillStyle = 'rgba(12, 16, 12, 0.85)';
          ctx.fillRect(bx - bw / 2, by - 7 * zoom, bw, 14 * zoom);
          ctx.fillStyle = side.accent;
          ctx.fillText(label, bx, by + 0.5);
        }

        // Its hit points, over the top of it, when it is hurt or selected.
        if (b.hp !== undefined) {
          const full = maxHp(view, b);
          if (b.hp < full || isSelected) {
            const big = type.size === 7;
            bars.push({
              x: centre.x,
              y: centre.y - size * zoom * (big ? 2.5 : rolling ? 0.8 : 1),
              width: size * zoom * (big ? 2.6 : 1.1),
              part: Math.max(0, Math.min(1, b.hp / full)),
            });
          }
        }
      }
    }

    // Pass 6: units out on the map, drawn between cells as they march: as
    // tokens, or dots when those would be too small to make out.
    if (view) {
      const radius = Math.max(2, size * 0.1 * zoom);
      const across = size * zoom * UNIT_TOKEN;
      const tokens = across >= UNIT_TOKEN_MIN && this.tokens?.has('unit') ? this.tokens : null;
      for (const u of Object.values(view.units)) {
        if (u.in !== undefined || u.q === undefined || u.r === undefined) continue;
        const side = sideOf(view, u.owner);
        if (!side) continue;
        const p = this.between(camera, u.q, u.r, u.path?.[0], progress(u, clock));
        const j = jitter(u.id);
        const x = p.x + j.x * size * zoom;
        const y = p.y + j.y * size * zoom;
        if (!onScreen({ x, y })) continue;
        if (tokens?.draw(ctx, 'unit', side.color, x, y, across)) continue;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = side.color;
        ctx.fill();
        ctx.lineWidth = Math.max(1, zoom);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.stroke();
      }
    }

    // Pass 7: hit point bars.
    const barHeight = Math.max(3, 4 * zoom);
    for (const bar of bars) {
      const x = bar.x - bar.width / 2;
      const y = bar.y - barHeight - 2 * zoom;
      ctx.fillStyle = 'rgba(10, 12, 10, 0.8)';
      ctx.fillRect(x - 1, y - 1, bar.width + 2, barHeight + 2);
      ctx.fillStyle = /** @type {typeof HP_COLORS[number]} */ (HP_COLORS.find((c) => bar.part > c.above)).color;
      ctx.fillRect(x, y, bar.width * bar.part, barHeight);
    }

    // Pass 8: hit points lost, and units that died.
    if (view) {
      for (const e of effects) {
        if (e.kind === 'hit') this.drawHit(camera, view, e, age(e), clock);
        else if (e.kind === 'death') this.drawDeath(camera, view, e, age(e), clock);
      }
    }

    // Pass 9: viewers' picks. Several viewers may pick the same hex, so rings
    // for one tile nest inside each other rather than overdrawing.
    /** @type {Map<string, Array<import('./net.js').NetPeer>>} */
    const byHex = new Map();
    for (const p of peers) {
      if (!p.sel) continue;
      const k = key(p.sel.q, p.sel.r);
      const bucket = byHex.get(k);
      if (bucket) bucket.push(p);
      else byHex.set(k, [p]);
    }
    for (const [, group] of byHex) {
      const first = group[0];
      if (!first.sel) continue;
      const sp = cellScreen(first.sel.q, first.sel.r);
      if (!onScreen(sp)) continue;
      group.forEach((p, i) => {
        const scale = 1 - i * 0.11;
        if (scale <= 0.2) return;
        this.hexPath(sp.x, sp.y, zoom, scale);
        ctx.lineWidth = Math.max(1.5, (p.isMe ? 3 : 2.2) * zoom);
        ctx.strokeStyle = p.color;
        ctx.setLineDash(p.isMe ? [] : [6 * zoom, 4 * zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    // Pass 10: hover.
    if (hover) {
      const sp = cellScreen(hover.q, hover.r);
      this.hexPath(sp.x, sp.y, zoom);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, 2 * zoom);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.stroke();
    }

    // Pass 11: coordinate labels, debug aid.
    if (this.showCoords && zoom > 0.75) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.font = `${Math.round(9 * zoom)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const { tile, cx, cy } of visible) {
        ctx.fillText(`${tile.q},${tile.r}`, cx, cy - size * zoom * 0.55);
      }
    }
  }

  /**
   * A fallen building crumbling: its shape sinking and fading, pieces
   * thrown out, and a ring of dust.
   * @param {import('./camera.js').Camera} camera
   * @param {import('./net.js').GameView} view
   * @param {Effect} e
   * @param {number} t How far it has played, from 0 to 1.
   */
  drawFall(camera, view, e, t) {
    const b = /** @type {Building} */ (e.building);
    const type = BUILDING_TYPES[b.type];
    const side = sideOf(view, b.owner);
    if (!type || !side) return;
    const ctx = this.ctx;
    const zoom = camera.zoom;
    const size = this.board.hexSize;
    const { centre, rolling } = this.place(camera, b, e.clock);
    const cells = rolling ? [centre] : footprint(b.type, b.q, b.r).map((c) => this.cellAt(camera, c.q, c.r));
    const spread = size * zoom * (type.size === 7 ? 2.4 : 0.9);
    ctx.save();

    ctx.globalAlpha = 1 - t;
    for (const sp of cells) {
      this.hexPath(sp.x, sp.y + size * zoom * 0.15 * t, zoom, (rolling ? 0.8 : 1) * (1 - 0.35 * t));
      ctx.fillStyle = side.color + '99';
      ctx.fill();
      ctx.fillStyle = `rgba(28, 22, 18, ${(0.6 * t).toFixed(3)})`;
      ctx.fill();
    }
    // Its token sinks and shrinks as it fades (the alpha is already set).
    const across = size * zoom * tokenHexes(type, Boolean(rolling));
    this.tokens?.draw(ctx, b.type, side.color, centre.x, centre.y + size * zoom * 0.2 * t, across * (1 - 0.3 * t));

    const ring = spread * (0.7 + 0.8 * easeOut(t));
    ctx.globalAlpha = 0.6 * (1 - t);
    ctx.beginPath();
    ctx.ellipse(centre.x, centre.y, ring, ring * 0.75, 0, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, 3 * zoom * (1 - t));
    ctx.strokeStyle = '#d6c8aa';
    ctx.stroke();

    let h = hash(b.id);
    const pieces = type.size === 7 ? 18 : 8;
    const piece = Math.max(1.5, 3.5 * zoom) * (1 - 0.5 * t);
    ctx.globalAlpha = 1 - t;
    for (let i = 0; i < pieces; i++) {
      h = scramble(h);
      const angle = ((i + (h & 0xff) / 255) / pieces) * Math.PI * 2;
      const fly = spread * (0.5 + (((h >>> 8) & 0xff) / 255) * 0.7) * easeOut(t);
      const x = centre.x + Math.cos(angle) * fly;
      const y = centre.y + Math.sin(angle) * fly * 0.75 + size * zoom * 0.5 * t * t;
      ctx.fillStyle = i % 2 ? side.color : '#9a9282';
      ctx.fillRect(x - piece / 2, y - piece / 2, piece, piece);
    }
    ctx.restore();
  }

  /**
   * The hit points a building just lost, floating up off it.
   * @param {import('./camera.js').Camera} camera
   * @param {import('./net.js').GameView} view
   * @param {Effect} e
   * @param {number} t How far it has played, from 0 to 1.
   * @param {number} clock
   */
  drawHit(camera, view, e, t, clock) {
    const zoom = camera.zoom;
    if (zoom < 0.35) return;
    const hit = /** @type {Building} */ (e.building);
    const b = view.buildings[hit.id] ?? hit;
    const size = this.board.hexSize;
    const { centre } = this.place(camera, b, clock);
    // Hits a second apart would float up over each other; each goes a little aside.
    const aside = (((e.seq * 7) % 5) - 2) * size * zoom * 0.12;
    const type = BUILDING_TYPES[b.type];
    const lift = type ? (size * zoom * tokenHexes(type, false)) / 2 : 0;
    const x = centre.x + aside;
    const y = centre.y - lift - size * zoom * 0.6 * easeOut(t);
    const label = `\u2212${e.damage}`;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = t < 0.5 ? 1 : 2 * (1 - t);
    ctx.font = `700 ${Math.round(Math.max(10, 13 * zoom))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, 3 * zoom);
    ctx.strokeStyle = 'rgba(24, 10, 8, 0.85)';
    ctx.strokeText(label, x, y);
    ctx.fillStyle = '#ff8a78';
    ctx.fillText(label, x, y);
    ctx.restore();
  }

  /**
   * A unit that died: a cross rising from where it was, with a ring
   * spreading under it out on the map. Those who died inside a building
   * rise from it as one, with how many.
   * @param {import('./camera.js').Camera} camera
   * @param {import('./net.js').GameView} view
   * @param {Effect} e
   * @param {number} t How far it has played, from 0 to 1.
   * @param {number} clock
   */
  drawDeath(camera, view, e, t, clock) {
    const zoom = camera.zoom;
    const size = this.board.hexSize;
    const u = e.unit;
    const b = e.building && (view.buildings[e.building.id] ?? e.building);
    const owner = (u ?? b)?.owner;
    if (owner === undefined) return;
    const side = sideOf(view, owner);
    /** @type {{ x: number, y: number }} */
    let at;
    if (u && u.q !== undefined && u.r !== undefined) {
      const p = this.between(camera, u.q, u.r, u.path?.[0], progress(u, e.clock));
      const j = jitter(u.id);
      at = { x: p.x + j.x * size * zoom, y: p.y + j.y * size * zoom };
    } else if (b) {
      const { centre } = this.place(camera, b, clock);
      at = { x: centre.x, y: centre.y - size * zoom * 0.3 };
    } else {
      return;
    }
    const ctx = this.ctx;
    const radius = Math.max(2, size * 0.1 * zoom);
    ctx.save();
    ctx.globalAlpha = 1 - t;
    if (u) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, radius * (1 + 2.5 * easeOut(t)), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, zoom);
      ctx.strokeStyle = side.accent;
      ctx.stroke();
    }
    const x = at.x;
    const y = at.y - size * zoom * 0.35 * easeOut(t);
    const arm = radius * 1.1;
    ctx.beginPath();
    ctx.moveTo(x - arm, y - arm);
    ctx.lineTo(x + arm, y + arm);
    ctx.moveTo(x + arm, y - arm);
    ctx.lineTo(x - arm, y + arm);
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, 2 * zoom);
    ctx.strokeStyle = '#f4efe6';
    ctx.stroke();
    if ((e.count ?? 1) > 1 && zoom > 0.45) {
      ctx.font = `600 ${Math.round(10 * zoom)}px ui-monospace, monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = side.accent;
      ctx.fillText(String(e.count), x + arm * 2, y);
    }
    ctx.restore();
  }
}
