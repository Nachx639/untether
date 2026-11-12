/**
 * Claude Code's permission mode, read from its screen. Its own module (2026-10-04) so the session
 * list's agent cards can use it without pulling the whole chat view into the first bundle.
 */
import { parseScreenChoices } from '../../shared/claude-screen.js';

/**
 * Whether pressing Shift+Tab now could answer something instead of changing the mode: no
 * mode line on the live screen, or a numbered permission dialog showing (Claude can keep the
 * mode line visible under it; Shift+Tab there means "allow all edits this session").
 */
export function modeSwitchBlocked(screen: string): boolean {
  return !parseClaudeMode(screen) || parseScreenChoices(screen) !== null;
}

/** Mode names Claude Code shows, lower-case, as they appear before " on". */
const KNOWN_MODE_NAMES = [
  'bypass permissions',
  'accept edits',
  'plan mode',
  'auto mode',
  'manual mode',
];

/**
 * A known mode on a line, anywhere on it, its spaces possibly overdrawn by a rule's "─".
 * Claude Code redraws its footer with cursor jumps and no erase-line: on a terminal whose size
 * differs from the PTY's, rows come out torn. Seen in a replay of the user's session: a stray
 * letter before the glyph ("s ⏵⏵ bypass permissions on …") and the separator rule painted
 * through it ("──⏵⏵─bypass─permissions─on …"). Only known names count this loosely, so a
 * background task row over the old mode line ("◯⏵file-browser-search on (shi▱▱") is never
 * read as a mode: it flipped the chip to a workflow name and back every second
 * (user report, 2026-10-14).
 */
const KNOWN_MODE_LINE = new RegExp(
  `(?:⏵⏵|⏵|⏸)[\\s─]+(${KNOWN_MODE_NAMES.map((n) => n.replace(' ', '[\\s─]')).join('|')})[\\s─]+on\\b`,
  'i'
);

/**
 * Any other name counts only on a whole mode line: the glyph near the left edge, whitespace,
 * the name, " on (shift+tab to cycle)" (a mode Claude Code adds later still shows).
 */
const OTHER_MODE_LINE = /^\s{0,4}(?:⏵⏵|⏵|⏸)\s+([a-z][a-z -]*?) on \(shift\+tab to cycle\)/i;

/** A mode glyph or the mode line's hint: something of the mode line is on screen, torn or not. */
const MODE_LINE_TRACE = /[⏵⏸]|shift\+tab to cycle/;

/**
 * Whether a name is one parseClaudeMode returns for a mode Claude Code ships ("Default mode"
 * included). A tab's remembered mode from before the stricter reading could be a workflow
 * name (user report, 2026-10-14): only these are shown before the screen confirms them.
 */
export function isKnownClaudeMode(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'default mode' || KNOWN_MODE_NAMES.includes(lower);
}

/** Claude Code's permission mode, read from its status line at the bottom of the screen. */
export function parseClaudeMode(screenText: string): string | null {
  const mode = readClaudeMode(screenText);
  return mode === undefined ? null : mode;
}

/**
 * parseClaudeMode, telling "no mode line" (null) from "a mode line is there but torn past
 * reading" (undefined): the chat's chip keeps its value on the latter.
 */
export function readClaudeMode(screenText: string): string | null | undefined {
  // e.g. "⏵⏵ bypass permissions on", "⏸ plan mode on", "⏸ manual mode on"; the bottom-most.
  const lines = screenText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(KNOWN_MODE_LINE) ?? lines[i].match(OTHER_MODE_LINE);
    if (!match) continue;
    const name = match[1].replace(/[\s─]+/g, ' ').trim();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  if (screenText.includes('? for shortcuts')) return 'Default mode';
  if (MODE_LINE_TRACE.test(screenText)) return undefined;
  // Claude Code keeps its footer on the bottom rows: a blank bottom is a screen caught
  // mid-redraw (a resize clears it before Claude paints again), not one without a mode.
  const bottom = lines.slice(-3);
  return bottom.length === 3 && bottom.every((line) => !line.trim()) ? undefined : null;
}

/**
 * Smooths the mode read from successive polls: a new value (or none) replaces the shown one
 * only after two reads in a row agree, so one torn redraw or a resize that blanks the footer
 * for a poll never flips or hides the chip (user report, 2026-10-14). The first value shown
 * is taken at once, so the chip still turns up on the first good read.
 */
export class ModeDebouncer {
  private shown: string | null = null;
  private pending: string | null | undefined = undefined;

  constructor(initial: string | null = null) {
    this.shown = initial;
  }

  get value(): string | null {
    return this.shown;
  }

  /**
   * Feeds one read; returns the mode to show. undefined (readClaudeMode: a mode line torn past
   * reading) says nothing either way: the shown mode stays and a pending change still waits.
   */
  read(mode: string | null | undefined): string | null {
    if (mode === undefined) return this.shown;
    if (mode === this.shown) {
      this.pending = undefined;
    } else if (this.shown === null) {
      this.shown = mode;
      this.pending = undefined;
    } else if (this.pending === mode) {
      this.shown = mode;
      this.pending = undefined;
    } else {
      this.pending = mode;
    }
    return this.shown;
  }

  /** A value known for sure (the mode picker saw it land): show it now. */
  set(mode: string | null): void {
    this.shown = mode;
    this.pending = undefined;
  }
}
