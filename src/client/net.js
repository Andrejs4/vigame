/**
 * The connection to a game on the Vigame game server (server/), which runs
 * the real game: the player's commands go to it as room messages, and its
 * state comes back as patches.
 *
 * `createServerNet` returns:
 *   ready()         resolves once the first state has arrived
 *   onState(fn)     fn(view) whenever the game changes; a late subscriber is
 *                   handed the latest view straight away. A view has the
 *                   shape of `publicView` in game.js.
 *   send(command)   give a command as this viewer's side; resolves to the
 *                   core's outcome, { ok } or { ok: false, reason }
 *   clock()         the game time now, in ticks, with a fraction: for drawing
 *                   movement between ticks
 *   running()       whether the game clock is running
 *   select(sel)     publish my picked hex ({q, r} or null)
 *   onPeers(fn)     fn(peerList) whenever the viewers or their picks change
 *   seat()          my side, or null for a spectator
 *   onSeat(fn)      fn(seat) when my seat or the seat table changes
 *   seats()         the player id in each seat, or null for a free one
 *   freeSeats()     the free seats whose castles stand
 *   canClaimSeat()  whether this viewer could take one of them: as a
 *                   spectator, or once their own castle has fallen
 *   claimSeat(seat) take a free seat, the one given if it is free
 *   releaseSeat()
 *   isCreator()     whether this viewer started the game
 *   startNow()      as its creator, have the game go on without the players
 *                   missing; resolves to { ok } or { ok: false, reason }
 *   viewers()       number of people currently viewing
 *   connected()     boolean
 *   leave()
 */

import { TICKS_PER_SECOND } from '../core/rules.js';

/** @typedef {{ q: number, r: number }} Axial */
/** @typedef {ReturnType<typeof import('../core/game.js').publicView>} GameView */
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

/** Real milliseconds per game tick. */
const TICK_MS = 1000 / TICKS_PER_SECOND;

/**
 * A list of listeners.
 * @template T
 */
function listeners() {
  /** @type {Array<(value: T) => void>} */
  const fns = [];
  return {
    /** @param {(value: T) => void} fn */
    add(fn) {
      fns.push(fn);
      return () => {
        const i = fns.indexOf(fn);
        if (i >= 0) fns.splice(i, 1);
      };
    },
    /** @param {T} value */
    emit(value) {
      for (const fn of [...fns]) fn(value);
    },
  };
}

/**
 * Join a game on the Vigame game server (Colyseus). The server runs the
 * real game and checks every command, so this transport sends commands, never
 * state, and shows whatever the server says the game is.
 *
 * The server mirrors the core's view as JSON strings, one per building and
 * unit and one per other field (server/schema.js). This rebuilds the view
 * from them, parsing only the entries that changed.
 *
 * @param {object} options
 * @param {any} options.client A Colyseus SDK client (`new Colyseus.Client(url)`).
 * @param {string} options.gameId
 * @param {string} options.token This browser's secret player token. The
 *   server knows the player by it, so nobody else may ever see it.
 * @param {() => number} [options.now]
 */
export async function createServerNet({ client, gameId, token, now = () => performance.now() }) {
  const room = await client.joinOrCreate('game', { gameId, token });

  const states = listeners();
  const peerListeners = listeners();
  const seatListeners = listeners();

  /** @type {GameView | null} */
  let view = null;
  /** Parsed entries by `collection/id`, with the JSON they came from. */
  /** @type {Map<string, { json: string, value: any }>} */
  const parsed = new Map();
  let isRunning = false;
  let tickAt = now();
  /** @type {number | null} */
  let mySeat = null;
  /** @type {Array<string | null>} */
  let seatList = [];
  let amCreator = false;
  let seatKey = '';
  /** @type {NetPeer[]} */
  let peerList = [];
  let peersKey = '';
  let viewerCount = 1;
  let isConnected = true;

  let resolveReady = () => {};
  const readyPromise = new Promise((res) => { resolveReady = () => res(undefined); });

  let seatCount = 0;
  /** @param {unknown} v */
  const isSide = (v) => Number.isInteger(v) && Number(v) >= 0 && Number(v) < seatCount;

  /**
   * One synced string map as plain values, reusing what hasn't changed.
   * @param {string} collection
   * @param {unknown} entries `{ id: json }`
   * @param {Set<string>} seen Keys present this time, filled in here.
   * @returns {{ values: Record<string, any>, changed: boolean }}
   */
  function readMap(collection, entries, seen) {
    /** @type {Record<string, any>} */
    const values = {};
    let changed = false;
    if (!entries || typeof entries !== 'object') return { values, changed };
    for (const [id, json] of Object.entries(entries)) {
      if (typeof json !== 'string') continue;
      const k = `${collection}/${id}`;
      seen.add(k);
      let entry = parsed.get(k);
      if (!entry || entry.json !== json) {
        let value;
        try { value = JSON.parse(json); } catch { continue; }
        entry = { json, value };
        parsed.set(k, entry);
        changed = true;
      }
      values[id] = entry.value;
    }
    return { values, changed };
  }

  /**
   * Take in the server's state. Colyseus reports every patch, including ones
   * that only move someone's pick, so each part is passed on only when it
   * actually changed.
   * @param {any} synced
   */
  function adopt(synced) {
    const raw = synced?.toJSON?.() ?? {};

    /** @type {Set<string>} */
    const seen = new Set();
    const fields = readMap('fields', raw.fields, seen);
    const buildings = readMap('buildings', raw.buildings, seen);
    const units = readMap('units', raw.units, seen);
    let removed = false;
    for (const k of [...parsed.keys()]) {
      if (!seen.has(k)) {
        parsed.delete(k);
        removed = true;
      }
    }
    const running = raw.running === true;
    if (running !== isRunning) {
      isRunning = running;
      tickAt = now();
    }

    // The very first callback can come before the server's state has arrived.
    if (Number.isSafeInteger(fields.values.seed) && (fields.changed || buildings.changed || units.changed || removed || !view)) {
      const tick = Number(fields.values.tick) || 0;
      if (!view || tick !== view.tick) tickAt = now();
      view = /** @type {GameView} */ ({ ...fields.values, buildings: buildings.values, units: units.values });
      states.emit(view);
    }

    const seats = Array.isArray(raw.seats) ? raw.seats : [];
    seatCount = seats.length;
    /** @type {Array<[string, any]>} */
    const viewers = raw.viewers && typeof raw.viewers === 'object' ? Object.entries(raw.viewers) : [];
    const me = viewers.find(([session]) => session === room.sessionId)?.[1];
    const seat = me && isSide(me.seat) ? me.seat : null;
    const holders = seats.map((s) => (typeof s === 'string' && s ? s : null));
    const creator = typeof me?.pid === 'string' && me.pid !== '' && raw.creator === me.pid;
    const key = JSON.stringify([seat, holders, creator]);
    if (key !== seatKey) {
      seatKey = key;
      mySeat = seat;
      seatList = holders;
      amCreator = creator;
      seatListeners.emit(mySeat);
    }

    viewerCount = viewers.length;
    const order = viewers.map(([session]) => session).sort();
    const list = viewers.map(([session, v]) => ({
      peer: session,
      uid: typeof v?.pid === 'string' ? v.pid : null,
      seat: isSide(v?.seat) ? v.seat : null,
      sel: v?.hasSel && Number.isSafeInteger(v.q) && Number.isSafeInteger(v.r) ? { q: v.q, r: v.r } : null,
      isMe: session === room.sessionId,
      color: PEER_COLORS[order.indexOf(session) % PEER_COLORS.length],
      name: typeof v?.name === 'string' ? v.name : '',
    }));
    const listKey = JSON.stringify(list);
    if (listKey !== peersKey) {
      peersKey = listKey;
      peerList = list;
      peerListeners.emit(peerList);
    }

    if (view) resolveReady();
  }

  room.onStateChange(adopt);
  adopt(room.state);

  /** The free seats whose castles stand. */
  function freeSeats() {
    return seatList.flatMap((holder, i) => (holder === null && view?.players[i]?.lost === undefined ? [i] : []));
  }

  /** @param {boolean} value */
  function setConnected(value) {
    if (value === isConnected) return;
    isConnected = value;
    seatListeners.emit(mySeat);
  }
  // The client reconnects by itself after a drop; `onLeave` is final.
  room.onDrop(() => setConnected(false));
  room.onReconnect(() => setConnected(true));
  room.onLeave(() => setConnected(false));

  return {
    ready: () => readyPromise,

    /** @param {(view: GameView) => void} fn */
    onState(fn) {
      if (view) fn(view);
      return states.add(fn);
    },

    /**
     * @param {unknown} command
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    send(command) {
      return room.request('command', command).then(
        () => ({ ok: true }),
        (/** @type {any} */ e) => ({ ok: false, reason: String(e?.reason ?? e?.message ?? e) }),
      );
    },

    // Between patches the time is worked out from when the last tick came in,
    // up to one tick ahead.
    clock: () => (view?.tick ?? 0) + (isRunning ? Math.min(1, Math.max(0, (now() - tickAt) / TICK_MS)) : 0),
    running: () => isRunning,

    /** @param {Axial | null} sel */
    select(sel) {
      room.send('select', sel ? { q: sel.q, r: sel.r } : null);
    },

    /** @param {(peers: NetPeer[]) => void} fn */
    onPeers(fn) {
      fn(peerList);
      return peerListeners.add(fn);
    },

    seat: () => mySeat,
    /** @param {(seat: number | null) => void} fn */
    onSeat: (fn) => seatListeners.add(fn),
    seats: () => [...seatList],
    freeSeats,
    canClaimSeat: () => isConnected && view?.over === undefined && freeSeats().length > 0
      && (mySeat === null || view?.players[mySeat]?.lost !== undefined),
    /** @param {number} [seat] */
    claimSeat: (seat) => room.request('claimSeat', seat === undefined ? undefined : { seat }).then(() => {}, () => {}),
    releaseSeat: () => room.request('releaseSeat').then(() => {}, () => {}),
    isCreator: () => amCreator,
    /** @returns {Promise<{ ok: boolean, reason?: string }>} */
    startNow: () => room.request('startNow').then(
      () => ({ ok: true }),
      (/** @type {any} */ e) => ({ ok: false, reason: String(e?.reason ?? e?.message ?? e) }),
    ),
    viewers: () => viewerCount,
    connected: () => isConnected,
    /** Leave the game, for tests and page teardown. */
    leave: () => room.leave(),
  };
}
