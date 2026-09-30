/**
 * Tokens: each building and unit drawn as a round counter in its side's
 * colour, with a light picture on it (the SVG files in art/, credited in
 * art/CREDITS.md). A token is painted once for each picture, colour and
 * size, and kept, so drawing one is a single image copy.
 */

/** The pictures in art/: one for each building type, and one for a unit. */
export const PICTURES = Object.freeze([
  'castle', 'tower', 'wagon', 'pit', 'farm', 'band', 'unit', 'lair', 'ghoul', 'ogre', 'raider',
]);

/** The picture's colour on every token, and its shadow's. */
const INK = '#f6f2e8';
const INK_SHADOW = 'rgba(0, 0, 0, 0.5)';

/** How much of a token's width its picture takes. */
const PICTURE_PART = 0.68;

/** The most tokens kept painted; past it the oldest go. */
const MAX_PAINTED = 300;

/**
 * A canvas to paint on, off screen.
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement | OffscreenCanvas}
 */
function blank(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * A 2D context, which an off-screen canvas always has.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 */
function paper(canvas) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

export class Tokens {
  /**
   * Start loading the pictures.
   * @param {() => void} onLoad Called as each picture arrives, to redraw.
   */
  constructor(onLoad) {
    /** @type {Map<string, HTMLImageElement>} */
    this.images = new Map();
    /** Pictures that failed to load; their things keep their letters. */
    this.failed = 0;
    /** @type {Map<string, HTMLCanvasElement | OffscreenCanvas>} */
    this.painted = new Map();
    for (const name of PICTURES) {
      const img = new Image();
      img.onload = () => {
        this.images.set(name, img);
        onLoad();
      };
      img.onerror = () => { this.failed++; };
      // Relative to this module, so the page works under a subfolder too.
      img.src = new URL(`art/${name}.svg`, import.meta.url).href;
    }
  }

  /**
   * Whether a picture has arrived.
   * @param {string} name
   */
  has(name) {
    return this.images.has(name);
  }

  /**
   * Draw a token centred on (x, y), `across` wide in canvas units, or
   * nothing if its picture hasn't arrived.
   * @param {CanvasRenderingContext2D} ctx Scaled for the device's pixels.
   * @param {string} name A picture, from PICTURES.
   * @param {string} color The side's colour.
   * @param {number} x
   * @param {number} y
   * @param {number} across
   * @param {number} [alpha=1]
   * @param {boolean} [mirror=false] Flipped left to right, facing left.
   * @returns {boolean} Whether it drew.
   */
  draw(ctx, name, color, x, y, across, alpha = 1, mirror = false) {
    const img = this.images.get(name);
    if (!img || across < 1) return false;
    const dpr = ctx.getTransform().a || 1;
    // Sizes a pixel or two apart share a painting, so zooming paints few.
    const exact = across * dpr;
    const px = exact < 32 ? Math.round(exact) : 2 * Math.round(exact / 2);
    const k = `${name}|${color}|${px}`;
    let token = this.painted.get(k);
    if (!token) {
      token = this.paint(img, color, px);
      this.painted.set(k, token);
      if (this.painted.size > MAX_PAINTED) this.painted.delete(/** @type {string} */ (this.painted.keys().next().value));
    }
    const scale = across / px;
    const w = token.width * scale;
    const before = ctx.globalAlpha;
    ctx.globalAlpha = before * alpha;
    if (mirror) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(-1, 1);
      ctx.drawImage(token, -w / 2, -w / 2, w, w);
      ctx.restore();
    } else {
      ctx.drawImage(token, x - w / 2, y - w / 2, w, w);
    }
    ctx.globalAlpha = before;
    return true;
  }

  /**
   * Paint a token `px` device pixels across, with room around it for its
   * shadow.
   * @param {HTMLImageElement} img
   * @param {string} color
   * @param {number} px
   */
  paint(img, color, px) {
    const pad = Math.ceil(px * 0.08) + 1;
    const size = px + 2 * pad;
    const token = blank(size, size);
    const ctx = paper(token);
    const c = size / 2;
    const r = px / 2;
    const rim = Math.max(1, px * 0.06);

    const disc = (/** @type {number} */ dy, /** @type {number} */ radius, /** @type {string} */ fill) => {
      ctx.beginPath();
      ctx.arc(c, c + dy, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    };
    disc(px * 0.05, r, 'rgba(0, 0, 0, 0.35)');
    disc(0, r, 'rgba(12, 14, 12, 0.9)');
    disc(0, r - rim, color);

    const side = Math.max(1, Math.round(px * PICTURE_PART));
    const at = c - side / 2;
    ctx.drawImage(this.tint(img, side, INK_SHADOW), at, at + Math.max(1, px * 0.025));
    ctx.drawImage(this.tint(img, side, INK), at, at);
    return token;
  }

  /**
   * A picture `side` pixels square, all in one colour.
   * @param {HTMLImageElement} img
   * @param {number} side
   * @param {string} color
   */
  tint(img, side, color) {
    const out = blank(side, side);
    const ctx = paper(out);
    ctx.drawImage(img, 0, 0, side, side);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, side, side);
    return out;
  }
}
