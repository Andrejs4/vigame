import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createBoard } from '../src/board.js';
import { createGame } from '../src/game.js';
import {
  PEER_COLORS, applyState, createArtifactNet, createLocalNet, sanitizeState, serialize,
} from '../src/net.js';
import { createFakeRuntime, settle } from './fake-runtime.js';

const board = createBoard({ seed: 1337 });
const opening = () => serialize(board, createGame(board));

/** A game some way in: turn 5, Crimson to move, Blue's scout advanced. */
function midGame() {
  const s = opening();
  s.turn = 5;
  s.currentPlayer = 1;
  s.units[0] = { ...s.units[0], q: s.units[0].q + 1, move: 1 };
  return s;
}

/**
 * Open the artifact as one viewer and wire it up the way main.js does:
 * create the net, then subscribe to state.
 */
async function join(rt, options) {
  const tab = rt.viewer(options);
  const net = await createArtifactNet({ db: tab.db, room: tab.room, user: tab.user, initial: opening() });
  const states = [];
  net.onState((s) => states.push(s));
  return { tab, net, states };
}

afterEach(() => mock.timers.reset());

/** Advance mocked time in one-second steps, letting deliveries run between. */
async function elapse(ms) {
  for (let t = 0; t < ms; t += 1000) {
    mock.timers.tick(1000);
    await settle();
  }
}

// --- serialisation ---------------------------------------------------------

test('serialize and applyState round-trip a game', () => {
  const game = createGame(board);
  const state = serialize(board, game);
  assert.equal(state.seed, 1337);

  const copy = createGame(createBoard({ seed: 1 }));
  copy.turn = 9;
  applyState(copy, JSON.parse(JSON.stringify(state)));
  assert.deepEqual(serialize(board, copy), state);
});

test('applyState drops a selection whose unit is gone', () => {
  const game = createGame(board);
  game.selectedUnitId = 'u0';
  applyState(game, { ...serialize(board, game), units: [] });
  assert.equal(game.selectedUnitId, null);
});

test('sanitizeState keeps good data and repairs or drops the rest', () => {
  assert.equal(sanitizeState(null), null);
  assert.equal(sanitizeState('nope'), null);
  assert.equal(sanitizeState([]), null);

  const clean = sanitizeState({
    seed: 12,
    turn: 3,
    currentPlayer: 1,
    units: [
      { id: 'a', owner: 0, q: 1, r: 2, move: 9, moveMax: 4, name: 'Scout' },
      { id: 'b', owner: 7, q: 0, r: 0, move: 1, moveMax: 2, name: 'Infantry' },
      { id: '', owner: 0, q: 0, r: 0, move: 1, moveMax: 2, name: 'Infantry' },
      { id: 'c', owner: 1, q: 0.5, r: 0, move: 1, moveMax: 2, name: 'Infantry' },
      { id: 'd', owner: 1, q: 3, r: 3, move: -2, moveMax: 2, name: 42 },
      { id: 'a', owner: 1, q: 5, r: 5, move: 1, moveMax: 2, name: 'Duplicate' },
      null,
    ],
  });
  assert.deepEqual(clean, {
    seed: 12,
    turn: 3,
    currentPlayer: 1,
    units: [
      { id: 'a', owner: 0, q: 1, r: 2, move: 4, moveMax: 4, name: 'Scout' },
      { id: 'd', owner: 1, q: 3, r: 3, move: 0, moveMax: 2, name: 'Unit' },
    ],
  });

  assert.deepEqual(sanitizeState({ seed: NaN, turn: -1, currentPlayer: 5, units: 'x' }), {
    seed: null, turn: 1, currentPlayer: 0, units: [],
  });
});

// --- hotseat ---------------------------------------------------------------

test('the local net is hotseat: no seat, no peers, commits go nowhere', async () => {
  const net = createLocalNet();
  assert.equal(net.mode, 'local');
  await net.ready();
  assert.equal(net.seat(), null);
  assert.equal(net.canClaimSeat(), false);
  assert.equal(net.connected(), false);
  assert.equal(net.viewers(), 1);
  net.commit(opening());
  net.select({ q: 0, r: 0 });
});

// --- online: authoritative state -------------------------------------------

test('the first viewer seeds an empty store with the opening position', async () => {
  const rt = createFakeRuntime();
  const { net } = await join(rt);
  await net.ready();
  await settle();
  assert.deepEqual(rt.docs.get('game/state'), opening());
});

test('a viewer who joins mid-game is handed the current state', async () => {
  const rt = createFakeRuntime();
  rt.docs.set('game/state', midGame());

  const { net, states } = await join(rt);
  await net.ready();
  await settle();

  assert.ok(states.length >= 1, 'onState never delivered the stored game');
  assert.deepEqual(states.at(-1), midGame());
  assert.deepEqual(rt.docs.get('game/state'), midGame(), 'the stored game was overwritten');
});

test('an empty snapshot served from cache does not reseed over a game', async () => {
  const rt = createFakeRuntime({ cachedFirst: true });
  rt.docs.set('game/state', midGame());

  const { net, states } = await join(rt);
  await net.ready();
  await settle();

  assert.deepEqual(rt.docs.get('game/state'), midGame());
  assert.deepEqual(states.at(-1), midGame());
});

test('ready waits for a definitive answer rather than the cache', async () => {
  const rt = createFakeRuntime({ cachedFirst: true });
  rt.docs.set('game/state', midGame());
  const { net, states } = await join(rt);
  await net.ready();
  assert.deepEqual(states.at(-1), midGame());
});

test('commits are written one at a time and the latest one wins', async () => {
  const rt = createFakeRuntime();
  const { net } = await join(rt);
  await net.ready();
  await settle();

  const writesBefore = rt.writeCount;
  const s1 = { ...opening(), turn: 2 };
  const s2 = { ...opening(), turn: 3 };
  const s3 = { ...opening(), turn: 4 };
  net.commit(s1);
  net.commit(s2);
  await net.commit(s3);
  await settle();

  assert.equal(rt.maxConcurrentWrites, 1, 'writes to game/state overlapped');
  assert.equal(rt.docs.get('game/state').turn, 4);
  assert.ok(rt.writeCount - writesBefore <= 2, 'superseded states should be coalesced');
});

test('a viewer without write access neither seeds nor sits down', async () => {
  const rt = createFakeRuntime();
  const { net } = await join(rt, { canWrite: false });
  await net.ready();
  await settle();
  assert.equal(rt.docs.has('game/state'), false);
  assert.equal(net.seat(), null);
  assert.equal(net.canWrite(), false);
  assert.equal(net.canClaimSeat(), false);
});

test('when the platform says nothing, the viewer is trusted until a write is refused', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T12:00:00Z') });
  const rt = createFakeRuntime();
  rt.docs.set('game/state', midGame());

  // Not told, and the server accepts: an ordinary player.
  const ok = await join(rt, { uid: 'u_ok', canWrite: null });
  await elapse(10000);
  assert.equal(ok.net.canWrite(), true);
  assert.equal(ok.net.seat(), 0);

  // Not told, and the server refuses. Claiming a seat is the first write;
  // once it bounces the viewer is read-only, and a commit changes nothing.
  const ro = await join(rt, { uid: 'u_ro', canWrite: null, writable: false });
  await ro.net.ready();
  await elapse(10000);
  assert.equal(ro.net.canWrite(), false);
  assert.equal(ro.net.seat(), null);
  assert.equal(ro.net.canClaimSeat(), false);
  await ro.net.commit(opening());
  assert.deepEqual(rt.docs.get('game/state'), midGame());
});

// --- online: seats ---------------------------------------------------------

test('the first two viewers take the two seats, a third spectates', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T12:00:00Z') });
  const rt = createFakeRuntime();
  const a = await join(rt, { uid: 'u_a' });
  await elapse(10000);
  const b = await join(rt, { uid: 'u_b' });
  await elapse(10000);
  const c = await join(rt, { uid: 'u_c' });
  await elapse(10000);

  assert.equal(a.net.seat(), 0);
  assert.equal(b.net.seat(), 1);
  assert.equal(c.net.seat(), null);
  assert.equal(c.net.canClaimSeat(), false);
});

test('a second player who joins while the first is still sitting down gets a seat', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T12:00:00Z') });
  const rt = createFakeRuntime();
  const a = await join(rt, { uid: 'u_a' });
  await settle();
  // A's lease on the seat table is still running when B arrives.
  const b = await join(rt, { uid: 'u_b' });
  await settle();
  assert.equal(b.net.seat(), null, 'B should have found the table busy');
  await elapse(10000);
  assert.equal(a.net.seat(), 0);
  assert.equal(b.net.seat(), 1);
});

test('a spectator arriving at a full table does not lock it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T12:00:00Z') });
  const rt = createFakeRuntime();
  const a = await join(rt, { uid: 'u_a' });
  await elapse(10000);
  await join(rt, { uid: 'u_b' });
  await elapse(10000);
  await join(rt, { uid: 'u_c' });
  await settle();

  // With no time passing, A can still get up straight away.
  a.net.releaseSeat();
  await settle();
  assert.equal(a.net.seat(), null, 'the release waited on a spectator\'s lease');
});

test('two players who arrive at the same moment both end up seated', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T12:00:00Z') });
  const rt = createFakeRuntime();
  const [a, b] = await Promise.all([join(rt, { uid: 'u_a' }), join(rt, { uid: 'u_b' })]);
  await settle();

  // One of them found the seat table leased by the other. That lease is
  // short; once it lapses the loser must try again rather than give up.
  for (let i = 0; i < 10 && (a.net.seat() === null || b.net.seat() === null); i++) {
    mock.timers.tick(1000);
    await settle();
  }

  assert.deepEqual([a.net.seat(), b.net.seat()].sort(), [0, 1]);
});

test('one person in two tabs holds one seat', async () => {
  const rt = createFakeRuntime();
  const tab1 = await join(rt, { uid: 'u_a' });
  await settle();
  const tab2 = await join(rt, { uid: 'u_a' });
  await settle();
  assert.equal(tab1.net.seat(), 0);
  assert.equal(tab2.net.seat(), 0);
  assert.deepEqual({ ...rt.docs.get('game/seats').seats }, { 0: 'u_a' });
});

test('a released seat stays free for someone else to take', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T12:00:00Z') });
  const rt = createFakeRuntime();
  const a = await join(rt, { uid: 'u_a' });
  await settle();
  mock.timers.tick(5000);
  const b = await join(rt, { uid: 'u_b' });
  await settle();
  mock.timers.tick(5000);
  const c = await join(rt, { uid: 'u_c' });
  await settle();
  assert.equal(c.net.seat(), null);

  const seatChanges = [];
  c.net.onSeat(() => seatChanges.push(c.net.canClaimSeat()));

  mock.timers.tick(5000);
  await a.net.releaseSeat();
  await settle();
  assert.equal(a.net.seat(), null);
  assert.equal(c.net.canClaimSeat(), true, 'the spectator should be offered the free seat');
  assert.ok(seatChanges.includes(true), 'onSeat should fire when the seat table changes');

  // A does not grab it straight back.
  mock.timers.tick(30000);
  await settle();
  assert.equal(a.net.seat(), null);

  mock.timers.tick(5000);
  await c.net.claimSeat();
  await settle();
  assert.equal(c.net.seat(), 0);
  assert.equal(b.net.seat(), 1);
  assert.equal(a.net.canClaimSeat(), false);
});

// --- online: presence -------------------------------------------------------

test('everyone sees everyone\'s selection, in colours they agree on', async () => {
  const rt = createFakeRuntime();
  const a = await join(rt, { uid: 'u_a' });
  const b = await join(rt, { uid: 'u_b' });

  let aPeers = [];
  let bPeers = [];
  a.net.onPeers((list) => { aPeers = list; });
  b.net.onPeers((list) => { bPeers = list; });

  a.net.select({ q: 3, r: 4 });
  b.net.select({ q: 3, r: 4 });
  await settle();

  assert.equal(aPeers.length, 2);
  assert.equal(bPeers.length, 2);
  assert.deepEqual(aPeers.map((p) => p.sel), [{ q: 3, r: 4 }, { q: 3, r: 4 }]);

  const mine = aPeers.find((p) => p.isMe);
  const theirs = aPeers.find((p) => !p.isMe);
  assert.ok(mine && theirs);
  assert.equal(bPeers.find((p) => p.peer === mine.peer).isMe, false);
  for (const p of aPeers) {
    assert.equal(p.color, bPeers.find((q) => q.peer === p.peer).color);
    assert.ok(PEER_COLORS.includes(p.color));
  }
  assert.notEqual(mine.color, theirs.color);

  a.net.select(null);
  await settle();
  assert.equal(bPeers.find((p) => p.peer === mine.peer).sel, null);
  assert.equal(a.net.viewers(), 2);
  assert.equal(a.net.connected(), true);
});

test('online play works without a room: no peers, state still syncs', async () => {
  const rt = createFakeRuntime();
  rt.docs.set('game/state', midGame());
  const { net, states } = await join(rt, { withRoom: false });
  await net.ready();
  await settle();
  assert.deepEqual(states.at(-1), midGame());
  assert.equal(net.viewers(), 1);
  assert.equal(net.connected(), false);
  net.select({ q: 1, r: 1 });
});
