import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BUILDING_TYPES } from '../src/core/rules.js';
import { PICTURES } from '../src/client/tokens.js';

const ART = new URL('../src/client/art/', import.meta.url);

test('every building type, and a unit, has a picture', () => {
  for (const kind of [...Object.keys(BUILDING_TYPES), 'unit']) assert.ok(PICTURES.includes(kind), `no picture for ${kind}`);
});

test('the pictures are small, plain, one-colour SVGs, and credited', () => {
  const credits = readFileSync(new URL('CREDITS.md', ART), 'utf8');
  for (const name of PICTURES) {
    const svg = readFileSync(new URL(`${name}.svg`, ART), 'utf8');
    assert.ok(svg.length < 8000, `${name}.svg is ${svg.length} bytes`);
    // Firefox draws an SVG on a canvas only with its size given.
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512" width="512" height="512">/);
    // Nothing but paths: no scripts, styles, links or colours of its own.
    const tags = svg.match(/<\/?[a-z]+/g) ?? [];
    assert.deepEqual([...new Set(tags)].sort(), ['</svg', '<path', '<svg'], `${name}.svg has more than paths`);
    assert.doesNotMatch(svg, /fill=|href|style/, `${name}.svg carries a colour or a link`);
    assert.ok(credits.includes(`\`${name}.svg\``), `${name}.svg is not in art/CREDITS.md`);
  }
});

test("the lobby's About names every picture's author and its licence", () => {
  const credits = readFileSync(new URL('CREDITS.md', ART), 'utf8');
  // The last column of each row of the table: | `castle.svg` | castle | Delapouite |
  const authors = new Set([...credits.matchAll(/^\| `[a-z]+\.svg` \|[^|]+\| ([^|]+?) \|$/gm)].map((m) => m[1]));
  assert.ok(authors.size > 0, 'no authors found in art/CREDITS.md');
  const page = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8');
  const about = page.slice(page.indexOf('id="lobby-about-section"'), page.indexOf('</details>', page.indexOf('id="lobby-about-section"')));
  for (const author of authors) assert.ok(about.includes(author), `About doesn't name ${author}`);
  assert.ok(about.includes('https://creativecommons.org/licenses/by/3.0/'), 'About has no link to CC BY 3.0');
});
