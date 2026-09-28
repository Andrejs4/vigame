/**
 * Networking seam.
 *
 * Two implementations of one interface. `createLocalNet` is hotseat: no
 * transport, everything resolves immediately, and the page behaves exactly as
 * it does offline. `createArtifactNet` syncs through the claude.ai Artifact
 * runtime — authoritative game state in a shared document, ephemeral
 * selections as presence.
 *
 * A Colyseus implementation is the third one, and it implements this same
 * interface: `commit` becomes a room message, `onState` a room state patch.
 * Nothing above this file changes when it arrives.
 *
 * Interface:
 *   mode           'local' | 'online'
 *   ready()        resolves once the initial state has been delivered
 *   onState(fn)    fn(serialisedState) whenever authoritative state changes;
 *                  a late subscriber is handed the latest state straight away
 *   commit(s)      publish new authoritative state
 *   select(sel)    publish my ephemeral selection ({q, r} or null)
 *   onPeers(fn)    fn(peerList) whenever the set of viewers or their selections change
 *   seat()         0, 1, or null for spectator
 *   onSeat(fn)     fn(seat) when my seat or the seat table changes
 *   canClaimSeat() whether a seat is free and this viewer could take it
 *   claimSeat()
 *   releaseSeat()
 *   canWrite()     false once this viewer is known not to be able to write
 *   viewers()      number of people currently viewing
 *   connected()    boolean
 */

import { PLAYERS } from './game.js';

/** @typedef {{ q: number, r: number }} Axial */
/** @typedef {{ seed: number | null, turn: number, currentPlayer: number, units: any[] }} GameState */
/** @typedef {{ peer: string, uid: string | null, seat: number | null, sel: Axial | null, isMe: boolean, color: string, name: string }} NetPeer */

/** Distinct hues for selection rings, assigned by sorted peer id so every
 *  client independently agrees on who is which colour. */
export const PEER_COLORS = [
  '#ffd84d', // amber
  '#6ee7b7', // mint
  '#f0a6ff', // orchid
  '#ff9e64', // tangerine
  '#7dd3fc', // sky
  '#fca5a5', // coral
];

/** Seat slots in the seats document, one per player. */
const SLOTS = PLAYERS.map((p) => String(p.id));

/** How long a seat-table lease lasts. The platform has no early release. */
const LEASE_MS = 4000;

/** How many times to wait out someone else's lease before giving up. */
const LEASE_RETRIES = 5;

/** Longest unit name kept from shared state; the HUD gives it one line. */
const MAX_NAME = 24;

/**
 * Hotseat: one browser, two players taking turns. No transport at all.
 * @returns {object}
 */
export function createLocalNet() {
  /** @type {Array<(s: GameState) => void>} */
  const stateHandlers = [];

  return {
    mode: /** @type {const} */ ('local'),
    ready: () => Promise.resolve(),
    onState(fn) { stateHandlers.push(fn); return () => {}; },
    // In hotseat the local page is already authoritative, so a commit is a
    // no-op rather than an echo — re-applying it would just churn.
    commit() {},
    select() {},
    onPeers() { return () => {}; },
    seat: () => /** @type {number | null} */ (null),
    onSeat() { return () => {}; },
    canClaimSeat: () => false,
    claimSeat: () => Promise.resolve(),
    releaseSeat: () => Promise.resolve(),
    canWrite: () => true,
    viewers: () => 1,
    connected: () => false,
  };
}

/**
 * Online play through the Artifact runtime.
 *
 * @param {object} caps
 * @param {any} caps.db    The `db` namespace.
 * @param {any} [caps.room] The `room` namespace, if this view can connect.
 * @param {any} [caps.user] The `user` namespace, if declared.
 * @param {GameState} caps.initial State to seed the store with if it is empty.
 * @returns {Promise<object>}
 */
export async function createArtifactNet({ db, room, user, initial }) {
  const stateRef = db.doc('game/state');
  const seatsRef = db.doc('game/seats');

  /** @type {string | null} */
  let uid = null;
  try { uid = user ? await user.id() : null; } catch { uid = null; }

  /** @type {boolean} */
  let canWrite = true;
  try {
    if (user?.can) {
      const answer = await user.can('data.write');
      // null means "not told" — keep the controls and let a rejected write decide.
      if (answer === false) canWrite = false;
    }
  } catch { /* keep the optimistic default */ }

  /** @type {Array<(s: GameState) => void>} */
  const stateHandlers = [];
  /** @type {Array<(p: NetPeer[]) => void>} */
  const peerHandlers = [];
  /** @type {Array<(s: number | null) => void>} */
  const seatHandlers = [];

  /** @type {number | null} */
  let mySeat = null;
  /** Slot to holder uid, from the seats document; null until first read. */
  /** @type {Record<string, string> | null} */
  let seatTable = null;
  /** Cleared when this viewer gives up a seat, so it is not retaken behind their back. */
  let wantsSeat = true;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let claimTimer;
  /** @type {NetPeer[]} */
  let peerList = [];
  /** The latest authoritative state, for subscribers that arrive after it. */
  /** @type {GameState | null} */
  let latestState = null;

  let resolveReady = () => {};
  const readyPromise = new Promise((res) => { resolveReady = () => res(undefined); });
  let gotFirstState = false;
  function markReady() {
    if (!gotFirstState) { gotFirstState = true; resolveReady(); }
  }

  // --- writes ----------------------------------------------------------------

  // The store wants one write at a time per document. Every commit is the
  // whole game, so one made while a write is in flight simply replaces any
  // still waiting — only the newest needs to land.

  /** @type {GameState | null} */
  let queued = null;
  /** @type {Promise<void> | null} */
  let draining = null;

  /** @param {GameState} s */
  function commit(s) {
    if (!canWrite) return Promise.resolve();
    queued = s;
    if (!draining) draining = drain();
    return draining;
  }

  /** A write was refused although well-formed: this viewer may not change
   *  shared state, so stop offering to for the rest of the visit. */
  function becomeReadOnly() {
    if (!canWrite) return;
    canWrite = false;
    queued = null;
    clearTimeout(claimTimer);
    notifySeat();
  }

  async function drain() {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        try {
          await stateRef.set(/** @type {any} */ (next));
        } catch (e) {
          if (/** @type {any} */ (e)?.code === 'invalid_argument') becomeReadOnly();
        }
      }
    } finally {
      // Runs in the same turn as the loop's last check of `queued`, so a
      // commit can never land between the two and be left unwritten.
      draining = null;
    }
  }

  // --- authoritative state -------------------------------------------------

  stateRef.onSnapshot(
    (snap) => {
      if (!snap.exists) {
        // A subscription may answer from cache before the server does. An
        // empty cache says nothing about whether a game exists, and seeding
        // on it would reset one in progress, so wait for the real answer.
        if (snap.metadata?.fromCache) return;
        // First viewer in seeds the store. A concurrent seed is harmless:
        // both write the same deterministic opening position.
        commit(initial);
        markReady();
        return;
      }
      const data = sanitizeState(snap.data());
      if (!data) return;
      latestState = data;
      for (const fn of [...stateHandlers]) fn(data);
      markReady();
    },
    () => markReady(),
  );

  // --- seats ---------------------------------------------------------------

  function notifySeat() {
    for (const fn of [...seatHandlers]) fn(mySeat);
  }

  /**
   * The seat table from a seats document body, keeping only real slots held
   * by a non-empty id. The document is shared, so trust nothing in it.
   * @param {any} body
   * @returns {Record<string, string>}
   */
  function readSeats(body) {
    const raw = body && typeof body.seats === 'object' && !Array.isArray(body.seats) ? body.seats : null;
    /** @type {Record<string, string>} */
    const seats = {};
    for (const slot of SLOTS) {
      const holder = raw?.[slot];
      if (typeof holder === 'string' && holder) seats[slot] = holder;
    }
    return seats;
  }

  /** Adopt a seat table and tell listeners. */
  function applySeats(/** @type {Record<string, string>} */ seats) {
    seatTable = seats;
    const slot = uid ? SLOTS.find((s) => seats[s] === uid) : undefined;
    const next = slot === undefined ? null : Number(slot);
    if (next !== mySeat) {
      mySeat = next;
      pushPresence();
    }
    rebuildPeers();
    notifySeat();
  }

  seatsRef.onSnapshot(
    (snap) => {
      // As with the state: an empty cached answer is not "every seat is free".
      if (!snap.exists && snap.metadata?.fromCache) return;
      applySeats(readSeats(snap.exists ? snap.data() : null));
    },
    () => {},
  );

  function canClaimSeat() {
    return Boolean(uid) && canWrite && mySeat === null && seatTable !== null
      && SLOTS.some((slot) => !seatTable?.[slot]);
  }

  /**
   * Read-modify-write the seat table under its lease: hold a short lease on
   * the seats document, re-read it, write only while holding it. A bare
   * get-then-set races and both callers believe they won.
   *
   * @param {(seats: Record<string, string>) => Record<string, string> | null} change
   *   The new table, or null to leave it alone.
   * @returns {Promise<{ busy: boolean, retryIn: number }>} `busy` when someone
   *   else holds the lease; it lapses by itself in `retryIn` ms or so.
   */
  async function withSeatsLease(change) {
    let lease;
    try {
      lease = await seatsRef.acquire({ holder: uid, ttlMs: LEASE_MS });
    } catch { return { busy: false, retryIn: 0 }; }

    if (!lease?.acquired) {
      const left = Date.parse(lease?.expiresAt ?? '') - Date.now();
      const wait = Number.isFinite(left) ? Math.min(LEASE_MS, Math.max(0, left)) : LEASE_MS;
      // Jitter, so two viewers who were both turned away do not collide again.
      return { busy: true, retryIn: wait + 100 + Math.random() * 400 };
    }

    try {
      const snap = await seatsRef.get();
      const body = snap.exists ? { .../** @type {any} */ (snap.data()) } : {};
      const seats = readSeats(body);
      const next = change(seats);
      if (next) {
        await seatsRef.set({ ...body, seats: next });
        applySeats(next);
      } else {
        applySeats(seats);
      }
    } catch (e) {
      if (/** @type {any} */ (e)?.code === 'invalid_argument') becomeReadOnly();
      // Otherwise the snapshot listener will reconcile.
    }
    return { busy: false, retryIn: 0 };
  }

  /**
   * Take the first free seat. Leases cannot be released early, only left to
   * lapse, so a viewer who arrives while someone else is mid-claim finds the
   * table busy for a few seconds; they wait it out and try again rather than
   * settle for spectating.
   * @param {number} [attempt=0]
   */
  async function claimSeat(attempt = 0) {
    clearTimeout(claimTimer);
    wantsSeat = true;
    if (!uid || !canWrite || mySeat !== null) return;

    // Look before taking the lease: someone arriving at a full table, or
    // already seated from another tab, should not lock it for everyone else.
    try {
      const seats = readSeats((await seatsRef.get()).data());
      if (Object.values(seats).includes(uid) || SLOTS.every((slot) => seats[slot])) {
        applySeats(seats);
        return;
      }
    } catch { /* take the lease and look again under it */ }

    const outcome = await withSeatsLease((seats) => {
      if (Object.values(seats).includes(uid)) return null; // seated from another tab
      const free = SLOTS.find((slot) => !seats[slot]);
      if (free === undefined) return null; // every seat taken: spectate
      return { ...seats, [free]: /** @type {string} */ (uid) };
    });

    if (outcome.busy && wantsSeat && attempt < LEASE_RETRIES) {
      claimTimer = setTimeout(() => { claimSeat(attempt + 1); }, outcome.retryIn);
    }
  }

  async function releaseSeat() {
    clearTimeout(claimTimer);
    wantsSeat = false;
    if (!uid || mySeat === null) return;

    for (let attempt = 0; attempt <= LEASE_RETRIES; attempt++) {
      const outcome = await withSeatsLease((seats) => {
        if (!Object.values(seats).includes(uid)) return null;
        return Object.fromEntries(Object.entries(seats).filter(([, holder]) => holder !== uid));
      });
      if (!outcome.busy) return;
      await new Promise((res) => setTimeout(res, outcome.retryIn));
    }
  }

  // --- presence ------------------------------------------------------------

  /** @type {Axial | null} */
  let mySelection = null;

  function pushPresence() {
    if (!room) return;
    room.presence({
      uid: uid ?? null,
      seat: mySeat,
      sel: mySelection,
    }).catch(() => {});
  }

  /**
   * Turn the room's peer list into render-ready selections. Colour is assigned
   * by position in the sorted peer-id list, so every client agrees.
   */
  function rebuildPeers() {
    if (!room) { peerList = []; return; }
    const raw = room.peers().filter((p) => p.kind === 'viewer');
    const order = raw.map((p) => p.peer).sort();

    peerList = raw.map((p) => {
      const pres = /** @type {any} */ (p.presence) || {};
      const sel = pres.sel && Number.isSafeInteger(pres.sel.q) && Number.isSafeInteger(pres.sel.r)
        ? { q: pres.sel.q, r: pres.sel.r }
        : null;
      return {
        peer: p.peer,
        uid: typeof pres.uid === 'string' ? pres.uid : null,
        seat: typeof pres.seat === 'number' ? pres.seat : null,
        sel,
        isMe: p.isMe && p.sameTab,
        color: PEER_COLORS[order.indexOf(p.peer) % PEER_COLORS.length],
        name: '',
      };
    });
    for (const fn of [...peerHandlers]) fn(peerList);
  }

  if (room) {
    room.onPeers(() => rebuildPeers(), () => {});
    room.onConnection(() => rebuildPeers(), () => {});
  }

  await claimSeat();
  pushPresence();

  return {
    mode: /** @type {const} */ ('online'),
    ready: () => readyPromise,

    onState(fn) {
      stateHandlers.push(fn);
      // State that arrived before this subscriber did — typically while the
      // seat was being claimed above — would otherwise never reach it.
      if (latestState) fn(latestState);
      return () => {
        const i = stateHandlers.indexOf(fn);
        if (i >= 0) stateHandlers.splice(i, 1);
      };
    },

    commit,

    /** @param {Axial | null} sel */
    select(sel) {
      mySelection = sel;
      pushPresence();
    },

    onPeers(fn) {
      peerHandlers.push(fn);
      fn(peerList);
      return () => {
        const i = peerHandlers.indexOf(fn);
        if (i >= 0) peerHandlers.splice(i, 1);
      };
    },

    seat: () => mySeat,
    onSeat(fn) {
      seatHandlers.push(fn);
      return () => {
        const i = seatHandlers.indexOf(fn);
        if (i >= 0) seatHandlers.splice(i, 1);
      };
    },
    canClaimSeat,
    claimSeat: () => claimSeat(),
    releaseSeat,
    canWrite: () => canWrite,
    viewers: () => (room ? room.peers().filter((p) => p.kind === 'viewer').length : 1),
    connected: () => (room ? room.connected() : false),
  };
}

/**
 * Validate state read from the shared store. Anyone who can write the store
 * can put anything in it — an older build, a bug, someone with devtools — and
 * one bad field must not take every viewer's page down with it. Keeps what is
 * well-formed and repairs or drops the rest.
 * @param {unknown} raw
 * @returns {GameState | null} null when it is not a state object at all.
 */
export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = /** @type {Record<string, any>} */ (raw);
  const isPlayer = (/** @type {unknown} */ v) => Number.isInteger(v) && Number(v) >= 0 && Number(v) < PLAYERS.length;

  const units = [];
  const seen = new Set();
  for (const u of Array.isArray(s.units) ? s.units : []) {
    if (!u || typeof u !== 'object') continue;
    const { id, owner, q, r, move, moveMax, name } = u;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (!isPlayer(owner) || !Number.isSafeInteger(q) || !Number.isSafeInteger(r)) continue;
    seen.add(id);
    const max = Number.isFinite(moveMax) && moveMax > 0 ? moveMax : 0;
    units.push({
      id, owner, q, r,
      move: Number.isFinite(move) ? Math.min(max, Math.max(0, move)) : 0,
      moveMax: max,
      name: typeof name === 'string' && name ? name.slice(0, MAX_NAME) : 'Unit',
    });
  }

  return {
    seed: Number.isSafeInteger(s.seed) ? s.seed : null,
    turn: Number.isSafeInteger(s.turn) && s.turn >= 1 ? s.turn : 1,
    currentPlayer: isPlayer(s.currentPlayer) ? s.currentPlayer : 0,
    units,
  };
}

/**
 * Serialise the live game into the shape the transport carries.
 * @param {{ seed: number }} board
 * @param {{ units: Map<string, any>, turn: number, currentPlayer: number }} game
 * @returns {GameState}
 */
export function serialize(board, game) {
  return {
    seed: board.seed,
    turn: game.turn,
    currentPlayer: game.currentPlayer,
    units: [...game.units.values()].map((u) => ({
      id: u.id, owner: u.owner, q: u.q, r: u.r,
      move: u.move, moveMax: u.moveMax, name: u.name,
    })),
  };
}

/**
 * Apply a transported state onto a live game object, in place.
 * @param {{ units: Map<string, any>, turn: number, currentPlayer: number, selectedUnitId: string | null }} game
 * @param {GameState} state
 */
export function applyState(game, state) {
  game.units.clear();
  for (const u of state.units ?? []) game.units.set(u.id, { ...u });
  game.turn = state.turn ?? 1;
  game.currentPlayer = state.currentPlayer ?? 0;
  if (game.selectedUnitId && !game.units.has(game.selectedUnitId)) {
    game.selectedUnitId = null;
  }
}
