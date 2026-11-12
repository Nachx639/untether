import { findLook, forcedLookMode } from '../../shared/looks.js';
import { syncThemeColorMeta } from './accent-themes.js';

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'untether-theme';
const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

/** Saved light/dark/system choice (same key the header toggle and compact menu use). */
export function getThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
    if (saved && THEME_MODES.includes(saved)) return saved;
  } catch {
    // Storage blocked (private mode): fall back to system.
  }
  return 'system';
}

/**
 * Light or dark as shown: the mode a style forces (it is kept out of storage, so the user's choice
 * comes back with another style), otherwise the saved mode, resolved for 'system'.
 */
export function effectiveThemeMode(mode: ThemeMode = getThemeMode()): 'light' | 'dark' {
  const forced = forcedLookMode(findLook(document.documentElement.getAttribute('data-look')));
  if (forced) return forced;
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Sets `data-theme` and the browser chrome from the saved mode and the active style. */
export function syncThemeMode(): void {
  document.documentElement.setAttribute('data-theme', effectiveThemeMode());
  syncThemeColorMeta();
}

/**
 * Persist and apply a light/dark/system choice: sets `data-theme` on <html> and syncs the
 * browser chrome color. Callers dispatch `theme-changed` themselves. A style that forces a mode
 * still wins; the choice is kept for when it goes.
 */
export function applyThemeMode(mode: ThemeMode): void {
  const theme = THEME_MODES.includes(mode) ? mode : 'system';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not persisted; still applied for this page.
  }
  syncThemeMode();
}
