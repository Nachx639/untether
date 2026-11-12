import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  castReplayStart,
  findLastResizeBefore,
  findLineStart,
  forEachCastLine,
  readCastHeaderLine,
  scanCastModeSequences,
} from './cast-tail.js';

const HEADER = JSON.stringify({ version: 2, width: 50, height: 12 });

describe('cast-tail', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, RM_TEST_DIR);
    tmpDir = null;
  });

  /** A cast of `count` output events full of 3-byte characters, and each line's end offset. */
  function writeCast(count: number): { file: string; lines: string[]; ends: number[] } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tail-'));
    const file = path.join(tmpDir, 'stdout');
    const lines = [HEADER];
    for (let i = 0; i < count; i++) {
      lines.push(JSON.stringify([i / 10, 'o', `${i} ╭${'─'.repeat(97 + (i % 13))}╮ é\r\n`]));
    }
    const ends: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offset += Buffer.byteLength(line) + 1;
      ends.push(offset);
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return { file, lines, ends };
  }

  it('reads the header line on its own', async () => {
    const { file, ends } = writeCast(10);

    expect(await readCastHeaderLine(file)).toEqual({ line: HEADER, end: ends[0] });
  });

  it('starts a cut replay on the first whole line inside the window', async () => {
    const { file, ends } = writeCast(5000);
    const size = fs.statSync(file).size;

    for (const maxBytes of [1000, 4097, 65_537, 300_001]) {
      const { start, truncated } = await castReplayStart(file, ends[0], size, maxBytes);
      expect(truncated).toBe(true);
      // A line start (just after a newline), never before the window.
      expect(ends).toContain(start);
      expect(start).toBeGreaterThanOrEqual(size - maxBytes);
      expect(ends.filter((end) => end >= size - maxBytes)[0]).toBe(start);
    }
  });

  it('replays everything that fits, and prefers the last clear inside the window', async () => {
    const { file, ends } = writeCast(1000);
    const size = fs.statSync(file).size;

    expect(await castReplayStart(file, ends[0], size, size)).toEqual({
      start: ends[0],
      truncated: false,
    });
    // A clear offset points inside its event's line: the replay starts at that line.
    const clearLineStart = ends[990];
    expect(await castReplayStart(file, ends[0], size, 5000, clearLineStart + 20)).toEqual({
      start: clearLineStart,
      truncated: true,
    });
    // One before the window does not pull the replay back past it.
    const early = await castReplayStart(file, ends[0], size, 5000, ends[10] + 20);
    expect(early.start).toBeGreaterThanOrEqual(size - 5000);
  });

  it('streams whole lines, with characters split across reads kept intact', async () => {
    // Bigger than one 256 KB read, so lines and 3-byte characters straddle chunk boundaries.
    const { file, lines, ends } = writeCast(8000);
    const size = fs.statSync(file).size;
    expect(size).toBeGreaterThan(3 * 256 * 1024);

    const seen: string[] = [];
    const seenEnds: number[] = [];
    const end = await forEachCastLine(file, 0, size, (line, lineEnd) => {
      seen.push(line);
      seenEnds.push(lineEnd);
    });

    expect(end).toBe(size);
    expect(seen).toEqual(lines);
    expect(seenEnds).toEqual(ends);
  });

  it('leaves a half-written last line for the next read', async () => {
    const { file, lines, ends } = writeCast(3);
    fs.appendFileSync(file, '[9.9,"o","half');
    const seen: string[] = [];

    const end = await forEachCastLine(file, ends[0], fs.statSync(file).size, (line) =>
      seen.push(line)
    );

    expect(seen).toEqual(lines.slice(1));
    expect(end).toBe(ends[3]);
  });

  it('finds the size in effect before an offset', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tail-'));
    const file = path.join(tmpDir, 'stdout');
    // Output that quotes a resize-looking text is escaped and must not count.
    const filler = JSON.stringify([1, 'o', 'x'.repeat(3 * 1024 * 1024)]);
    const lines = [
      HEADER,
      JSON.stringify([0.5, 'r', '91x33']),
      filler,
      JSON.stringify([2, 'o', ',"r","12x3"]']),
    ];
    const before = Buffer.byteLength(`${lines.join('\n')}\n`);
    lines.push(JSON.stringify([3, 'r', '70x20']));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    expect(await findLastResizeBefore(file, before)).toBe('91x33');
    expect(await findLastResizeBefore(file, fs.statSync(file).size)).toBe('70x20');
    expect(await findLastResizeBefore(file, before, 0, 1024 * 1024)).toBeNull();
  });

  it('finds the mode changes and resets in output events only, in order', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tail-'));
    const file = path.join(tmpDir, 'stdout');
    const lines = [
      HEADER,
      JSON.stringify([0.1, 'o', '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J']),
      // A typed Alt+C and a typed mode sequence are input: never applied.
      JSON.stringify([0.2, 'i', '\x1bc\x1b[?1000l']),
      JSON.stringify([0.3, 'r', '80x24']),
      // Text that only spells an escape (a backslash before u001b) is not one.
      JSON.stringify([0.4, 'o', 'echo \\u001b[?1000l \\\x1b[?2004h']),
      JSON.stringify([0.5, 'o', `${'x'.repeat(300 * 1024)}\x1b[?25l\x1b[?1002;1006h`]),
      JSON.stringify([0.6, 'o', '\x1b[!p\x1bc\x1b[?7l']),
      JSON.stringify(['exit', 0, 'fwd']),
      '',
    ];
    fs.writeFileSync(file, lines.join('\n'));
    const seen: string[] = [];
    const end = await scanCastModeSequences(file, 0, fs.statSync(file).size, (s) => seen.push(s));
    expect(end).toBe(fs.statSync(file).size);
    expect(seen).toEqual([
      '\x1b[?1049h',
      '\x1b[?1000h',
      '\x1b[?1006h',
      '\x1b[?2004h',
      // ESC[?25l (cursor), written around every frame, is left out.
      '\x1b[?1002;1006h',
      '\x1b[!p',
      '\x1bc',
      '\x1b[?7l',
    ]);
  });

  it('finds every sequence wherever the reads cut the lines', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tail-'));
    const file = path.join(tmpDir, 'stdout');
    const lines = [HEADER];
    const expected: string[] = [];
    // Lines of growing length put the sequences and line starts at every offset around
    // the 256 KB reads; one line is longer than a read.
    let pad = 256 * 1024 - 200;
    for (let i = 0; i < 120; i++) {
      const mode = `\x1b[?${1000 + (i % 7)}${i % 2 ? 'l' : 'h'}`;
      const typed = i % 5 === 0;
      lines.push(JSON.stringify([i, typed ? 'i' : 'o', `${'y'.repeat(pad)}${mode}\x1b[31mz`]));
      if (!typed) expected.push(mode);
      pad = i === 60 ? 700 * 1024 : 3 + (i % 9);
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const seen: string[] = [];
    await scanCastModeSequences(file, 0, fs.statSync(file).size, (s) => seen.push(s));
    expect(seen).toEqual(expected);
  });

  /**
   * A compacted cast (native/ut-fwd/src/cast_compact.rs, 2026-10-22): its old middle is a hole
   * of NUL bytes cut on 4 KB blocks, so it starts and ends mid-line.
   */
  describe('a compacted cast', () => {
    function punch(file: string, from: number, to: number) {
      const fd = fs.openSync(file, 'r+');
      try {
        fs.writeSync(fd, Buffer.alloc(to - from), 0, to - from, from);
      } finally {
        fs.closeSync(fd);
      }
    }

    it('drops the lines a hole cuts and streams every whole line around it', async () => {
      const { file, lines, ends } = writeCast(3000);
      const size = fs.statSync(file).size;
      const holeStart = 4096;
      const holeEnd = 40 * 4096;
      // Both edges mid-line, as the block-aligned punch leaves them.
      expect(ends).not.toContain(holeStart);
      expect(ends).not.toContain(holeEnd);
      punch(file, holeStart, holeEnd);

      const seen: string[] = [];
      const seenEnds: number[] = [];
      const end = await forEachCastLine(file, 0, size, (line, lineEnd) => {
        seen.push(line);
        seenEnds.push(lineEnd);
      });

      const kept = lines.filter(
        (_, i) => ends[i] <= holeStart || ends[i] - Buffer.byteLength(lines[i]) - 1 >= holeEnd
      );
      expect(seen).toEqual(kept);
      expect(seenEnds).toEqual(ends.filter((_, i) => kept.includes(lines[i])));
      for (const line of seen) expect(() => JSON.parse(line)).not.toThrow();
      expect(end).toBe(size);
    });

    it('finds line starts without searching back through the hole', () => {
      const { file, ends } = writeCast(3000);
      const holeStart = 4096;
      const holeEnd = 40 * 4096;
      punch(file, holeStart, holeEnd);
      const firstWhole = ends.find((end) => end > holeEnd) as number;

      // Inside the hole: no line there, the offset itself.
      expect(findLineStart(file, holeStart + 5000)).toBe(holeStart + 5000);
      // In the rest of the line the hole cut: the hole's end (a line the readers drop).
      expect(findLineStart(file, firstWhole - 1)).toBe(holeEnd);
      // Past it, as usual.
      expect(findLineStart(file, firstWhole + 1)).toBe(firstWhole);
    });

    it('streams the tail past a hole of hundreds of MB without gathering it', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-tail-'));
      const file = path.join(tmpDir, 'stdout');
      const hole = 300 * 1024 * 1024;
      const tail = Array.from({ length: 50 }, (_, i) => JSON.stringify([i, 'o', `tail ${i}`]));
      const fd = fs.openSync(file, 'w');
      try {
        fs.writeSync(fd, `${HEADER}\n[0.1,"o","the line the hole st`);
        fs.ftruncateSync(fd, hole); // sparse: no disk used
        fs.writeSync(fd, `arts in and the one it ends in"]\n${tail.join('\n')}\n`, hole);
      } finally {
        fs.closeSync(fd);
      }
      const size = fs.statSync(file).size;
      const longest = { length: 0 };
      const seen: string[] = [];

      const end = await forEachCastLine(file, 0, size, (line) => {
        seen.push(line);
        longest.length = Math.max(longest.length, line.length);
      });

      expect(seen).toEqual([HEADER, ...tail]);
      expect(longest.length).toBeLessThan(1000);
      expect(end).toBe(size);
      expect(findLineStart(file, hole / 2)).toBe(hole / 2);
    });
  });
});
