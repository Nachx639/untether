import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { builtForwarder } from '../../test/utils/built-forwarder.js';

// The real ghostty-web and its WASM (snapshots draw the screen with it): the test setup mocks it.
vi.unmock('ghostty-web');

import type { Session } from '../../shared/types.js';
import type { SessionManager } from '../pty/session-manager.js';
import { CastOutputHub, type CastOutputHubEvent } from './cast-output-hub.js';
import { bigCastsCheck, compactCastsWithForwarder, controlDirCheck } from './doctor-checks.js';
import {
  type CastCompactor,
  diskBytes,
  FINISHED_KEEP_BYTES,
  ROTATION_STATE_FILE,
  rotationLimits,
  snapshotBytes,
  trimFinishedRecordings,
  writeIntoHole,
} from './session-recordings.js';

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const HEADER = JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 1_700_000_000 });

/**
 * Stands in for `untether-fwd --compact-cast` where cargo did not build it: the same range as
 * cast_compact.rs punch_range (punch_range_until given a hole end), zeroed in place (reads
 * return NULs, as from a hole).
 */
const zeroingCompactor: CastCompactor = async (files, capBytes, keepBytes, holeEnd) => {
  const results = new Map<string, { punched?: number; error?: string }>();
  for (const file of files) {
    const content = fs.readFileSync(file);
    if (diskBytes(file) <= capBytes) {
      results.set(file, { punched: 0 });
      continue;
    }
    const block = Number(fs.statfsSync(file).bsize);
    const headerEnd = content.indexOf(0x0a) + 1;
    const start = Math.ceil(headerEnd / block) * block;
    const end =
      holeEnd === undefined
        ? Math.floor(Math.max(0, content.length - keepBytes) / block) * block
        : Math.floor(Math.min(holeEnd, content.length) / block) * block;
    if (end <= start) {
      results.set(file, { punched: 0 });
      continue;
    }
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(end - start), 0, end - start, start);
    fs.closeSync(fd);
    results.set(file, { punched: end - start });
  }
  return results;
};

// The real forwarder, when this checkout built it from its current sources.
const forwarder = builtForwarder();

function frame(n: number, time = 1 + n / 1000): string {
  return JSON.stringify([time, 'o', `\x1b[Hframe ${n} ${'─'.repeat(80)}`]);
}

/** The event lines of the snapshot at `at`: up to the NUL that ends it. */
function snapshotLines(file: string, at: number): string[] {
  const content = fs.readFileSync(file);
  return content.toString('utf8', at, content.indexOf(0, at)).split('\n').filter(Boolean);
}

function outputOf(events: CastOutputHubEvent[]): string {
  return events
    .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
    .map((e) => e.data)
    .join('');
}

describe('session recordings', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-recordings-'));
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  /** A live cast: 120x40 and mouse reporting + bracketed paste set at its start, then frames. */
  function writeLiveCast(id: string, frames: number): string {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    const file = path.join(dir, id, 'stdout');
    // The size and modes are set past the first block (which the hole never takes, being
    // the header's), as an app does once it started.
    const lines = [
      HEADER,
      ...Array.from({ length: 100 }, (_, n) => frame(n, 0.01)),
      JSON.stringify([0.1, 'r', '120x40']),
      JSON.stringify([0.2, 'o', '\x1b[?1000h\x1b[?1006h\x1b[?2004h']),
      ...Array.from({ length: frames }, (_, n) => frame(1000 + n)),
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  }

  function hubFor(file: string, options = {}) {
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath: file }),
      // A session this server does not run: its modes are read from the cast.
      loadSessionInfo: () => ({ status: 'running' }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    return new CastOutputHub(sessionManager, options);
  }

  describe('rotation of live casts', () => {
    it('keeps the size: at least a whole replay, at most half the cap', () => {
      expect(rotationLimits(undefined)).toEqual({ rotateBytes: 64 * MB, keepBytes: 32 * MB });
      expect(rotationLimits({ rotateMB: 128 })).toEqual({
        rotateBytes: 128 * MB,
        keepBytes: 64 * MB,
      });
      // Under a replay window plus room: raised.
      expect(rotationLimits({ rotateMB: 4 }).keepBytes).toBeGreaterThanOrEqual(24 * MB);
    });

    it('rotates with a client connected: it goes on receiving, in order, and a new one replays size and modes from the snapshot', async () => {
      const file = writeLiveCast('11111111-live', 30_000); // about 8 MB
      const hub = hubFor(file, { historyMaxBytes: 64 * 1024 });
      const live: CastOutputHubEvent[] = [];
      const unsubscribe = hub.subscribe('s1', (event) => live.push(event));
      await vi.waitFor(() => expect(live.some((e) => e.kind === 'header')).toBe(true));

      const log = vi.fn();
      const check = bigCastsCheck({
        controlDir: dir,
        compact: zeroingCompactor,
        limits: () => ({ rotateBytes: 2 * MB, keepBytes: MB }),
        log,
      });
      // The writer goes on appending while the rotation runs.
      let next = 100_000;
      const writer = setInterval(() => {
        fs.appendFileSync(file, `${frame(next++)}\n`);
      }, 2);
      try {
        await check.run();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        clearInterval(writer);
      }
      const last = next - 1;
      fs.appendFileSync(file, `${frame(next)}\n`);
      await vi.waitFor(() => expect(outputOf(live)).toContain(`frame ${next} `), {
        timeout: 5000,
      });
      unsubscribe();

      // The connected client saw every frame written after it joined, once each, in order.
      const seen = [...outputOf(live).matchAll(/frame (\d+) /g)].map((match) => Number(match[1]));
      const fromJoin = seen.slice(seen.indexOf(100_000));
      expect(fromJoin).toEqual(Array.from({ length: next - 100_000 + 1 }, (_, n) => 100_000 + n));
      expect(outputOf(live)).not.toContain('\0');
      expect(last).toBeGreaterThan(100_000);

      // The snapshot sits right before the tail; the old start is gone.
      const content = fs.readFileSync(file);
      expect(content.subarray(0, HEADER.length).toString()).toBe(HEADER);
      expect(content.includes(Buffer.from('frame 1100 '))).toBe(false);
      expect(content.includes(Buffer.from('[0.2,"o","\\u001b[?1000h'))).toBe(false);
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, '11111111-live', ROTATION_STATE_FILE), 'utf8')
      );
      expect(state.size).toBe('120x40');
      const snapshot = snapshotLines(file, state.snapshotAt);
      expect(snapshot[0]).toMatch(/^\[[\d.]+,"r","120x40"\]$/);
      // The screen drawn again, then the modes.
      expect(JSON.parse(snapshot[1])[2]).toContain('\x1b[H\x1b[2J');
      expect(JSON.parse(snapshot[2])[2]).toContain('\x1b[?1000h');

      // A client opening it now: its replay starts in the tail, the size and modes the app set
      // at the start (punched out) come from the snapshot.
      const fresh: CastOutputHubEvent[] = [];
      const stop = hubFor(file, { historyMaxBytes: 64 * 1024 }).subscribe('s2', (event) =>
        fresh.push(event)
      );
      // Until the replay reached the last frame, not just its header: under load (2026-11-02,
      // load 78) the output came after the header and the test read an empty replay.
      await vi.waitFor(() => expect(outputOf(fresh)).toContain(`frame ${next} `), {
        timeout: 5000,
      });
      stop();
      const header = fresh.find((e) => e.kind === 'header') as Extract<
        CastOutputHubEvent,
        { kind: 'header' }
      >;
      expect(`${header.header.width}x${header.header.height}`).toBe('120x40');
      const replayed = outputOf(fresh);
      expect(replayed).toContain('\x1b[?1000h');
      expect(replayed).toContain('\x1b[?2004h');
      expect(replayed).toContain(`frame ${next} `);
      expect(replayed).not.toContain('\0');
    });

    it('carries the state over a second rotation through the previous snapshot', async () => {
      const file = writeLiveCast('22222222-twice', 30_000);
      const check = bigCastsCheck({
        controlDir: dir,
        compact: zeroingCompactor,
        limits: () => ({ rotateBytes: 2 * MB, keepBytes: MB }),
      });
      // The zeroing stand-in frees no disk: only the snapshot is looked at.
      await check.run();
      const first = JSON.parse(
        fs.readFileSync(path.join(dir, '22222222-twice', ROTATION_STATE_FILE), 'utf8')
      );
      // Bracketed paste goes off later; the start (mouse on, 120x40) is long punched out.
      const more = Array.from({ length: 30_000 }, (_, n) => frame(40_000 + n));
      more.splice(10, 0, JSON.stringify([50, 'o', '\x1b[?2004l']));
      fs.appendFileSync(file, `${more.join('\n')}\n`);
      // The zeroing stand-in frees no disk: only the snapshot is looked at.
      await check.run();
      const second = JSON.parse(
        fs.readFileSync(path.join(dir, '22222222-twice', ROTATION_STATE_FILE), 'utf8')
      );
      expect(second.snapshotAt).toBeGreaterThan(first.snapshotAt);
      const snapshot = snapshotLines(file, second.snapshotAt).join('\n');
      expect(snapshot).toContain('"r","120x40"');
      expect(snapshot).toContain('?1000h');
      expect(snapshot).toContain('?2004l');
    });

    it('ends the hole where the snapshot was taken, whatever the writer appends meanwhile', async () => {
      const file = writeLiveCast('44444444-race', 30_000);
      // Between the plan and the punch the app resizes and turns bracketed paste off, in more
      // than a block of output: with the hole ended `keep` before the new size these were
      // punched out and the snapshot's older state stood in for them.
      const racing: CastCompactor = async (files, cap, keep, holeEnd) => {
        const late = [
          JSON.stringify([500, 'r', '100x30']),
          JSON.stringify([500.1, 'o', '\x1b[?2004l']),
          ...Array.from({ length: 200 }, (_, n) => frame(200_000 + n, 501)),
        ];
        fs.appendFileSync(file, `${late.join('\n')}\n`);
        return zeroingCompactor(files, cap, keep, holeEnd);
      };
      await bigCastsCheck({
        controlDir: dir,
        compact: racing,
        limits: () => ({ rotateBytes: 2 * MB, keepBytes: MB }),
      }).run();
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain('[500,"r","100x30"]');
      expect(content).toContain('\\u001b[?2004l');
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, '44444444-race', ROTATION_STATE_FILE), 'utf8')
      );
      // The snapshot is the state where the hole ends, before the late events.
      expect(state.size).toBe('120x40');
      expect(state.snapshotAt).toBeLessThan(content.indexOf('[500,"r","100x30"]'));
      // A client replaying from the snapshot gets the late state last.
      const fresh: CastOutputHubEvent[] = [];
      const stop = hubFor(file, { historyMaxBytes: 2 * MB }).subscribe('s', (event) =>
        fresh.push(event)
      );
      await vi.waitFor(() => expect(fresh.some((e) => e.kind === 'replay-end')).toBe(true));
      stop();
      const resizes = fresh
        .filter((e) => e.kind === 'resize')
        .map((e) => (e as { dimensions: string }).dimensions);
      expect(resizes.at(-1)).toBe('100x30');
    });

    it('keeps on screen what was drawn before the tail and never redrawn since', async () => {
      // A TUI that draws a title bar once, then only updates its bottom line, for 8 MB.
      fs.mkdirSync(path.join(dir, '55555555-static'));
      const file = path.join(dir, '55555555-static', 'stdout');
      const lines = [
        HEADER,
        // Past the header's block, which no hole takes.
        ...Array.from({ length: 100 }, (_, n) => frame(n, 0.01)),
        JSON.stringify([0.1, 'r', '60x10']),
        JSON.stringify([
          0.2,
          'o',
          '\x1b[H\x1b[2J\x1b[1;37;44m TITLE BAR DRAWN ONCE \x1b[0m\r\nsecond row',
        ]),
        ...Array.from({ length: 60_000 }, (_, n) =>
          JSON.stringify([1 + n / 1000, 'o', `\x1b[10;1Hstatus ${n} ${'.'.repeat(40)}\x1b[K`])
        ),
      ];
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      await bigCastsCheck({
        controlDir: dir,
        compact: zeroingCompactor,
        limits: () => ({ rotateBytes: 2 * MB, keepBytes: MB }),
      }).run();
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('[0.2,"o"');
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, '55555555-static', ROTATION_STATE_FILE), 'utf8')
      );
      const screenLine = snapshotLines(file, state.snapshotAt)[1];
      const [, kind, screen] = JSON.parse(screenLine) as [number, string, string];
      expect(kind).toBe('o');
      expect(screen.startsWith('\x1b[0m\x1b[H\x1b[2J')).toBe(true);
      expect(screen).toContain('TITLE BAR DRAWN ONCE');
      expect(screen).toContain('second row');
      // Its colours too (white on blue, bold).
      expect(screen.replaceAll('\x1b', 'ESC')).toMatch(/ESC\[0;1;38;2;[\d;]+;48;2;[\d;]+m TITLE/);

      // A client opening it now gets the title bar back, though the tail never drew it.
      const fresh: CastOutputHubEvent[] = [];
      const stop = hubFor(file, { historyMaxBytes: 2 * MB }).subscribe('s', (event) =>
        fresh.push(event)
      );
      await vi.waitFor(() => expect(fresh.some((e) => e.kind === 'replay-end')).toBe(true));
      stop();
      expect(outputOf(fresh)).toContain('TITLE BAR DRAWN ONCE');
      expect(outputOf(fresh)).toContain('status 59999 ');
    });

    it('keeps a title bar drawn far before the cut, past any replay window, on a first rotation', async () => {
      // 2026-11-01 review: rebuilt from the last 16 MB only, a title drawn before them was lost.
      fs.mkdirSync(path.join(dir, '66666666-far'));
      const file = path.join(dir, '66666666-far', 'stdout');
      const fd = fs.openSync(file, 'w');
      fs.writeSync(
        fd,
        `${[
          HEADER,
          ...Array.from({ length: 100 }, (_, n) => frame(n, 0.01)),
          JSON.stringify([0.1, 'r', '60x10']),
          JSON.stringify([0.2, 'o', '\x1b[H\x1b[2J FAR TITLE \r\n']),
        ].join('\n')}\n`
      );
      const batch = (from: number) =>
        Array.from(
          { length: 10_000 },
          (_, n) =>
            `${JSON.stringify([1 + (from + n) / 1000, 'o', `\x1b[10;1Hstatus ${from + n} ${'.'.repeat(40)}\x1b[K`])}\n`
        ).join('');
      for (let from = 0; from < 300_000; from += 10_000) fs.writeSync(fd, batch(from));
      fs.closeSync(fd);
      expect(fs.statSync(file).size).toBeGreaterThan(20 * MB);
      await bigCastsCheck({
        controlDir: dir,
        compact: zeroingCompactor,
        limits: () => ({ rotateBytes: 2 * MB, keepBytes: MB }),
      }).run();
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, '66666666-far', ROTATION_STATE_FILE), 'utf8')
      );
      const screen = JSON.parse(snapshotLines(file, state.snapshotAt)[1])[2] as string;
      expect(screen).toContain('FAR TITLE');
      expect(screen).toContain('status ');
    }, 60_000);

    it('ends with the style in effect at the cut, for a tail that writes on in it', async () => {
      const { createHeadlessTerminal } = await import('./terminal-manager.js');
      const { serializeScreen } = await import('./session-recordings.js');
      const source = await createHeadlessTerminal(20, 4);
      const copy = await createHeadlessTerminal(20, 4);
      try {
        // Bold red set before the cut; the tail writes "abc" without setting it again.
        source.write('plain \x1b[1;31mred');
        copy.write(serializeScreen(source));
        copy.write('abc');
        copy.update();
        const cells = copy.getViewport();
        // "plain red" then "abc" from column 9.
        const a = { ...cells[9] };
        const p = { ...cells[0] };
        expect(String.fromCodePoint(a.codepoint)).toBe('a');
        expect(a.flags).toBe(p.flags | 1); // BOLD
        expect([a.fg_r, a.fg_g, a.fg_b]).not.toEqual([p.fg_r, p.fg_g, p.fg_b]);
        // And "red" itself drawn in it, "plain" not.
        expect(cells[6].flags & 1).toBe(1);
        expect(p.flags & 1).toBe(0);
      } finally {
        source.free();
        copy.free();
      }
    });

    it('draws the scrollback before the screen so it lands in history, the screen in place', async () => {
      const { createHeadlessTerminal } = await import('./terminal-manager.js');
      const { serializeScreen } = await import('./session-recordings.js');
      const source = await createHeadlessTerminal(20, 4);
      const copy = await createHeadlessTerminal(20, 4);
      try {
        const text = (terminal: typeof source) => {
          terminal.update();
          const viewport = terminal.getViewport();
          return Array.from({ length: terminal.rows }, (_, row) =>
            viewport
              .slice(row * terminal.cols, (row + 1) * terminal.cols)
              .map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '))
              .join('')
              .trimEnd()
          );
        };
        source.write(Array.from({ length: 10 }, (_, n) => `line ${n}`).join('\r\n'));
        source.write('\x1b[2;3H');
        const scrollbackLength = source.getScrollbackLength();
        const sourceText = text(source);
        copy.write(serializeScreen(source));
        expect(text(copy)).toEqual(sourceText);
        expect(copy.getCursor()).toMatchObject({ x: 2, y: 1 });
        expect(copy.getScrollbackLength()).toBe(scrollbackLength);
      } finally {
        source.free();
        copy.free();
      }
    });

    it('never writes a snapshot over data: the end of the hole must be empty', () => {
      const file = path.join(dir, 'cast');
      fs.writeFileSync(file, Buffer.alloc(8192, 0x41));
      const { bytes } = snapshotBytes({
        offset: 0,
        time: 1,
        size: '80x24',
        modes: { 1000: true },
        screen: 'x',
      });
      expect(writeIntoHole(file, 0, 8192, bytes)).toBe(false);
      expect(fs.readFileSync(file).every((byte) => byte === 0x41)).toBe(true);
    });

    it.skipIf(!forwarder)(
      'rotates a real cast with the forwarder: disk freed, size, header and tail kept, snapshot in the hole',
      async () => {
        const file = writeLiveCast('33333333-real', 30_000);
        const before = fs.readFileSync(file);
        const check = bigCastsCheck({
          controlDir: dir,
          compact: compactCastsWithForwarder(() => [forwarder as string]),
          limits: () => ({ rotateBytes: 2 * MB, keepBytes: MB }),
        });
        expect(await check.run()).toEqual([]);
        const after = fs.readFileSync(file);
        expect(after.length).toBe(before.length);
        expect(diskBytes(file)).toBeLessThanOrEqual(2 * MB);
        expect(after.subarray(-MB).equals(before.subarray(-MB))).toBe(true);
        const state = JSON.parse(
          fs.readFileSync(path.join(dir, '33333333-real', ROTATION_STATE_FILE), 'utf8')
        );
        expect(after.toString('utf8', state.snapshotAt, state.snapshotAt + 40)).toMatch(
          /^\[[\d.]+,"r","120x40"\]/
        );
      }
    );
  });

  describe('finished sessions', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');

    function session(id: string, fields: Partial<Session>, ageDays: number): Session {
      const sessionDir = path.join(dir, id);
      fs.mkdirSync(sessionDir, { recursive: true });
      const at = new Date(now - ageDays * DAY);
      const lines = [
        HEADER,
        JSON.stringify([0.1, 'r', '132x50']),
        ...Array.from({ length: 12_000 }, (_, n) => frame(n)),
        JSON.stringify([99, 'o', 'the last screen']),
      ];
      fs.writeFileSync(path.join(sessionDir, 'stdout'), `${lines.join('\n')}\n`);
      fs.writeFileSync(
        path.join(sessionDir, 'session.json'),
        JSON.stringify({ id, name: `title ${id}`, claudeSessionId: `claude-${id}` })
      );
      fs.utimesSync(path.join(sessionDir, 'stdout'), at, at);
      fs.utimesSync(path.join(sessionDir, 'session.json'), at, at);
      return {
        id,
        name: `title ${id}`,
        command: ['claude'],
        workingDir: dir,
        status: 'exited',
        startedAt: at.toISOString(),
        lastModified: at.toISOString(),
        claudeSessionId: `claude-${id}`,
        ...fields,
      } as Session;
    }

    it('trims old finished recordings to their last screen and respects the exceptions', async () => {
      const sessions = [
        session('old-plain', {}, 5),
        session(
          'old-suspended',
          { suspended: { claudeSessionId: 'x' } as Session['suspended'] },
          5
        ),
        session('old-tmux-lost', { shielded: true, shieldEnd: 'tmux-lost' }, 5),
        session('old-task', {}, 5),
        session('old-running', { status: 'running', shielded: true }, 5),
        session('recent', {}, 1),
      ];
      const sizes = new Map(
        sessions.map((s) => [s.id, fs.statSync(path.join(dir, s.id, 'stdout')).size])
      );
      const mtime = fs.statSync(path.join(dir, 'old-plain', 'stdout')).mtimeMs;

      const result = await trimFinishedRecordings({
        controlPath: dir,
        listSessions: () => sessions,
        settings: () => ({ finishedDays: 2 }),
        keep: (s) => s.id === 'old-task',
        now: () => now,
      });

      expect(result.trimmed).toEqual(['old-plain']);
      expect(result.freedBytes).toBeGreaterThan(MB);
      for (const id of ['old-suspended', 'old-tmux-lost', 'old-task', 'old-running', 'recent']) {
        expect(fs.statSync(path.join(dir, id, 'stdout')).size, id).toBe(sizes.get(id));
      }
      const file = path.join(dir, 'old-plain', 'stdout');
      const trimmed = fs.readFileSync(file, 'utf8');
      expect(trimmed.length).toBeLessThanOrEqual(FINISHED_KEEP_BYTES + 4096);
      const [header, notice] = trimmed.split('\n');
      expect(JSON.parse(header)).toMatchObject({
        width: 132,
        height: 50,
        timestamp: 1_700_000_000,
      });
      expect(notice).toContain('removed 2 day(s) after it finished');
      expect(trimmed.endsWith(`${JSON.stringify([99, 'o', 'the last screen'])}\n`)).toBe(true);
      // Every line a whole event.
      for (const line of trimmed.trim().split('\n').slice(1))
        expect(() => JSON.parse(line)).not.toThrow();
      // Its time, title and ids stay: lists, History and "Reanudar Claude" read them.
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, 'old-plain', 'session.json'), 'utf8'))
      ).toEqual({
        id: 'old-plain',
        name: 'title old-plain',
        claudeSessionId: 'claude-old-plain',
      });

      // Trimmed once: the next run leaves it.
      const again = await trimFinishedRecordings({
        controlPath: dir,
        listSessions: () => sessions,
        settings: () => ({ finishedDays: 2 }),
        now: () => now,
      });
      expect(again.trimmed).not.toContain('old-plain');
    });

    it('trims younger finished recordings, oldest first, while they take over half of controlWarnGB (2026-11-02)', async () => {
      const sessions = [
        session('half-day', {}, 0.5),
        session('third-day', {}, 0.3),
        session('fifth-day', {}, 0.2),
        session('just-now', {}, 0.005),
      ];
      const each = fs.statSync(path.join(dir, 'half-day', 'stdout')).size;
      const result = await trimFinishedRecordings({
        controlPath: dir,
        listSessions: () => sessions,
        // Budget: half of the warning, room for about one and a half recordings.
        settings: () => ({ finishedDays: 2, controlWarnGB: (each * 3) / 1024 ** 3 }),
        now: () => now,
      });
      // Oldest first, until what is left fits; one finished minutes ago is never touched.
      expect(result.trimmed).toEqual(['half-day', 'third-day']);
      expect(fs.statSync(path.join(dir, 'fifth-day', 'stdout')).size).toBe(each);
      expect(fs.statSync(path.join(dir, 'just-now', 'stdout')).size).toBe(each);
      expect(fs.readFileSync(path.join(dir, 'half-day', 'stdout'), 'utf8')).toContain(
        'to keep the disk use in bounds'
      );
    });

    it('trims nothing with finishedDays 0', async () => {
      const sessions = [session('old', {}, 30)];
      const result = await trimFinishedRecordings({
        controlPath: dir,
        listSessions: () => sessions,
        settings: () => ({ finishedDays: 0 }),
        now: () => now,
      });
      expect(result.trimmed).toEqual([]);
    });
  });

  describe('the doctor on the control dir', () => {
    it('says nothing under the threshold and what uses it over', async () => {
      fs.mkdirSync(path.join(dir, 'aaaaaaaa-live'));
      fs.writeFileSync(path.join(dir, 'aaaaaaaa-live', 'stdout'), Buffer.alloc(3 * MB, 1));
      fs.mkdirSync(path.join(dir, 'bbbbbbbb-done'));
      fs.writeFileSync(path.join(dir, 'bbbbbbbb-done', 'stdout'), Buffer.alloc(2 * MB, 1));
      fs.mkdirSync(path.join(dir, 'uploads'));
      fs.writeFileSync(path.join(dir, 'uploads', 'a.png'), Buffer.alloc(MB, 1));
      const sessions = () => [
        { id: 'aaaaaaaa-live', name: 'orquestador', status: 'running' as const },
        { id: 'bbbbbbbb-done', name: 'tarea', status: 'exited' as const },
      ];
      expect(
        await controlDirCheck({ controlDir: dir, warnBytes: () => 100 * MB, sessions }).run()
      ).toEqual([]);
      const found = await controlDirCheck({
        controlDir: dir,
        warnBytes: () => 4 * MB,
        sessions,
      }).run();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ key: 'control-dir:big', severity: 'warning' });
      expect(found[0].problem).toMatch(
        /running or suspended sessions 3 MB, finished 2 MB, the rest 1 MB/
      );
      expect(found[0].problem).toContain('aaaaaaaa «orquestador» (running) 3 MB');
      expect(found[0].problem.indexOf('aaaaaaaa')).toBeLessThan(
        found[0].problem.indexOf('bbbbbbbb')
      );
    });
  });
});
