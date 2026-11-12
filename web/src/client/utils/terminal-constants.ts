/**
 * Terminal component constants and selectors
 *
 * Centralized definitions to prevent breaking changes when IDs or classes are modified
 */

/**
 * HTML element IDs used across terminal components
 */
export const TERMINAL_IDS = {
  /** Main session container element */
  SESSION_TERMINAL: 'session-terminal',
  /** Buffer container for ut-terminal-buffer component */
  BUFFER_CONTAINER: 'buffer-container',
  /** Terminal container for terminal.ts component */
  TERMINAL_CONTAINER: 'terminal-container',
  /** Stable browser-automation target for terminal keyboard input */
  TERMINAL_INPUT: 'terminal-input',
} as const;

/**
 * Standard terminal font family used across the application: Hack Nerd Font Mono (styles.css,
 * loaded as utils/terminal-fonts.ts describes), with the system's monospace behind it. Until
 * 2026-10-04 the canvas terminal named only the system fonts, none of which has the Nerd icons.
 */
export const TERMINAL_FONT_FAMILY =
  '"Hack Nerd Font Mono", ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace';

/**
 * IME input vertical offset in pixels for better alignment
 */
export const IME_VERTICAL_OFFSET_PX = 3;

/**
 * CJK (Chinese, Japanese, Korean) language codes for IME detection
 */
export const CJK_LANGUAGE_CODES = [
  'zh',
  'zh-CN',
  'zh-TW',
  'zh-HK',
  'zh-SG', // Chinese variants
  'ja',
  'ja-JP', // Japanese
  'ko',
  'ko-KR', // Korean
] as const;
