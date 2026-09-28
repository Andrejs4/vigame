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
 *   mode         'local' | 'online'
 *   ready()      resolves once the initial state has been delivered
 *   onState(fn)  fn(serialisedState) whenever authoritative state changes
 *   commit(s)    publish new authoritative state
 *   select(sel)  publish my ephemeral selection ({q, r} or null)
 *   onPeers(fn)  fn(peerList) whenever the set of viewers or their selections change
 *   seat()       0, 1, or null for spectator
 *   onSeat(fn)   fn(seat) when my seat changes
 *   releaseSeat()
 *   viewers()    number of people currently viewing
 *   connected()  boolean
 */

/** @typedef {{ q: number, r: number }} Axial */
/** @typedef {{ seed: number, turn: number, currentPlayer: number, units: any[] }} GameState */
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
    releaseSeat() {},
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
  /** @type {Record<string, number>} */
  let seatsByUid = {};
  /** @type {NetPeer[]} */
  let peerList = [];

  let resolveReady = () => {};
  const readyPromise = new Promise((res) => { resolveReady = () => res(undefined); });
  let gotFirstState = false;

  // --- authoritative state -------------------------------------------------

  stateRef.onSnapshot(
    (snap) => {
      if (!snap.exists) {
        // First viewer in seeds the store. A concurrent seed is harmless:
        // both write the same deterministic opening position.
        if (canWrite) stateRef.set(/** @type {any} */ (initial)).catch(() => {});
        if (!gotFirstState) { gotFirstState = true; resolveReady(); }
        return;
      }
      const data = /** @type {GameState} */ (snap.data());
      for (const fn of stateHandlers) fn(data);
      if (!gotFirstState) { gotFirstState = true; resolveReady(); }
    },
    () => { if (!gotFirstState) { gotFirstState = true; resolveReady(); } },
  );

  // --- seats ---------------------------------------------------------------

  /** Recompute my seat from the seats document and notify if it changed. */
  function recomputeSeat() {
    const next = uid && seatsByUid[uid] !== undefined ? seatsByUid[uid] : null;
    if (next === mySeat) return;
    mySeat = next;
    for (const fn of seatHandlers) fn(mySeat);
    pushPresence();
  }

  seatsRef.onSnapshot(
    (snap) => {
      const body = snap.exists ? /** @type {any} */ (snap.data()) : {};
      seatsByUid = {};
      for (const [slot, holder] of Object.entries(body.seats ?? {})) {
        if (typeof holder === 'string') seatsByUid[holder] = Number(slot);
      }
      recomputeSeat();
      rebuildPeers();
    },
    () => {},
  );

  /**
   * Claim the first free seat, using the lease idiom: hold a short lease on
   * the seats document, re-read it, write only if the slot is still free.
   * A bare get-then-set races and both callers believe they won.
   */
  async function claimSeat() {
    if (!uid || !canWrite || mySeat !== null) return;
    let lease;
    try {
      lease = await seatsRef.acquire({ holder: uid, ttlMs: 4000 });
    } catch { return; }
    if (!lease?.acquired) return; // someone else is mid-claim

    try {
      const snap = await seatsRef.get();
      const body = snap.exists ? { .../** @type {any} */ (snap.data()) } : {};
      const seats = { ...(body.seats ?? {}) };

      // Already seated (another tab of mine) — nothing to do.
      for (const [slot, holder] of Object.entries(seats)) {
        if (holder === uid) { seatsByUid[uid] = Number(slot); recomputeSeat(); return; }
      }
      const free = ['0', '1'].find((slot) => !seats[slot]);
      if (free === undefined) return; // both taken: spectate

      seats[free] = uid;
      await seatsRef.set({ ...body, seats });
    } catch { /* the snapshot listener will reconcile */ }
  }

  async function releaseSeat() {
    if (!uid || mySeat === null) return;
    try {
      const snap = await seatsRef.get();
      if (!snap.exists) return;
      const body = { .../** @type {any} */ (snap.data()) };
      const seats = { ...(body.seats ?? {}) };
      for (const [slot, holder] of Object.entries(seats)) {
        if (holder === uid) delete seats[slot];
      }
      await seatsRef.set({ ...body, seats });
    } catch { /* ignore */ }
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
      const sel = pres.sel && typeof pres.sel.q === 'number' && typeof pres.sel.r === 'number'
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
    for (const fn of peerHandlers) fn(peerList);
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
      return () => {
        const i = stateHandlers.indexOf(fn);
        if (i >= 0) stateHandlers.splice(i, 1);
      };
    },

    /** @param {GameState} s */
    commit(s) {
      if (!canWrite) return Promise.resolve();
      return stateRef.set(/** @type {any} */ (s)).catch(() => {});
    },

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
    onSeat(fn) { seatHandlers.push(fn); return () => {}; },
    claimSeat,
    releaseSeat,
    canWrite: () => canWrite,
    viewers: () => (room ? room.peers().filter((p) => p.kind === 'viewer').length : 1),
    connected: () => (room ? room.connected() : false),
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
