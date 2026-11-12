/**
 * Copying from the web terminal with a mouse (desktop browsers).
 *
 * 2026-10-31, user report on Chrome and Safari on the Mac: "no me copia bien las cosas de la
 * terminal con cmd c": select in the terminal, Cmd+C, and the paste was a lone "-". Reproduced
 * in Chromium and WebKit (src/test/terminal-copy.browser.ts); every cause is fixed here:
 *
 * - ghostty-web 0.4 auto-scrolls while a drag is in the top or bottom 30 px of the canvas (two
 *   rows), and its auto-scroll moves the selection's end to the first or last row. Without
 *   history (Claude Code's full screen) nothing scrolls, so a drag that touched those rows,
 *   where Claude's prompt and status lines are, ended with one or two cells selected, the "-".
 *   Here the history scrolls only when the pointer leaves the canvas, and only if there is one.
 * - Cmd+C copied nothing itself (the copy came from ghostty's copy-on-release): the browser's
 *   copy now gets the terminal's selection (installCopyHandler).
 * - The text: rows the terminal soft-wrapped are joined back into the printed line (ghostty
 *   put a newline at every row), wide characters (CJK, emoji) lost their trailing blank cell,
 *   graphemes stay whole, padding at the end of rows goes, Claude Code's frames and prompt rules
 *   are left out, and Option+drag selects a block of columns.
 * - Apps that track the mouse (Claude Code's full screen, vim, tmux with mouse on) get plain
 *   drags as mouse reports, so they select and copy themselves (OSC 52, see Osc52Scanner);
 *   Shift+drag and Option+drag select locally, as in native terminals.
 * - The IME input (ime-input.ts) sat over the cursor's row and took the mouse events there.
 */

import type { Terminal as GhosttyTerminal } from 'ghostty-web';

/** A cell of ghostty's selection; `absoluteRow` counts from the oldest history row. */
export type CellPos = { col: number; absoluteRow: number };

/** One row as the copy reads it: one entry per column ('' for a wide character's tail). */
export type CopyRow = { cells: string[]; continues: boolean };

type WasmCell = { codepoint: number; width: number; grapheme_len: number };

/** The parts of ghostty-web 0.4's WASM terminal the copy reads (private there). */
export interface CopyWasm {
  getScrollbackLength(): number;
  getScrollbackLine(row: number): WasmCell[] | null;
  getLine(row: number): WasmCell[] | null;
  isRowWrapped(row: number): boolean;
  getGraphemeString(row: number, col: number): string;
  getScrollbackGraphemeString(row: number, col: number): string;
  isAlternateScreen(): boolean;
}

/** The parts of ghostty-web 0.4's SelectionManager this module reaches (private there). */
interface GhosttySelectionManager {
  selectionStart: CellPos | null;
  selectionEnd: CellPos | null;
  isSelecting: boolean;
  wasmTerm: CopyWasm;
  getSelection(): string;
  hasSelection(): boolean;
  clearSelection(): void;
  startAutoScroll(direction: number): void;
  stopAutoScroll(): void;
  updateAutoScroll(offsetY: number, height: number): void;
  normalizeSelection(): {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null;
  selectionChangedEmitter?: { fire(): void };
}

interface GhosttyRendererSelection {
  isInSelection(col: number, row: number): boolean;
  currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null;
}

/** Box drawing and block elements: frames, rules, Claude Code's prompt box. */
const BOX = /[─-▟]/;

/** Reads `row` (absolute) as cells, graphemes whole and wide tails empty. */
export function readCopyRow(wasm: CopyWasm, row: number): CopyRow {
  const history = wasm.getScrollbackLength();
  const inHistory = row < history;
  const line = inHistory ? wasm.getScrollbackLine(row) : wasm.getLine(row - history);
  const cells: string[] = [];
  for (let col = 0; col < (line?.length ?? 0); col++) {
    const cell = line?.[col];
    if (!cell || cell.width === 0) {
      // A wide character's tail (its cell is the one before), or nothing.
      cells.push(cell && col > 0 && (line?.[col - 1]?.width ?? 1) === 2 ? '' : ' ');
      continue;
    }
    if (cell.codepoint === 0) {
      cells.push(' ');
      continue;
    }
    cells.push(
      cell.grapheme_len > 0
        ? inHistory
          ? wasm.getScrollbackGraphemeString(row, col)
          : wasm.getGraphemeString(row - history, col)
        : String.fromCodePoint(cell.codepoint)
    );
  }
  let continues = false;
  if (!inHistory) {
    continues = wasm.isRowWrapped(row - history);
  } else if (row > 0) {
    // ghostty-web keeps no wrap flag for history rows: a row continues the one above when
    // that one is full to its last column (a soft wrap fills it), unless it ends in a rule.
    const above = wasm.getScrollbackLine(row - 1);
    const last = above?.[above.length - 1];
    continues = !!last && last.codepoint > 32 && !BOX.test(String.fromCodePoint(last.codepoint));
  }
  return { cells, continues };
}

/**
 * The text of rows from `start` to `end` (inclusive, in order). A line selection joins rows the
 * terminal soft-wrapped back into the printed line; a block selection takes the same columns
 * of every row. Trailing padding goes, then cleanCopiedLines.
 */
export function copyText(
  rows: CopyRow[],
  start: { col: number; row: number },
  end: { col: number; row: number },
  block = false
): string {
  const lines: string[] = [];
  const left = Math.min(start.col, end.col);
  const right = Math.max(start.col, end.col);
  for (let i = 0; i < rows.length; i++) {
    const row = start.row + i;
    if (row > end.row) break;
    const cells = rows[i].cells;
    const from = block ? left : row === start.row ? start.col : 0;
    const to = block ? right + 1 : row === end.row ? end.col + 1 : cells.length;
    const piece = cells.slice(from, to).join('');
    if (!block && i > 0 && rows[i].continues) lines[lines.length - 1] += piece;
    else lines.push(piece);
  }
  return cleanCopiedLines(lines.map((line) => line.trimEnd())).join('\n');
}

/** A full-width rule of Claude Code's prompt: '─' only (a table's ┼ or ┬ rows are not). */
const isRule = (line: string) => /^\s*─+\s*$/.test(line);
/** The top or bottom of Claude Code's rounded prompt box, nothing inside the edge. */
const isBoxEdge = (line: string) => /^\s*(?:╭─*╮|╰─*╯)\s*$/.test(line);
const FRAMED = /^\s*│(.*)│\s*$/u;
const PROMPT_MARKER = /^\s*[❯>] /;

/**
 * Claude Code's screen around the text, and nothing else: its rounded prompt box (│ … │ between
 * ╭──╮ and ╰──╯) or its prompt between two rules of '─' (─── ❯ text ───). A selection that holds
 * more than that frame copies the text without it; one that is only a rule copies the rule.
 * Other drawings stay as printed: tables (┌┬┐ ├┼┤, nushell's ╭─┬─╮), trees, markdown's ---.
 */
export function cleanCopiedLines(lines: string[]): string[] {
  const frame = (line: string) => isRule(line) || isBoxEdge(line);
  if (!lines.some((line) => line.trim() && !frame(line))) return lines;
  const boxed = lines.some(isBoxEdge);
  const out: string[] = [];
  // The prompt's first row: right after a rule or the box's top.
  let promptRow = false;
  for (const line of lines) {
    if (frame(line)) {
      promptRow = isRule(line) || line.trim().startsWith('╭');
      continue;
    }
    let text = line;
    const framed = boxed ? text.match(FRAMED) : null;
    if (framed) text = framed[1].replace(/^ /, '').trimEnd();
    if (promptRow) text = text.replace(PROMPT_MARKER, '');
    promptRow = false;
    out.push(text);
  }
  // Rows dropped at the ends leave no blank lines behind.
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  while (out.length > 1 && out[0] === '') out.shift();
  return out;
}

/** Whether the terminal's app asked for drags (button-event or any-event mouse tracking). */
export function appTracksDrags(term: GhosttyTerminal | null): boolean {
  try {
    return !!term && (term.getMode(1002) || term.getMode(1003));
  } catch {
    return false;
  }
}

/** ghostty's selection manager, if this ghostty-web still has the shape it is patched for. */
function selectionManagerOf(term: GhosttyTerminal): GhosttySelectionManager | null {
  const manager = (term as unknown as { selectionManager?: GhosttySelectionManager })
    .selectionManager;
  return manager &&
    typeof manager.getSelection === 'function' &&
    typeof manager.updateAutoScroll === 'function' &&
    typeof manager.startAutoScroll === 'function' &&
    manager.wasmTerm
    ? manager
    : null;
}

/**
 * Patches ghostty's local selection: its text (copyText), no auto-scroll inside the canvas nor
 * without history, and the block shape for Option+drag. Returns the block flag's setter.
 */
export function patchGhosttySelection(term: GhosttyTerminal): {
  setBlock(block: boolean): void;
  text(): string;
} | null {
  const manager = selectionManagerOf(term);
  if (!manager) return null;
  let block = false;

  const text = () => {
    const a = manager.selectionStart;
    const b = manager.selectionEnd;
    if (!a || !b || !manager.hasSelection()) return '';
    const [first, last] =
      a.absoluteRow < b.absoluteRow || (a.absoluteRow === b.absoluteRow && a.col <= b.col)
        ? [a, b]
        : [b, a];
    const rows: CopyRow[] = [];
    for (let row = first.absoluteRow; row <= last.absoluteRow; row++) {
      rows.push(readCopyRow(manager.wasmTerm, row));
    }
    return copyText(
      rows,
      { col: first.col, row: first.absoluteRow },
      { col: last.col, row: last.absoluteRow },
      block
    );
  };
  manager.getSelection = text;

  // Inside the canvas a drag never scrolls (ghostty scrolled in its top and bottom 30 px).
  manager.updateAutoScroll = () => manager.stopAutoScroll();
  const startAutoScroll = manager.startAutoScroll.bind(manager);
  manager.startAutoScroll = (direction: number) => {
    // No history to scroll (an app's full screen): its auto-scroll only moved the selection's
    // end to the first or last row.
    if (manager.wasmTerm.getScrollbackLength() === 0 || manager.wasmTerm.isAlternateScreen()) {
      return;
    }
    startAutoScroll(direction);
  };

  const renderer = (term as unknown as { renderer?: GhosttyRendererSelection }).renderer;
  if (renderer && typeof renderer.isInSelection === 'function') {
    const isInSelection = renderer.isInSelection.bind(renderer);
    renderer.isInSelection = (col: number, row: number) => {
      const coords = renderer.currentSelectionCoords;
      if (!block || !coords) return isInSelection(col, row);
      const start = manager.selectionStart;
      const end = manager.selectionEnd;
      if (!start || !end) return false;
      const left = Math.min(start.col, end.col);
      const right = Math.max(start.col, end.col);
      return row >= coords.startRow && row <= coords.endRow && col >= left && col <= right;
    };
  }
  return {
    setBlock(value: boolean) {
      block = value;
    },
    text,
  };
}

/**
 * Longest text an app may put on the clipboard (OSC 52), decoded: a long vim yank or a whole
 * Claude Code answer fits; a program flooding the clipboard does not.
 */
export const OSC52_MAX_CHARS = 100_000;
/** Base64 that long or longer is dropped as it comes, never held. */
const OSC52_MAX_ENCODED = Math.ceil((OSC52_MAX_CHARS * 4 * 4) / 3) + 16;

const OSC52_START = '\x1b]52;';
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls that end or cancel an OSC.
const CONTROL_IN_OSC = /[\x07\x1b\x18\x1a]/g;

/**
 * Finds OSC 52 clipboard writes (ESC ] 52 ; Pc ; base64, ended by BEL or ESC \\) in terminal
 * output, also when one is split across chunks. Only writes: a query ('?') is never answered
 * and an empty payload (clear) does nothing. A payload over the limit is not kept as it comes
 * and is reported as too long.
 */
export class Osc52Scanner {
  /** Output held over to the next chunk: the start of ESC ] 5 2 ;, or an ESC inside one. */
  private carry = '';
  private body: string | null = null;
  private overflow = false;

  push(chunk: string): Array<{ text: string } | { tooLong: true }> {
    const found: Array<{ text: string } | { tooLong: true }> = [];
    const data = this.carry + chunk;
    this.carry = '';
    let index = 0;
    while (index < data.length) {
      if (this.body === null) {
        const start = data.indexOf(OSC52_START, index);
        if (start < 0) {
          for (let keep = Math.min(OSC52_START.length - 1, data.length - index); keep > 0; keep--) {
            const tail = data.slice(data.length - keep);
            if (OSC52_START.startsWith(tail)) {
              this.carry = tail;
              break;
            }
          }
          break;
        }
        this.body = '';
        this.overflow = false;
        index = start + OSC52_START.length;
        continue;
      }
      // BEL or ESC end it; CAN and SUB cancel it, as in terminals' parsers. An OSC 52 that never
      // ends holds at most OSC52_MAX_ENCODED and is cut off by the next escape sequence.
      CONTROL_IN_OSC.lastIndex = index;
      const stop = CONTROL_IN_OSC.exec(data)?.index ?? -1;
      if (stop < 0) {
        this.append(data.slice(index));
        break;
      }
      this.append(data.slice(index, stop));
      const esc = data[stop] === '\x1b' ? stop : -1;
      if (data[stop] === '\x18' || data[stop] === '\x1a') {
        this.body = null;
        this.overflow = false;
        index = stop + 1;
        continue;
      }
      if (stop === esc) {
        if (esc === data.length - 1) {
          // ESC at the end: the next chunk says whether it is ST.
          this.carry = '\x1b';
          break;
        }
        if (data[esc + 1] !== '\\') {
          // Another sequence began: this one was cut off, as terminals drop it.
          this.body = null;
          index = esc;
          continue;
        }
      }
      index = stop + (stop === esc ? 2 : 1);
      const payload = this.body;
      const overflowed = this.overflow;
      this.body = null;
      this.overflow = false;
      if (overflowed) {
        found.push({ tooLong: true });
        continue;
      }
      const decoded = decodeOsc52(payload);
      if (decoded === null) continue;
      found.push(decoded.length > OSC52_MAX_CHARS ? { tooLong: true } : { text: decoded });
    }
    return found;
  }

  private append(text: string) {
    if (this.body === null || this.overflow) return;
    this.body += text;
    if (this.body.length > OSC52_MAX_ENCODED) {
      this.overflow = true;
      this.body = '';
    }
  }

  reset() {
    this.carry = '';
    this.body = null;
    this.overflow = false;
  }
}

/** `Pc;Pd` of an OSC 52: the text to write, or null for a query, a clear or bad base64. */
export function decodeOsc52(payload: string): string | null {
  const semicolon = payload.indexOf(';');
  if (semicolon < 0) return null;
  const data = payload.slice(semicolon + 1).replace(/\s+/g, '');
  if (data === '' || data === '?') return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface DesktopCopyHost {
  terminal(): GhosttyTerminal | null;
  canvas(): HTMLCanvasElement | null;
  /** A mouse report for the app at the pointer's cell (terminal.ts mouseReport). */
  mouseReport(button: number, clientX: number, clientY: number, release?: boolean): string;
  sendToApp(text: string): void;
  /** Mouse events iOS emulates after a touch (they are not a mouse). */
  isEmulatedMouse(): boolean;
  /** The terminal is shown and in the page's foreground. */
  onScreen(): boolean;
  /** Says what happened to an app's copy (OSC 52). */
  notify(result: AppCopyResult): void;
}

export type AppCopyResult =
  | { kind: 'copied'; text: string }
  /** `unasked`: no key or click came just before, the copy waits for one (see copyFromApp). */
  | { kind: 'blocked'; text: string; unasked: boolean; retry: () => Promise<boolean> }
  | { kind: 'tooLong' };

/** The start of a copied text for a toast, on one line: what is on the clipboard is seen. */
export function copyPreview(text: string, max = 48): string {
  const line = text
    .replace(/\s*\n\s*/g, ' ⏎ ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * An app's copy goes to the clipboard by itself only this soon after a key or click in the page
 * (Claude Code copies on the drag's release, vim on y, tmux on its copy key). Later, it is offered
 * with a button: output nobody asked for (a file shown with cat, a program in the background)
 * cannot put a command on the clipboard to be pasted unseen.
 */
export const APP_COPY_INPUT_WINDOW_MS = 3000;

const USER_INPUT_EVENTS = ['keydown', 'mousedown', 'mouseup', 'touchend'] as const;

/** How long after a drag the app has to send its copy for Safari's clipboard (see release). */
const APP_COPY_WAIT_MS = 1500;

/** Safari lets the clipboard be written only inside a click or key handler. */
function isSafari(): boolean {
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android/i.test(ua);
}

/** The element with the focus, through shadow roots. */
function deepActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/** Whether the focused field has text of its own selected (its Cmd+C copies that). */
function fieldHasSelection(): boolean {
  const active = deepActiveElement();
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return false;
  try {
    return (active.selectionStart ?? 0) !== (active.selectionEnd ?? 0);
  } catch {
    return false;
  }
}

/**
 * The terminal's mouse selection and copy on a desktop: what a drag does, Cmd+C, and the
 * clipboard writes of apps (OSC 52). See the top of this file.
 */
export class DesktopCopy {
  private selection: ReturnType<typeof patchGhosttySelection> = null;
  private container: HTMLElement | null = null;
  /** A drag going to the app as mouse reports: the last cell reported. */
  private appDrag: { col: number; row: number } | null = null;
  private appDragMoved = false;
  /** Safari: a clipboard write opened in the drag's release, waiting for the app's copy. */
  private pendingWrite: {
    resolve(text: string): void;
    reject(): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private host: DesktopCopyHost) {}

  attach(term: GhosttyTerminal, container: HTMLElement) {
    this.detach();
    this.selection = patchGhosttySelection(term);
    this.container = container;
    // Capture: before ghostty's own mousedown on the canvas starts a selection.
    container.addEventListener('mousedown', this.handleMouseDown, true);
    document.addEventListener('copy', this.handleCopy);
    for (const type of USER_INPUT_EVENTS) document.addEventListener(type, this.noteInput, true);
  }

  /** When the user last pressed a key or the mouse in the page. */
  private lastInputAt = Number.NEGATIVE_INFINITY;

  private noteInput = () => {
    this.lastInputAt = performance.now();
  };

  detach() {
    this.container?.removeEventListener('mousedown', this.handleMouseDown, true);
    document.removeEventListener('copy', this.handleCopy);
    for (const type of USER_INPUT_EVENTS) document.removeEventListener(type, this.noteInput, true);
    this.endAppDrag();
    this.container = null;
    this.selection = null;
    this.settlePending(null);
  }

  /** The local selection's text, as Cmd+C copies it. */
  selectedText(): string {
    return this.selection?.text() ?? '';
  }

  private cellAt(clientX: number, clientY: number): { col: number; row: number } {
    const term = this.host.terminal();
    const rect = this.host.canvas()?.getBoundingClientRect();
    if (!term || !rect || rect.width <= 0 || rect.height <= 0) return { col: 0, row: 0 };
    const cell = (offset: number, size: number, count: number) =>
      Math.min(count - 1, Math.max(0, Math.floor((offset / size) * count)));
    return {
      col: cell(clientX - rect.left, rect.width, term.cols),
      row: cell(clientY - rect.top, rect.height, term.rows),
    };
  }

  private handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || this.host.isEmulatedMouse()) return;
    const canvas = this.host.canvas();
    if (!canvas || !(event.target instanceof Node) || !canvas.contains(event.target)) return;
    const term = this.host.terminal();
    // Option+drag selects a block of columns, as in Terminal.app and Ghostty.
    this.selection?.setBlock(event.altKey);
    if (!term || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    if (!appTracksDrags(term)) return;
    // The app takes the drag: no local selection starts (ghostty's handler never sees it).
    event.stopPropagation();
    event.preventDefault();
    if (term.hasSelection()) term.clearSelection();
    this.appDrag = this.cellAt(event.clientX, event.clientY);
    this.appDragMoved = false;
    this.host.sendToApp(this.host.mouseReport(0, event.clientX, event.clientY));
    document.addEventListener('mousemove', this.handleAppDragMove, true);
    document.addEventListener('mouseup', this.handleAppDragUp, true);
  };

  private handleAppDragMove = (event: MouseEvent) => {
    if (!this.appDrag) return;
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell.col === this.appDrag.col && cell.row === this.appDrag.row) return;
    this.appDrag = cell;
    this.appDragMoved = true;
    // Button 0 held while moving: 32 + 0.
    this.host.sendToApp(this.host.mouseReport(32, event.clientX, event.clientY));
  };

  private handleAppDragUp = (event: MouseEvent) => {
    if (!this.appDrag) return;
    const copies = this.appDragMoved || event.detail >= 2;
    this.endAppDrag();
    this.host.sendToApp(this.host.mouseReport(0, event.clientX, event.clientY, true));
    // Safari writes the clipboard only in a user's click or key: the write opens here, in the
    // release, and gets its text when the app's copy (OSC 52) comes, or nothing. Only after a
    // drag or a double click: what an app selects (and copies) with the mouse.
    if (copies && isSafari()) this.openPendingWrite();
  };

  private endAppDrag() {
    this.appDrag = null;
    document.removeEventListener('mousemove', this.handleAppDragMove, true);
    document.removeEventListener('mouseup', this.handleAppDragUp, true);
  }

  private openPendingWrite() {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return;
    this.settlePending(null);
    const text = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.settlePending(null), APP_COPY_WAIT_MS);
      this.pendingWrite = { resolve, reject: () => reject(new Error('no copy')), timer };
    });
    const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).catch(() => {
      // Nothing came (a click or a drag that copied nothing), or Safari said no.
    });
  }

  /** Gives the open Safari write its text (true), or closes it with none. */
  private settlePending(text: string | null): boolean {
    const pending = this.pendingWrite;
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingWrite = null;
    if (text === null) {
      pending.reject();
      return false;
    }
    pending.resolve(text);
    return true;
  }

  /**
   * An app's OSC 52 write: to the clipboard only while this terminal is on screen in the
   * focused page (a background tab or a session not shown never writes it).
   */
  copyFromApp(request: { text: string } | { tooLong: true }) {
    if (!this.host.onScreen()) return;
    if ('tooLong' in request) {
      this.settlePending(null);
      this.host.notify({ kind: 'tooLong' });
      return;
    }
    const text = request.text;
    if (this.settlePending(text)) {
      this.host.notify({ kind: 'copied', text });
      return;
    }
    const write = async () => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    };
    if (performance.now() - this.lastInputAt > APP_COPY_INPUT_WINDOW_MS) {
      this.host.notify({ kind: 'blocked', text, unasked: true, retry: write });
      return;
    }
    void write().then((ok) => {
      this.host.notify(
        ok ? { kind: 'copied', text } : { kind: 'blocked', text, unasked: false, retry: write }
      );
    });
  }

  /** Cmd+C (Ctrl+C elsewhere) with text selected in the terminal copies that text. */
  private handleCopy = (event: ClipboardEvent) => {
    const term = this.host.terminal();
    if (!term?.hasSelection() || !event.clipboardData) return;
    // Text selected on the page or in a field is what the user meant to copy.
    if ((document.getSelection()?.toString() ?? '') !== '' || fieldHasSelection()) return;
    if (!this.host.onScreen()) return;
    const text = this.selectedText();
    if (!text) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  };
}
