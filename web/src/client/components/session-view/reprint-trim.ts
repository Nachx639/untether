/**
 * Dropping the part of an app's repaint after a resize that would only scroll into the history.
 *
 * User report (2026-10-14): after every change of size Claude Code homes the cursor, clears
 * every row of its screen and prints its whole region again with plain line feeds. When that
 * region has more lines than the terminal showing it has rows (a page that shows another
 * device's taller screen, a smaller grid in a replay), the first lines scroll into the history,
 * where the same lines already are: each change of size left a copy of Claude's last answer.
 * Those first lines are dropped before they are written, so the screen ends up the same and
 * nothing is copied into the history.
 *
 * Only for output that starts, right after a resize, with that pattern: `ESC[H`, the rows
 * cleared one by one (`ESC[2K ESC[1B`), `ESC[H` again. The repaint is held until it ends (the
 * cursor shown again, `ESC[?25h`, or a synchronized update closed, `ESC[?2026l`), or until the
 * caller flushes it. It is trimmed only when it is plain lines: no cursor moves between rows
 * and no line wider than the grid (whose wrapping would change the count) before its last line
 * feed. Anything else is written unchanged.
 */

const CLEAR_START =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences are what it matches
  /^(?:\x1b\[\?25l|\x1b\[\?2026h|\x1b\[\d*[ABCDG]|\r)*\x1b\[H((?:\x1b\[2K\x1b\[1B)+)(?:\x1b\[2K)?\x1b\[H/;
/** Most held while waiting for the repaint's end: more is written unchanged. */
const MAX_HELD_CHARS = 1024 * 1024;

export interface GridSize {
  cols: number;
  rows: number;
}

export class ReprintTrimmer {
  private armedRows = 0;
  private held: string | null = null;
  /** Where the repaint's lines start in `held`. */
  private reprintAt = 0;

  /** `grid()`: the size of the grid the repaint will be written into. */
  constructor(private readonly grid: () => GridSize | null) {}

  /** The PTY was just resized to `rows`: its next output may be such a repaint. */
  arm(rows: number): void {
    this.armedRows = rows;
  }

  /** Whether a repaint is held, waiting for its end (the caller flushes it after a while). */
  isHolding(): boolean {
    return this.held !== null;
  }

  /** Output from the stream: what to write now (possibly nothing while a repaint is held). */
  push(chunk: string): string {
    if (this.held !== null) {
      this.held += chunk;
      return this.release(false);
    }
    const rows = this.armedRows;
    if (!rows) return chunk;
    this.armedRows = 0;
    const match = CLEAR_START.exec(chunk);
    // Claude clears as many rows as the PTY has, less one or so: a clear of fewer is something
    // else (a smaller redraw), written as it is.
    if (!match || match[1].length / 8 < rows - 2) return chunk;
    this.held = chunk;
    this.reprintAt = match[0].length;
    return this.release(false);
  }

  /** Everything held, trimmed if it can be (a new resize, the end of a replay, a timeout). */
  flush(): string {
    if (this.held === null) return '';
    return this.release(true);
  }

  private release(force: boolean): string {
    const held = this.held ?? '';
    const ends = [
      held.indexOf('\x1b[?25h', this.reprintAt),
      held.indexOf('\x1b[?2026l', this.reprintAt),
    ]
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (ends.length === 0 && !force) {
      if (held.length <= MAX_HELD_CHARS) return '';
      this.held = null;
      return held;
    }
    this.held = null;
    const end = ends.length > 0 ? ends[0] : held.length;
    const grid = this.grid();
    const repaint = held.slice(0, end);
    const rest = held.slice(end);
    if (!grid) return held;
    return trimRepaint(repaint, this.reprintAt, grid) + rest;
  }
}

/**
 * `repaint` with its lines from `start` on: the ones that would scroll off a grid of `grid`
 * rows dropped, their colors and links kept. Unchanged when that cannot be told for sure.
 */
export function trimRepaint(repaint: string, start: number, grid: GridSize): string {
  const lines = repaint.slice(start);
  const scan = scanLines(lines, grid.cols);
  if (!scan) return repaint;
  const drop = scan.feeds.length - (grid.rows - 1);
  if (drop <= 0) return repaint;
  const cut = scan.feeds[drop - 1] + 1;
  return repaint.slice(0, start) + keptSequences(lines.slice(0, cut)) + lines.slice(cut);
}

/**
 * Where the line feeds of `text` are, if it is plain lines for a grid `cols` wide: null when a
 * cursor move between rows, or a line wider than the grid, comes before its last line feed.
 */
function scanLines(text: string, cols: number): { feeds: number[] } | null {
  const feeds: number[] = [];
  let col = 0;
  let risky = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 0x1b) {
      const seq = escapeAt(text, i);
      if (!seq) {
        risky = i;
        break;
      }
      const effect = escapeEffect(seq, col);
      if (effect === null) {
        if (risky < 0) risky = i;
      } else col = effect;
      i += seq.length;
      continue;
    }
    if (ch === 0x0a) {
      feeds.push(i);
    } else if (ch === 0x0d) {
      col = 0;
    } else if (ch === 0x08) {
      col = Math.max(0, col - 1);
    } else if (ch === 0x09) {
      col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
    } else if (ch >= 0x20) {
      const code = text.codePointAt(i) ?? ch;
      const width = cellWidth(code);
      if (col + width > cols && risky < 0) risky = i;
      col += width;
      if (code > 0xffff) i++;
    }
    i++;
  }
  if (feeds.length === 0) return null;
  if (risky >= 0 && risky < feeds[feeds.length - 1]) return null;
  return { feeds };
}

/** The escape sequence starting at `i` (ESC included), or null if it is cut short. */
function escapeAt(text: string, i: number): string | null {
  const kind = text[i + 1];
  if (kind === undefined) return null;
  if (kind === '[') {
    for (let j = i + 2; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return text.slice(i, j + 1);
    }
    return null;
  }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
    for (let j = i + 2; j < text.length; j++) {
      if (text[j] === '\x07') return text.slice(i, j + 1);
      if (text[j] === '\x1b' && text[j + 1] === '\\') return text.slice(i, j + 2);
    }
    return null;
  }
  const code = kind.charCodeAt(0);
  if (code >= 0x20 && code <= 0x2f) {
    for (let j = i + 2; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c >= 0x30 && c <= 0x7e) return text.slice(i, j + 1);
    }
    return null;
  }
  return text.slice(i, i + 2);
}

/** The column after `seq` from `col`; null when it moves between rows or is not known. */
function escapeEffect(seq: string, col: number): number | null {
  if (seq[1] === ']' || seq[1] === 'P' || seq[1] === '_' || seq[1] === '^' || seq[1] === 'X') {
    return col;
  }
  if (seq[1] !== '[') {
    const code = seq.charCodeAt(1);
    // Charsets and the like (ESC ( B), keypad modes: nothing moves.
    if ((code >= 0x20 && code <= 0x2f) || seq[1] === '=' || seq[1] === '>') return col;
    return null;
  }
  const final = seq[seq.length - 1];
  const params = seq.slice(2, -1);
  const n = Math.max(1, Number.parseInt(params, 10) || 1);
  switch (final) {
    case 'G':
    case '`':
      return n - 1;
    case 'C':
    case 'a':
      return col + n;
    case 'D':
      return Math.max(0, col - n);
    case 'm':
    case 'K':
    case 'X':
    case 'h':
    case 'l':
    case 'q':
    case 'n':
    case 't':
      return col;
    default:
      return null;
  }
}

/** The colors, attributes and links set in dropped lines: what the kept ones may rely on. */
function keptSequences(text: string): string {
  let out = '';
  for (let i = text.indexOf('\x1b'); i !== -1; i = text.indexOf('\x1b', i + 1)) {
    const seq = escapeAt(text, i);
    if (!seq) break;
    if ((seq[1] === '[' && seq.endsWith('m')) || seq[1] === ']') out += seq;
    i += seq.length - 1;
  }
  return out;
}

/** Cells a code point takes: 2 for wide East Asian letters and emoji, 0 for combining marks. */
export function cellWidth(code: number): number {
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0xfe00 && code <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}
