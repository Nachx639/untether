/**
 * Tap-to-place-the-caret for Claude Code's classic prompt (user report, 2026-10-14: in terminal
 * mode on the phone, tapping an earlier word of the text being typed did not move the caret).
 *
 * Claude Code sometimes runs with its classic renderer (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, or a
 * user who turned fullscreen off), and that renderer never turns on mouse reporting: a tap cannot
 * reach it as a click. With the fullscreen renderer (Untether's own sessions and, since 2026-10-14,
 * Mac-window sessions) Claude asks for the mouse and a tap reaches its prompt directly. What it does do is leave the terminal cursor on its caret after every
 * frame and move the caret by visual row on Up/Down (keeping the column) and by character on
 * Left/Right. So a tap on the prompt becomes arrow keys: rows first, then, once the cursor shows
 * which row it reached, characters along that row.
 *
 * The prompt is recognised by its frame: a row of ─ above and below, the first row inside starting
 * with "❯ " (also "> " and "! " for bash mode) and the rest indented by two. Anything else (menus,
 * dialogs, a shell) is left alone. Pure and DOM-free: rows come in as cells.
 */

/**
 * A screen row as cells: a character per cell, ' ' for an empty cell (dim placeholder or
 * suggestion text counts as empty: it is not part of the input), '' for a wide character's
 * second half.
 */
export type PromptRowCells = string[];

export interface CellPoint {
  /** Absolute buffer row. */
  row: number;
  /** Cell column; for a tap, the gap before this cell (round the tap to the nearest gap). */
  col: number;
}

export interface PromptCaretPlan {
  /** First and last input rows (inside the rules), absolute. */
  first: number;
  last: number;
  /** Where the caret goes. */
  target: CellPoint;
  /** Rows to move: negative is Up, positive Down. */
  rows: number;
}

/** Where the text of every input row starts: after "❯ " on the first one, the indent on the rest. */
export const PROMPT_TEXT_COL = 2;
/** The input box can grow; rows searched each way from the cursor for its rules. */
const MAX_PROMPT_ROWS = 12;
const PROMPT_MARKERS = new Set(['❯', '>', '!']);
const BLANKS = new Set([' ', ' ', '']);

function isRule(cells: PromptRowCells | null): boolean {
  if (!cells) return false;
  const text = cells.join('').trim();
  return text.length >= 8 && /^─+$/.test(text);
}

const isBlank = (cell: string | undefined) => cell === undefined || BLANKS.has(cell);

/** Just past the row's last character, never before the text start. */
function rowEnd(cells: PromptRowCells): number {
  for (let col = cells.length - 1; col >= PROMPT_TEXT_COL; col--) {
    if (!isBlank(cells[col])) return col + 1;
  }
  return PROMPT_TEXT_COL;
}

/** The input rows of the Claude prompt holding the cursor, or null when it is not in one. */
export function findPromptRows(
  readRow: (row: number) => PromptRowCells | null,
  cursor: CellPoint
): { first: number; last: number } | null {
  if (isRule(readRow(cursor.row))) return null;
  let top = -1;
  for (let row = cursor.row - 1; row >= cursor.row - MAX_PROMPT_ROWS && row >= 0; row--) {
    if (isRule(readRow(row))) {
      top = row;
      break;
    }
  }
  let bottom = -1;
  for (let row = cursor.row + 1; row <= cursor.row + MAX_PROMPT_ROWS; row++) {
    const cells = readRow(row);
    if (!cells) break;
    if (isRule(cells)) {
      bottom = row;
      break;
    }
  }
  if (top < 0 || bottom < 0) return null;
  const first = top + 1;
  const last = bottom - 1;
  // The prompt's own shape, so a menu under a rule ("  ❯ Yes") is not taken for it.
  for (let row = first; row <= last; row++) {
    const cells = readRow(row);
    if (!cells) return null;
    const lead = row === first ? PROMPT_MARKERS.has(cells[0] ?? '') : isBlank(cells[0]);
    if (!lead || !isBlank(cells[1])) return null;
  }
  return { first, last };
}

/**
 * The arrow moves that take the caret from the cursor to the tap, or null when the cursor is not
 * in a Claude prompt or the tap is outside its input rows.
 */
export function planPromptCaret(
  readRow: (row: number) => PromptRowCells | null,
  cursor: CellPoint,
  tap: CellPoint
): PromptCaretPlan | null {
  const prompt = findPromptRows(readRow, cursor);
  if (!prompt || tap.row < prompt.first || tap.row > prompt.last) return null;
  const cells = readRow(tap.row) ?? [];
  let col = Math.max(PROMPT_TEXT_COL, Math.min(rowEnd(cells), tap.col));
  // Not between the two halves of a wide character: before it.
  while (col > PROMPT_TEXT_COL && cells[col] === '') col--;
  return { ...prompt, target: { row: tap.row, col }, rows: tap.row - cursor.row };
}

/**
 * Left (negative) or Right (positive) presses from `from` to `to` on one row: one per character,
 * so a wide character's second cell is not counted.
 */
export function promptCharacterSteps(cells: PromptRowCells, from: number, to: number): number {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  let steps = 0;
  for (let col = start; col < end; col++) if (cells[col] !== '') steps++;
  return to >= from ? steps : -steps;
}

/** Arrow keys as the app wants them: SS3 with application cursor keys (DECCKM), CSI otherwise. */
export function arrowKeys(
  direction: 'up' | 'down' | 'left' | 'right',
  count: number,
  ss3: boolean
) {
  if (count <= 0) return '';
  const final = { up: 'A', down: 'B', right: 'C', left: 'D' }[direction];
  return `${ss3 ? '\x1bO' : '\x1b['}${final}`.repeat(count);
}
