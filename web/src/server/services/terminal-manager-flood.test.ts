import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { TerminalManager } from './terminal-manager.js';

// The real ghostty-web and its WASM: the test setup mocks the module for unit tests.
vi.unmock('ghostty-web');

/**
 * 2026-10-04: flow control paused a session's server-side terminal once its scrollback passed
 * 8,000 lines (80% of SCROLLBACK_LIMIT) and resumed it below 5,000, which never happens: the
 * scrollback does not shrink. Its screen (/text, previews, the Claude menu reader, pushes) then
 * froze until a 5-minute timeout that also dropped the lines queued meanwhile. ghostty's limit
 * is a byte budget, so its line count passes 8,000 only on a narrow terminal (about 15,000
 * lines at 5 columns, 1,100 at 80): the session here is 5 columns wide.
 */
const COLS = 5;
const ROWS = 10;
const HISTORY_LINES = 20_000;
const FLOOD_EVENTS = 20_000;

/** Short enough for one row: base 36, at most 4 characters with the prefix up to 46,655. */
const label = (prefix: string, i: number) => `${prefix}${i.toString(36)}`;

describe('TerminalManager under an output flood with a full scrollback', () => {
  let controlDir: string | null = null;
  let manager: TerminalManager | null = null;

  afterEach(() => {
    manager?.destroy();
    manager = null;
    if (controlDir) fs.rmSync(controlDir, RM_TEST_DIR);
    controlDir = null;
  });

  function event(t: number, data: string): string {
    return `${JSON.stringify([t, 'o', data])}\n`;
  }

  /** A session whose replay alone takes the scrollback past the old pause mark. */
  function writeLongSession(sessionId: string): string {
    controlDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ut-flood-'));
    const dir = path.join(controlDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'stdout');
    const lines = [`${JSON.stringify({ version: 2, width: COLS, height: ROWS })}\n`];
    for (let i = 0; i < HISTORY_LINES; i++) lines.push(event(i / 1000, `${label('h', i)}\r\n`));
    fs.writeFileSync(file, lines.join(''));
    return file;
  }

  it('keeps the screen current and drops no line of the flood', async () => {
    const file = writeLongSession('s1');
    manager = new TerminalManager(controlDir as string);
    const terminal = await manager.getTerminal('s1');
    expect(terminal.getScrollbackLength() + ROWS).toBeGreaterThan(8000);
    expect((await manager.getRecentText('s1', 2)).text).toBe(`${label('h', HISTORY_LINES - 1)}\n`);

    await new Promise((resolve) => setTimeout(resolve, 200)); // the file watcher starts
    // One small event per line, the way a busy program writes them.
    const flood: string[] = [];
    for (let i = 0; i < FLOOD_EVENTS; i++) flood.push(event(30 + i / 1000, `${label('f', i)}\r\n`));
    fs.appendFileSync(file, `${flood.join('')}${event(99, 'END')}`);

    await vi.waitFor(
      async () => expect((await manager?.getRecentText('s1', 1))?.text).toBe('END'),
      { timeout: 5000, interval: 50 }
    );

    // Every flood line reached the terminal, in order: its scrollback ends with the last 8000.
    const kept = 8000;
    const recent = (await manager.getRecentText('s1', kept + 1)).text.split('\n');
    expect(recent.at(-1)).toBe('END');
    expect(recent.slice(0, -1)).toEqual(
      Array.from({ length: kept }, (_, i) => label('f', FLOOD_EVENTS - kept + i))
    );

    // And it goes on following what comes next.
    fs.appendFileSync(file, event(100, '\r\nnext'));
    await vi.waitFor(
      async () => expect((await manager?.getRecentText('s1', 1))?.text).toBe('next'),
      { timeout: 2000, interval: 50 }
    );
  });

  it('shows output written right after the terminal was built, with no later write', async () => {
    const file = writeLongSession('s1');
    manager = new TerminalManager(controlDir as string);
    await manager.getTerminal('s1');

    // Before the watcher has settled: fs.watch on macOS reported nothing for this one.
    fs.appendFileSync(file, event(50, 'idle'));

    await vi.waitFor(
      async () => expect((await manager?.getRecentText('s1', 1))?.text).toBe('idle'),
      { timeout: 3000, interval: 50 }
    );
  });
});
