/**
 * iOS sends a click ~after a tap's pointerup. Sheets act on pointerup (a first tap on a
 * fresh button can be eaten as hover) and close at once, so that click lands on whatever
 * is now under the finger: a session row underneath opened that session (2026-10-02, found
 * in the simulator after "Pin to top"). Call this when a pointerup action closes or replaces
 * the UI under the finger: the next click anywhere within `ms` is swallowed.
 */
let pending: ((e: Event) => void) | null = null;

/**
 * A new touch is a new gesture: the guard of the last one ends with it. Some actions that
 * set it never get a click (a swipe closing the lightbox, a long press), and a real tap on
 * the search or keyboard button right after was lost (review of 2026-10-03).
 */
const releaseOnTouch = () => resetGhostClickGuard();

export function resetGhostClickGuard(): void {
  if (pending && typeof document !== 'undefined') {
    document.removeEventListener('click', pending, true);
    document.removeEventListener('pointerdown', releaseOnTouch, true);
  }
  pending = null;
}

/**
 * A tap that closed or replaced the UI under the finger is still finishing: a hidden field
 * focused now (the chat's search, the keyboard button) was focused by that tap, not a new one.
 * 2026-10-03: closing the "while you were away" card opened the chat search under it.
 */
export function isSwallowingGhostClick(): boolean {
  return pending !== null;
}

export function swallowNextClick(ms = 700): void {
  if (typeof document === 'undefined') return;
  resetGhostClickGuard();
  const until = Date.now() + ms;
  const swallow = (e: Event) => {
    resetGhostClickGuard();
    if (Date.now() > until) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  pending = swallow;
  document.addEventListener('click', swallow, true);
  document.addEventListener('pointerdown', releaseOnTouch, true);
  setTimeout(() => {
    if (pending === swallow) resetGhostClickGuard();
  }, ms);
}
