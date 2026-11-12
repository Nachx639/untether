/**
 * TerminalSettingsManager
 *
 * Manages terminal configuration settings including:
 * - Terminal width/columns management
 * - Font size settings
 * - Theme selection
 * - Settings persistence via TerminalPreferencesManager
 */
import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { createLogger } from '../../utils/logger.js';
import {
  COMMON_TERMINAL_WIDTHS,
  TERMINAL_THEME_CHANGED_EVENT,
  TerminalPreferencesManager,
} from '../../utils/terminal-preferences.js';
import { resolveTerminalTheme, type TerminalThemeId } from '../../utils/terminal-themes.js';
import { getCurrentTheme } from '../../utils/theme-utils.js';
import type { Terminal } from '../terminal.js';

const logger = createLogger('terminal-settings-manager');

/** The CSS variable the session header and the terminal's inset take (design spec 5.2). */
export const TERMINAL_BG_VAR = '--ut-terminal-bg';

export interface TerminalSettingsCallbacks {
  getSession: () => Session | null;
  getTerminalElement: () => Terminal | null;
  requestUpdate: () => void;
  setTerminalMaxCols: (cols: number) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalTheme: (theme: TerminalThemeId) => void;
  setShowWidthSelector: (show: boolean) => void;
  setCustomWidth: (width: string) => void;
  getTerminalLifecycleManager: () => {
    setTerminalMaxCols: (cols: number) => void;
    setTerminalFontSize: (size: number) => void;
    setTerminalTheme: (theme: TerminalThemeId) => void;
  } | null;
}

/** The last fixed terminal width (columns) chosen on this device. */
const LAST_WIDTH_KEY = 'ut-terminal-last-fixed-cols';

export function lastFixedWidth(): number {
  try {
    const value = Number(localStorage.getItem(LAST_WIDTH_KEY));
    return Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function rememberFixedWidth(cols: number): void {
  try {
    localStorage.setItem(LAST_WIDTH_KEY, String(cols));
  } catch {
    // Blocked storage: the width list opens instead.
  }
}

export class TerminalSettingsManager {
  private preferencesManager = TerminalPreferencesManager.getInstance();
  private callbacks: TerminalSettingsCallbacks | null = null;

  // Current settings state
  private terminalMaxCols = 0;
  private terminalFontSize = 14;
  private terminalTheme: TerminalThemeId = 'auto';

  constructor() {
    // Load initial preferences
    this.loadPreferences();
  }

  setCallbacks(callbacks: TerminalSettingsCallbacks): void {
    this.callbacks = callbacks;

    // Sync initial state with callbacks
    if (callbacks) {
      callbacks.setTerminalMaxCols(this.terminalMaxCols);
      callbacks.setTerminalFontSize(this.terminalFontSize);
      callbacks.setTerminalTheme(this.terminalTheme);
    }
    this.startTerminalBackgroundSync();
  }

  // Terminal background → --ut-terminal-bg (2026-10-12): the padding around the terminal, and in
  // Original the header (--ut-session-bar), take the active terminal theme's background, so the
  // terminal reads as one surface with its frame. Follows the theme setting, light/dark (Auto picks a theme per appearance)
  // and the accent, and is removed when the session view goes.
  private themeObserver: MutationObserver | null = null;

  private syncTerminalBackground = (): void => {
    if (typeof document === 'undefined') return;
    const background = this.resolveTerminalBackground();
    const root = document.documentElement;
    if (background) root.style.setProperty(TERMINAL_BG_VAR, background);
    else root.style.removeProperty(TERMINAL_BG_VAR);
  };

  /** The active theme's background, with var(--color-*) resolved; '' when unknown. */
  resolveTerminalBackground(): string {
    // Settings may change it elsewhere (Settings › Terminal): read the stored choice.
    const id = this.preferencesManager.getTheme() ?? this.terminalTheme;
    const theme = resolveTerminalTheme(
      id,
      getCurrentTheme(),
      this.preferencesManager.getAutoThemePair()
    );
    const value = theme?.colors?.background ?? '';
    const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
    if (!name) return value;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  private startTerminalBackgroundSync(): void {
    if (typeof document === 'undefined' || this.themeObserver) {
      this.syncTerminalBackground();
      return;
    }
    this.syncTerminalBackground();
    this.themeObserver = new MutationObserver(this.syncTerminalBackground);
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    window.addEventListener('untether-accent-changed', this.syncTerminalBackground);
    window.addEventListener('storage', this.syncTerminalBackground);
    window.addEventListener(TERMINAL_THEME_CHANGED_EVENT, this.syncTerminalBackground);
  }

  /** The session view is going: stop following and give the page its own background back. */
  dispose(): void {
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('untether-accent-changed', this.syncTerminalBackground);
      window.removeEventListener('storage', this.syncTerminalBackground);
      window.removeEventListener(TERMINAL_THEME_CHANGED_EVENT, this.syncTerminalBackground);
    }
    if (typeof document !== 'undefined') {
      document.documentElement.style.removeProperty(TERMINAL_BG_VAR);
    }
  }

  private loadPreferences(): void {
    this.terminalMaxCols = this.preferencesManager.getMaxCols();
    this.terminalFontSize = this.preferencesManager.getFontSize();
    this.terminalTheme = this.preferencesManager.getTheme();
    logger.debug('Loaded terminal preferences:', {
      maxCols: this.terminalMaxCols,
      fontSize: this.terminalFontSize,
      theme: this.terminalTheme,
    });
  }

  // Getters for current settings
  getMaxCols(): number {
    return this.terminalMaxCols;
  }

  getFontSize(): number {
    return this.terminalFontSize;
  }

  getTheme(): TerminalThemeId {
    return this.terminalTheme;
  }

  // Width management
  handleMaxWidthToggle(): void {
    if (this.callbacks) {
      this.callbacks.setShowWidthSelector(true);
    }
  }

  handleWidthSelect(newMaxCols: number): void {
    if (!this.callbacks) return;

    // A fixed width is remembered: turning "fit to the window" off again goes back to it.
    if (newMaxCols > 0) rememberFixedWidth(newMaxCols);
    else if (this.terminalMaxCols > 0) rememberFixedWidth(this.terminalMaxCols);
    this.terminalMaxCols = newMaxCols;
    this.preferencesManager.setMaxCols(newMaxCols);
    this.callbacks.setShowWidthSelector(false);
    this.callbacks.setTerminalMaxCols(newMaxCols);

    // Update the terminal lifecycle manager
    const lifecycleManager = this.callbacks.getTerminalLifecycleManager();
    if (lifecycleManager) {
      lifecycleManager.setTerminalMaxCols(newMaxCols);
    }

    // Update the terminal component
    const terminal = this.callbacks.getTerminalElement();
    if (terminal) {
      terminal.maxCols = newMaxCols;
      terminal.refitToChosenWidth();
      // Trigger a resize to apply the new constraint
      terminal.requestUpdate();
    } else {
      logger.warn('Terminal component not found when setting width');
    }
  }

  /**
   * The phone's "Ajustar a la ventana" switch turned off: back to the width used before it
   * was turned on (2026-10-20: it opened the width list, a second step for an undo). Without
   * one remembered, the list opens to pick one.
   */
  handleFitOff(): void {
    const previous = lastFixedWidth();
    if (previous > 0) this.handleWidthSelect(previous);
    else this.handleMaxWidthToggle();
  }

  getCurrentWidthLabel(): string {
    if (!this.callbacks) return '∞';

    if (this.terminalMaxCols === 0) return '∞';
    const commonWidth = COMMON_TERMINAL_WIDTHS.find((w) => w.value === this.terminalMaxCols);
    return commonWidth ? commonWidth.label : this.terminalMaxCols.toString();
  }

  getWidthTooltip(): string {
    if (!this.callbacks)
      return t('terminalSettings.widthTooltip', { width: t('terminalSettings.unlimited') });

    return t('terminalSettings.widthTooltip', {
      width:
        this.terminalMaxCols === 0
          ? t('terminalSettings.unlimited')
          : t('terminalSettings.columns', { n: this.terminalMaxCols }),
    });
  }

  // Font size management
  handleFontSizeChange(newSize: number): void {
    if (!this.callbacks) return;

    // Clamp to reasonable bounds
    const clampedSize = Math.max(8, Math.min(32, newSize));
    this.terminalFontSize = clampedSize;
    this.preferencesManager.setFontSize(clampedSize);
    this.callbacks.setTerminalFontSize(clampedSize);

    // Update the terminal lifecycle manager
    const lifecycleManager = this.callbacks.getTerminalLifecycleManager();
    if (lifecycleManager) {
      lifecycleManager.setTerminalFontSize(clampedSize);
    }

    // Update the terminal component
    const terminal = this.callbacks.getTerminalElement();
    if (terminal) {
      terminal.fontSize = clampedSize;
      terminal.requestUpdate();
    }
  }

  // Theme management
  handleThemeChange(newTheme: TerminalThemeId): void {
    if (!this.callbacks) return;

    logger.debug('Changing terminal theme to:', newTheme);

    this.terminalTheme = newTheme;
    this.preferencesManager.setTheme(newTheme);
    this.callbacks.setTerminalTheme(newTheme);
    this.syncTerminalBackground();

    const lifecycleManager = this.callbacks.getTerminalLifecycleManager();
    if (lifecycleManager) {
      lifecycleManager.setTerminalTheme(newTheme);
    }

    const terminal = this.callbacks.getTerminalElement();
    if (terminal) {
      terminal.theme = newTheme;
      terminal.requestUpdate();
    }
  }

  // Getter for current state
  getTerminalTheme(): TerminalThemeId {
    return this.terminalTheme;
  }
}
