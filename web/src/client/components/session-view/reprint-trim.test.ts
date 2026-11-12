// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { GhosttyTerminal } from 'ghostty-web';
import { describe, expect, it, vi } from 'vitest';
import { cellWidth, ReprintTrimmer, trimRepaint } from './reprint-trim.js';

// The real ghostty-web on the real WASM: the test setup mocks both for components.
vi.unmock('ghostty-web');
vi.unmock('../terminal-ghostty.js');

const wasm = readFileSync(createRequire(import.meta.url).resolve('ghostty-web/ghostty-vt.wasm'));

async function ghostty(cols: number, rows: number): Promise<GhosttyTerminal> {
  const { Ghostty } = await import('ghostty-web');
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => {} } });
  return new Ghostty(instance).createTerminal(cols, rows, { scrollbackLimit: 10000 });
}

function text(term: GhosttyTerminal): { history: string[]; screen: string[] } {
  const line = (cells: ReturnType<GhosttyTerminal['getLine']>) =>
    (cells ?? [])
      .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
      .join('')
      .trimEnd();
  const history: string[] = [];
  for (let i = term.getScrollbackLength() - 1; i >= 0; i--) {
    history.push(line(term.getScrollbackLine(i)));
  }
  const screen = Array.from({ length: term.rows }, (_, y) => line(term.getLine(y)));
  return { history, screen };
}

/**
 * Claude Code's repaint after a resize (as in the recording of a Mac-window session): cursor
 * hidden and moved, home, every row of the PTY cleared, home, its region with `\r\r\n` and
 * columns placed with `ESC[nG`, colors, the cursor taken back up into its prompt and shown.
 */
function claudeRepaint(ptyRows: number, region: string[]): string {
  const body = region
    .map((line, i) => `\x1b[3G\x1b[${i % 2 ? 1 : 22}m${line}\x1b[22m`)
    .join('\r\r\n');
  return `\x1b[?25l\x1b[2D\x1b[9B\x1b[H${'\x1b[2K\x1b[1B'.repeat(ptyRows - 1)}\x1b[2K\x1b[H${body}\x1b[2C\x1b[3A\x1b[?25h`;
}

const region = Array.from({ length: 38 }, (_, i) => `answer row ${String(i + 1).padStart(2, '0')}`);

describe('trimming the part of a repaint that only scrolls into the history', () => {
  it('a viewer with fewer rows than the PTY: no copy in the history, the same screen', async () => {
    const plain = await ghostty(60, 20);
    const trimmed = await ghostty(60, 20);
    // What the viewer had: the region printed once (its top scrolled into the history).
    const before = `${region.map((l) => `  ${l}`).join('\r\n')}`;
    plain.write(before);
    trimmed.write(before);

    const repaint = claudeRepaint(40, region);
    plain.write(repaint);
    const trimmer = new ReprintTrimmer(() => ({ cols: 60, rows: 20 }));
    trimmer.arm(40);
    trimmed.write(trimmer.push(repaint));

    const a = text(plain);
    const b = text(trimmed);
    expect(b.screen).toEqual(a.screen);
    expect(a.history.filter((l) => l.includes('answer row 01'))).toHaveLength(2);
    expect(b.history.filter((l) => l.includes('answer row 01'))).toHaveLength(1);
    expect(b.history.length).toBe(a.history.length - (region.length - 20));
  });

  it('holds a repaint that comes in pieces until it ends, live or flushed', async () => {
    const repaint = claudeRepaint(40, region);
    const trimmer = new ReprintTrimmer(() => ({ cols: 60, rows: 20 }));
    trimmer.arm(40);
    const cut = repaint.indexOf('answer row 20');
    expect(trimmer.push(repaint.slice(0, cut))).toBe('');
    expect(trimmer.isHolding()).toBe(true);
    const out = trimmer.push(`${repaint.slice(cut)}after`);
    expect(trimmer.isHolding()).toBe(false);
    expect(out.endsWith('\x1b[?25hafter')).toBe(true);
    expect(out).not.toContain('answer row 01');

    // No end in sight: the caller's flush writes it, trimmed.
    trimmer.arm(40);
    expect(trimmer.push(repaint.slice(0, repaint.length - 6))).toBe('');
    expect(trimmer.flush()).not.toContain('answer row 01');
  });

  it('leaves alone output that is not such a repaint', () => {
    const trimmer = new ReprintTrimmer(() => ({ cols: 60, rows: 20 }));
    // Not armed: no resize just before.
    const repaint = claudeRepaint(40, region);
    expect(trimmer.push(repaint)).toBe(repaint);
    // Armed, but something else comes first.
    trimmer.arm(40);
    expect(trimmer.push('hello\r\n')).toBe('hello\r\n');
    expect(trimmer.push(repaint)).toBe(repaint);
    // A clear of a few rows only (a smaller redraw).
    trimmer.arm(40);
    const small = `\x1b[H${'\x1b[2K\x1b[1B'.repeat(5)}\x1b[H${region.join('\r\n')}\x1b[?25h`;
    expect(trimmer.push(small)).toBe(small);
  });

  it('leaves a repaint alone when it fits, moves the cursor between rows, or wraps', () => {
    const grid = { cols: 60, rows: 20 };
    const fits = claudeRepaint(40, region.slice(0, 10));
    expect(trimRepaint(fits, fits.indexOf('\x1b[H', 20) + 3, grid)).toBe(fits);
    const moved = claudeRepaint(40, region).replace('answer row 30', '\x1b[2Aanswer row 30');
    const start = moved.indexOf('\x1b[2K\x1b[H') + 7;
    expect(trimRepaint(moved, start, grid)).toBe(moved);
    const wide = claudeRepaint(40, [...region.slice(0, 5), 'x'.repeat(70), ...region.slice(5)]);
    expect(trimRepaint(wide, wide.indexOf('\x1b[2K\x1b[H') + 7, grid)).toBe(wide);
  });

  it('counts wide letters as two cells, marks as none', () => {
    expect(cellWidth('a'.codePointAt(0) ?? 0)).toBe(1);
    expect(cellWidth('漢'.codePointAt(0) ?? 0)).toBe(2);
    expect(cellWidth('😀'.codePointAt(0) ?? 0)).toBe(2);
    expect(cellWidth(0x301)).toBe(0);
  });
});
