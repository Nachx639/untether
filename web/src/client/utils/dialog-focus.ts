/**
 * Focus helpers for the dialogs that are not wrapped in <modal-wrapper> (2026-10-12).
 */
/** Tab stops inside a dialog, as modal-wrapper counts them. */
const TAB_STOPS =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab / Shift+Tab inside `root`, the same cycle as modal-wrapper. For dialogs that draw
 * their own frame instead of <modal-wrapper> (settings, new session). QA 2026-10-12: Tab left
 * both dialogs for the page controls behind the scrim.
 */
export function cycleTabWithin(root: HTMLElement, e: KeyboardEvent): void {
  const stops = [...root.querySelectorAll<HTMLElement>(TAB_STOPS)].filter((el) => {
    if (el.closest('[hidden]')) return false;
    const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
    return check ? check.call(el) : true;
  });
  const active = document.activeElement;
  if (!stops.length) {
    e.preventDefault();
    return;
  }
  const first = stops[0];
  const last = stops[stops.length - 1];
  const inside = active instanceof Node && active !== root && root.contains(active);
  if (!inside || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

/** The element focused right now, when it is a real target outside `root` (else null). */
export function captureOpener(root: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && !root.contains(active)
    ? active
    : null;
}

/** Puts focus back on `target` next frame, unless something else already took it. */
export function restoreFocusLater(target: HTMLElement | null): void {
  if (!target) return;
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (target.isConnected && (!active || active === document.body)) target.focus();
  });
}
