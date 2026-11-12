/**
 * Session list: constants, stored preferences and small helpers shared by its layers.
 */
import { createLogger } from '../../utils/logger.js';
import { detectMobile } from '../../utils/mobile-utils.js';

export const logger: ReturnType<typeof createLogger> = createLogger('session-list');

/**
 * What the phone "new session" flow remembers between visits: the last tool you started and
 * the folders you worked in, so they survive clearing the sessions they came from.
 */
export const PHONE_STARTS_KEY = 'ut-phone-recent-starts';
export const MAX_RECENT_FOLDERS = 6;
export const WORKTREE_RETRY_MS = 60_000;
/**
 * The soft keyboard is taken to be up when the visible viewport is this much shorter than the
 * window (iOS shrinks visualViewport, not innerHeight): the tab bar and strip step aside.
 */
export const KEYBOARD_GAP_PX = 120;
/** Pull the top of the list down this far to reveal the search field. */
export const SEARCH_PULL_PX = 56;
/** How often the phone asks again which quick starts the Mac can run (the server caches 5 min). */
export const QUICK_START_AVAILABILITY_REFRESH_MS = 60_000;

export interface PhoneStarts {
  tool?: string;
  folders?: string[];
  /** Folder of the last "Ask Claude…" (or Claude session started from the phone). */
  claudeFolder?: string;
}

export function readPhoneStarts(): PhoneStarts {
  try {
    const value = JSON.parse(localStorage.getItem(PHONE_STARTS_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function writePhoneStarts(update: PhoneStarts) {
  try {
    localStorage.setItem(PHONE_STARTS_KEY, JSON.stringify({ ...readPhoneStarts(), ...update }));
  } catch {
    // Private mode or blocked storage: the sheet just falls back to current sessions.
  }
}

/** Phones get a chat-style list (rows instead of cards, sidebar included), and "On this Mac". */
export function isPhoneListLayout(): boolean {
  return detectMobile() && Math.min(window.innerWidth, window.innerHeight) < 600;
}

export type ListFilter = 'all' | 'agents' | 'terminals' | 'attention';
export type ListSort = 'activity' | 'name' | 'repo';
export type ListView = 'grid' | 'list';
/** Narrowest card column on desktop (list.css): 4 columns in a 1440px window. */
export const GRID_MIN_COLUMN = 336;
/**
 * How many columns a style's own `--ut-list-columns` lays out, or null when the value does not
 * say (auto-fill, auto-fit): `minmax(0, 1fr)` is 1, `1fr 1fr` is 2, `repeat(3, 1fr)` is 3.
 */
export function ownColumnCount(template: string): number | null {
  if (/auto-fi(ll|t)/.test(template)) return null;
  let depth = 0;
  let tracks = 0;
  let inTrack = false;
  let repeats = 1;
  const repeat = /^repeat\(\s*(\d+)\s*,(.*)\)$/s.exec(template.trim());
  if (repeat) repeats = Number(repeat[1]);
  for (const char of (repeat ? repeat[2] : template).trim()) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (depth === 0 && /\s/.test(char)) inTrack = false;
    else if (!inTrack) {
      inTrack = true;
      tracks++;
    }
  }
  return tracks ? tracks * repeats : null;
}
export const LIST_FILTERS: readonly ListFilter[] = ['all', 'agents', 'terminals', 'attention'];
export const LIST_SORTS: readonly ListSort[] = ['activity', 'name', 'repo'];
export const LIST_VIEWS: readonly ListView[] = ['grid', 'list'];

/** Desktop list options (filter, sort, view, group) remembered per browser. */
export function readListPref<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T
): T {
  try {
    const value = localStorage.getItem(`ut-list-${name}`);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeListPref(name: string, value: string) {
  try {
    localStorage.setItem(`ut-list-${name}`, value);
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

// v2 since shielding became the default (2026-10-03): under the old key '0' just meant "the
// switch was left off" when off was the default, so old choices don't carry over.
export const NEW_SHIELDED_KEY = 'ut-phone-new-shielded-v2';

export function readNewShieldedChoice(): boolean | null {
  try {
    const stored = localStorage.getItem(NEW_SHIELDED_KEY);
    return stored === '1' ? true : stored === '0' ? false : null;
  } catch {
    return null;
  }
}

export function writeNewShielded(value: boolean) {
  try {
    localStorage.setItem(NEW_SHIELDED_KEY, value ? '1' : '0');
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}
