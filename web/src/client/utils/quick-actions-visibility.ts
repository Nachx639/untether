/**
 * Whether the phone's quick actions strip (components/quick-actions-bar.ts) shows: a
 * per-browser preference, off until turned on in Settings → Terminal (2026-10-20: the user
 * didn't want it there by default).
 */
const SHOWN_KEY = 'untether_quick_actions_shown';
export const QUICK_ACTIONS_VISIBILITY_EVENT = 'ut-quick-actions-visibility';

export function quickActionsHidden(): boolean {
  try {
    return localStorage.getItem(SHOWN_KEY) !== '1';
  } catch {
    return true;
  }
}

/** Remembered in this browser and applied at once by every strip on screen. */
export function setQuickActionsHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.removeItem(SHOWN_KEY);
    else localStorage.setItem(SHOWN_KEY, '1');
  } catch {
    // Private mode: the toggle still applies until reload.
  }
  window.dispatchEvent(new CustomEvent(QUICK_ACTIONS_VISIBILITY_EVENT, { detail: { hidden } }));
}
