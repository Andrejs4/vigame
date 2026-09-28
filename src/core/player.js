/**
 * Player names, checked the same way on the page and on the game server.
 * Pure: the server imports this module unchanged.
 */

/** Longest player name, in characters (code points). */
export const PLAYER_NAME_MAX = 15;

/**
 * Letters and digits in any script, with the marks some scripts write them
 * with, plus space and - _ . ' between them. No emoji, symbols, or invisible
 * characters such as direction overrides.
 */
const PLAYER_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} '._-]*$/u;

/**
 * A name as it will be stored and shown, or null if it isn't allowed.
 * Spaces are trimmed and runs of whitespace become one space; the text is
 * normalised (NFC) first, so an accented letter counts once however it was
 * typed.
 * @param {unknown} text
 * @returns {string | null}
 */
export function cleanPlayerName(text) {
  if (typeof text !== 'string') return null;
  const name = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const length = [...name].length;
  if (length < 1 || length > PLAYER_NAME_MAX) return null;
  return PLAYER_NAME.test(name) ? name : null;
}
