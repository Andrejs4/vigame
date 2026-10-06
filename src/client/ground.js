/**
 * Pictures of the ground, drawn on each cell at the closest zooms over its
 * flat colour: a few versions of each terrain (art/ground-<terrain>-<n>.webp,
 * the author's, made by scripts/ground.py and credited in art/CREDITS.md),
 * each already cut to a hex. A cell's version, its turn by sixths of a
 * turn and its mirror come from the cell's tint, which the map's seed gives
 * it, so every player sees the same ground and the repeats are hard to see.
 */

/** How many versions of each terrain's picture there are. */
export const GROUND_VERSIONS = Object.freeze({ grass: 2, meadow: 1, scrub: 1, water: 2 });

/** The pictures' file names, without folder or extension. */
export const GROUND_PICTURES = Object.freeze(Object.entries(GROUND_VERSIONS)
  .flatMap(([terrain, n]) => Array.from({ length: n }, (_, i) => `ground-${terrain}-${i + 1}`)));

/**
 * The zooms over which the pictures fade in: none below GROUND_FROM, all of
 * them from GROUND_FULL. The camera goes from 0.4 to 2.5, and the − button
 * divides the zoom by 1.25, a wheel notch by 1.12: so the pictures show in
 * full at the closest zoom and two presses of − out (2.5, 2, 1.6), and are
 * gone at the third (1.28); with the wheel, four notches out in full, gone
 * at the sixth. Further out the flat colours read better, and cost nothing.
 */
export const GROUND_FROM = 1.4;
export const GROUND_FULL = 1.55;

/**
 * How much of the pictures shows at a zoom, from 0 to 1.
 * @param {number} zoom
 */
export function groundShown(zoom) {
  return Math.min(1, Math.max(0, (zoom - GROUND_FROM) / (GROUND_FULL - GROUND_FROM)));
}

/**
 * The picture a cell shows, how many sixths of a turn it is turned, and
 * whether it is mirrored, from its terrain and tint.
 * @param {{ terrain: string, tint: number }} tile
 * @returns {{ name: string, turn: number, mirror: boolean } | null} Null for a terrain without pictures.
 */
export function groundLook(tile) {
  const versions = GROUND_VERSIONS[/** @type {keyof typeof GROUND_VERSIONS} */ (tile.terrain)];
  if (!versions) return null;
  const n = Math.floor(tile.tint * 2 ** 32) >>> 0;
  return { name: `ground-${tile.terrain}-${(n % versions) + 1}`, turn: (n >>> 8) % 6, mirror: Boolean((n >>> 16) & 1) };
}

export class Ground {
  /**
   * Start loading the pictures.
   * @param {() => void} onLoad Called as each picture arrives, to redraw.
   */
  constructor(onLoad) {
    /** @type {Map<string, HTMLImageElement>} */
    this.images = new Map();
    /** Pictures that failed to load; their cells keep their flat colours. */
    this.failed = 0;
    for (const name of GROUND_PICTURES) {
      const img = new Image();
      img.onload = () => {
        this.images.set(name, img);
        onLoad();
      };
      img.onerror = () => { this.failed++; };
      // Relative to this module, so the page works under a subfolder too.
      img.src = new URL(`art/${name}.webp`, import.meta.url).href;
    }
  }

  /**
   * Draw a cell's picture over its flat colour, if it has arrived.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ terrain: string, tint: number }} tile
   * @param {number} cx The cell's centre on the canvas.
   * @param {number} cy
   * @param {number} radius From its centre to a corner, on the canvas.
   */
  draw(ctx, tile, cx, cy, radius) {
    const look = groundLook(tile);
    const img = look && this.images.get(look.name);
    if (!look || !img) return;
    // A pointy-top hex turned by a sixth of a turn covers the same cell.
    const tall = 2 * radius;
    const wide = Math.sqrt(3) * radius;
    ctx.save();
    ctx.translate(cx, cy);
    if (look.turn) ctx.rotate((look.turn * Math.PI) / 3);
    if (look.mirror) ctx.scale(-1, 1);
    ctx.drawImage(img, -wide / 2, -tall / 2, wide, tall);
    ctx.restore();
  }
}
