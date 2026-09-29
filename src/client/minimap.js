/**
 * The minimap: the whole board at a few pixels a cell, in a corner of the
 * screen, with a frame around the part the main view shows. Pressing or
 * dragging on it moves the main view there (see play.js).
 *
 * It repaints as little as it can: the ground once per map; the rest only
 * after the server reported a change, at most once every MINIMAP_PERIOD, and
 * only if a pixel would differ. The frame is a positioned element over the
 * canvas, so panning and zooming never repaint the minimap.
 */

import { footprint, sideOf } from '../core/game.js';
import { BUILDING_TYPES } from '../core/rules.js';
import { groundColor } from './render.js';

/** Shortest time between two repaints, in milliseconds. */
export const MINIMAP_PERIOD = 500;

/**
 * How much wider than tall a minimap pixel stands for on the board: √3/2 of
 * a hex size across, 3/4 down.
 */
const PIXEL_ASPECT = Math.sqrt(3) / 2 / 0.75;

/**
 * Where a board's cells go on the minimap: each is a 2 × 2 block, and odd
 * rows are shifted one pixel, as hex rows are half a cell. That is a linear
 * map of world pixels, so points convert both ways.
 * @param {import('../core/board.js').Board} board
 */
export function minimapLayout(board) {
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const t of board.list) {
    const col = t.q + Math.floor(t.r / 2);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, t.r);
    maxRow = Math.max(maxRow, t.r);
  }
  // World pixels per minimap pixel, across and down.
  const across = board.hexSize * Math.sqrt(3) / 2;
  const down = board.hexSize * 0.75;
  return {
    width: 2 * (maxCol - minCol + 1) + 1,
    height: 2 * (maxRow - minRow + 1),
    /**
     * The top left pixel of a cell's block.
     * @param {number} q
     * @param {number} r
     */
    cell: (q, r) => ({ x: 2 * (q + Math.floor(r / 2) - minCol) + (r & 1), y: 2 * (r - minRow) }),
    /**
     * A minimap point (in its pixels) as a world point.
     * @param {number} mx
     * @param {number} my
     */
    toWorld: (mx, my) => ({ x: (mx - 1 + 2 * minCol) * across, y: (my - 1 + 2 * minRow) * down }),
    /**
     * A world point as a minimap point.
     * @param {number} wx
     * @param {number} wy
     */
    toMinimap: (wx, wy) => ({ x: wx / across - 2 * minCol + 1, y: wy / down - 2 * minRow + 1 }),
  };
}

/**
 * What the minimap shows of a game, as flat [x, y, colour, ...] blocks:
 * standing buildings in their side's colour, and what moves (units in the
 * open, wagons, bands, raiders) in its lighter accent, on top.
 * @param {ReturnType<typeof minimapLayout>} layout
 * @param {import('./net.js').GameView} view
 */
function marksOf(layout, view) {
  /** @type {Array<number | string>} */
  const marks = [];
  const put = (/** @type {number} */ q, /** @type {number} */ r, /** @type {string} */ colour) => {
    const p = layout.cell(q, r);
    marks.push(p.x, p.y, colour);
  };
  const movers = [];
  for (const b of Object.values(view.buildings)) {
    if (BUILDING_TYPES[b.type]?.speed) movers.push(b);
    else for (const c of footprint(b.type, b.q, b.r)) put(c.q, c.r, sideOf(view, b.owner).color);
  }
  for (const b of movers) put(b.q, b.r, sideOf(view, b.owner).accent);
  for (const u of Object.values(view.units)) {
    if (u.in === undefined && u.q !== undefined && u.r !== undefined) put(u.q, u.r, sideOf(view, u.owner).accent);
  }
  return marks;
}

export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} frame Outlines the main view, over the canvas.
   * @param {import('../core/board.js').Board} board
   */
  constructor(canvas, frame, board) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.frame = frame;
    this.layout = minimapLayout(board);
    const { width, height } = this.layout;
    canvas.width = width;
    canvas.height = height;
    // The page sets the width; this keeps the board's proportions.
    canvas.style.aspectRatio = `${width * PIXEL_ASPECT} / ${height}`;

    this.ground = document.createElement('canvas');
    this.ground.width = width;
    this.ground.height = height;
    const g = /** @type {CanvasRenderingContext2D} */ (this.ground.getContext('2d'));
    for (const t of board.list) {
      const p = this.layout.cell(t.q, t.r);
      g.fillStyle = groundColor(t);
      g.fillRect(p.x, p.y, 2, 2);
    }
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.ground, 0, 0);

    /** @type {import('./net.js').GameView | null} */
    this.view = null;
    this.changed = false;
    this.paintedAt = -Infinity;
    this.shown = '';
    this.framed = '';
    /** How many times it has repainted, for the smoke check. */
    this.paints = 0;
  }

  /**
   * Take in the game as the server reports it. It shows at the next `paint`.
   * @param {import('./net.js').GameView} view
   */
  show(view) {
    this.view = view;
    this.changed = true;
  }

  /**
   * Repaint, if the game changed since the last time, that was long enough
   * ago, and a pixel would differ.
   * @param {number} now Milliseconds, as requestAnimationFrame gives them.
   */
  paint(now) {
    if (!this.changed || !this.view || now - this.paintedAt < MINIMAP_PERIOD) return;
    this.changed = false;
    this.paintedAt = now;
    const marks = marksOf(this.layout, this.view);
    const shown = marks.join();
    if (shown === this.shown) return;
    this.shown = shown;
    const ctx = this.ctx;
    ctx.drawImage(this.ground, 0, 0);
    for (let i = 0; i < marks.length; i += 3) {
      ctx.fillStyle = /** @type {string} */ (marks[i + 2]);
      ctx.fillRect(/** @type {number} */ (marks[i]), /** @type {number} */ (marks[i + 1]), 2, 2);
    }
    this.paints += 1;
  }

  /**
   * Move the frame to what the main view shows. Touches the page only when
   * the frame moved.
   * @param {import('./camera.js').Camera} camera
   * @param {number} viewW The main view's size, in CSS pixels.
   * @param {number} viewH
   */
  frameView(camera, viewW, viewH) {
    const a = camera.toWorld(0, 0);
    const b = camera.toWorld(viewW, viewH);
    const from = this.layout.toMinimap(a.x, a.y);
    const to = this.layout.toMinimap(b.x, b.y);
    const { width, height } = this.layout;
    const pct = (/** @type {number} */ v, /** @type {number} */ of) => `${(v / of * 100).toFixed(2)}%`;
    const box = [pct(from.x, width), pct(from.y, height), pct(to.x - from.x, width), pct(to.y - from.y, height)];
    const framed = box.join();
    if (framed === this.framed) return;
    this.framed = framed;
    [this.frame.style.left, this.frame.style.top, this.frame.style.width, this.frame.style.height] = box;
  }

  /**
   * The world point under a point on the screen, for clicks on the minimap.
   * @param {number} clientX
   * @param {number} clientY
   */
  worldAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { width, height } = this.layout;
    return this.layout.toWorld((clientX - rect.left) / rect.width * width, (clientY - rect.top) / rect.height * height);
  }
}
