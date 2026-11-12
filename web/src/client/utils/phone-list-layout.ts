/**
 * How the phone session list fits a small screen (session-list.ts).
 *
 * On a 375×667 pt iPhone SE the first screen showed no session at all: the Ask box, "Tareas",
 * the notifications banner, the search field and the previews filled it (2026-10-04). Two
 * levels, so larger phones keep the classic look:
 *
 * - `tight`: less vertical spacing. Pure spacing, automatic on a screen ≤ 375 pt wide or
 *   ≤ 700 pt tall (an SE, a mini), and when "Compact list" is turned on in Settings.
 * - `compact`: things change shape. "Tareas" is an icon in the Ask card's row, the
 *   notifications banner is one line, and previews whose server is down fold into the
 *   "Vistas previas (n)" disclosure. A setting ("Compact list", Settings), on by default on
 *   every phone since the 2026-10-12 phone redesign (phone-spec 4.1: the first row within
 *   300 pt of the top of a 15 Pro); "off" in Settings brings back the roomier spacing.
 *
 * The screen's size, not the window's: it doesn't change with Safari's bars or the keyboard,
 * so the layout doesn't jump while you type in the Ask box. Except a phone on its side
 * (utils/short-landscape.ts), checked again on every rotation: iOS reports the screen in
 * portrait, so a Pro Max in landscape, about 300 pt tall, got neither (2026-10-04). There the
 * list has two columns (session-list.ts) and the spacing is tight; `compact` stays the
 * setting's.
 */

import { currentShortLandscape } from './short-landscape.js';

export const SHORT_SCREEN_MAX_PT = 700;
export const NARROW_SCREEN_MAX_PT = 375;

/** "on" / "off" once chosen in Settings; nothing stored means the screen decides. */
export const COMPACT_LIST_KEY = 'ut-compact-phone-list';
export const COMPACT_LIST_CHANGED_EVENT = 'ut-compact-phone-list-changed';

export type CompactListPref = 'auto' | 'on' | 'off';

export interface ScreenSize {
  width: number;
  height: number;
}

export interface PhoneListLayout {
  tight: boolean;
  compact: boolean;
}

/** The device screen in CSS px (pt on iOS), either orientation. */
export function currentScreen(): ScreenSize {
  const width = window.screen?.width || window.innerWidth;
  const height = window.screen?.height || window.innerHeight;
  return { width, height };
}

export function isShortScreen(screen: ScreenSize): boolean {
  return Math.max(screen.width, screen.height) <= SHORT_SCREEN_MAX_PT;
}

export function isNarrowScreen(screen: ScreenSize): boolean {
  return Math.min(screen.width, screen.height) <= NARROW_SCREEN_MAX_PT;
}

/** Whether the compact list is on for this preference: on unless turned off (2026-10-12). */
export function compactListOn(_screen: ScreenSize, pref: CompactListPref): boolean {
  return pref !== 'off';
}

export function phoneListLayout(
  screen: ScreenSize,
  pref: CompactListPref,
  shortLandscape = false
): PhoneListLayout {
  const compact = compactListOn(screen, pref);
  return {
    compact,
    // The screen decides the spacing; a "Compact list" chosen in Settings tightens it too.
    tight: pref === 'on' || shortLandscape || isShortScreen(screen) || isNarrowScreen(screen),
  };
}

export function readCompactListPref(): CompactListPref {
  try {
    const value = localStorage.getItem(COMPACT_LIST_KEY);
    return value === 'on' || value === 'off' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeCompactListPref(pref: CompactListPref): void {
  try {
    if (pref === 'auto') localStorage.removeItem(COMPACT_LIST_KEY);
    else localStorage.setItem(COMPACT_LIST_KEY, pref);
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(COMPACT_LIST_CHANGED_EVENT, { detail: pref }));
}

/** The layout for this device now; `shortLandscape` as utils/short-landscape.ts sees it. */
export function currentPhoneListLayout(shortLandscape = currentShortLandscape()): PhoneListLayout {
  return phoneListLayout(currentScreen(), readCompactListPref(), shortLandscape);
}

/**
 * The previews section's down rows (server not answering): shown, or folded into the
 * "Vistas previas (n)" disclosure. `count` is how many are down. Folded in the compact list
 * while not searching (a search shows what matches), not opened by the user, and none of
 * them glowing after `ut open` (that one must be seen). Live previews always show.
 */
export function previewsFolded(options: {
  compact: boolean;
  count: number;
  searching: boolean;
  expanded: boolean;
  highlighted: boolean;
}): boolean {
  return (
    options.compact &&
    options.count > 0 &&
    !options.searching &&
    !options.expanded &&
    !options.highlighted
  );
}
