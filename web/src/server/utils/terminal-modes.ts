/**
 * DEC private modes that change how a client must talk to the app: cursor-key mode,
 * autowrap, cursor visibility, mouse reporting and its encodings, focus events and
 * bracketed paste. Apps usually set them once at startup, before the last screen clear,
 * so a client replaying from that clear never learned them (no mouse wheel/clicks for
 * Claude Code, raw multi-line pastes) unless the server restores them first.
 */
const TRACKED_MODES = new Set([1, 7, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004]);
// Mode set/reset, plus full (RIS, ESC c) and soft (DECSTR, ESC [ ! p) terminal resets.
// biome-ignore lint/complexity/useRegexLiterals: a literal would need control characters
const MODE_OR_RESET = new RegExp('\\x1b\\[\\?([\\d;]+)([hl])|\\x1bc|\\x1b\\[!p', 'g');

/**
 * Apply the DEC mode sequences and terminal resets found in `data`, in order.
 * Returns true if a tracked mode changed. Re-scanning text already applied is harmless.
 */
export function trackDecModes(modes: Record<string, boolean>, data: string): boolean {
  if (!data.includes('\x1b')) return false;
  let changed = false;
  for (const match of data.matchAll(MODE_OR_RESET)) {
    if (!match[1]) {
      for (const mode of Object.keys(modes)) {
        delete modes[mode];
        changed = true;
      }
      continue;
    }
    const enabled = match[2] === 'h';
    for (const mode of match[1].split(';')) {
      if (!TRACKED_MODES.has(Number(mode))) continue;
      if (modes[mode] !== enabled) {
        modes[mode] = enabled;
        changed = true;
      }
    }
  }
  return changed;
}

/** Same tracked state (a missing mode equals a missing one; key order does not matter). */
export function sameModes(
  a: Record<string, boolean> | undefined,
  b: Record<string, boolean> | undefined
): boolean {
  const left = Object.entries(a ?? {});
  if (left.length !== Object.keys(b ?? {}).length) return false;
  return left.every(([mode, enabled]) => b?.[mode] === enabled);
}

/** Escape sequence that restores `modes` on a fresh terminal. */
export function decModesToSequence(modes: Record<string, boolean> | undefined): string {
  if (!modes) return '';
  // Only tracked modes: session.json is a file, and anything else in it is not ours to send.
  return Object.entries(modes)
    .filter(([mode, enabled]) => TRACKED_MODES.has(Number(mode)) && typeof enabled === 'boolean')
    .map(([mode, enabled]) => `\x1b[?${mode}${enabled ? 'h' : 'l'}`)
    .join('');
}
