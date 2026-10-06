"""Make the ground pictures, src/client/art/ground-<terrain>-<n>.webp, from
the author's originals in art-src/ground/<terrain>-<n>.png (kept out of
git). Each is shrunk, recoloured to its terrain's colour on the board
(TERRAIN_COLORS in src/client/render.js) keeping its detail, made a little
lighter or darker as LIFT says, and cut to a pointy-top hex with clear
corners, so the page draws it on a cell as it is, turned or mirrored.

Usage: python3 scripts/ground.py   (needs Pillow and numpy)
"""
import colorsys
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'art-src' / 'ground'
OUT = ROOT / 'src' / 'client' / 'art'

# Each terrain's colour on the board, as hue, saturation and lightness:
# TERRAIN_COLORS in src/client/render.js.
COLORS = {'grass': (104, 32, 40), 'meadow': (88, 38, 48), 'scrub': (74, 24, 34), 'water': (203, 44, 40)}
# Lighter (+) or darker (-) than the terrain's colour, by picture, so the
# versions of a terrain differ a little.
LIFT = {'grass-1': 0.02, 'grass-2': -0.02, 'water-1': 0.03, 'water-2': -0.03}
# A hex from corner to corner, top to bottom; the page draws it at most
# 170 px tall (hexSize 34 at the closest zoom, 2.5).
TALL = 256
WIDE = round(math.sqrt(3) * TALL / 2)


def hls(rgb):
    """Hue, lightness and saturation of each pixel (0 to 1), and which pixels have a hue."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    top, low = rgb.max(-1), rgb.min(-1)
    light = (top + low) / 2
    spread = top - low
    sat = np.where(spread == 0, 0, spread / np.where(light < 0.5, top + low + 1e-9, 2 - top - low + 1e-9))
    rc, gc, bc = ((top - c) / (spread + 1e-9) for c in (r, g, b))
    hue = np.where(r == top, bc - gc, np.where(g == top, 2 + rc - bc, 4 + gc - rc))
    return (hue / 6) % 1, light, sat, spread > 0


def recolour(image, terrain, lift):
    """Move the picture's mean hue to the terrain's, and scale its saturation
    and lightness to the terrain's, so its detail stays and its colour is the
    board's."""
    rgb = np.asarray(image.convert('RGB')).astype(np.float64) / 255
    hue, light, sat, coloured = hls(rgb)
    h, s, l = COLORS[terrain]
    mean_hue = np.angle(np.mean(np.exp(2j * np.pi * hue[coloured]))) / (2 * np.pi) % 1
    hue = (hue + h / 360 - mean_hue) % 1
    sat = np.clip(sat * (s / 100) / max(sat.mean(), 1e-6), 0, 1)
    light = np.clip(light * (l / 100 + lift) / max(light.mean(), 1e-6), 0, 1)
    out = np.stack(np.vectorize(colorsys.hls_to_rgb)(hue, light, sat), -1)
    return Image.fromarray((out * 255).round().astype(np.uint8))


def hex_mask():
    """A pointy-top hex filling WIDE × TALL, its edges smoothed."""
    scale = 4
    mask = Image.new('L', (WIDE * scale, TALL * scale), 0)
    r = TALL * scale / 2
    cx, cy = WIDE * scale / 2, TALL * scale / 2
    corners = [(cx + r * math.cos(math.radians(60 * i - 90)), cy + r * math.sin(math.radians(60 * i - 90))) for i in range(6)]
    ImageDraw.Draw(mask).polygon(corners, fill=255)
    return mask.resize((WIDE, TALL), Image.LANCZOS)


def main():
    mask = hex_mask()
    for source in sorted(SOURCE.glob('*-*.png')):
        name = source.stem
        terrain = name.split('-')[0]
        if terrain not in COLORS:
            continue
        image = Image.open(source)
        side = min(image.size)
        # The middle square, shrunk so the hex is TALL from corner to corner.
        image = image.crop(((image.width - side) // 2, (image.height - side) // 2,
                            (image.width + side) // 2, (image.height + side) // 2)).resize((TALL, TALL), Image.LANCZOS)
        image = recolour(image, terrain, LIFT.get(name, 0)).crop(((TALL - WIDE) // 2, 0, (TALL - WIDE) // 2 + WIDE, TALL))
        image.putalpha(mask)
        out = OUT / f'ground-{name}.webp'
        image.save(out, 'WEBP', quality=85, method=6)
        print(f'{out.relative_to(ROOT)}: {out.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
