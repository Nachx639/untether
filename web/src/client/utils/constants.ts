// UI Constants for Untether

export const BREAKPOINTS = {
  MOBILE: 768,
  DESKTOP: 1280,
} as const;

export const SIDEBAR = {
  DEFAULT_WIDTH: 300, // 420 until 2026-10-12 (design spec 3.6); saved widths are kept
  MIN_WIDTH: 240,
  MAX_WIDTH: 480,
} as const;

export const TRANSITIONS = {
  SIDEBAR: 200,
  MOBILE_SLIDE: 200,
  RESIZE_HANDLE: 200,
} as const;

/**
 * Z-Index layering system for UI components
 *
 * Layers (from bottom to top):
 * - 0-49: Base UI elements (terminals, buttons, mobile overlays)
 * - 50-99: Dropdowns and popovers
 * - 100-199: Modal dialogs and their backdrops
 * - 200+: Special overlays that must appear above everything
 *
 * When adding new z-index values:
 * 1. Choose the appropriate range based on the component type
 * 2. Leave gaps between values for future insertions
 * 3. Document why the component needs its specific layer
 */
export const Z_INDEX = {
  // Base UI elements (0-49)
  SESSION_LIST_BOTTOM_BAR: 10,
  TERMINAL_OVERLAY: 15,
  MOBILE_OVERLAY: 25,
  SIDEBAR_MOBILE: 55, // Full-screen on phones: above the sticky session header (50) and quick keys (48)
  TERMINAL_QUICK_KEYS: 48,
  // Above terminal chrome, below interactive popovers and modals. The session view's layer for
  // "Session ended" and "Reconnecting…", under its sticky header (50), whose menus open over it.
  SESSION_EXITED_OVERLAY: 49,

  // Dropdowns and popovers (50-99)
  WIDTH_SELECTOR_DROPDOWN: 60,
  IME_INPUT: 70, // Invisible IME input for CJK text - needs to be above terminal but below modals

  // Modals and overlays (100-199)
  MODAL_BACKDROP: 100,
  MODAL: 105,
  FILE_PICKER: 110,
  NOTIFICATION: 150, // Notifications appear above modals but below file browser

  // Special high-priority overlays (200+)
  // «Conversar» (copilot-sheet.ts): full screen on <body>, over the app's own sheets and banners.
  COPILOT_SHEET: 1000,
  FILE_BROWSER: 1100, // Over «Conversar» (1000) and everything below it
  // The floating label of a session or group being dragged in the list (utils/list-drag.ts).
  LIST_DRAG_GHOST: 1200,
  // A nested editor opened from a phone content sheet (the shared sheet uses 2001).
  SHEET_EDITOR: 2100,
  // The input diagnostics line (utils/input-diagnostics.ts): over everything, it takes no taps.
  DIAG_LINE: 3000,
} as const;

export const TIMING = {
  AUTO_REFRESH_INTERVAL: 1000,
  SESSION_SEARCH_DELAY: 500,
  KILL_ALL_ANIMATION_DELAY: 500,
  ERROR_MESSAGE_TIMEOUT: 5000,
  SUCCESS_MESSAGE_TIMEOUT: 5000,
  KILL_ALL_BUTTON_DISABLE_DURATION: 2000,
} as const;

/**
 * Fired on window before a task push reveals its row (app.ts showTask, detail: { taskId }):
 * the list opens what hides it ("Hechas", a search that leaves it out).
 */
export const TASK_UNFOLD_EVENT = 'ut-task-unfold';

/** Fired on window to bring a task's row into view (detail: { taskId }), like its push. */
export const SHOW_TASK_EVENT = 'ut-show-task';
