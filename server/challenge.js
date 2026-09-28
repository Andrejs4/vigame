/**
 * The sign-in check: a sum a person answers at a glance. It keeps out scripts
 * that don't know about this server, not ones written for it.
 *
 * Each challenge is kept in memory until it is answered or expires, and can be
 * answered once, right or wrong. A restart forgets them all, which costs
 * whoever was signing in one more sum.
 */

import { randomBytes, randomInt } from 'node:crypto';

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs] How long a challenge stays answerable.
 * @param {number} [options.max] Most challenges held at once; the oldest go first.
 * @param {() => number} [options.now]
 */
export function createChallenges({ ttlMs = 10 * 60_000, max = 10_000, now = Date.now } = {}) {
  /** Oldest first, since every challenge lives equally long. */
  /** @type {Map<string, { answer: number, expires: number }>} */
  const open = new Map();

  function prune() {
    for (const [id, { expires }] of open) {
      if (expires > now() && open.size <= max) break;
      open.delete(id);
    }
  }

  return {
    /** @returns {{ id: string, question: string }} */
    issue() {
      const a = randomInt(1, 10);
      const b = randomInt(1, 10);
      const id = randomBytes(12).toString('base64url');
      open.set(id, { answer: a + b, expires: now() + ttlMs });
      prune();
      return { id, question: `${a} + ${b}` };
    },

    /**
     * Whether `answer` solves challenge `id`. Uses the challenge up either way.
     * @param {unknown} id
     * @param {unknown} answer A number, or digits as text.
     */
    check(id, answer) {
      if (typeof id !== 'string') return false;
      const challenge = open.get(id);
      if (!challenge) return false;
      open.delete(id);
      const given = typeof answer === 'string' && /^\s*\d{1,3}\s*$/.test(answer) ? Number(answer) : answer;
      return challenge.expires > now() && given === challenge.answer;
    },

    /** How many challenges are waiting for an answer. */
    size: () => open.size,
  };
}
