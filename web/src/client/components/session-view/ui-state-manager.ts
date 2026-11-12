/**
 * UIStateManager
 *
 * Centralizes all UI state management for the session view including:
 * - Modal visibility states
 * - Mobile detection and orientation
 * - Keyboard and input states
 * - Loading states
 * - Terminal dimensions
 */

import { createLogger } from '../../utils/logger.js';
import { detectMobile } from '../../utils/mobile-utils.js';
import type { TerminalThemeId } from '../../utils/terminal-themes.js';

const logger = createLogger('ui-state-manager');

/** Open the next session in chat mode on phones (the saved view choice, as the toggle does). */
export function preferPhoneChatMode(): void {
  try {
    const stored = localStorage.getItem('untether_app_preferences');
    const preferences = stored ? JSON.parse(stored) : {};
    localStorage.setItem(
      'untether_app_preferences',
      JSON.stringify({ ...preferences, chatMode: true })
    );
  } catch {
    // Blocked storage: the session just opens in the last-used view.
  }
}

export interface UIState {
  // Connection state
  connected: boolean;

  // Mobile states
  isMobile: boolean;
  isLandscape: boolean;
  showQuickKeys: boolean;
  keyboardHeight: number;

  // Terminal dimensions
  terminalCols: number;
  terminalRows: number;

  // Control sequences
  showCtrlAlpha: boolean;
  ctrlSequence: string[];

  // Modal states
  showFileBrowser: boolean;
  showImagePicker: boolean;
  showWidthSelector: boolean;
  customWidth: string;
  isDragOver: boolean;

  // Terminal settings
  terminalMaxCols: number;
  terminalFontSize: number;
  terminalTheme: TerminalThemeId;

  // View mode
  viewMode: 'terminal' | 'worktree';

  // Chat mode - display terminal as chat bubbles
  chatMode: boolean;

  // Keyboard capture
  keyboardCaptureActive: boolean;
}

export interface UIStateCallbacks {
  requestUpdate: () => void;
}

export class UIStateManager {
  private state: UIState = {
    // Connection state
    connected: false,

    // Mobile states
    isMobile: false,
    isLandscape: false,
    showQuickKeys: false,
    keyboardHeight: 0,

    // Terminal dimensions
    terminalCols: 0,
    terminalRows: 0,

    // Control sequences
    showCtrlAlpha: false,
    ctrlSequence: [],

    // Modal states
    showFileBrowser: false,
    showImagePicker: false,
    showWidthSelector: false,
    customWidth: '',
    isDragOver: false,

    // Terminal settings
    terminalMaxCols: 0,
    terminalFontSize: 14,
    terminalTheme: 'auto',

    // View mode
    viewMode: 'terminal',

    // Chat mode
    chatMode: false,

    // Keyboard capture
    keyboardCaptureActive: true,
  };

  private callbacks: UIStateCallbacks | null = null;

  setCallbacks(callbacks: UIStateCallbacks): void {
    this.callbacks = callbacks;
  }

  // Get full state
  getState(): Readonly<UIState> {
    return { ...this.state };
  }

  // Connection state
  setConnected(connected: boolean): void {
    this.state.connected = connected;
    this.callbacks?.requestUpdate();
  }

  // Mobile states
  setIsMobile(isMobile: boolean): void {
    this.state.isMobile = isMobile;
    this.callbacks?.requestUpdate();
  }

  setIsLandscape(isLandscape: boolean): void {
    this.state.isLandscape = isLandscape;
    this.callbacks?.requestUpdate();
  }

  setShowQuickKeys(show: boolean): void {
    this.state.showQuickKeys = show;
    this.callbacks?.requestUpdate();
  }

  setKeyboardHeight(height: number): void {
    this.state.keyboardHeight = height;
    this.callbacks?.requestUpdate();
  }

  // Terminal dimensions
  setTerminalDimensions(cols: number, rows: number): void {
    this.state.terminalCols = cols;
    this.state.terminalRows = rows;
    this.callbacks?.requestUpdate();
  }

  // Control sequences
  setShowCtrlAlpha(show: boolean): void {
    this.state.showCtrlAlpha = show;
    this.callbacks?.requestUpdate();
  }

  addCtrlSequence(letter: string): void {
    this.state.ctrlSequence = [...this.state.ctrlSequence, letter];
    this.callbacks?.requestUpdate();
  }

  clearCtrlSequence(): void {
    this.state.ctrlSequence = [];
    this.callbacks?.requestUpdate();
  }

  // Modal states
  setShowFileBrowser(show: boolean): void {
    this.state.showFileBrowser = show;
    this.callbacks?.requestUpdate();
  }

  setShowImagePicker(show: boolean): void {
    this.state.showImagePicker = show;
    this.callbacks?.requestUpdate();
  }

  setShowWidthSelector(show: boolean): void {
    this.state.showWidthSelector = show;
    this.callbacks?.requestUpdate();
  }

  setCustomWidth(width: string): void {
    this.state.customWidth = width;
    this.callbacks?.requestUpdate();
  }

  setIsDragOver(isDragOver: boolean): void {
    this.state.isDragOver = isDragOver;
    this.callbacks?.requestUpdate();
  }

  setTerminalMaxCols(cols: number): void {
    this.state.terminalMaxCols = cols;
    this.callbacks?.requestUpdate();
  }

  setTerminalFontSize(size: number): void {
    this.state.terminalFontSize = size;
    this.callbacks?.requestUpdate();
  }

  setTerminalTheme(theme: TerminalThemeId): void {
    this.state.terminalTheme = theme;
    this.callbacks?.requestUpdate();
  }

  // View mode
  setViewMode(mode: 'terminal' | 'worktree'): void {
    this.state.viewMode = mode;
    this.callbacks?.requestUpdate();
  }

  // Keyboard capture
  setKeyboardCaptureActive(active: boolean): void {
    this.state.keyboardCaptureActive = active;
    this.callbacks?.requestUpdate();
  }

  toggleCtrlAlpha(): void {
    this.state.showCtrlAlpha = !this.state.showCtrlAlpha;
    this.callbacks?.requestUpdate();
  }

  // Check orientation
  checkOrientation(): void {
    const isLandscape = window.matchMedia('(orientation: landscape)').matches;
    this.state.isLandscape = isLandscape;
    this.callbacks?.requestUpdate();
  }

  // Chat mode
  setChatMode(enabled: boolean): void {
    this.state.chatMode = enabled;
    // Hide quick keys when entering chat mode (chat has its own input)
    if (enabled) {
      this.state.showQuickKeys = false;
    }
    this.callbacks?.requestUpdate();
  }

  toggleChatMode(): void {
    const enteringChatMode = !this.state.chatMode;
    this.state.chatMode = enteringChatMode;
    // Hide quick keys when entering chat mode (chat has its own input)
    if (enteringChatMode) {
      this.state.showQuickKeys = false;
    }
    this.saveAppPreference('chatMode', enteringChatMode);
    this.callbacks?.requestUpdate();
  }

  /**
   * Restore chat mode on phones, so reopening a session or reloading keeps the chosen view.
   * Desktop chat mode hides the terminal entirely, so it is never restored there.
   */
  loadChatModePreference(): void {
    if (!detectMobile()) return;
    try {
      const stored = localStorage.getItem('untether_app_preferences');
      this.state.chatMode = stored ? JSON.parse(stored).chatMode === true : false;
    } catch {
      this.state.chatMode = false;
    }
  }

  private saveAppPreference(key: string, value: unknown): void {
    try {
      const stored = localStorage.getItem('untether_app_preferences');
      const preferences = stored ? JSON.parse(stored) : {};
      localStorage.setItem(
        'untether_app_preferences',
        JSON.stringify({ ...preferences, [key]: value })
      );
    } catch (error) {
      logger.warn('Failed to save app preferences', error);
    }
  }
}
