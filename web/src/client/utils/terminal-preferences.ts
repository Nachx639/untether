/**
 * Terminal preferences management
 * Handles saving and loading terminal-related user preferences
 */

import { createLogger } from './logger.js';
import { detectMobile } from './mobile-utils.js';
import {
  type AutoThemePair,
  type ConcreteTerminalThemeId,
  DEFAULT_AUTO_DARK_THEME,
  DEFAULT_AUTO_LIGHT_THEME,
  isTerminalThemeId,
  isThemeOfAppearance,
  type TerminalAppearance,
  type TerminalThemeId,
} from './terminal-themes.js';

const logger = createLogger('terminal-preferences');

export interface TerminalPreferences {
  maxCols: number; // 0 means no limit, positive numbers set max width
  fontSize: number;
  fitHorizontally: boolean;
  theme: TerminalThemeId;
  /** The dark and light themes "Auto" switches between, following the app's appearance. */
  autoDarkTheme: ConcreteTerminalThemeId;
  autoLightTheme: ConcreteTerminalThemeId;
}

/** Fired on window (detail: the selected theme id) when the theme or the Auto pair changes. */
export const TERMINAL_THEME_CHANGED_EVENT = 'terminal-theme-changed';

// Common terminal widths
export const COMMON_TERMINAL_WIDTHS = [
  { value: 0, label: '∞', description: 'Unlimited (full width)' },
  { value: 80, label: '80', description: 'Classic terminal' },
  { value: 100, label: '100', description: 'Modern standard' },
  { value: 120, label: '120', description: 'Wide terminal' },
  { value: 132, label: '132', description: 'Mainframe width' },
  { value: 160, label: '160', description: 'Ultra-wide' },
] as const;

const DEFAULT_PREFERENCES: TerminalPreferences = {
  maxCols: 0, // No limit by default - take as much as possible
  fontSize: detectMobile() ? 12 : 14, // 12px on mobile, 14px on desktop
  fitHorizontally: false,
  theme: 'auto',
  autoDarkTheme: DEFAULT_AUTO_DARK_THEME,
  autoLightTheme: DEFAULT_AUTO_LIGHT_THEME,
};

const STORAGE_KEY_TERMINAL_PREFS = 'untether_terminal_preferences';

export class TerminalPreferencesManager {
  private static instance: TerminalPreferencesManager;
  private preferences: TerminalPreferences;

  private constructor() {
    this.preferences = this.loadPreferences();
  }

  static getInstance(): TerminalPreferencesManager {
    if (!TerminalPreferencesManager.instance) {
      TerminalPreferencesManager.instance = new TerminalPreferencesManager();
    }
    return TerminalPreferencesManager.instance;
  }

  private loadPreferences(): TerminalPreferences {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_TERMINAL_PREFS);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Merge with defaults to handle new properties; unknown theme ids fall back.
        const merged: TerminalPreferences = { ...DEFAULT_PREFERENCES, ...parsed };
        if (!isTerminalThemeId(merged.theme)) merged.theme = DEFAULT_PREFERENCES.theme;
        if (!isThemeOfAppearance(merged.autoDarkTheme, 'dark')) {
          merged.autoDarkTheme = DEFAULT_AUTO_DARK_THEME;
        }
        if (!isThemeOfAppearance(merged.autoLightTheme, 'light')) {
          merged.autoLightTheme = DEFAULT_AUTO_LIGHT_THEME;
        }
        logger.debug('Loaded terminal preferences:', merged);
        return merged;
      }
    } catch (error) {
      logger.warn('Failed to load terminal preferences', { error });
    }
    logger.debug('Using default terminal preferences');
    return { ...DEFAULT_PREFERENCES };
  }

  private savePreferences() {
    try {
      const toSave = JSON.stringify(this.preferences);
      localStorage.setItem(STORAGE_KEY_TERMINAL_PREFS, toSave);
      logger.debug('Saved terminal preferences to localStorage');
    } catch (error) {
      logger.warn('Failed to save terminal preferences', { error });
    }
  }

  getMaxCols(): number {
    return this.preferences.maxCols;
  }

  setMaxCols(maxCols: number) {
    this.preferences.maxCols = Math.max(0, maxCols); // Ensure non-negative
    this.savePreferences();
  }

  getFontSize(): number {
    return this.preferences.fontSize;
  }

  setFontSize(fontSize: number) {
    this.preferences.fontSize = Math.max(8, Math.min(32, fontSize)); // Reasonable bounds
    this.savePreferences();
  }

  getFitHorizontally(): boolean {
    return this.preferences.fitHorizontally;
  }

  setFitHorizontally(fitHorizontally: boolean) {
    this.preferences.fitHorizontally = fitHorizontally;
    this.savePreferences();
  }

  getTheme(): TerminalThemeId {
    return this.preferences.theme;
  }

  setTheme(theme: TerminalThemeId) {
    if (!isTerminalThemeId(theme)) return;
    logger.debug('Setting terminal theme:', theme);
    this.preferences.theme = theme;
    this.savePreferences();
  }

  getAutoThemePair(): AutoThemePair {
    return { dark: this.preferences.autoDarkTheme, light: this.preferences.autoLightTheme };
  }

  /** Pairs a theme with Auto for one appearance; ignored when it is not of that appearance. */
  setAutoTheme(appearance: TerminalAppearance, theme: ConcreteTerminalThemeId) {
    if (!isThemeOfAppearance(theme, appearance)) return;
    if (appearance === 'dark') this.preferences.autoDarkTheme = theme;
    else this.preferences.autoLightTheme = theme;
    this.savePreferences();
  }

  getPreferences(): TerminalPreferences {
    return { ...this.preferences };
  }

  resetToDefaults() {
    this.preferences = { ...DEFAULT_PREFERENCES };
    this.savePreferences();
  }
}
