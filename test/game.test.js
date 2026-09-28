import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoard, tileAt } from '../src/board.js';
import { PLAYERS, applyCommand, createGame, endTurn, moveUnit, reachable, unitAt } from '../src/game.js';
import { axialToPixel, key } from '../src/hex.js';
import { boardFrom, gameWith } from './helpers.js';

test('createGame deploys two units per side on distinct passable tiles', () => {
  const board = createBoard({ seed: 1337 });
  const game = createGame(board);
  const units = [...game.units.values()];

  assert.equal(units.length, 4);
  assert.deepEqual(units.map((u) => u.owner), [0, 0, 1, 1]);
  assert.equal(new Set(units.map((u) => key(u.q, u.r))).size, 4);
  for (const u of units) {
    assert.ok(tileAt(board, u.q, u.r)?.passable);
    assert.equal(u.move, u.moveMax);
  }
  assert.equal(game.turn, 1);
  assert.equal(game.currentPlayer, 0);
  assert.equal(game.selectedUnitId, null);

  // Blue deploys on the left, Crimson on the right.
  const x = (u) => axialToPixel(u.q, u.r, board.hexSize).x;
  assert.ok(Math.max(...units.filter((u) => u.owner === 0).map(x))
    < Math.min(...units.filter((u) => u.owner === 1).map(x)));
});

test('createGame is deterministic for a seed and copes with an all-water board', () => {
  const a = createGame(createBoard({ seed: 5 }));
  const b = createGame(createBoard({ seed: 5 }));
  assert.deepEqual([...a.units.values()], [...b.units.values()]);

  const flooded = createGame(boardFrom({ '0,0': 'water', '1,0': 'water' }));
  assert.equal(flooded.units.size, 0);
});

test('unitAt finds the occupant of a hex', () => {
  const game = gameWith([{ id: 'a', q: 1, r: 2 }]);
  assert.equal(unitAt(game, 1, 2)?.id, 'a');
  assert.equal(unitAt(game, 0, 0), undefined);
});

// A straight east-west strip: 0,0 grass | 1,0 scrub | 2,0 grass | 3,0 grass
// with a meadow detour on row 1 and water at 0,1.
const STRIP = {
  '0,0': 'grass', '1,0': 'scrub', '2,0': 'grass', '3,0': 'grass',
  '-1,1': 'meadow', '0,1': 'water', '1,1': 'meadow', '2,1': 'meadow',
};

test('reachable charges terrain cost and stops at the movement budget', () => {
  const board = boardFrom(STRIP);
  const unit = { id: 'u', owner: 0, q: 0, r: 0, move: 2, moveMax: 2, name: 'Infantry' };
  const game = gameWith([unit]);
  const costs = reachable(board, game, game.units.get('u'));

  assert.equal(costs.has('0,0'), false, 'start hex is not a destination');
  assert.equal(costs.get('1,0'), 2, 'scrub costs 2');
  assert.equal(costs.get('-1,1'), 1);
  assert.equal(costs.has('0,1'), false, 'water is impassable');
  assert.equal(costs.has('2,0'), false, 'beyond budget through scrub');
  for (const c of costs.values()) assert.ok(c <= 2);
});

test('reachable takes the cheapest route, not the shortest', () => {
  // Straight east to 3,0 is three steps through two scrub hexes: 2 + 2 + 1 = 5.
  // The grass detour along row -1 is four steps but costs only 4.
  const board = boardFrom({
    '0,0': 'grass', '1,0': 'scrub', '2,0': 'scrub', '3,0': 'grass',
    '1,-1': 'grass', '2,-1': 'grass', '3,-1': 'grass',
  });
  const game = gameWith([{ id: 'u', q: 0, r: 0, move: 4, moveMax: 4 }]);
  const costs = reachable(board, game, game.units.get('u'));
  assert.equal(costs.get('3,0'), 4);
  assert.equal(costs.get('2,0'), 4);
  assert.equal(costs.get('3,-1'), 3);
});

test('reachable treats every other unit as blocking', () => {
  const board = boardFrom(STRIP);
  const game = gameWith([
    { id: 'u', q: 2, r: 0, move: 2 },
    { id: 'friend', q: 3, r: 0, owner: 0 },
    { id: 'foe', q: 2, r: 1, owner: 1 },
  ]);
  const costs = reachable(board, game, game.units.get('u'));
  assert.equal(costs.has('3,0'), false);
  assert.equal(costs.has('2,1'), false);
});

test('moveUnit spends movement and refuses illegal moves', () => {
  const board = boardFrom(STRIP);
  const game = gameWith([
    { id: 'blue', owner: 0, q: 0, r: 0, move: 2 },
    { id: 'red', owner: 1, q: 3, r: 0, move: 2 },
  ]);

  assert.equal(moveUnit(board, game, 'red', 2, 0), false, 'not their turn');
  assert.equal(moveUnit(board, game, 'nobody', 1, 0), false, 'unknown unit');
  assert.equal(moveUnit(board, game, 'blue', 0, 1), false, 'water');
  assert.equal(moveUnit(board, game, 'blue', 2, 0), false, 'out of range');

  assert.equal(moveUnit(board, game, 'blue', 1, 0), true);
  assert.deepEqual({ ...game.units.get('blue') }, {
    id: 'blue', owner: 0, q: 1, r: 0, move: 0, moveMax: 2, name: 'Infantry',
  });
  assert.equal(moveUnit(board, game, 'blue', 2, 0), false, 'no movement left');
});

test('endTurn hands over, restores the new side, and counts full rounds', () => {
  const game = gameWith([
    { id: 'blue', owner: 0, move: 0, moveMax: 2 },
    { id: 'red', owner: 1, move: 1, moveMax: 4 },
  ]);
  game.selectedUnitId = 'blue';

  endTurn(game);
  assert.equal(game.currentPlayer, 1);
  assert.equal(game.turn, 1);
  assert.equal(game.selectedUnitId, null);
  assert.equal(game.units.get('red').move, 4);
  assert.equal(game.units.get('blue').move, 0, 'the side that just moved is untouched');

  endTurn(game);
  assert.equal(game.currentPlayer, 0);
  assert.equal(game.turn, 2);
  assert.equal(game.units.get('blue').move, 2);
  assert.equal(PLAYERS.length, 2);
});

test('applyCommand moves and ends turns for the side whose turn it is', () => {
  const board = boardFrom(STRIP);
  const game = gameWith([
    { id: 'blue', owner: 0, q: 0, r: 0, move: 2 },
    { id: 'red', owner: 1, q: 3, r: 0, move: 2 },
  ]);

  assert.equal(applyCommand(board, game, 0, { type: 'move', unit: 'blue', q: 1, r: 0 }), true);
  assert.deepEqual([game.units.get('blue').q, game.units.get('blue').move], [1, 0]);
  assert.equal(applyCommand(board, game, 0, { type: 'endTurn' }), true);
  assert.equal(game.currentPlayer, 1);
  assert.equal(applyCommand(board, game, 1, { type: 'move', unit: 'red', q: 2, r: 0 }), true);
});

test('applyCommand refuses the other side, and anything malformed, without changing the game', () => {
  const board = boardFrom(STRIP);
  const game = gameWith([
    { id: 'blue', owner: 0, q: 0, r: 0, move: 2 },
    { id: 'red', owner: 1, q: 3, r: 0, move: 2 },
  ]);
  const before = JSON.stringify([...game.units.values(), game.turn, game.currentPlayer]);

  const refused = [
    [1, { type: 'endTurn' }],                              // not Crimson's turn
    [1, { type: 'move', unit: 'red', q: 2, r: 0 }],
    [0, { type: 'move', unit: 'red', q: 2, r: 0 }],         // Blue moving Crimson's unit
    [0, { type: 'move', unit: 'blue', q: '1', r: '0' }],    // "1" would match the hex key
    [0, { type: 'move', unit: 'blue', q: 1.5, r: 0 }],
    [0, { type: 'move', unit: 'blue', q: 1 }],
    [0, { type: 'move', unit: ['blue'], q: 1, r: 0 }],
    [0, { type: 'fly' }],
    [0, null],
    [0, 'endTurn'],
    [undefined, { type: 'endTurn' }],
  ];
  for (const [player, cmd] of refused) {
    assert.equal(applyCommand(board, game, player, cmd), false, JSON.stringify([player, cmd]));
  }
  assert.equal(JSON.stringify([...game.units.values(), game.turn, game.currentPlayer]), before);
});
