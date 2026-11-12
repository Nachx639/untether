/**
 * Shared interfaces for session-view components
 *
 * Breaking down the large callback interface into smaller, focused interfaces
 * following the Interface Segregation Principle
 */

/**
 * State management callbacks for basic component state
 */
export interface StateCallbacks {
  getIsMobile(): boolean;
  setIsMobile(value: boolean): void;
  setShowQuickKeys(value: boolean): void;
  setShowFileBrowser(value: boolean): void;
  getShowWidthSelector(): boolean;
  setShowWidthSelector(value: boolean): void;
  setCustomWidth(value: string): void;
  setKeyboardHeight(value: number): void;
  setConnected(connected: boolean): void;
  getKeyboardCaptureActive(): boolean;
  /** Phone chat mode: its composer takes what is typed, not the terminal under the chat. */
  getChatMode?(): boolean;
  /** Types a hardware key's character into the chat composer, focusing it; false without one. */
  typeIntoComposer?(text: string): boolean;
  /** Chat mode shows Claude's conversation over the terminal, which is then out of sight. */
  getChatCoversTerminal?(): boolean;
}

/**
 * UI update and rendering callbacks
 */
export interface UICallbacks {
  requestUpdate(): void;
  focus(): void;
  getDisableFocusManagement(): boolean;
}

/**
 * Navigation and routing callbacks
 */
export interface NavigationCallbacks {
  handleBack(): void;
  handleKeyboardInput(e: KeyboardEvent): Promise<void>;
  /** Switch to the adjacent running session (touch swipe / shortcut driven). */
  switchSession?(direction: 'next' | 'prev'): void;
}

/**
 * DOM operation callbacks
 */
export interface DOMCallbacks {
  querySelector(selector: string): Element | null;
  setTabIndex(value: number): void;
  addEventListener(event: string, handler: EventListener): void;
  removeEventListener(event: string, handler: EventListener): void;
}

/**
 * Loading state management callbacks
 */
export interface LoadingCallbacks {
  startLoading(): void;
  stopLoading(): void;
}

/**
 * Manager access callbacks - provides access to other managers
 * Note: These return minimal interfaces to reduce coupling
 */
export interface ManagerAccessCallbacks {
  getDirectKeyboardManager(): {
    getShowQuickKeys(): boolean;
    setShowQuickKeys?(value: boolean): void;
    ensureHiddenInputVisible(): void;
    cleanup(): void;
    exitKeyboardMode(): void;
    getKeyboardMode(): boolean;
    isRecentlyEnteredKeyboardMode(): boolean;
  };
  getInputManager(): { isKeyboardShortcut(e: KeyboardEvent): boolean } | null;
  getTerminalLifecycleManager(): {
    resetTerminalSize(): void;
    cleanup(): void;
  } | null;
  getConnectionManager(): {
    setConnected(connected: boolean): void;
    cleanupStreamConnection(): void;
  } | null;
}

/**
 * Combined interface for lifecycle event manager
 * Extends all the smaller interfaces
 */
export interface LifecycleEventManagerCallbacks
  extends StateCallbacks,
    UICallbacks,
    NavigationCallbacks,
    DOMCallbacks,
    LoadingCallbacks,
    ManagerAccessCallbacks {}
