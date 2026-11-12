/**
 * Selecting text right in the terminal on phones. The terminal is a <canvas>, so iOS has no
 * selection of its own there: a long press selects the word under the finger (ghostty-web
 * paints the highlight), two handles drawn over the canvas move its ends, dragging one to the
 * top or bottom edge scrolls the history, and a small menu copies it. A tap elsewhere ends it.
 * Copy mode (the sheet with the text as a native <pre>) stays in the session menu.
 *
 * Where the app scrolls (mouse reporting: tmux, Claude Code), the terminal's own history is
 * not the text: the app redraws the screen. There the selection follows the text by matching
 * each new screen against the last one (screenShift), and keeps the rows that scroll off, so a
 * drag past the edge (which scrolls the app) can select more than one screen (2026-10-10: it
 * selected blank local history, and a scroll left the highlight on other text).
 */

import type { Terminal as GhosttyTerminal } from 'ghostty-web';
import { t } from '../i18n/index.js';
import { copyToClipboard } from '../utils/path-utils.js';

/** A cell; `row` counts from the oldest history row (scrollback first, then the screen). */
export type SelectionPoint = { col: number; row: number };

export interface TouchSelectionHost {
  terminal(): GhosttyTerminal | null;
  /** Where the handles and the menu go: positioned, around the canvas, not clipping it. */
  overlayRoot(): HTMLElement | null;
  canvas(): HTMLCanvasElement | null;
  /** Scrolls the view (or the app, where it scrolls) by rows; positive goes back in time. */
  scrollRows(rows: number): void;
  /** The app scrolls its own screen (mouse reporting): the selection follows the screen. */
  appScrolls(): boolean;
  /** Pastes the clipboard into the session, as the quick keys' Paste does. */
  paste(): void;
}

/** A row of the buffer as the selection reads it: one entry per column ('' for a wide tail). */
export type SelectionRow = { cells: string[]; isWrapped: boolean };

/** Rows from the edge where a dragged handle scrolls the view, and how fast. */
const AUTO_SCROLL_EDGE_ROWS = 1;
const AUTO_SCROLL_MS = 60;
/** Where the app scrolls, each step is a wheel step it may answer with several rows. */
const APP_AUTO_SCROLL_MS = 180;
/** How long "Copied" shows before the selection goes. */
const COPIED_MS = 900;

/** Characters that end a word for a long press: blanks, quotes, brackets and box drawing. */
const WORD_BREAK = /[\s"'`()[\]{}<>│┃|─━╭╮╰╯┌┐└┘,;]/;

/** The word around `col` (paths and URLs stay whole); a blank cell selects just itself. */
export function wordRange(cells: string[], col: number): { start: number; end: number } {
  // A wide character's tail belongs to the character before it.
  const chars = cells.map((cell, i) => cell || cells[i - 1] || ' ');
  if (col >= chars.length || WORD_BREAK.test(chars[col] ?? ' ')) return { start: col, end: col };
  let start = col;
  while (start > 0 && !WORD_BREAK.test(chars[start - 1])) start--;
  let end = col;
  while (end < chars.length - 1 && !WORD_BREAK.test(chars[end + 1])) end++;
  // A sentence's full stop or colon is not part of the word.
  while (end > start && /[.:!?]/.test(chars[end])) end--;
  return { start, end };
}

/**
 * How many rows the text moved up from `prev` to `next` (negative: down), by the shift under
 * which most rows with text match; 0 when none matches at least two (a new screen). Rows that
 * repeat (rules, blank-ish lines) say nothing about where the text went and are left out.
 */
export function screenShift(prev: string[], next: string[]): number {
  const rows = Math.min(prev.length, next.length);
  const seen = new Map<string, number>();
  for (const line of prev) seen.set(line, (seen.get(line) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (let shift = -(rows - 1); shift <= rows - 1; shift++) {
    let count = 0;
    for (let i = 0; i < rows; i++) {
      const j = i + shift;
      if (j < 0 || j >= rows || !next[i].trim() || seen.get(next[i]) !== 1) continue;
      if (next[i] === prev[j]) count++;
    }
    // A tie keeps the smaller move: fixed rows (a prompt box) match without one.
    if (count > bestCount || (count === bestCount && Math.abs(shift) < Math.abs(best))) {
      best = shift;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? best : 0;
}

/** Orders two points: the earlier one first. */
export function orderPoints(
  a: SelectionPoint,
  b: SelectionPoint
): [SelectionPoint, SelectionPoint] {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

/**
 * The selected text from `rows` (indexed by row, from the first selected one): rows the
 * terminal soft-wrapped are joined back into the line that was printed, trailing blanks go.
 */
export function selectionText(
  rows: SelectionRow[],
  start: SelectionPoint,
  end: SelectionPoint
): string {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = start.row + i;
    if (row > end.row) break;
    const chars = rows[i].cells;
    const from = row === start.row ? start.col : 0;
    const to = row === end.row ? end.col + 1 : chars.length;
    const piece = chars.slice(from, to).join('');
    if (i > 0 && rows[i].isWrapped) lines[lines.length - 1] += piece;
    else lines.push(piece);
  }
  return lines.map((line) => line.trimEnd()).join('\n');
}

type GhosttySelection = {
  selectionStart: { col: number; absoluteRow: number } | null;
  selectionEnd: { col: number; absoluteRow: number } | null;
  markCurrentSelectionDirty(): void;
  selectionChangedEmitter: { fire(): void };
};

type Drag = {
  /** The end that stays put while the other one moves. */
  fixed: SelectionPoint;
  /** Which edge of its cell the moving end follows: a start handle sits left of its cell. */
  edge: 'start' | 'end';
  /** From the finger to the point of the handle it moves (the knob sits off the text). */
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  pointerId: number | null;
};

export class TouchSelection {
  /** Rows: buffer rows, or where the app scrolls, rows of the text seen (screen mode). */
  private start: SelectionPoint | null = null;
  private end: SelectionPoint | null = null;
  private cols = 0;
  private drag: Drag | null = null;
  private autoScroll: ReturnType<typeof setInterval> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private status: 'idle' | 'copied' | 'failed' = 'idle';
  private startHandle: HTMLElement | null = null;
  private endHandle: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  private copyButton: HTMLButtonElement | null = null;
  /**
   * A long press on a blank cell (the prompt's empty input, as on iOS in an empty field): no
   * highlight and no handles, a menu with Paste. Dragging from it turns it into a selection.
   */
  private caretOnly = false;
  /** Screen mode: the text seen, by row; the row at the top of the screen; the last screen. */
  private screenMode = false;
  private seen = new Map<number, string[]>();
  private screenTop = 0;
  private lastScreen: string[] = [];

  constructor(private readonly host: TouchSelectionHost) {}

  get active(): boolean {
    return this.start !== null;
  }

  /** A long press: selects the word under the finger, which may go on to drag its end. */
  beginAt(clientX: number, clientY: number): boolean {
    this.screenMode = this.host.appScrolls();
    this.seen.clear();
    this.screenTop = 0;
    this.lastScreen = [];
    if (this.screenMode) this.syncScreen();
    const cell = this.cellAt(clientX, clientY, 'start');
    if (!cell) return false;
    const range = wordRange(this.selectionCells(cell.row), cell.col);
    this.caretOnly = !(this.selectionCells(cell.row)[cell.col] ?? '').trim();
    this.cols = this.host.terminal()?.cols ?? 0;
    this.setRange({ col: range.start, row: cell.row }, { col: range.end, row: cell.row });
    this.drag = {
      fixed: { col: range.start, row: cell.row },
      edge: 'end',
      offsetX: 0,
      offsetY: 0,
      x: clientX,
      y: clientY,
      pointerId: null,
    };
    this.status = 'idle';
    this.layout();
    return true;
  }

  /** The finger that made the selection moves on: its end follows (iOS does the same). */
  extendTo(clientX: number, clientY: number) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== null) return;
    // Within the word it started on, the selection stays that word.
    const cell = this.cellAt(clientX, clientY, 'end');
    if (cell && this.start && this.end && cell.row === this.start.row) {
      if (cell.col >= this.start.col && cell.col <= this.end.col) return;
    }
    drag.x = clientX;
    drag.y = clientY;
    this.caretOnly = false;
    this.dragTo();
  }

  /** The long press's finger lifted: the handles and the menu come up. */
  release() {
    if (this.drag?.pointerId === null) this.endDrag();
  }

  clear() {
    if (!this.start) return;
    this.endDrag();
    this.start = null;
    this.end = null;
    this.caretOnly = false;
    this.seen.clear();
    this.lastScreen = [];
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = null;
    const selection = this.ghosttySelection();
    if (selection) {
      selection.markCurrentSelectionDirty();
      selection.selectionStart = null;
      selection.selectionEnd = null;
      selection.selectionChangedEmitter.fire();
    }
    this.layout();
  }

  dispose() {
    this.clear();
    for (const el of [this.startHandle, this.endHandle, this.menu]) el?.remove();
    this.startHandle = null;
    this.endHandle = null;
    this.menu = null;
    this.copyButton = null;
  }

  /** The selection's text, printed lines whole. */
  getText(): string {
    const term = this.host.terminal();
    if (!term || !this.start || !this.end) return '';
    const [start, end] = orderPoints(this.start, this.end);
    const rows: SelectionRow[] = [];
    for (let row = start.row; row <= end.row; row++) {
      if (this.screenMode) {
        rows.push({ cells: this.seen.get(row) ?? [], isWrapped: false });
        continue;
      }
      const line = term.buffer.active.getLine(row);
      rows.push({ cells: line ? lineCells(line) : [], isWrapped: line?.isWrapped ?? false });
    }
    return selectionText(rows, start, end);
  }

  /**
   * Puts the handles and the menu where the selection is now (after a scroll, a paint).
   * `changed`: the screen may hold new text (where the app scrolls, it is matched again).
   */
  layout(changed = false) {
    const term = this.host.terminal();
    const root = this.host.overlayRoot();
    const canvas = this.host.canvas();
    if (!this.start || !this.end || !term || !root || !canvas) {
      this.hide();
      return;
    }
    // ghostty dropped it (a click elsewhere on the page), or new columns reflowed the rows and
    // the cells selected are no longer the text that was.
    const painted = this.ghosttySelection();
    if ((painted && !painted.selectionStart && this.paintsSome()) || term.cols !== this.cols) {
      this.clear();
      return;
    }
    if (this.screenMode && changed && this.syncScreen()) this.paint();
    this.ensureElements(root);
    const [start, end] = orderPoints(this.start, this.end);
    const box = canvas.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    const cellW = box.width / term.cols;
    const cellH = box.height / term.rows;
    const startRow = this.viewRow(start.row);
    const endRow = this.viewRow(end.row);
    const x0 = box.left - rootBox.left;
    const y0 = box.top - rootBox.top;
    const visible = (row: number) => row >= 0 && row < term.rows;
    const dragging = this.drag !== null;

    placeHandle(
      this.startHandle,
      visible(startRow) && !this.caretOnly,
      x0 + start.col * cellW,
      y0 + startRow * cellH,
      cellH
    );
    placeHandle(
      this.endHandle,
      visible(endRow) && !this.caretOnly,
      x0 + (end.col + 1) * cellW,
      y0 + endRow * cellH,
      cellH
    );

    // The menu: above the selection, or below it, or at the top when it fills the screen.
    const menu = this.menu as HTMLElement;
    const first = Math.max(startRow, 0);
    const last = Math.min(endRow, term.rows - 1);
    if (dragging || first > last) {
      menu.style.display = 'none';
      return;
    }
    this.updateCopyLabel();
    if (this.copyButton) this.copyButton.style.display = this.caretOnly ? 'none' : '';
    menu.style.display = 'flex';
    const menuH = menu.offsetHeight || 40;
    const menuW = menu.offsetWidth || 200;
    const above = y0 + first * cellH - menuH - 14;
    const below = y0 + (last + 1) * cellH + 22;
    const y =
      above >= 4 ? above : below + menuH <= rootBox.height - 4 ? below : Math.max(4, y0 + 4);
    const middle =
      x0 + (startRow === endRow ? (start.col + end.col + 1) / 2 : term.cols / 2) * cellW;
    const x = Math.max(4, Math.min(rootBox.width - menuW - 4, middle - menuW / 2));
    menu.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private hide() {
    for (const el of [this.startHandle, this.endHandle, this.menu]) {
      if (el) el.style.display = 'none';
    }
  }

  private ghosttySelection(): GhosttySelection | null {
    const term = this.host.terminal() as unknown as { selectionManager?: GhosttySelection } | null;
    const selection = term?.selectionManager;
    return selection && typeof selection.markCurrentSelectionDirty === 'function'
      ? selection
      : null;
  }

  private setRange(a: SelectionPoint, b: SelectionPoint) {
    this.start = a;
    this.end = b;
    this.paint();
  }

  /** Where a selection row is on screen (may be above or below it). */
  private viewRow(row: number): number {
    return row - (this.screenMode ? this.screenTop : this.firstVisibleRow());
  }

  /** Some of the selection is on screen (in screen mode, ghostty paints only that part). */
  private paintsSome(): boolean {
    const term = this.host.terminal();
    if (!this.start || !this.end || !term) return false;
    if (!this.screenMode) return true;
    const [start, end] = orderPoints(this.start, this.end);
    return this.viewRow(end.row) >= 0 && this.viewRow(start.row) < term.rows;
  }

  /**
   * The selection as ghostty paints it, in its rows (scrollback first, then the screen). In
   * screen mode only the part on screen, cut at its edges.
   */
  private paint() {
    const selection = this.ghosttySelection();
    const term = this.host.terminal();
    if (!selection || !term || !this.start || !this.end) return;
    let [first, last] = orderPoints(this.start, this.end);
    selection.markCurrentSelectionDirty();
    if (this.screenMode) {
      const top = this.firstVisibleRow();
      const from = this.viewRow(first.row);
      const to = this.viewRow(last.row);
      if (to < 0 || from >= term.rows) {
        selection.selectionStart = null;
        selection.selectionEnd = null;
        selection.selectionChangedEmitter.fire();
        return;
      }
      first = from < 0 ? { col: 0, row: top } : { col: first.col, row: top + from };
      last =
        to >= term.rows
          ? { col: term.cols - 1, row: top + term.rows - 1 }
          : { col: last.col, row: top + to };
    }
    selection.selectionStart = { col: first.col, absoluteRow: first.row };
    selection.selectionEnd = { col: last.col, absoluteRow: last.row };
    selection.markCurrentSelectionDirty();
    selection.selectionChangedEmitter.fire();
  }

  /**
   * Screen mode: reads the screen, finds how far its text moved since the last read, and keeps
   * its rows. Returns whether the text moved.
   */
  private syncScreen(): boolean {
    const term = this.host.terminal();
    if (!term) return false;
    const top = this.firstVisibleRow();
    const cells: string[][] = [];
    for (let i = 0; i < term.rows; i++) cells.push(this.rowCells(top + i));
    const screen = cells.map((row) => row.join('').trimEnd());
    const shift = this.lastScreen.length ? screenShift(this.lastScreen, screen) : 0;
    this.screenTop += shift;
    this.lastScreen = screen;
    for (let i = 0; i < cells.length; i++) this.seen.set(this.screenTop + i, cells[i]);
    return shift !== 0;
  }

  /** The history row at the top of the screen. */
  private firstVisibleRow(): number {
    const term = this.host.terminal();
    if (!term) return 0;
    const history = Math.max(0, term.buffer.active.length - term.rows);
    return history - Math.max(0, Math.floor(term.getViewportY()));
  }

  /** The cell under a point; a start takes the nearest gap's right cell, an end its left one. */
  private cellAt(clientX: number, clientY: number, edge: 'start' | 'end'): SelectionPoint | null {
    const term = this.host.terminal();
    const canvas = this.host.canvas();
    if (!term || !canvas || term.cols <= 0 || term.rows <= 0) return null;
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const cellW = box.width / term.cols;
    const cellH = box.height / term.rows;
    const viewRow = Math.max(0, Math.min(term.rows - 1, Math.floor((clientY - box.top) / cellH)));
    const across = (clientX - box.left) / cellW;
    const col = edge === 'start' ? Math.round(across) : Math.round(across) - 1;
    return {
      col: Math.max(0, Math.min(term.cols - 1, col)),
      row: (this.screenMode ? this.screenTop : this.firstVisibleRow()) + viewRow,
    };
  }

  /** A selection row's cells: the buffer's, or in screen mode the text seen there. */
  private selectionCells(row: number): string[] {
    return this.screenMode ? (this.seen.get(row) ?? []) : this.rowCells(row);
  }

  private rowCells(row: number): string[] {
    const line = this.host.terminal()?.buffer.active.getLine(row);
    return line ? lineCells(line) : [];
  }

  /** The moving end goes to the cell under the drag; at the top or bottom edge, it scrolls. */
  private dragTo() {
    const drag = this.drag;
    const term = this.host.terminal();
    const canvas = this.host.canvas();
    if (!drag || !term || !canvas) return;
    const x = drag.x + drag.offsetX;
    const y = drag.y + drag.offsetY;
    const cell = this.cellAt(x, y, drag.edge);
    if (cell) this.setRange(drag.fixed, cell);
    const box = canvas.getBoundingClientRect();
    const edge = (box.height / term.rows) * AUTO_SCROLL_EDGE_ROWS;
    const direction = drag.y < box.top + edge ? 1 : drag.y > box.bottom - edge ? -1 : 0;
    if (direction === 0) this.stopAutoScroll();
    else if (!this.autoScroll) {
      this.autoScroll = setInterval(
        () => {
          const live = this.drag;
          if (!live) return this.stopAutoScroll();
          const liveBox = canvas.getBoundingClientRect();
          const liveEdge = (liveBox.height / term.rows) * AUTO_SCROLL_EDGE_ROWS;
          const dir =
            live.y < liveBox.top + liveEdge ? 1 : live.y > liveBox.bottom - liveEdge ? -1 : 0;
          if (dir === 0) return this.stopAutoScroll();
          this.host.scrollRows(dir);
          const moved = this.cellAt(live.x + live.offsetX, live.y + live.offsetY, live.edge);
          if (moved) this.setRange(live.fixed, moved);
          this.layout();
        },
        this.screenMode ? APP_AUTO_SCROLL_MS : AUTO_SCROLL_MS
      );
    }
    this.layout();
  }

  private stopAutoScroll() {
    if (this.autoScroll) clearInterval(this.autoScroll);
    this.autoScroll = null;
  }

  private endDrag() {
    this.stopAutoScroll();
    if (!this.drag) return;
    this.drag = null;
    this.layout();
  }

  private ensureElements(root: HTMLElement) {
    if (this.startHandle?.parentElement === root) return;
    for (const el of [this.startHandle, this.endHandle, this.menu]) el?.remove();
    this.startHandle = this.createHandle(root, 'start');
    this.endHandle = this.createHandle(root, 'end');
    this.menu = this.createMenu(root);
  }

  private createHandle(root: HTMLElement, which: 'start' | 'end'): HTMLElement {
    const handle = document.createElement('div');
    handle.className = `terminal-select-handle ${which}`;
    handle.dataset.testid = `terminal-select-handle-${which}`;
    handle.setAttribute('aria-hidden', 'true');
    const stem = document.createElement('span');
    stem.className = 'terminal-select-stem';
    const knob = document.createElement('span');
    knob.className = 'terminal-select-knob';
    handle.append(stem, knob);
    handle.addEventListener('pointerdown', (event) => this.grabHandle(event, which, handle));
    handle.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.dragTo();
    });
    const drop = (event: PointerEvent) => {
      if (this.drag?.pointerId !== event.pointerId) return;
      this.endDrag();
    };
    handle.addEventListener('pointerup', drop);
    handle.addEventListener('pointercancel', drop);
    swallowTouches(handle);
    root.appendChild(handle);
    return handle;
  }

  private grabHandle(event: PointerEvent, which: 'start' | 'end', handle: HTMLElement) {
    if (!this.start || !this.end) return;
    event.preventDefault();
    event.stopPropagation();
    const [start, end] = orderPoints(this.start, this.end);
    const stem = handle.querySelector('.terminal-select-stem')?.getBoundingClientRect();
    // The finger holds the knob; the end follows the stem's middle, on the text.
    const pointX = stem ? stem.left + stem.width / 2 : event.clientX;
    const pointY = stem ? stem.top + stem.height / 2 : event.clientY;
    this.drag = {
      fixed: which === 'start' ? end : start,
      edge: which,
      offsetX: pointX - event.clientX,
      offsetY: pointY - event.clientY,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
    };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Already released: the move events still come while the finger is on the handle.
    }
    this.layout();
  }

  private createMenu(root: HTMLElement): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'terminal-select-menu';
    menu.dataset.testid = 'terminal-select-menu';
    menu.setAttribute('role', 'toolbar');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.testid = 'terminal-select-copy';
    const paste = document.createElement('button');
    paste.type = 'button';
    paste.dataset.testid = 'terminal-select-paste';
    paste.textContent = t('terminalSelect.paste');
    const all = document.createElement('button');
    all.type = 'button';
    all.dataset.testid = 'terminal-select-all';
    all.textContent = t('terminalSelect.selectAll');
    onTapOrClick(copy, () => void this.copy());
    // Synchronously inside the tap: iOS reads the clipboard only within the user's gesture.
    onTapOrClick(paste, () => {
      this.host.paste();
      this.clear();
    });
    onTapOrClick(all, () => {
      this.caretOnly = false;
      this.selectAll();
    });
    menu.append(copy, paste, all);
    swallowTouches(menu);
    root.appendChild(menu);
    this.copyButton = copy;
    this.updateCopyLabel();
    return menu;
  }

  private updateCopyLabel() {
    if (!this.copyButton) return;
    this.copyButton.textContent =
      this.status === 'copied'
        ? t('terminalSelect.copied')
        : this.status === 'failed'
          ? t('copyMode.copyFailed')
          : t('terminalSelect.copy');
  }

  private async copy() {
    const text = this.getText();
    if (!text) return;
    const ok = await copyToClipboard(text);
    this.status = ok ? 'copied' : 'failed';
    this.updateCopyLabel();
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => {
      this.copiedTimer = null;
      this.status = 'idle';
      if (ok) this.clear();
      else this.updateCopyLabel();
    }, COPIED_MS);
  }

  /** All of it: the history and the screen, down to the last row with text. */
  private selectAll() {
    const term = this.host.terminal();
    if (!term) return;
    if (this.screenMode) {
      // Where the app scrolls: all the text seen while selecting.
      const rows = [...this.seen.keys()].filter((row) => this.seen.get(row)?.join('').trim());
      if (!rows.length) return;
      const lastRow = Math.max(...rows);
      const lastCells = this.seen.get(lastRow) ?? [];
      let col = lastCells.length - 1;
      while (col > 0 && !lastCells[col].trim()) col--;
      this.status = 'idle';
      this.setRange({ col: 0, row: Math.min(...rows) }, { col: Math.max(0, col), row: lastRow });
      this.layout();
      return;
    }
    const buffer = term.buffer.active;
    let last = buffer.length - 1;
    while (last > 0 && !this.rowCells(last).join('').trim()) last--;
    const cells = this.rowCells(last);
    let lastCol = cells.length - 1;
    while (lastCol > 0 && !cells[lastCol].trim()) lastCol--;
    this.status = 'idle';
    this.setRange({ col: 0, row: 0 }, { col: Math.max(0, lastCol), row: last });
    this.layout();
  }
}

/** A row's cells: empty ones as spaces, a wide character's second cell as ''. */
function lineCells(line: {
  length: number;
  getCell(col: number): { getChars(): string; getWidth(): number } | undefined;
}): string[] {
  const cells: string[] = [];
  for (let col = 0; col < line.length; col++) {
    const cell = line.getCell(col);
    cells.push(!cell ? ' ' : cell.getWidth() === 0 ? '' : cell.getChars() || ' ');
  }
  return cells;
}

function placeHandle(
  handle: HTMLElement | null,
  visible: boolean,
  x: number,
  y: number,
  height: number
) {
  if (!handle) return;
  if (!visible) {
    handle.style.display = 'none';
    return;
  }
  handle.style.display = 'block';
  handle.style.height = `${Math.round(height)}px`;
  handle.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** Touches on the handles and the menu are theirs: no page scroll, no tap on the terminal. */
function swallowTouches(el: HTMLElement) {
  const stop = (event: Event) => {
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
  };
  el.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
  el.addEventListener('touchmove', stop, { passive: false });
  el.addEventListener('touchend', stop, { passive: false });
  el.addEventListener('click', (event) => event.stopPropagation());
  el.addEventListener('mousedown', (event) => event.stopPropagation());
}

/**
 * Touch acts on pointerup (its click is cancelled by swallowTouches' touchend), mouse and
 * keyboard on click. The clipboard write stays inside the user's gesture either way.
 */
function onTapOrClick(button: HTMLButtonElement, act: () => void) {
  let down: { x: number; y: number } | null = null;
  button.addEventListener('pointerdown', (event) => {
    down = { x: event.clientX, y: event.clientY };
  });
  button.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;
    const moved = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10;
    down = null;
    if (!moved) act();
  });
  button.addEventListener('click', (event) => {
    if ((event as PointerEvent).pointerType && (event as PointerEvent).pointerType !== 'mouse') {
      return;
    }
    act();
  });
}

export const TOUCH_SELECT_STYLES = `
  .terminal-select-handle {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    z-index: 25;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .terminal-select-stem {
    position: absolute;
    left: -1px;
    top: 0;
    width: 2px;
    height: 100%;
    background: var(--ut-selection-handle);
    pointer-events: none;
  }
  .terminal-select-knob {
    position: absolute;
    left: -6px;
    width: 12px;
    height: 12px;
    border-radius: var(--ut-r-circle);
    background: var(--ut-selection-handle);
    pointer-events: none;
  }
  .terminal-select-handle.start .terminal-select-knob { top: -11px; }
  .terminal-select-handle.end .terminal-select-knob { bottom: -11px; }
  /* A finger-sized grip around the knob. */
  .terminal-select-handle::before {
    content: '';
    position: absolute;
    left: -22px;
    width: 44px;
    height: 44px;
  }
  .terminal-select-handle.start::before { top: -36px; }
  .terminal-select-handle.end::before { bottom: -36px; }
  .terminal-select-menu {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 26;
    display: flex;
    overflow: hidden;
    gap: 1px;
    border-radius: var(--ut-r-lg);
    /* Shows through the 1px gaps as the dividers: a hidden button leaves none behind. */
    background: var(--ut-bubble-frost);
    box-shadow: var(--ut-drop-16-35);
    -webkit-user-select: none;
    user-select: none;
  }
  .terminal-select-menu button {
    min-height: 40px;
    padding: 0 14px;
    border: 0;
    background: var(--ut-bubble-bg);
    color: var(--ut-text-on-solid);
    font: 500 15px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    white-space: nowrap;
    touch-action: manipulation;
  }
`;
