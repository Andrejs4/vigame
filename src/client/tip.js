/**
 * A message in the middle of the screen: a title and a line or two, faint
 * over the board, which it never gets in the way of. It takes no clicks
 * (`pointer-events: none`), so they reach the cells under it. It fades in,
 * and out again after its time, or at the player's first click, tap or key
 * press, which still does what it would have (unless it is to stay its
 * time). Its caller may pause the game meanwhile (`onClose` says when to
 * go on).
 */

/** How long one stays, unless the player acts first, in milliseconds. */
export const TIP_MS = 8000;

/** How long it takes to fade, as in style.css, in milliseconds. */
const FADE_MS = 400;

/**
 * @param {HTMLElement} box The `.tip` element, with a `.tip-title` and a `.tip-text` inside.
 */
export function createTip(box) {
  const title = /** @type {HTMLElement} */ (box.querySelector('.tip-title'));
  const text = /** @type {HTMLElement} */ (box.querySelector('.tip-text'));
  /** @type {(() => void) | null} */
  let closing = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let gone;

  // The player's first action closes it; it isn't stopped, so it still
  // reaches the board, a button or a key's shortcut.
  const act = () => hide();
  const listen = (/** @type {boolean} */ on) => {
    for (const type of ['pointerdown', 'keydown']) {
      if (on) addEventListener(type, act, { capture: true, passive: true });
      else removeEventListener(type, act, { capture: true });
    }
  };

  /** Fade it out, and say it closed. */
  function hide() {
    if (!closing) return;
    const done = closing;
    closing = null;
    clearTimeout(timer);
    listen(false);
    box.classList.remove('shown');
    gone = setTimeout(() => { box.hidden = true; }, FADE_MS);
    done();
  }

  return {
    /**
     * Show a message, in place of any shown now.
     * @param {{ title?: string, text: string, ms?: number, stays?: boolean, onClose?: () => void }} message
     *   `ms`: how long it stays unless the player acts first (Infinity: until they do);
     *   `stays`: it stays all that time, whatever the player does.
     */
    show({ title: heading = '', text: body, ms = TIP_MS, stays = false, onClose = () => {} }) {
      hide();
      clearTimeout(gone);
      title.textContent = heading;
      title.hidden = !heading;
      text.textContent = body;
      box.hidden = false;
      // A frame shown before it fades in, or it would appear at once.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (closing) box.classList.add('shown'); }));
      closing = onClose;
      if (Number.isFinite(ms)) timer = setTimeout(hide, ms);
      if (!stays) listen(true);
    },
    hide,
    /** Whether one is shown. */
    shown: () => closing !== null,
  };
}
