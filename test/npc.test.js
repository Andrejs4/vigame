import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_OPTIONS, createBoard } from '../src/core/board.js';
import { advance, applyCommand, castleOf, checkState, fallenMayMove, newGame, publicView, seatsOf } from '../src/core/game.js';
import { distance } from '../src/core/hex.js';
import { npcMemory, npcMove, npcRefused } from '../src/core/npc.js';
import { NPC, TICKS_PER_SECOND } from '../src/core/rules.js';
import { openBoard, stateWith, unitsIn } from './helpers.js';

/**
 * Let every seat's NPC play, as the game server does: each thinks every
 * NPC.think ticks, a few ticks apart, up to NPC.perThink commands.
 * @param {import('../src/core/board.js').Board} board
 * @param {import('../src/core/game.js').GameState} state
 * @param {number} ticks
 */
function npcsPlay(board, state, ticks) {
  const seats = seatsOf(state);
  const memory = Array.from({ length: seats }, npcMemory);
  /** @type {Record<string, number>} */
  const given = {};
  let refused = 0;
  const end = state.tick + ticks;
  while (state.tick < end && state.over === undefined) {
    advance(board, state);
    for (let seat = 0; seat < seats; seat++) {
      if ((state.tick + seat * 3) % NPC.think !== 0) continue;
      for (let i = 0; i < NPC.perThink; i++) {
        const command = npcMove(board, state, seat, memory[seat]);
        if (!command) break;
        const outcome = applyCommand(board, state, seat, structuredClone(command));
        const kind = command.type === 'build' ? command.kind : command.type;
        given[kind] = (given[kind] ?? 0) + 1;
        if (!outcome.ok) {
          refused += 1;
          npcRefused(memory[seat], command, state.tick);
          break;
        }
      }
    }
  }
  return { given, refused };
}

/**
 * Give an NPC's commands until it has none, as if it thought now.
 * @param {import('../src/core/board.js').Board} board
 * @param {import('../src/core/game.js').GameState} state
 * @param {import('../src/core/npc.js').NpcMemory} memory
 */
function think(board, state, memory, seat = 0) {
  const given = [];
  for (let i = 0; i < 20; i++) {
    const command = npcMove(board, state, seat, memory);
    if (!command) break;
    const outcome = applyCommand(board, state, seat, structuredClone(command));
    assert.deepEqual(outcome, { ok: true }, JSON.stringify(command));
    given.push(command);
  }
  return given;
}

test('NPCs alone play a game: they build, crew, upgrade and send bands, and the game stays sound', () => {
  for (const [mode, players] of /** @type {Array<[string, number]>} */ ([['ffa', 2], ['coop', 2], ['teams', 4]])) {
    const board = createBoard({ ...BOARD_OPTIONS, seed: 7, players });
    const state = newGame(board, { mode, npcs: true });
    const { given, refused } = npcsPlay(board, state, 10 * 60 * TICKS_PER_SECOND);
    assert.deepEqual(checkState(board, state), [], mode);
    for (const kind of ['pit', 'farm', 'tower', 'band', 'target']) assert.ok(given[kind] > 0, `${mode}: no ${kind} in ${JSON.stringify(given)}`);
    assert.ok(refused <= 2, `${mode}: ${refused} refused`);
    // The same game again comes out the same: an NPC draws on no dice.
    const again = newGame(board, { mode, npcs: true });
    npcsPlay(board, again, 10 * 60 * TICKS_PER_SECOND);
    assert.deepEqual(again, state);
  }
});

test('an NPC waits NPC.start before its first move', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 7, players: 2 });
  const state = newGame(board, { mode: 'ffa', npcs: true });
  state.tick = NPC.start - 1;
  assert.equal(npcMove(board, state, 0, npcMemory()), null);
  state.tick = NPC.start;
  assert.notEqual(npcMove(board, state, 0, npcMemory()), null);
});

test('a manned enemy tower that can reach its buildings is answered by a band, once seen for NPC.react', () => {
  const board = openBoard(12);
  const state = stateWith(
    [{ id: 'b1', type: 'castle', q: 0, r: 0 }, { id: 'b2', type: 'castle', owner: 1, q: 0, r: 10 }, { id: 'b3', type: 'tower', owner: 1, q: 0, r: 5 }],
    [...unitsIn('b1', 20, 10), ...unitsIn('b3', 5, 40, 1)],
  );
  for (const p of state.players) Object.assign(p, { stone: 0, metal: 0, food: 1000 });
  state.tick = NPC.start;
  const memory = npcMemory();
  const before = think(board, state, memory);
  assert.ok(!before.some((c) => c.type === 'build' && c.kind === 'band'), 'not at once');
  assert.equal(memory.seen.b3, NPC.start, 'but it has seen it');
  state.tick += NPC.react;
  const after = think(board, state, memory);
  const band = after.find((c) => c.type === 'build' && c.kind === 'band');
  assert.ok(band && band.type === 'build' && (band.units?.length ?? 0) >= NPC.bandMin, JSON.stringify(after));
  const sent = after.find((c) => c.type === 'target');
  assert.deepEqual(sent && sent.type === 'target' && sent.target, 'b3', 'the band goes for the tower');
  // An empty tower is no threat.
  const quiet = stateWith(
    [{ id: 'b1', type: 'castle', q: 0, r: 0 }, { id: 'b2', type: 'castle', owner: 1, q: 0, r: 10 }, { id: 'b3', type: 'tower', owner: 1, q: 0, r: 5 }],
    unitsIn('b1', 20, 10),
  );
  const calm = npcMemory();
  quiet.tick = NPC.start;
  think(board, quiet, calm);
  assert.deepEqual(calm.seen, {});
});

test('from NPC.wagonsFrom it builds wagons behind its castle, sends them once the metal is spent, then goes all in', () => {
  const board = openBoard(14);
  const state = stateWith(
    [{ id: 'b1', type: 'castle', q: 0, r: 0 }, { id: 'b2', type: 'castle', owner: 1, q: 9, r: 0 }],
    unitsIn('b1', NPC.bandFrom - 1, 10), // too few at home for a band of its own
  );
  Object.assign(state.players[0], { stone: 0, metal: 30, food: 1000 });
  state.tick = NPC.wagonsFrom - 1;
  const memory = npcMemory();
  assert.ok(!think(board, state, memory).some((c) => c.type === 'build' && c.kind === 'wagon'), 'not before twelve minutes');
  state.tick = NPC.wagonsFrom;
  const wagons = think(board, state, memory).filter((c) => c.type === 'build' && c.kind === 'wagon');
  assert.equal(wagons.length, 2, 'two for its 30 dark metal');
  const enemy = /** @type {import('../src/core/game.js').Building} */ (castleOf(state, 1));
  for (const w of wagons) {
    assert.ok(w.type === 'build' && distance(w, enemy) > distance(state.buildings.b1, enemy), 'behind its castle');
  }
  // They go up; with the metal spent, they fill up and set off.
  for (let i = 0; i < 300; i++) advance(board, state);
  const sent = think(board, state, memory);
  const targets = sent.filter((c) => c.type === 'target');
  assert.equal(targets.length, 2, JSON.stringify(sent));
  assert.ok(targets.every((c) => c.type === 'target' && c.target === 'b2'));
  assert.equal(memory.wagonsSent, state.tick);
  // NPC.allInAfter later, everyone at home goes in bands: those born meanwhile too.
  const skills = { breeding: 0, ranged: 0, melee: 0, build: 0, farming: 0, running: 0 };
  for (const u of unitsIn('b1', 12, 100)) {
    state.units[u.id] = { ...u, name: 'New Unit', level: 1, born: state.tick, xp: 0, skills: { ...skills }, practice: { ...skills } };
  }
  state.nextId = Math.max(state.nextId, 112);
  assert.deepEqual(checkState(board, state), []);
  state.tick += NPC.allInAfter;
  const all = think(board, state, memory);
  assert.ok(all.some((c) => c.type === 'build' && c.kind === 'band'), JSON.stringify(all));
  assert.ok(Object.values(state.units).filter((u) => u.in === 'b1' && u.to === undefined).length < NPC.bandMin, 'nobody left at home');
  assert.equal(memory.allIn, memory.wagonsSent);
});

test('the flag that NPCs play free seats is kept in the game, and seen by players', () => {
  const board = createBoard({ ...BOARD_OPTIONS, seed: 7, players: 2 });
  const state = newGame(board, { mode: 'ffa', npcs: true });
  assert.equal(state.npcs, true);
  assert.equal(publicView(state).npcs, true);
  assert.equal(Object.hasOwn(newGame(board), 'npcs'), false, 'none by default');
  assert.deepEqual(checkState(board, { ...state, npcs: false }), ['bad npcs']);
  // A fallen player may take a free base, but not from an NPC against players.
  assert.equal(fallenMayMove(state), false);
  assert.equal(fallenMayMove({ mode: 'coop', npcs: true }), true);
  assert.equal(fallenMayMove({ mode: 'ffa' }), true);
});
