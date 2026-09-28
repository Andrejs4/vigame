/**
 * Canvas 2D renderer for the board.
 *
 * Kept behind a small interface (construct, then call draw each frame) so the
 * PixiJS renderer can be dropped in later without the rest of the app caring.
 */

import { axialToPixel, corners, key } from './hex.js';
import { PLAYERS } from './game.js';

/** Base colours per terrain, before per-tile tint. */
const TERRAIN_COLORS = {
  grass:  { h: 104, s: 32, l: 40 },
  meadow: { h: 88,  s: 38, l: 48 },
  scrub:  { h: 74,  s: 24, l: 34 },
  water:  { h: 203, s: 44, l: 40 },
};

/**
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @param {number} [a=1]
 */
function hsl(h, s, l, a = 1) {
  return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

export class BoardRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {ReturnType<typeof import('./board.js').createBoard>} board
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
   * Trace a hex path centred at a world point, in screen space.
   * @param {number} cx Screen centre x.
   * @param {number} cy Screen centre y.
   * @param {number} zoom
   * @param {number} [scale=1] Shrinks the hex about its centre, for the
   *   concentric rings that let several viewers select the same tile.
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
   * Draw one frame.
   *
   * @param {object} state
   * @param {import('./camera.js').Camera} state.camera
   * @param {{ units: Map<string, any>, currentPlayer: number, selectedUnitId: string | null }} state.game
   * @param {{ q: number, r: number } | null} state.hover
   * @param {Map<string, number>} state.reachable
   * @param {Array<import('./net.js').NetPeer>} [state.peers] Other viewers'
   *   selections, drawn as concentric rings so overlapping picks stay legible.
   */
  draw(state) {
    const { camera, game, hover, reachable } = state;
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

    // Cull anything outside the viewport before touching the path API.
    /** @type {Array<{ tile: any, cx: number, cy: number }>} */
    const visible = [];
    for (const tile of this.board.list) {
      const wp = axialToPixel(tile.q, tile.r, size);
      const sp = camera.toScreen(wp.x, wp.y);
      if (sp.x < -margin || sp.x > w + margin || sp.y < -margin || sp.y > h + margin) continue;
      visible.push({ tile, cx: sp.x, cy: sp.y });
    }

    // Pass 1: terrain fill.
    for (const { tile, cx, cy } of visible) {
      const base = TERRAIN_COLORS[tile.terrain];
      const lift = (tile.tint - 0.5) * 7;
      this.hexPath(cx, cy, zoom);
      ctx.fillStyle = hsl(base.h + (tile.tint - 0.5) * 8, base.s, base.l + lift);
      ctx.fill();
    }

    // Pass 2: grid lines, drawn after all fills so no fill overlaps a line.
    ctx.lineWidth = Math.max(0.5, 1 * zoom);
    ctx.strokeStyle = 'rgba(12, 22, 12, 0.30)';
    for (const { cx, cy } of visible) {
      this.hexPath(cx, cy, zoom);
      ctx.stroke();
    }

    // Pass 3: movement range overlay.
    if (reachable.size) {
      for (const { tile, cx, cy } of visible) {
        if (!reachable.has(key(tile.q, tile.r))) continue;
        this.hexPath(cx, cy, zoom);
        ctx.fillStyle = 'rgba(150, 205, 255, 0.26)';
        ctx.fill();
        ctx.lineWidth = Math.max(1, 1.5 * zoom);
        ctx.strokeStyle = 'rgba(190, 228, 255, 0.55)';
        ctx.stroke();
      }
    }

    // Pass 4: other viewers' selections. Several viewers may pick the same
    // hex — nothing is locked — so rings for one tile nest inside each other
    // rather than overdrawing.
    if (peers.length) {
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
        const wp = axialToPixel(first.sel.q, first.sel.r, size);
        const sp = camera.toScreen(wp.x, wp.y);
        if (sp.x < -margin || sp.x > w + margin || sp.y < -margin || sp.y > h + margin) continue;

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
    }

    // Pass 5: hover.
    if (hover) {
      const wp = axialToPixel(hover.q, hover.r, size);
      const sp = camera.toScreen(wp.x, wp.y);
      this.hexPath(sp.x, sp.y, zoom);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, 2 * zoom);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.stroke();
    }

    // Pass 6: units.
    for (const unit of game.units.values()) {
      const wp = axialToPixel(unit.q, unit.r, size);
      const sp = camera.toScreen(wp.x, wp.y);
      if (sp.x < -margin || sp.x > w + margin || sp.y < -margin || sp.y > h + margin) continue;

      const player = PLAYERS[unit.owner];
      const radius = size * 0.52 * zoom;
      const selected = game.selectedUnitId === unit.id;

      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y + radius * 0.55, radius * 0.85, radius * 0.32, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, (selected ? 3.5 : 2) * zoom);
      ctx.strokeStyle = selected ? '#ffd84d' : 'rgba(255, 255, 255, 0.8)';
      ctx.stroke();

      // Initial of the unit type, so Scout and Infantry are distinguishable.
      if (zoom > 0.6) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.font = `600 ${Math.round(radius * 0.95)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(unit.name[0], sp.x, sp.y + 1);
      }

      // Spent units read as dimmed rather than absent.
      if (unit.owner === game.currentPlayer && unit.move === 0) {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 14, 10, 0.45)';
        ctx.fill();
      }
    }

    // Pass 7: coordinate labels, debug aid.
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
