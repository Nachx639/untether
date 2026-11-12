/**
 * The one rule about the soft keyboard everything that makes room for it goes by (2026-11-11):
 * with nothing editable focused there is no keyboard, whatever the viewport numbers say.
 *
 * The iPhone home-screen app sometimes showed the keyboard's gap with no keyboard up; a tap then
 * opened the real one. Every follower trusted the visual viewport alone, and only when it fired
 * an event: iOS can leave it at its keyboard-up size with no resize after the keyboard goes (a
 * return from the background, a session change, a blur), so the gap stayed until the next one.
 * Here: who has the focus (`softKeyboardTarget`), and the moments a follower must look again
 * besides the viewport's own events (`watchSoftKeyboard`).
 */

/** The focused element, through shadow roots. */
export function deepActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/**
 * The focused element a soft keyboard could be up for: a field, an editable element, or a frame
 * (a preview's own fields are out of sight from here). null: no keyboard can be up.
 */
export function softKeyboardTarget(): HTMLElement | null {
  const active = deepActiveElement();
  if (!active) return null;
  const tag = active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'IFRAME') return active;
  return active.isContentEditable === true ? active : null;
}

/** After a blur: once the focus has settled, and once the keyboard's animation is over. */
export const KEYBOARD_BLUR_RECHECK_MS = [300, 1000] as const;

/**
 * Calls `recheck` when the keyboard may have gone with no viewport event: a field lost the
 * focus (a moment later, see KEYBOARD_BLUR_RECHECK_MS), a field got it, the page is visible
 * again, came back from the bfcache, or the window got the focus back. Returns the cleanup.
 */
export function watchSoftKeyboard(recheck: () => void): () => void {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  const later = () => {
    clear();
    timers = KEYBOARD_BLUR_RECHECK_MS.map((delay) => setTimeout(recheck, delay));
  };
  const visible = () => {
    if (!document.hidden) {
      recheck();
      later();
    }
  };
  // Only the window's own focus (element focus events reach a window listener in capture).
  const windowFocus = (e: Event) => {
    if (!(e.target instanceof Node)) visible();
  };
  document.addEventListener('focusin', recheck);
  document.addEventListener('focusout', later);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pageshow', visible);
  window.addEventListener('focus', windowFocus);
  return () => {
    clear();
    document.removeEventListener('focusin', recheck);
    document.removeEventListener('focusout', later);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pageshow', visible);
    window.removeEventListener('focus', windowFocus);
  };
}
