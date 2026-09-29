import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { axialToPixel, key, pixelToAxial } from '../src/core/hex.js';
import { minimapLayout } from '../src/client/minimap.js';

test('each cell has a block of its own, and a point on it looks at that cell', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 3, players: 8 });
  const layout = minimapLayout(board);
  const taken = new Set();
  for (const t of board.list) {
    const p = layout.cell(t.q, t.r);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = p.x + dx;
      const y = p.y + dy;
      assert.ok(x >= 0 && x < layout.width && y >= 0 && y < layout.height, `${t.q},${t.r} is off the minimap`);
      assert.ok(!taken.has(key(x, y)), `${t.q},${t.r} overlaps another cell`);
      taken.add(key(x, y));
    }
    const w = layout.toWorld(p.x + 1, p.y + 1);
    assert.deepEqual(pixelToAxial(w.x, w.y, board.hexSize), { q: t.q, r: t.r });
    const c = axialToPixel(t.q, t.r, board.hexSize);
    const back = layout.toMinimap(c.x, c.y);
    assert.ok(Math.abs(back.x - p.x - 1) < 1e-9 && Math.abs(back.y - p.y - 1) < 1e-9);
  }
});
