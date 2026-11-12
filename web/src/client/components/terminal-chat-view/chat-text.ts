/**
 * Marks text painted after the cursor jumped to another row (toChatText). U+0001 never stays
 * in the text: control characters from the PTY are removed before it is added.
 */
export const PAINTED = '\u0001';

/**
 * A TUI's spinner or status line: an optional mark, one capitalized word ending in "…", then
 * at most a counter and a parenthesised status, as Claude Code, Codex and Gemini draw them.
 */
const SPINNER_STATUS =
  /^[\s·•✢✳✶✻✽✦∗*+⏺●○◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]*\p{Lu}\p{Ll}+(?:[ -]\p{Ll}+)?…\s*\d*\s*(?:\(.*)?$/u;

/** Box drawing, block elements, geometric shapes and spinner marks, nothing else. */
export const GLYPHS_ONLY = /^[\s\u2500-\u25ff·•✢✳✶✻✽✦∗⏺⏵⏴⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/u;

export function isSpinnerStatus(line: string): boolean {
  return SPINNER_STATUS.test(line.trim());
}

/**
 * Text painted at a cursor position (toChatText) that is not worth a message: a counter, a
 * mark, a fragment without a word in it. A TUI repaints only the cells that change ("5" for
 * a timer going from 4 s to 5 s).
 */
export function isPaintedNoise(line: string): boolean {
  const text = line.trim();
  return !/\p{L}{2,}/u.test(text) || isSpinnerStatus(text);
}
