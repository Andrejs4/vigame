/**
 * The room state Colyseus keeps in sync with every client.
 *
 * It mirrors the game (`game.js` objects), which stays the source of truth:
 * the room changes the game, then copies it here. Colyseus sends clients only
 * the fields that changed, so real-time play later needs no new format.
 *
 * Clients learn these definitions from the server when they join, so the
 * page needs no copy of this file.
 */

import { schema, t } from '@colyseus/schema';

export const UnitState = schema({
  id: t.string(),
  owner: t.uint8(),
  q: t.int32(),
  r: t.int32(),
  move: t.number(),
  moveMax: t.number(),
  name: t.string(),
}, 'Unit');

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
  seed: t.number(),
  turn: t.number(),
  currentPlayer: t.uint8(),
  /** Keyed by unit id. */
  units: t.map(UnitState),
  /** Player id per seat, '' when free. */
  seats: t.array('string'),
  /** Keyed by session id. */
  viewers: t.map(ViewerState),
}, 'GameState');

/**
 * Copy the game into the synced state, touching only what differs.
 * @param {InstanceType<typeof GameState>} state
 * @param {{ seed: number }} board
 * @param {{ units: Map<string, import('../src/game.js').Unit>, turn: number, currentPlayer: number }} game
 */
export function syncGame(state, board, game) {
  if (state.seed !== board.seed) state.seed = board.seed;
  if (state.turn !== game.turn) state.turn = game.turn;
  if (state.currentPlayer !== game.currentPlayer) state.currentPlayer = game.currentPlayer;

  for (const id of [...state.units.keys()]) {
    if (!game.units.has(id)) state.units.delete(id);
  }
  for (const unit of game.units.values()) {
    let synced = state.units.get(unit.id);
    if (!synced) {
      synced = new UnitState();
      state.units.set(unit.id, synced);
    }
    for (const field of /** @type {const} */ (['id', 'owner', 'q', 'r', 'move', 'moveMax', 'name'])) {
      if (synced[field] !== unit[field]) synced[field] = /** @type {never} */ (unit[field]);
    }
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
