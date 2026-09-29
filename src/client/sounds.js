/**
 * Sounds: short, gentle notes made on the spot with the Web Audio API, like
 * an old MIDI synth, so there are no sound files. Each sound is a few notes
 * in SOUNDS; `soundsFor` picks the ones an update calls for (from the
 * effects it started and a few changes of its own), and `Sounds` plays them.
 *
 * Browsers start audio only after the player clicks or presses a key on the
 * page, so the first sounds come after the first click in a game.
 */

import { allied } from '../core/game.js';
import { BUILDING_TYPES } from '../core/rules.js';
import { jumped } from './effects.js';

/**
 * @typedef {object} Sound
 * @property {OscillatorType} wave
 * @property {number} gain How loud, at most SOUND_GAIN_MAX.
 * @property {Array<[number, number, number, number?]>} notes Each a MIDI
 *   note number, when it starts and how long it lasts (in seconds), and how
 *   many semitones it slides by the end, if it does.
 * @property {number} [every] The fewest milliseconds between two of it.
 */

/** No sound is louder than this: they are all meant to be gentle. */
export const SOUND_GAIN_MAX = 0.25;

/** @type {Record<string, Sound>} */
export const SOUNDS = {
  // Feedback on the player's own clicks.
  ok: { wave: 'triangle', gain: 0.14, notes: [[76, 0, 0.06], [83, 0.05, 0.09]] },
  no: { wave: 'triangle', gain: 0.14, notes: [[57, 0, 0.1], [53, 0.1, 0.16]] },
  select: { wave: 'sine', gain: 0.1, notes: [[88, 0, 0.035]] },
  // Fighting, on screen.
  hit: { wave: 'sine', gain: 0.2, notes: [[45, 0, 0.14, -7]], every: 180 },
  death: { wave: 'sine', gain: 0.07, notes: [[81, 0, 0.03]], every: 150 },
  felled: { wave: 'triangle', gain: 0.13, notes: [[60, 0, 0.3], [64, 0.04, 0.3], [67, 0.08, 0.35]] },
  // What happens to the player's side.
  lost: { wave: 'triangle', gain: 0.16, notes: [[67, 0, 0.15], [63, 0.13, 0.15], [60, 0.26, 0.15], [55, 0.39, 0.35]] },
  built: { wave: 'triangle', gain: 0.13, notes: [[72, 0, 0.1], [76, 0.1, 0.1], [79, 0.2, 0.28]] },
  born: { wave: 'sine', gain: 0.09, notes: [[84, 0, 0.3], [91, 0.07, 0.35]], every: 400 },
  wave: { wave: 'triangle', gain: 0.18, notes: [[43, 0, 0.45, 2], [50, 0.4, 0.7]] },
  win: { wave: 'triangle', gain: 0.15, notes: [[72, 0, 0.14], [76, 0.14, 0.14], [79, 0.28, 0.14], [84, 0.42, 0.5]] },
  lose: { wave: 'triangle', gain: 0.15, notes: [[69, 0, 0.18], [65, 0.18, 0.18], [62, 0.36, 0.18], [57, 0.54, 0.6]] },
};

/** How far to either side a sound on screen may go, from 0 to 1. */
const PAN_WIDTH = 0.6;

/** The most notes sounding at once; past it, new sounds are skipped. */
const MAX_VOICES = 16;

/** Where the player's choice of mute is kept, in this browser. */
const MUTE_KEY = 'vigame.muted';

/**
 * @typedef {import('./net.js').GameView} GameView
 * @typedef {import('./effects.js').Effect} Effect
 */

/**
 * The sounds an update calls for, heard as the player in `seat` (or a
 * spectator), each at most once. Hits and deaths are heard only on screen.
 * @param {object} what
 * @param {GameView | null} what.prev
 * @param {GameView} what.next
 * @param {Effect[]} what.fresh The effects the update started.
 * @param {number | null} what.seat
 * @param {(q: number, r: number) => number | null} what.where Where a cell is
 *   across the screen, from -1 (left) to 1 (right), or null when off it.
 * @returns {Array<{ name: string, pan: number }>}
 */
export function soundsFor({ prev, next, fresh, seat, where }) {
  if (!prev || jumped(prev, next)) return [];
  /** @type {Map<string, number>} */
  const heard = new Map();
  const hear = (/** @type {string} */ name, /** @type {number | null} */ pan) => {
    if (!heard.has(name)) heard.set(name, pan ?? 0);
  };
  const mine = (/** @type {number} */ owner) => seat !== null && owner === seat;
  const foe = (/** @type {number} */ owner) => seat === null || !allied(next, owner, seat);

  for (const e of fresh) {
    const b = e.building;
    if (e.kind === 'hit' && b && mine(b.owner)) {
      const pan = where(b.q, b.r);
      if (pan !== null) hear('hit', pan);
    } else if (e.kind === 'fall' && b) {
      const pan = where(b.q, b.r);
      if (mine(b.owner)) hear('lost', pan);
      else if (foe(b.owner) && pan !== null) hear('felled', pan);
    } else if (e.kind === 'death') {
      const at = e.unit ?? b;
      const pan = at && at.q !== undefined && at.r !== undefined ? where(at.q, at.r) : null;
      if (pan !== null) hear('death', pan);
    }
  }

  for (const b of Object.values(next.buildings)) {
    const was = prev.buildings[b.id];
    if (!was) {
      if (BUILDING_TYPES[b.type]?.hunts) hear('wave', where(b.q, b.r));
    } else if (mine(b.owner) && ((was.raised !== undefined && b.raised === undefined) || b.grade > was.grade)) {
      hear('built', where(b.q, b.r));
    }
  }
  if (Object.values(next.units).some((u) => !prev.units[u.id] && mine(u.owner))) hear('born', null);

  if (next.over !== undefined && prev.over === undefined && seat !== null) {
    hear(next.winner !== undefined && next.winner === next.players[seat]?.team ? 'win' : 'lose', null);
  }
  return [...heard].map(([name, pan]) => ({ name, pan }));
}

/**
 * The player's choice to mute, as last made in this browser.
 * @returns {boolean}
 */
function mutedBefore() {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export class Sounds {
  constructor() {
    this.muted = mutedBefore();
    /** @type {AudioContext | null} */
    this.audio = null;
    /** @type {AudioNode | null} */
    this.out = null;
    /** When each sound last played (performance.now()). */
    /** @type {Map<string, number>} */
    this.last = new Map();
    /** Notes still sounding. */
    this.voices = 0;
    /** The latest sounds asked for and not muted or too soon, newest last: for checks. */
    /** @type {string[]} */
    this.log = [];
  }

  /**
   * Start audio, or resume it: call on the player's clicks and keys, which
   * are what browsers allow it after.
   */
  wake() {
    if (this.muted) return;
    try {
      if (!this.audio) {
        const audio = new AudioContext();
        // Softened and evened out, so many sounds at once never grate.
        const volume = new GainNode(audio, { gain: 0.7 });
        const soften = new BiquadFilterNode(audio, { type: 'lowpass', frequency: 3200 });
        const even = new DynamicsCompressorNode(audio, { threshold: -18, ratio: 6 });
        volume.connect(soften).connect(even).connect(audio.destination);
        this.audio = audio;
        this.out = volume;
      }
      if (this.audio.state === 'suspended') this.audio.resume().catch(() => {});
    } catch {
      // No audio here: the game goes on silently.
      this.audio = null;
    }
  }

  /**
   * Mute or unmute, and remember it in this browser.
   * @param {boolean} muted
   */
  setMuted(muted) {
    this.muted = muted;
    try {
      globalThis.localStorage?.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // Not remembered, then.
    }
    if (muted) this.audio?.suspend().catch(() => {});
    else this.wake();
  }

  /**
   * Play a sound from SOUNDS, unless muted or too soon after the last one.
   * @param {string} name
   * @param {number} [pan=0] From -1 (left) to 1 (right).
   */
  play(name, pan = 0) {
    const sound = SOUNDS[name];
    if (!sound || this.muted) return;
    const now = performance.now();
    if (now - (this.last.get(name) ?? -Infinity) < (sound.every ?? 0)) return;
    this.last.set(name, now);
    this.log.push(name);
    if (this.log.length > 20) this.log.shift();

    const audio = this.audio;
    // Nothing is queued while audio waits for a click: it would all sound at once after.
    if (!audio || !this.out || audio.state !== 'running' || this.voices + sound.notes.length > MAX_VOICES) return;
    const out = pan ? new StereoPannerNode(audio, { pan: Math.max(-1, Math.min(1, pan)) * PAN_WIDTH }) : null;
    out?.connect(this.out);
    const start = audio.currentTime + 0.01;
    let sounding = sound.notes.length;
    for (const [note, at, length, slide = 0] of sound.notes) {
      const t = start + at;
      const pitch = 440 * 2 ** ((note - 69) / 12);
      const osc = new OscillatorNode(audio, { type: sound.wave, frequency: pitch });
      if (slide) osc.frequency.exponentialRampToValueAtTime(pitch * 2 ** (slide / 12), t + length);
      const envelope = new GainNode(audio, { gain: 0 });
      envelope.gain.setValueAtTime(0, t);
      envelope.gain.linearRampToValueAtTime(Math.min(sound.gain, SOUND_GAIN_MAX), t + 0.008);
      envelope.gain.exponentialRampToValueAtTime(0.0001, t + length);
      osc.connect(envelope).connect(out ?? this.out);
      this.voices++;
      osc.onended = () => {
        this.voices--;
        osc.disconnect();
        envelope.disconnect();
        if (--sounding === 0) out?.disconnect();
      };
      osc.start(t);
      osc.stop(t + length + 0.02);
    }
  }
}
