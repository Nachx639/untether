import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { TerminalManager } from './terminal-manager.js';

// The real ghostty-web and its WASM: the test setup mocks the module for unit tests.
vi.unmock('ghostty-web');

/**
 * 2026-10-04: a long Claude Code session's 1 GB cast could not be read into one string
 * ("Cannot create a string longer than 0x1fffffe8 characters"), so its server-side terminal
 * (/text, previews, the Claude menu reader, pushes) had no screen at all. These casts have a
 * 600 MB hole of NUL bytes in the middle (a sparse file: no disk used) standing for that
 * history; only their last part, written by a full-screen app repainting itself, matters.
 */
const HOLE_BYTES = 600 * 1024 * 1024;
const REPLAY_MAX_BYTES = 256 * 1024;
const FRAMES = 3000;

/** One full repaint of a full-screen app: every row redrawn in place, no clear. */
function frame(n: number, rows: number): string {
  let out = '\x1b[H';
  for (let row = 0; row < rows; row++) out += `\x1b[${row + 1};1Hframe ${n} row ${row} ─ é\x1b[K`;
  return out;
}

function expectedScreen(n: number, rows: number): string[] {
  return Array.from({ length: rows }, (_, row) => `frame ${n} row ${row} ─ é`);
}

describe('TerminalManager on a cast too big for a string', () => {
  let controlDir: string | null = null;
  let manager: TerminalManager | null = null;

  afterEach(() => {
    manager?.destroy();
    manager = null;
    if (controlDir) fs.rmSync(controlDir, RM_TEST_DIR);
    controlDir = null;
  });

  /** Header 50x12, the hole, then (optionally) a resize and FRAMES repaints at that size. */
  function writeBigCast(sessionId: string, resize?: { cols: number; rows: number }): string {
    controlDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ut-big-cast-'));
    const dir = path.join(controlDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'stdout');
    const rows = resize?.rows ?? 12;
    const tail: string[] = [];
    if (resize) tail.push(JSON.stringify([1, 'r', `${resize.cols}x${resize.rows}`]));
    for (let n = 1; n <= FRAMES; n++) tail.push(JSON.stringify([1 + n / 100, 'o', frame(n, rows)]));

    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, `${JSON.stringify({ version: 2, width: 50, height: 12 })}\n`);
      fs.ftruncateSync(fd, HOLE_BYTES);
      const data = Buffer.from(`\n${tail.join('\n')}\n`);
      fs.writeSync(fd, data, 0, data.length, HOLE_BYTES);
    } finally {
      fs.closeSync(fd);
    }
    // The tail is bigger than the replay window, so the window starts inside it.
    expect(fs.statSync(file).size - HOLE_BYTES).toBeGreaterThan(2 * REPLAY_MAX_BYTES);
    return file;
  }

  function screenOf(snapshot: { cells: { char: string }[][] }): string[] {
    return snapshot.cells.map((row) =>
      row
        .map((cell) => cell.char)
        .join('')
        .trimEnd()
    );
  }

  it('rebuilds the final screen from the end of the cast, at the size the header gives', async () => {
    writeBigCast('s1');
    manager = new TerminalManager(controlDir as string, { castReplayMaxBytes: REPLAY_MAX_BYTES });

    const recent = await manager.getRecentText('s1', 12);

    expect({ cols: recent.cols, rows: recent.rows }).toEqual({ cols: 50, rows: 12 });
    expect(recent.text.split('\n')).toEqual(expectedScreen(FRAMES, 12));
    expect(screenOf(await manager.getBufferSnapshot('s1')).slice(0, 12)).toEqual(
      expectedScreen(FRAMES, 12)
    );
  });

  it('uses the last resize before the replayed part', async () => {
    writeBigCast('s1', { cols: 60, rows: 14 });
    manager = new TerminalManager(controlDir as string, { castReplayMaxBytes: REPLAY_MAX_BYTES });

    const recent = await manager.getRecentText('s1', 14);

    expect({ cols: recent.cols, rows: recent.rows }).toEqual({ cols: 60, rows: 14 });
    expect(recent.text.split('\n')).toEqual(expectedScreen(FRAMES, 14));
  });

  it('follows output written afterwards, a character split across two writes included', async () => {
    const file = writeBigCast('s1');
    manager = new TerminalManager(controlDir as string, { castReplayMaxBytes: REPLAY_MAX_BYTES });
    await manager.getTerminal('s1');

    const line = Buffer.from(`${JSON.stringify([99, 'o', frame(FRAMES + 1, 12)])}\n`);
    const split = line.indexOf(Buffer.from('é')) + 1;
    fs.appendFileSync(file, line.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.appendFileSync(file, line.subarray(split));

    await vi.waitFor(
      async () =>
        expect((await manager?.getRecentText('s1', 12))?.text.split('\n')).toEqual(
          expectedScreen(FRAMES + 1, 12)
        ),
      { timeout: 3000 }
    );
  });

  it('builds the plain-text fallback snapshot from the end of the cast', async () => {
    writeBigCast('s1');
    manager = new TerminalManager(controlDir as string, { castReplayMaxBytes: REPLAY_MAX_BYTES });
    const internals = manager as unknown as {
      buildFallbackSnapshot(id: string): Promise<{ cols: number; cells: { char: string }[][] }>;
    };

    const fallback = await internals.buildFallbackSnapshot('s1');

    expect(fallback.cols).toBe(50);
    expect(screenOf(fallback).join('\n')).toContain('frame ');
  });
});
