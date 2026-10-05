/**
 * Player and game names, and a player's language, checked the same way on
 * the page and on the game server. Pure: the server imports this module
 * unchanged.
 */

/** Longest player name, in characters (code points). */
export const PLAYER_NAME_MAX = 15;

/** Longest game name, in characters (code points). */
export const GAME_NAME_MAX = 24;

/**
 * Letters and digits in any script, with the marks some scripts write them
 * with, plus space and - _ . ' between them. No emoji, symbols, or invisible
 * characters such as direction overrides.
 */
const NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} '._-]*$/u;

/**
 * A name as it will be stored and shown, or null if it isn't allowed.
 * Spaces are trimmed and runs of whitespace become one space; the text is
 * normalised (NFC) first, so an accented letter counts once however it was
 * typed.
 * @param {unknown} text
 * @param {number} max The most characters it may have.
 * @returns {string | null}
 */
function cleanName(text, max) {
  if (typeof text !== 'string') return null;
  const name = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const length = [...name].length;
  if (length < 1 || length > max) return null;
  return NAME.test(name) ? name : null;
}

/**
 * A player's name as it will be stored and shown, or null if it isn't allowed.
 * @param {unknown} text
 */
export function cleanPlayerName(text) {
  return cleanName(text, PLAYER_NAME_MAX);
}

/**
 * A game's name as it will be stored and shown, or null if it isn't
 * allowed: the same characters as a player's, up to GAME_NAME_MAX.
 * @param {unknown} text
 */
export function cleanGameName(text) {
  return cleanName(text, GAME_NAME_MAX);
}

/**
 * The languages a player may choose for the page: `auto` lets the page pick
 * one (`autoLanguage` in src/client/language.js), the rest are languages.
 */
export const LANGUAGES = /** @type {const} */ (['auto', 'en', 'ru', 'lv', 'fi']);

/** @typedef {typeof LANGUAGES[number]} Language */

/**
 * A language setting as it will be stored, or null if it isn't one.
 * @param {unknown} code
 * @returns {Language | null}
 */
export function cleanLanguage(code) {
  return LANGUAGES.find((l) => l === code) ?? null;
}
