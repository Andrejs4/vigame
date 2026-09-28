/**
 * Camera: converts between screen pixels and world pixels, and handles
 * drag-to-pan and wheel-to-zoom. Knows nothing about hexes.
 */

export class Camera {
  /**
   * @param {object} [options]
   * @param {number} [options.minZoom=0.4]
   * @param {number} [options.maxZoom=2.5]
   */
  constructor(options = {}) {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.minZoom = options.minZoom ?? 0.4;
    this.maxZoom = options.maxZoom ?? 2.5;
  }

  /**
   * Screen point to world point.
   * @param {number} sx
   * @param {number} sy
   * @returns {{ x: number, y: number }}
   */
  toWorld(sx, sy) {
    return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y };
  }

  /**
   * World point to screen point.
   * @param {number} wx
   * @param {number} wy
   * @returns {{ x: number, y: number }}
   */
  toScreen(wx, wy) {
    return { x: (wx - this.x) * this.zoom, y: (wy - this.y) * this.zoom };
  }

  /**
   * Pan by a screen-space delta.
   * @param {number} dxScreen
   * @param {number} dyScreen
   */
  pan(dxScreen, dyScreen) {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
  }

  /**
   * Zoom about a fixed screen point, so the world point under the cursor
   * stays under the cursor.
   * @param {number} factor Multiplier, e.g. 1.1 to zoom in.
   * @param {number} sx Screen anchor x.
   * @param {number} sy Screen anchor y.
   */
  zoomAt(factor, sx, sy) {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /**
   * Centre the view on a world-space bounding box and fit it to the viewport.
   * @param {{ minX: number, minY: number, width: number, height: number }} box
   * @param {number} viewW
   * @param {number} viewH
   * @param {number} [padding=48] Screen-space margin to leave around the box.
   */
  fit(box, viewW, viewH, padding = 48) {
    if (box.width <= 0 || box.height <= 0) return;
    const z = Math.min((viewW - padding * 2) / box.width, (viewH - padding * 2) / box.height);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, z));
    this.x = box.minX + box.width / 2 - viewW / (2 * this.zoom);
    this.y = box.minY + box.height / 2 - viewH / (2 * this.zoom);
  }
}
