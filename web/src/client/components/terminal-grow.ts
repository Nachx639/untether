/**
 * Growing the terminal by rows the way xterm does: the bottom stays put and history rows come
 * down from the scrollback above it.
 *
 * ghostty only pulls rows down from the scrollback when the cursor is on the last row; anywhere
 * else it keeps the screen where it is and adds blank rows below (PageList.resizeWithoutReflow,
 * "we don't want to pull down scrollback"). Claude Code keeps its cursor in the prompt box, a few
 * rows above its status line, so hiding the phone's keyboard left Claude's frame at the top of
 * the grown terminal and an empty band under it until Claude redrew for the PTY's new size,
 * ~500 ms later (2026-10-04, iPhone SE simulator, home-screen app). The cursor is taken to the
 * last row for the resize, so ghostty pulls rows down, and put back on its own cell after it.
 *
 * The moves go straight to the WASM terminal: nothing of them reaches the PTY.
 */
import type { GhosttyTerminal } from 'ghostty-web';

/** The bits of ghostty-web's WASM terminal a grow needs. */
export type GrowableTerminal = Pick<
  GhosttyTerminal,
  'rows' | 'write' | 'getCursor' | 'getScrollbackLength' | 'isAlternateScreen' | 'getMode'
>;

/** DECOM: with it set, CUP counts from the scroll region and the moves below would miss. */
const ORIGIN_MODE = 6;

/**
 * Resizes with `resize` (ghostty-web's Terminal.resize: the WASM grid, the canvas, a repaint)
 * so that a grow by rows keeps the bottom anchored. Returns how many rows came down from the
 * scrollback. Anything but a plain grow (a shrink, the alternate screen, which has no
 * scrollback and whose apps redraw on SIGWINCH, origin mode) is left to ghostty.
 */
export function resizeKeepingBottom(
  wasm: GrowableTerminal,
  rows: number,
  resize: () => void
): number {
  const before = wasm.rows;
  const cursor = wasm.getCursor();
  const scrollback = wasm.getScrollbackLength();
  if (
    rows <= before ||
    scrollback === 0 ||
    cursor.y >= before - 1 ||
    wasm.isAlternateScreen() ||
    wasm.getMode(ORIGIN_MODE)
  ) {
    resize();
    return 0;
  }
  // CUP rather than DECSC/DECRC: those would overwrite a cursor the app saved itself.
  wasm.write(`\x1b[${before};1H`);
  resize();
  const pulled = Math.max(0, scrollback - wasm.getScrollbackLength());
  wasm.write(`\x1b[${cursor.y + pulled + 1};${cursor.x + 1}H`);
  return pulled;
}

/** Longest unterminated sequence kept (an OSC can be long; its terminator is what matters). */
const MAX_OPEN_ESCAPE = 4096;

function escapeComplete(seq: string): boolean {
  if (seq.length < 2) return false;
  const kind = seq[1];
  if (kind === '[') {
    // CSI: parameters and intermediates (0x20-0x3F) up to a final byte (0x40-0x7E).
    for (let i = 2; i < seq.length; i++) {
      const code = seq.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return true;
    }
    return false;
  }
  // OSC, DCS, APC, PM, SOS run to BEL or ST (ESC \, which would be the last ESC itself).
  if (']P_^X'.includes(kind)) return seq.includes('\x07', 2);
  const code = kind.charCodeAt(0);
  if (code >= 0x20 && code <= 0x2f) {
    // ESC with intermediates (charsets, DECALN...): up to a final byte 0x30-0x7E.
    for (let i = 2; i < seq.length; i++) {
      const c = seq.charCodeAt(i);
      if (c >= 0x30 && c <= 0x7e) return true;
    }
    return false;
  }
  return true;
}

/**
 * The escape sequence the output so far ends inside of ('' when none), given the previous
 * tail and the new chunk. A chunk of the stream can end in the middle of a sequence; writing
 * our own moves into the WASM terminal then would cut it short, so the grow waits for none.
 */
export function openEscapeTail(tail: string, data: string): string {
  const start = data.lastIndexOf('\x1b');
  let seq: string;
  if (start >= 0) seq = data.slice(start);
  else if (tail) seq = tail + data;
  else return '';
  if (escapeComplete(seq)) return '';
  return seq.length > MAX_OPEN_ESCAPE ? seq.slice(0, 2) + seq.slice(-MAX_OPEN_ESCAPE) : seq;
}
