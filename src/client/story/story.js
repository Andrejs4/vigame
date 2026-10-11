/**
 * Story mode on the page: each act's words, its line under the game's
 * details (the act, its goal, the time left), and how it came out. All of
 * it from the game's `story` (`Story` in game.js), so the page needs none
 * of src/story/.
 */

import { TICKS_PER_SECOND } from '../../core/rules.js';

/** @typedef {import('../words.js').Word} Word */
/** @typedef {(word: Word, values?: Record<string, string | number>) => string} Say */

/**
 * Each act's words, by its id (ACTS in src/story/acts.js): its name, goal,
 * and how it is won or lost; and its tips, each shown in the middle of the
 * screen at its game second, whatever the player has done by then.
 */
export const ACT_WORDS = /** @type {Record<string, { name: Word, goal: Word, rules: Word, tips: Array<[number, Word]> }>} */ ({
  'starving-village': {
    name: 'actStarvingVillage', goal: 'goalStarvingVillage', rules: 'rulesStarvingVillage',
    tips: [[8, 'tipStarvingFarm'], [20, 'tipStarvingPit'], [34, 'tipStarvingCrew'], [40, 'tipStarvingLuck']],
  },
});

/** How late a tip may still show: a page that comes later (reloaded, say) skips it. */
const TIP_LATE = 2 * TICKS_PER_SECOND;

/**
 * The act's tip due now, if one after the game second `after` is.
 * @param {{ tick: number, over?: number, story?: import('../../core/game.js').Story }} view
 * @param {number} after The second of the last tip shown, or 0.
 * @returns {{ second: number, word: Word } | null}
 */
export function storyTip(view, after) {
  const tips = view.story && view.over === undefined ? ACT_WORDS[view.story.act]?.tips ?? [] : [];
  let due = null;
  for (const [second, word] of tips) {
    const at = second * TICKS_PER_SECOND;
    if (second > after && at <= view.tick && view.tick < at + TIP_LATE) due = { second, word };
  }
  return due;
}

/** How an act came out, by its `result`; one given up has none. */
const RESULT_WORDS = /** @type {Record<string, Word>} */ ({
  fed: 'storyFed', supplied: 'storySupplied', time: 'storyTime', empty: 'storyEmpty', fallen: 'storyFallen',
});

/**
 * An act's name in the player's language.
 * @param {string} act
 * @param {Say} word
 */
export function actName(act, word) {
  const words = ACT_WORDS[act];
  return words ? word(words.name) : act;
}

/**
 * What the status panel says of an act: its name, its goal, and while it
 * goes on, the time left; and how it is won or lost, for its tooltip.
 * @param {{ tick: number, over?: number, story?: import('../../core/game.js').Story }} view
 * @param {Say} word
 * @param {(tick: number) => string} time
 * @returns {{ name: string, goal: string, left: string, rules: string } | null}
 */
export function storyLine(view, word, time) {
  const story = view.story;
  if (!story) return null;
  const words = ACT_WORDS[story.act];
  return {
    name: actName(story.act, word),
    goal: words ? word(words.goal) : '',
    left: view.over === undefined ? word('storyLeft', { time: time(Math.max(0, story.until - view.tick)) }) : '',
    rules: words ? word(words.rules) : '',
  };
}

/**
 * How an act came out, and what comes next: the next act, the story
 * complete, or the story again from the first act.
 * @param {{ winner?: number, story?: import('../../core/game.js').Story }} view
 * @param {Say} word
 */
export function storyOutcome(view, word) {
  const story = view.story;
  if (!story) return '';
  const won = view.winner !== undefined;
  const result = story.result !== undefined && RESULT_WORDS[story.result] ? word(RESULT_WORDS[story.result]) : word('storyAbandoned');
  const next = !won ? word('storyRestart') : story.final ? word('storyDone') : word('storyNext');
  return `${result} ${next}`;
}
