/**
 * How the home-screen app keeps iOS 26+/27's scroll-edge blur off the list header, with a
 * hidden switch to compare on a device (2026-10-04). The blur is system chrome drawn over the
 * web view ~40 pt past the status bar; neither a fixed band over the status bar nor a sticky
 * opaque header made WebKit drop it on the iPhone SE simulator (iOS 27). Modes:
 *
 * - `pad` (default): the header's content starts below the blurred zone, its opaque
 *   background filling the zone (the approach other apps confirmed on devices); the session
 *   view's header too, since the same day (it was frosted the same way);
 * - `sticky`: the header sticky and opaque at the top, plus the band (did not help);
 * - `off`: neither, as before.
 *
 * The home-screen app takes no URL parameters, so the switch is a long press on the version
 * in Settings (settings.ts), stored in localStorage and applied at once as
 * `html[data-edge-fix]`; assets/viewport-init.js applies the stored one at boot (the test
 * checks the two agree). The CSS is in styles.css under html[data-standalone].
 */

export const EDGE_FIX_KEY = 'ut-edge-fix';
export const EDGE_FIX_MODES = ['pad', 'sticky', 'off'] as const;
export type EdgeFixMode = (typeof EDGE_FIX_MODES)[number];
export const DEFAULT_EDGE_FIX: EdgeFixMode = 'pad';

export function parseEdgeFix(value: string | null | undefined): EdgeFixMode {
  return EDGE_FIX_MODES.includes(value as EdgeFixMode) ? (value as EdgeFixMode) : DEFAULT_EDGE_FIX;
}

/** The next mode of the cycle pad → sticky → off → pad. */
export function nextEdgeFix(mode: EdgeFixMode): EdgeFixMode {
  return EDGE_FIX_MODES[(EDGE_FIX_MODES.indexOf(mode) + 1) % EDGE_FIX_MODES.length];
}

export function readEdgeFix(): EdgeFixMode {
  try {
    return parseEdgeFix(localStorage.getItem(EDGE_FIX_KEY));
  } catch {
    return DEFAULT_EDGE_FIX;
  }
}

/** Stores the mode and applies it now (the CSS keys off the attribute). */
export function applyEdgeFix(mode: EdgeFixMode): void {
  try {
    localStorage.setItem(EDGE_FIX_KEY, mode);
  } catch {
    // Blocked storage: it lasts until the page reloads.
  }
  document.documentElement.setAttribute('data-edge-fix', mode);
}
