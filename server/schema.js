/**
 * The room state Colyseus keeps in sync with every client.
 *
 * It is a display copy of the game core's state (`publicView` in
 * src/core/game.js), which stays the only real copy: the room changes the core's
 * state, then mirrors it here. The mirror knows nothing about the game's
 * fields. Each building and unit travels as its own JSON string, keyed by id,
 * and every other top-level field of the view as a JSON string of its own.
 * Colyseus sends only the entries that changed, so a unit costs bandwidth
 * when it crosses into a new cell, not every tick, and a new field in the
 * core needs no change here or on the page.
 *
 * Clients learn these definitions from the server when they join, so the
 * page needs no copy of this file.
 */

import { schema, t } from '@colyseus/schema';

/** One connected browser tab. */
export const ViewerState = schema({
  /** Public player id. Several tabs of one player share it. */
  pid: t.string(),
  /** The player's name, as they gave it when signing in. */
  name: t.string(),
  /** The seat this viewer's player holds, or -1 when spectating. */
  seat: t.int8().default(-1),
  /** The hex this viewer last picked, if `hasSel`. */
  hasSel: t.boolean().default(false),
  q: t.int32().default(0),
  r: t.int32().default(0),
}, 'Viewer');

export const GameState = schema({
  /** The view's top-level fields other than the collections (seed, tick, players…), as JSON. */
  fields: t.map('string'),
  /** Each building as JSON, by id. */
  buildings: t.map('string'),
  /** Each unit as JSON, by id. */
  units: t.map('string'),
  /** Whether the game clock is running: see `GameRoom.clockRuns`. */
  running: t.boolean().default(false),
  /** Player id per seat, '' when free. */
  seats: t.array('string'),
  /** The player id of whoever started the game, '' if nobody did. */
  creator: t.string().default(''),
  /** Keyed by session id. */
  viewers: t.map(ViewerState),
}, 'GameState');

/** The view's fields that are collections of entities keyed by id. */
const COLLECTIONS = /** @type {const} */ (['buildings', 'units']);

/**
 * Make a string map hold exactly these entries, touching only what differs.
 * @param {Map<string, string>} synced A Colyseus MapSchema of strings.
 * @param {Record<string, unknown>} entries
 */
function mirror(synced, entries) {
  for (const id of [...synced.keys()]) {
    if (!Object.hasOwn(entries, id)) synced.delete(id);
  }
  for (const [id, value] of Object.entries(entries)) {
    const json = JSON.stringify(value);
    if (synced.get(id) !== json) synced.set(id, json);
  }
}

/**
 * Copy a view of the game into the synced state.
 * @param {InstanceType<typeof GameState>} state
 * @param {Record<string, unknown>} view `publicView(game)`.
 */
export function syncGame(state, view) {
  /** @type {Record<string, unknown>} */
  const fields = {};
  for (const [name, value] of Object.entries(view)) {
    if (!COLLECTIONS.includes(/** @type {any} */ (name))) fields[name] = value;
  }
  mirror(/** @type {any} */ (state.fields), fields);
  for (const name of COLLECTIONS) {
    mirror(/** @type {any} */ (state[name]), /** @type {Record<string, unknown>} */ (view[name] ?? {}));
  }
}

/**
 * Copy the seat table into the synced state, and each viewer's seat with it.
 * @param {InstanceType<typeof GameState>} state
 * @param {Array<string | null>} seats
 */
export function syncSeats(state, seats) {
  seats.forEach((holder, i) => {
    const value = holder ?? '';
    if (i >= state.seats.length) state.seats.push(value);
    else if (state.seats[i] !== value) state.seats[i] = value;
  });
  while (state.seats.length > seats.length) state.seats.pop();

  for (const viewer of state.viewers.values()) {
    const seat = seats.indexOf(viewer.pid);
    if (viewer.seat !== seat) viewer.seat = seat;
  }
}
