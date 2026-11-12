// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { GhosttyTerminal } from 'ghostty-web';
import { describe, expect, it, vi } from 'vitest';
import { openEscapeTail, resizeKeepingBottom } from './terminal-grow.js';

// The real ghostty-web on the real WASM: the test setup mocks both for components.
vi.unmock('ghostty-web');
vi.unmock('./terminal-ghostty.js');

const wasm = readFileSync(createRequire(import.meta.url).resolve('ghostty-web/ghostty-vt.wasm'));

async function ghosttyTerminal(cols: number, rows: number): Promise<GhosttyTerminal> {
  const { Ghostty } = await import('ghostty-web');
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => {} } });
  return new Ghostty(instance).createTerminal(cols, rows, { scrollbackLimit: 10000 });
}

function screen(terminal: GhosttyTerminal): string[] {
  return Array.from({ length: terminal.rows }, (_, y) =>
    (terminal.getLine(y) ?? [])
      .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
      .join('')
      .trimEnd()
  );
}

/**
 * What Claude Code leaves on a 10-row screen with the keyboard up: its transcript, the prompt
 * box with the cursor in it, and the status line under it (the cursor is not on the last row).
 */
async function claudeFrame(): Promise<GhosttyTerminal> {
  const terminal = await ghosttyTerminal(30, 10);
  let output = '';
  for (let i = 1; i <= 30; i++) output += `line ${i}\r\n`;
  terminal.write(`${output}> \x1b[31mhola\x1b[0m\r\n  status line`);
  terminal.write('\x1b[1A\x1b[7G');
  return terminal;
}

describe('growing the terminal when the keyboard goes down', () => {
  it('ghostty alone keeps the frame at the top and leaves a blank band below it', async () => {
    const terminal = await claudeFrame();
    terminal.resize(30, 14);
    // The empty band the owner saw until Claude redrew (2026-10-04).
    expect(screen(terminal).slice(-4)).toEqual(['', '', '', '']);
    expect(screen(terminal)[8]).toBe('> hola');
  });

  it('keeps the prompt and the status line on the bottom edge, history coming down', async () => {
    const terminal = await claudeFrame();
    const resize = vi.fn(() => terminal.resize(30, 14));

    expect(resizeKeepingBottom(terminal, 14, resize)).toBe(4);

    expect(resize).toHaveBeenCalledOnce();
    expect(screen(terminal)).toEqual([
      'line 19',
      'line 20',
      'line 21',
      'line 22',
      'line 23',
      'line 24',
      'line 25',
      'line 26',
      'line 27',
      'line 28',
      'line 29',
      'line 30',
      '> hola',
      '  status line',
    ]);
    // The cursor is back on its own cell, four rows lower: Claude's relative moves still land.
    expect(terminal.getCursor()).toMatchObject({ x: 6, y: 12 });
    // And the app's colours are untouched: output after the grow is not red.
    terminal.write('!');
    expect(terminal.getLine(12)?.[6]).toMatchObject({ codepoint: 33 });
    expect(terminal.getLine(12)?.[6]?.fg_r).toBe(terminal.getLine(0)?.[0]?.fg_r);
  });

  it('pulls down only what the history has, the rest blank below', async () => {
    const terminal = await ghosttyTerminal(30, 4);
    terminal.write('one\r\ntwo\r\nthree\r\n> \r\n  status');
    terminal.write('\x1b[1A\x1b[3G');

    expect(resizeKeepingBottom(terminal, 8, () => terminal.resize(30, 8))).toBe(1);

    expect(screen(terminal).slice(0, 5)).toEqual(['one', 'two', 'three', '>', '  status']);
    expect(terminal.getCursor()).toMatchObject({ x: 2, y: 3 });
  });

  it('leaves shrinking and the alternate screen to ghostty', async () => {
    const terminal = await claudeFrame();
    const write = vi.spyOn(terminal, 'write');
    expect(resizeKeepingBottom(terminal, 6, () => terminal.resize(30, 6))).toBe(0);
    expect(screen(terminal).slice(-2)).toEqual(['> hola', '  status line']);

    terminal.write('\x1b[?1049h');
    write.mockClear();
    expect(resizeKeepingBottom(terminal, 12, () => terminal.resize(30, 12))).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(terminal.rows).toBe(12);
  });
});

describe('openEscapeTail', () => {
  it('is empty when the output ends between sequences', () => {
    expect(openEscapeTail('', 'plain text')).toBe('');
    expect(openEscapeTail('', 'a\x1b[31mred\x1b[0m')).toBe('');
    expect(openEscapeTail('', '\x1b]0;title\x07')).toBe('');
    expect(openEscapeTail('', '\x1b]8;;https://x\x1b\\link')).toBe('');
    expect(openEscapeTail('', '\x1b7')).toBe('');
    expect(openEscapeTail('', '\x1b(B')).toBe('');
  });

  it('keeps a sequence cut at the end of a chunk until a later chunk ends it', () => {
    let tail = openEscapeTail('', 'text\x1b[3');
    expect(tail).toBe('\x1b[3');
    tail = openEscapeTail(tail, '8;5');
    expect(tail).toBe('\x1b[38;5');
    expect(openEscapeTail(tail, ';1mok')).toBe('');

    tail = openEscapeTail('', '\x1b]0;a long ti');
    expect(tail).not.toBe('');
    expect(openEscapeTail(tail, 'tle\x07')).toBe('');
    expect(openEscapeTail('', '\x1b')).toBe('\x1b');
    expect(openEscapeTail('', '\x1b(')).toBe('\x1b(');
  });
});

/**
 * User report 2026-10-14: a phone keyboard's every up and down left a copy of Claude Code's
 * screen in a Mac-window session's history, in a replay or a viewer's grid. Shrinking pushes
 * the screen's top into the history; Claude then clears the screen and reprints its whole
 * region for the new size. Grown at the top, the pushed rows stayed in the history and the
 * reprint for the larger size printed them again; grown keeping the bottom, they come back
 * down and the reprint overwrites them.
 */
describe('a keyboard going up and down under a Claude-like app', () => {
  // Claude's reprint after a resize: home, every row cleared, home, then its region, the
  // cursor left in its prompt box a few rows above the bottom.
  const reprint = (rows: number, lines: string[]) =>
    `\x1b[H${'\x1b[2K\x1b[1B'.repeat(rows - 1)}\x1b[2K\x1b[H${lines.join('\r\n')}\x1b[3A`;
  const region = Array.from({ length: 18 }, (_, i) => `answer row ${i + 1}`);

  async function cycle(grow: (terminal: GhosttyTerminal, rows: number) => void) {
    const terminal = await ghosttyTerminal(30, 20);
    let older = '';
    for (let i = 1; i <= 10; i++) older += `older ${i}\r\n`;
    terminal.write(older + reprint(20, region));
    for (let round = 0; round < 3; round++) {
      terminal.resize(30, 8); // keyboard up
      terminal.write(reprint(8, region.slice(-8)));
      grow(terminal, 20); // keyboard down
      terminal.write(reprint(20, region));
    }
    const all: string[] = [];
    for (let i = terminal.getScrollbackLength() - 1; i >= 0; i--) {
      all.push(
        (terminal.getScrollbackLine(i) ?? [])
          .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
          .join('')
          .trimEnd()
      );
    }
    all.push(...screen(terminal));
    return all.filter((line) => line === 'answer row 1').length;
  }

  it('leaves copies when the grid grows at the top', async () => {
    expect(await cycle((terminal, rows) => terminal.resize(30, rows))).toBeGreaterThan(1);
  });

  it('leaves none when the grid grows keeping the bottom', async () => {
    expect(
      await cycle((terminal, rows) =>
        resizeKeepingBottom(terminal, rows, () => terminal.resize(30, rows))
      )
    ).toBe(1);
  });
});
