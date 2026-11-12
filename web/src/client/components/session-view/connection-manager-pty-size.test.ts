/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { GhosttyCell, GhosttyTerminal } from 'ghostty-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { Terminal } from '../terminal.js';

vi.unmock('ghostty-web');

type SubscribeOpts = {
  onStdout?: (data: Uint8Array) => void;
  onEvent?: (data: unknown) => void;
};

const subscriptions: SubscribeOpts[] = [];

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    subscribe: vi.fn((_sessionId: string, opts: SubscribeOpts) => {
      subscriptions.push(opts);
      return () => {};
    }),
  },
}));

const { ConnectionManager } = await import('./connection-manager.js');
const { Ghostty } = await vi.importActual<typeof import('ghostty-web')>('ghostty-web');
const wasm = await WebAssembly.compile(
  readFileSync(createRequire(import.meta.url).resolve('ghostty-web/ghostty-vt.wasm'))
);
// One WASM instance per terminal: on a shared one a new terminal shows the last one's text
// (see createGhostty).
const newGhostty = () => new Ghostty(new WebAssembly.Instance(wasm, { env: { log: () => {} } }));

const encoder = new TextEncoder();
const PHONE = { cols: 80, rows: 24 };

/**
 * A Claude Code-like cast (no real content): each word placed with an absolute column move
 * (CHA, ESC[nG), a status frame repainted in place (ESC[nA + ESC[2K), all while a Mac window
 * had the PTY at 120 columns; then the phone takes it to 80 and Claude redraws its screen.
 */
function claudeLikeCast(): Array<['o', string] | ['r', string]> {
  const words =
    'El siguiente paso del plan es el paso cuatro revisar y alinear con el diseño nuevo las ventanas de la app del Mac Ajustes bienvenida y About con capturas reales'.split(
      ' '
    );
  const placed = (width: number) => {
    const rows: string[] = [];
    let row = '';
    let col = 3;
    for (const word of words) {
      if (col + word.length > width) {
        rows.push(row);
        row = '';
        col = 3;
      }
      row += `\x1b[${col}G${word}`;
      col += word.length + 1;
    }
    rows.push(row);
    return rows;
  };
  const events: Array<['o', string] | ['r', string]> = [['r', '120x24']];
  for (let i = 0; i < 30; i++) {
    events.push(['o', `⏺ mensaje ${i}\r\r\n${placed(120).join('\r\r\n')}\r\r\n\r\r\n`]);
  }
  let previous = 0;
  for (let frame = 0; frame < 5; frame++) {
    const lines = [`✻ Working ${frame}`, ...placed(120), '❯ '];
    const up = previous ? `\x1b[${previous}A\r` : '';
    events.push(['o', `${up}${lines.map((line) => `\x1b[2K${line}`).join('\r\r\n')}\r\r\n`]);
    previous = lines.length;
  }
  events.push(['r', '80x24']);
  events.push([
    'o',
    `\x1b[H${'\x1b[2K\x1b[1B'.repeat(24)}\x1b[H${placed(80).join('\r\r\n')}\r\r\n❯ `,
  ]);
  return events;
}

function allLines(term: GhosttyTerminal): string[] {
  const text = (cells: GhosttyCell[] | null | undefined) => {
    let line = '';
    for (const cell of cells ?? []) {
      if (!cell || cell.width === 0) continue;
      line += cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' ';
    }
    return line.trimEnd();
  };
  const lines: string[] = [];
  for (let i = 0; i < term.getScrollbackLength(); i++) lines.push(text(term.getScrollbackLine(i)));
  for (let y = 0; y < term.rows; y++) lines.push(text(term.getLine(y)));
  return lines;
}

/** Rows like the screenshot: one to three letters on the left, a stray one on the right. */
const fragments = (lines: string[]) =>
  lines.filter(
    (line) => line !== '❯' && (/^\S{1,3}\s{20,}\S$/.test(line) || /^\S{1,3}$/.test(line.trim()))
  );

describe('history drawn for another PTY size (2026-10-12)', () => {
  let term: GhosttyTerminal;

  beforeEach(() => {
    vi.useFakeTimers();
    subscriptions.length = 0;
    term = newGhostty().createTerminal(PHONE.cols, PHONE.rows, { scrollbackLimit: 100000 });
  });

  afterEach(() => {
    term.free?.();
    vi.useRealTimers();
  });

  /**
   * The grid as terminal.ts lays it out (followPtySize): during a replay at the PTY's size,
   * live at its columns when they are not the phone's, else the phone's own size.
   */
  function phoneTerminal(followsPtySize: boolean): Terminal {
    const fake = {
      write: (data: string) => term.write(data),
      holdPaint: vi.fn(),
      releasePaint: vi.fn(),
      isPaintHeld: () => true,
      followPtySize: (cols: number, rows: number, replaying: boolean) => {
        if (replaying) term.resize(cols, rows);
        else if (cols === PHONE.cols) term.resize(PHONE.cols, PHONE.rows);
        else term.resize(cols, PHONE.rows);
      },
      ptyReplayEnded: () => {
        if (term.cols === PHONE.cols) term.resize(PHONE.cols, PHONE.rows);
        else term.resize(term.cols, PHONE.rows);
      },
    };
    if (!followsPtySize) {
      // Before: the PTY's size was only remembered, the grid stayed the phone's.
      return { ...fake, followPtySize: undefined, ptyReplayEnded: undefined } as never;
    }
    return fake as unknown as Terminal;
  }

  function replay(terminal: Terminal) {
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    manager.setTerminal(terminal);
    manager.setSession({ id: 'fwd_test' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    const sub = subscriptions[0];
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    for (const [kind, data] of claudeLikeCast()) {
      if (kind === 'o') sub.onStdout?.(encoder.encode(data));
      else sub.onEvent?.({ kind: 'resize', dimensions: data });
    }
    sub.onEvent?.({ kind: 'replay-end' });
    vi.runAllTimers();
    return allLines(term);
  }

  it('reproduces the bug: written into the phone grid, the history comes apart', () => {
    const lines = replay(phoneTerminal(false));
    expect(fragments(lines).length).toBeGreaterThan(50);
    expect(lines.filter((line) => line.startsWith('✻ Working')).length).toBeGreaterThan(1);
  });

  it('lays each stretch out at its size: no fragments, no stale frames, phone width', () => {
    const lines = replay(phoneTerminal(true));
    expect(fragments(lines)).toEqual([]);
    // The status frame repainted in place leaves no copies in the history.
    expect(lines.filter((line) => line.startsWith('✻ Working')).length).toBeLessThanOrEqual(1);
    // Every message in the history is there once (the last screen is cleared and redrawn).
    for (let i = 0; i < 30; i++) {
      const copies = lines.filter((line) => line === `⏺ mensaje ${i}`).length;
      if (i < 25) expect(copies).toBe(1);
      else expect(copies).toBeLessThanOrEqual(1);
    }
    expect(term.cols).toBe(PHONE.cols);
    expect(term.rows).toBe(PHONE.rows);
  });

  it('writes the output before a live resize at the size it was drawn for', () => {
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    const sizes: string[] = [];
    const written: string[] = [];
    manager.setTerminal({
      write: (data: string) => written.push(data),
      holdPaint: vi.fn(),
      releasePaint: vi.fn(),
      isPaintHeld: () => false,
      followPtySize: (cols: number, rows: number, replaying: boolean) =>
        sizes.push(`${cols}x${rows}${replaying ? ' replay' : ''} after ${written.join('|')}`),
      ptyReplayEnded: vi.fn(),
    } as unknown as Terminal);
    manager.setSession({ id: 'fwd_test' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    const sub = subscriptions[0];
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    sub.onStdout?.(encoder.encode('a'));
    sub.onEvent?.({ kind: 'replay-end' });
    sub.onStdout?.(encoder.encode('b'));
    sub.onEvent?.({ kind: 'resize', dimensions: '120x52' });
    expect(sizes).toEqual(['80x24 replay after ', '120x52 after a|b']);
  });
  it('resizes a replay only once for back-to-back sizes, each stretch at its size', () => {
    // User report 2026-10-14: every size in a Mac window's history resized (and reflowed) the
    // grid, even when another came before any output.
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    const log: string[] = [];
    manager.setTerminal({
      write: (data: string) => log.push(data),
      holdPaint: vi.fn(),
      releasePaint: vi.fn(),
      isPaintHeld: () => true,
      followPtySize: (cols: number, rows: number, replaying: boolean) =>
        log.push(`${cols}x${rows}${replaying ? ' replay' : ''}`),
      ptyReplayEnded: () => log.push('end'),
    } as unknown as Terminal);
    manager.setSession({ id: 'fwd_test' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    const sub = subscriptions[0];
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    sub.onEvent?.({ kind: 'resize', dimensions: '100x30' });
    sub.onStdout?.(encoder.encode('a'));
    for (const size of ['110x30', '120x30', '121x31']) {
      sub.onEvent?.({ kind: 'resize', dimensions: size });
    }
    sub.onStdout?.(encoder.encode('b'));
    sub.onEvent?.({ kind: 'resize', dimensions: '90x20' });
    sub.onEvent?.({ kind: 'replay-end' });
    vi.runAllTimers();
    expect(log).toEqual(['100x30 replay', 'a', '121x31 replay', 'b', '90x20 replay', 'end']);
  });
});
