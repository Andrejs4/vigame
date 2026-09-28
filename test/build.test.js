import { test } from 'node:test';
import assert from 'node:assert/strict';

import { artifactBody, build } from '../scripts/build.js';

test('the bundle inlines every module, dependencies first, as one script', () => {
  const html = build();
  const order = [...html.matchAll(/^\/\/ ---- (src\/\w+\.js) -+$/gm)].map((m) => m[1]);
  assert.deepEqual(order, [
    'src/hex.js', 'src/board.js', 'src/game.js', 'src/camera.js',
    'src/net.js', 'src/render.js', 'src/main.js',
  ]);
  assert.equal(html.includes('type="module"'), false);
  assert.match(html, /<title>Vigame Hex Board<\/title>/);
});

test('the bundled script has no module syntax left and parses', () => {
  const html = build();
  const script = html.slice(html.indexOf('<script>\n') + 9, html.lastIndexOf('</script>'));
  assert.doesNotMatch(script, /^\s*(import|export)\b/m);
  // Parse without running: a syntax error throws here.
  assert.doesNotThrow(() => new Function(script));
});

test('the artifact body is the page without its document skeleton', () => {
  const body = artifactBody(build());
  assert.match(body, /^<title>Vigame Hex Board<\/title>\n/);
  assert.doesNotMatch(body, /<!doctype|<html|<head|<body|<\/body>|<\/html>/i);
  assert.match(body, /<\/script>\n$/);
});
