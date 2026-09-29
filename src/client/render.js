/**
 * Canvas 2D renderer for the board.
 *
 * Kept behind a small interface (construct, then call draw each frame) so a
 * WebGL renderer such as PixiJS can be dropped in later without the rest of
 * the app caring. It draws a view of the game (see `publicView` in game.js)
 * at a moment in time, placing marching units and rolling wagons between
 * cells by the clock.
 */

import { DIRECTIONS, axialToPixel, corners, key } from '../core/hex.js';
import { footprint, occupancy, sideOf } from '../core/game.js';
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
 * A small fixed offset per unit, so units on one cell don't sit exactly on
 * top of each other.
 * @param {string} id
 */
function jitter(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761) >>> 0;
  return { x: ((h & 0xff) / 255 - 0.5) * 0.5, y: (((h >>> 8) & 0xff) / 255 - 0.5) * 0.5 };
}

export class BoardRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/board.js').Board} board
   */
  constructor(canvas, board) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.board = board;
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
   */
  draw(state) {
    const { camera, view, clock, selected, highlights, hover } = state;
    const peers = state.peers ?? [];
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
    const cellScreen = (/** @type {number} */ q, /** @type {number} */ r) => {
      const wp = axialToPixel(q, r, size);
      return camera.toScreen(wp.x, wp.y);
    };

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

    // Pass 4: buildings. Standing ones fill their cells and outline the whole
    // shape, so a castle reads as one thing across its seven cells.
    if (view && occ) {
      for (const b of Object.values(view.buildings)) {
        const type = BUILDING_TYPES[b.type];
        const side = sideOf(view, b.owner);
        if (!type || !side) continue;
        const isSelected = b.id === selected;
        const rolling = type.speed && b.path?.length ? b.path[0] : undefined;
        const centre = this.between(camera, b.q, b.r, rolling, progress(b, clock));
        if (!onScreen(centre)) continue;

        const cells = rolling ? [{ q: b.q, r: b.r }] : footprint(b.type, b.q, b.r);
        const inShape = new Set(cells.map((c) => key(c.q, c.r)));
        for (const c of cells) {
          const sp = rolling ? centre : cellScreen(c.q, c.r);
          this.hexPath(sp.x, sp.y, zoom, rolling ? 0.8 : 1);
          ctx.fillStyle = side.color + (rolling ? 'cc' : '66');
          ctx.fill();
        }
        ctx.lineWidth = Math.max(1.5, (isSelected ? 3.5 : 2) * zoom);
        ctx.strokeStyle = isSelected ? '#ffd84d' : side.accent;
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

        // Its letter, grade pips, and how many are inside.
        const letter = size * zoom * (type.size === 7 ? 0.8 : 0.55);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.font = `600 ${Math.round(letter)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(type.name[0], centre.x, centre.y);
        for (let g = 0; g < b.grade; g++) {
          ctx.beginPath();
          ctx.arc(centre.x + (g - (b.grade - 1) / 2) * 6 * zoom, centre.y + letter * 0.62, 1.8 * zoom, 0, Math.PI * 2);
          ctx.fill();
        }
        const count = occ.inside.get(b.id)?.length ?? 0;
        if (count && zoom > 0.45) {
          const label = String(count);
          ctx.font = `600 ${Math.round(10 * zoom)}px ui-monospace, monospace`;
          const bw = ctx.measureText(label).width + 8 * zoom;
          const bx = centre.x + size * zoom * 0.35;
          const by = centre.y - size * zoom * 0.62;
          ctx.fillStyle = 'rgba(12, 16, 12, 0.85)';
          ctx.fillRect(bx - bw / 2, by - 7 * zoom, bw, 14 * zoom);
          ctx.fillStyle = side.accent;
          ctx.fillText(label, bx, by + 0.5);
        }
      }
    }

    // Pass 5: units out on the map, drawn between cells as they march.
    if (view) {
      const radius = Math.max(2, size * 0.1 * zoom);
      for (const u of Object.values(view.units)) {
        if (u.in !== undefined || u.q === undefined || u.r === undefined) continue;
        const side = sideOf(view, u.owner);
        if (!side) continue;
        const p = this.between(camera, u.q, u.r, u.path?.[0], progress(u, clock));
        const j = jitter(u.id);
        const x = p.x + j.x * size * zoom;
        const y = p.y + j.y * size * zoom;
        if (!onScreen({ x, y })) continue;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = side.color;
        ctx.fill();
        ctx.lineWidth = Math.max(1, zoom);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.stroke();
      }
    }

    // Pass 6: viewers' picks. Several viewers may pick the same hex, so rings
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

    // Pass 7: hover.
    if (hover) {
      const sp = cellScreen(hover.q, hover.r);
      this.hexPath(sp.x, sp.y, zoom);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, 2 * zoom);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.stroke();
    }

    // Pass 8: coordinate labels, debug aid.
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
}
