import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { SessionManager } from '../pty/session-manager.js';
import { CAST_CLIENT_REPLAY_MAX_BYTES, CAST_REPLAY_MAX_BYTES } from '../utils/cast-tail.js';
import { CastOutputHub, type CastOutputHubEvent } from './cast-output-hub.js';

const HEADER = JSON.stringify({ version: 2, width: 48, height: 20 });

/**
 * 2026-11-02: the live-follow tests waited seconds for the 1 s poll and for the gone-session
 * grace. They now run the hub with a short poll (`pollMs`) and wait for the polls themselves:
 * every read the hub starts goes through readNewOutput, so a spy on it shows when the poll has
 * had its chances (and settled) instead of a fixed sleep that only guesses it.
 */
type HubInternals = {
  readNewOutput(sessionId: string, watcherInfo: unknown): Promise<void>;
  activeWatchers: Map<string, unknown>;
};
const POLL_MS = 50;

function spyReads(hub: CastOutputHub) {
  const reads = vi.spyOn(hub as unknown as HubInternals, 'readNewOutput');
  return {
    /** Reads of `sessionId` started after `since` calls; resolves once they all finished. */
    async waitForReads(sessionId: string, count: number, since = 0) {
      await vi.waitFor(
        () =>
          expect(
            reads.mock.calls.slice(since).filter(([id]) => id === sessionId).length
          ).toBeGreaterThanOrEqual(count),
        { timeout: 10_000, interval: 10 }
      );
      await Promise.all(reads.mock.results.map((result) => result.value));
    },
    reads,
  };
}
const OLD = JSON.stringify([0.1, 'o', 'stale screen']);
// Claude Code clears and redraws the whole screen in a single write.
const CLEAR_AND_REDRAW = JSON.stringify([0.2, 'o', 'tail\x1b[2J\x1b[Hcurrent screen']);
const AFTER = JSON.stringify([0.3, 'o', ' + typing']);

describe('CastOutputHub replay', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, RM_TEST_DIR);
    tmpDir = null;
  });

  async function replay(lastClearOffset: (content: string) => number): Promise<string> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const content = [HEADER, OLD, CLEAR_AND_REDRAW, AFTER, ''].join('\n');
    fs.writeFileSync(stdoutPath, content);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: lastClearOffset(content) }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;

    const hub = new CastOutputHub(sessionManager);
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = hub.subscribe('s1', (event) => events.push(event));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
    unsubscribe();

    return events
      .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
      .map((e) => e.data)
      .join('');
  }

  it.each([
    ['from the start of the file', () => 0],
    // The writer records the clear position inside the event's JSON line.
    ['from a stored offset inside the clearing event', (c: string) => c.indexOf('\\u001b[2J')],
  ])('replays the frame drawn after the last clear %s', async (_name, offset) => {
    const output = await replay(offset);

    expect(output).toBe('\x1b[Hcurrent screen + typing');
  });

  /**
   * A compacted cast (native/ut-fwd/src/cast_compact.rs, 2026-10-22): its old middle is a hole
   * of NUL bytes cut mid-line on both sides, and the saved clear may point into it.
   */
  it.each([
    ['a tail shorter than the replay window', 50, 1024 * 1024],
    ['a tail longer than the replay window', 30_000, 40 * 1024 * 1024],
  ])(
    'replays a compacted cast with %s, the clear saved inside its hole',
    async (_name, events, clearBack) => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
      const stdoutPath = path.join(tmpDir, 'stdout');
      const hole = 64 * 1024 * 1024;
      const tail = Array.from({ length: events }, (_, n) =>
        JSON.stringify([1 + n / 1000, 'o', `\x1b[Hframe ${n} ${'─'.repeat(60)}`])
      );
      const fd = fs.openSync(stdoutPath, 'w');
      try {
        fs.writeSync(fd, `${HEADER}\n[0.1,"o","the line the hole st`);
        fs.ftruncateSync(fd, hole);
        fs.writeSync(fd, `arts in and the one it ends in"]\n${tail.join('\n')}\n`, hole);
      } finally {
        fs.closeSync(fd);
      }
      const sessionManager = {
        getSessionPaths: () => ({ stdoutPath }),
        loadSessionInfo: () => ({ lastClearOffset: hole - clearBack }),
        saveSessionInfo: vi.fn(),
      } as unknown as SessionManager;

      const received: CastOutputHubEvent[] = [];
      const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (e) =>
        received.push(e)
      );
      await vi.waitFor(() => expect(received.some((e) => e.kind === 'header')).toBe(true));
      unsubscribe();

      const output = received
        .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
        .map((e) => e.data)
        .join('');
      expect(output).not.toContain('\0');
      expect(output).not.toContain('hole');
      expect(output.endsWith(`frame ${events - 1} ${'─'.repeat(60)}`)).toBe(true);
      if (events === 50) expect(output.startsWith('\x1b[Hframe 0 ')).toBe(true);
    }
  );

  it('ignores a stored clear offset past the end of the file', async () => {
    // Saved against a longer cast (a forwarder restarted under the same id truncates it):
    // clamped to the size, it left nothing to replay and a reconnect showed no history.
    const output = await replay((c) => Buffer.byteLength(c) + 900 * 1024 * 1024);

    expect(output).toBe('\x1b[Hcurrent screen + typing');
  });

  it('restores terminal modes the app set before the replayed clear', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, [HEADER, CLEAR_AND_REDRAW, ''].join('\n'));
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({
        lastClearOffset: 0,
        terminalModes: { '1000': true, '1006': true },
      }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;

    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
    unsubscribe();

    const outputs = events
      .filter((e) => e.kind === 'output')
      .map((e) => (e as { data: string }).data);
    expect(outputs).toEqual(['\x1b[?1000h\x1b[?1006h', '\x1b[Hcurrent screen']);
  });

  describe('a session this server does not run (Mac window, no tracked modes)', () => {
    // User report 2026-10-14: Claude Code's fullscreen renderer turns mouse reporting on at
    // start, before its first clear. A phone opening a Mac-window session replayed from the
    // clear, never learned it, and scrolling up took Claude's pinned prompt off screen.
    const START = JSON.stringify([0.05, 'o', '\x1b[?1049h\x1b[?1000h\x1b[?1006h']);
    const TYPED = JSON.stringify([0.07, 'i', '\x1bc']);
    const clearAt = (content: string) => content.lastIndexOf('\\u001b[2J');

    /** Replays `lines` as session.json says, which the replay may update (castModes). */
    async function replayForwarded(
      lines: string[],
      info: Record<string, unknown>
    ): Promise<{ outputs: string[]; saved: Record<string, unknown>; content: string }> {
      tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
      const stdoutPath = path.join(tmpDir, 'stdout');
      const content = [...lines, ''].join('\n');
      fs.writeFileSync(stdoutPath, content);
      let saved: Record<string, unknown> = { lastClearOffset: clearAt(content), ...info };
      const sessionManager = {
        getSessionPaths: () => ({ stdoutPath }),
        loadSessionInfo: () => structuredClone(saved),
        saveSessionInfo: (_id: string, next: Record<string, unknown>) => {
          saved = structuredClone(next);
        },
      } as unknown as SessionManager;
      const events: CastOutputHubEvent[] = [];
      const unsubscribe = new CastOutputHub(sessionManager).subscribe('fwd_1_2', (e) =>
        events.push(e)
      );
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'replay-end')).toBe(true));
      unsubscribe();
      const outputs = events
        .filter((e) => e.kind === 'output')
        .map((e) => (e as { data: string }).data);
      return { outputs, saved, content };
    }

    it('reads the modes from the history before the saved clear', async () => {
      const { outputs } = await replayForwarded(
        [HEADER, START, TYPED, OLD, CLEAR_AND_REDRAW, AFTER],
        { status: 'running' }
      );
      expect(outputs).toEqual(['\x1b[?1000h\x1b[?1006h', '\x1b[Hcurrent screen + typing']);
    });

    it('reads them from the scanned range and from the clearing write itself', async () => {
      const clearing = JSON.stringify([0.2, 'o', '\x1b[?2004h\x1b[2J\x1b[Hcurrent screen']);
      const { outputs } = await replayForwarded([HEADER, START, OLD, clearing, AFTER], {
        status: 'running',
        lastClearOffset: 0,
      });
      expect(outputs).toEqual([
        '\x1b[?1000h\x1b[?1006h\x1b[?2004h',
        '\x1b[Hcurrent screen + typing',
      ]);
    });

    it('reads on from where the last replay stopped, and again from the start of a new cast', async () => {
      const header = JSON.stringify({ version: 2, width: 48, height: 20, timestamp: 1 });
      const off = JSON.stringify([0.4, 'o', '\x1b[?1000l\x1b[?1006l']);
      const redraw = JSON.stringify([0.5, 'o', '\x1b[2J\x1b[Hlater screen']);
      const first = await replayForwarded([header, START, OLD, CLEAR_AND_REDRAW], {
        status: 'running',
      });
      expect(first.outputs[0]).toBe('\x1b[?1000h\x1b[?1006h');
      const castModes = first.saved.castModes as { cast: string; offset: number };
      expect(castModes).toMatchObject({ cast: '1', modes: { '1000': true, '1006': true } });
      expect(first.content.slice(castModes.offset)).toMatch(/^\[0\.2,"o"/);

      // What was read is not read again: modes saved as read so far stand for the start.
      const second = await replayForwarded([header, START, OLD, CLEAR_AND_REDRAW, off, redraw], {
        status: 'running',
        castModes: { ...castModes, modes: { '2004': true } },
      });
      expect(second.outputs).toEqual(['\x1b[?1000l\x1b[?1006l\x1b[?2004h', '\x1b[Hlater screen']);

      // A forwarder restarted under the same id writes a new cast (another header).
      const header2 = JSON.stringify({ version: 2, width: 48, height: 20, timestamp: 2 });
      const third = await replayForwarded([header2, START, CLEAR_AND_REDRAW], {
        status: 'running',
        castModes: { ...castModes, offset: 10, modes: { '2004': true } },
      });
      expect(third.outputs).toEqual(['\x1b[?1000h\x1b[?1006h', '\x1b[Hcurrent screen']);
    });

    it('restores nothing once it has exited', async () => {
      const { outputs } = await replayForwarded([HEADER, START, OLD, CLEAR_AND_REDRAW], {
        status: 'exited',
      });
      expect(outputs).toEqual(['\x1b[Hcurrent screen']);
    });
  });

  it('restores no terminal modes for a session that has exited', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, [HEADER, CLEAR_AND_REDRAW, ''].join('\n'));
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      // Marked exited by the zombie scan: its modes were never cleared.
      loadSessionInfo: () => ({
        lastClearOffset: 0,
        status: 'exited',
        terminalModes: { '1000': true, '1006': true },
      }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;

    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
    unsubscribe();

    const outputs = events
      .filter((e) => e.kind === 'output')
      .map((e) => (e as { data: string }).data);
    expect(outputs).toEqual(['\x1b[Hcurrent screen']);
  });

  it('replays from the saved clear at the size set before it, not the header size', async () => {
    // 2026-10-14: a Claude session resized from 120 to 84 columns, then cleared; its replay
    // from the saved clear went out with the header's 120 columns and drew the screen torn.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const resize = JSON.stringify([0.15, 'r', '84x30']);
    const content = [HEADER, OLD, resize, CLEAR_AND_REDRAW, AFTER, ''].join('\n');
    fs.writeFileSync(stdoutPath, content);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: content.indexOf('\\u001b[2J') }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;

    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'replay-end')).toBe(true));
    unsubscribe();

    const header = events.find((e) => e.kind === 'header') as
      | { header: { width: number; height: number } }
      | undefined;
    expect(header?.header).toMatchObject({ width: 84, height: 30 });
    const outputs = events
      .filter((e) => e.kind === 'output')
      .map((e) => (e as { data: string }).data)
      .join('');
    expect(outputs).toBe('\x1b[Hcurrent screen + typing');
  });
});

describe('CastOutputHub live follow', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, RM_TEST_DIR);
    tmpDir = null;
  });

  it('keeps a UTF-8 character that one read splits in two', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, `${HEADER}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const live: string[] = [];
    const hub = new CastOutputHub(sessionManager, { pollMs: POLL_MS });
    const { reads, waitForReads } = spyReads(hub);
    const unsubscribe = hub.subscribe('s1', (event) => {
      if (event.kind === 'output' && !event.historical) live.push(event.data);
    });
    try {
      const fd = fs.openSync(stdoutPath, 'a');
      // Once a line arrives live, the watcher is armed (its very first change can be missed).
      await vi.waitFor(
        () => {
          if (live.length === 0) fs.writeSync(fd, `${JSON.stringify([0.1, 'o', 'ready'])}\n`);
          expect(live.length).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 100 }
      );
      // Every read under way is over (a second ready line was delivered by now if any).
      await waitForReads('s1', 2, reads.mock.calls.length);
      live.length = 0;

      const line = Buffer.from(`${JSON.stringify([0.5, 'o', '╭─ résumé ─╮'])}\n`);
      const split = line.indexOf(Buffer.from('╭')) + 1; // inside the 3-byte box character
      fs.writeSync(fd, line.subarray(0, split));
      // The first half was read on its own: two reads began after it and finished (2026-11-02:
      // was a 200 ms sleep).
      await waitForReads('s1', 2, reads.mock.calls.length);
      fs.writeSync(fd, line.subarray(split));
      fs.closeSync(fd);

      await vi.waitFor(() => expect(live).toEqual(['╭─ résumé ─╮']), { timeout: 10_000 });
    } finally {
      unsubscribe();
    }
  });

  it('delivers output written right after subscribing, with no later write', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, `${HEADER}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const live: string[] = [];
    // The poll is what catches this write; a short one keeps the test about that, not its pace.
    const hub = new CastOutputHub(sessionManager, { pollMs: POLL_MS });
    const unsubscribe = hub.subscribe('s1', (event) => {
      if (event.kind === 'output' && !event.historical) live.push(event.data);
    });
    try {
      // Before the watcher has settled: fs.watch on macOS reports nothing for this one.
      fs.appendFileSync(stdoutPath, `${JSON.stringify([0.1, 'o', 'idle'])}\n`);

      await vi.waitFor(() => expect(live).toEqual(['idle']), { timeout: 3000, interval: 50 });
    } finally {
      unsubscribe();
    }
  });

  it('resets its clients and replays the new content when the cast shrinks', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const lines = (word: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${JSON.stringify([i, 'o', `<${word} ${i}>`])}\n`);
    fs.writeFileSync(stdoutPath, [`${HEADER}\n`, ...lines('old', 40)].join(''));
    const newContent = [`${HEADER}\n`, ...lines('new', 10)].join('');
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      // Saved against the old content, inside the new one's size.
      loadSessionInfo: () => ({ lastClearOffset: Buffer.byteLength(newContent) - 20 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (event) =>
      events.push(event)
    );
    try {
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
      events.length = 0;

      // A forwarder restarted under the same id truncates the cast and writes it anew.
      fs.writeFileSync(stdoutPath, newContent);
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true), {
        timeout: 3000,
      });
      fs.appendFileSync(stdoutPath, `${JSON.stringify([11, 'o', '<live>'])}\n`);

      const outputs = () =>
        events.filter((e) => e.kind === 'output').map((e) => (e as { data: string }).data);
      await vi.waitFor(() => expect(outputs().at(-1)).toBe('<live>'), { timeout: 3000 });
      expect(outputs()).toEqual([
        '\x1bc',
        Array.from({ length: 10 }, (_, i) => `<new ${i}>`).join(''),
        '<live>',
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('replays a history of many short events in a few large chunks', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const lines = [HEADER];
    let expected = '';
    for (let i = 0; i < 100_000; i++) {
      const data = `${i % 1000}\r\n`;
      expected += data;
      lines.push(JSON.stringify([i / 1000, 'o', data]));
    }
    lines.push(JSON.stringify([101, 'r', '50x20']));
    lines.push(JSON.stringify([102, 'o', 'after']));
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const hub = new CastOutputHub(sessionManager);
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = hub.subscribe('s1', (event) => events.push(event));
    try {
      await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('replay-end'), { timeout: 5000 });
      // 2026-10-04: one event (one WebSocket frame) per cast line, 100k of them for 500 KB.
      const kinds = events.map((e) => e.kind);
      expect(kinds.filter((kind) => kind === 'output').length).toBeLessThanOrEqual(4);
      // In order, and the resize between them still where it was.
      const outputs = events.filter(
        (e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output'
      );
      expect(outputs.at(-1)?.data).toBe('after');
      expect(
        outputs
          .slice(0, -1)
          .map((e) => e.data)
          .join('')
      ).toBe(expected);
      expect(kinds.slice(-3)).toEqual(['resize', 'output', 'replay-end']);
    } finally {
      unsubscribe();
    }
  });

  it('does not log an error every second once the cast is deleted', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, `${HEADER}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: CastOutputHubEvent[] = [];
    const hub = new CastOutputHub(sessionManager, { pollMs: POLL_MS });
    const { reads, waitForReads } = spyReads(hub);
    const unsubscribe = hub.subscribe('s1', (e) => events.push(e));
    try {
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
      // A session cleaned up while a phone still follows it.
      fs.rmSync(stdoutPath);
      // Several polls (one a second in production) found the cast missing and finished.
      await waitForReads('s1', 5, reads.mock.calls.length);

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      consoleError.mockRestore();
    }
  });

  it('tells its clients the session exited and stops following once its folder is deleted', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const dir = tmpDir;
    // s2 is a session that stays: its polls show when s1's would have run.
    for (const id of ['s1', 's2']) {
      fs.mkdirSync(path.join(dir, id));
      fs.writeFileSync(path.join(dir, id, 'stdout'), `${HEADER}\n`);
    }
    const sessionManager = {
      getSessionPaths: (id: string) => ({ stdoutPath: path.join(dir, id, 'stdout') }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new CastOutputHub(sessionManager, { goneGraceMs: 300, pollMs: POLL_MS });
    const { reads, waitForReads } = spyReads(hub);
    const watchers = (hub as unknown as HubInternals).activeWatchers;
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = hub.subscribe('s1', (e) => events.push(e));
    const unsubscribeOther = hub.subscribe('s2', () => {});
    try {
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
      // 2026-10-24: DELETE /api/sessions/:id or a finished task removes the whole folder.
      fs.rmSync(path.join(dir, 's1'), RM_TEST_DIR);

      await vi.waitFor(() => expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1), {
        timeout: 10_000,
      });
      expect(watchers.has('s1')).toBe(false);
      // Polls of the other session went on: none of them read s1 or told it exited again.
      const stoppedAt = reads.mock.calls.length;
      await waitForReads('s2', 5, stoppedAt);
      expect(reads.mock.calls.slice(stoppedAt).filter(([id]) => id === 's1')).toEqual([]);
      expect(events.filter((e) => e.kind === 'exit')).toHaveLength(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      unsubscribeOther();
      consoleError.mockRestore();
    }
  });

  it('goes on following a session whose folder is made again under the same id', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const sessionDir = path.join(tmpDir, 's1');
    fs.mkdirSync(sessionDir);
    const stdoutPath = path.join(sessionDir, 'stdout');
    fs.writeFileSync(stdoutPath, `${HEADER}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const goneGraceMs = 3000;
    const hub = new CastOutputHub(sessionManager, { goneGraceMs, pollMs: POLL_MS });
    const { reads, waitForReads } = spyReads(hub);
    const events: CastOutputHubEvent[] = [];
    // 2026-11-02: the clock the grace is measured on is fake and stands still unless moved, so
    // the grace neither runs out early under load nor takes real seconds to pass; the polls
    // and files stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const unsubscribe = hub.subscribe('s1', (e) => events.push(e));
    try {
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
      fs.rmSync(sessionDir, RM_TEST_DIR);
      // Polls ran on the missing folder: its grace started.
      await waitForReads('s1', 2, reads.mock.calls.length);
      expect(events.some((e) => e.kind === 'exit')).toBe(false);
      fs.mkdirSync(sessionDir);
      fs.writeFileSync(stdoutPath, `${HEADER}\n${JSON.stringify([0.1, 'o', 'again'])}\n`);

      await vi.waitFor(
        () => expect(events.some((e) => e.kind === 'output' && e.data === 'again')).toBe(true),
        { timeout: 10_000 }
      );
      // Past the end of the grace, and polls ran after it: the session was not declared gone.
      vi.setSystemTime(Date.now() + goneGraceMs + 1000);
      await waitForReads('s1', 3, reads.mock.calls.length);
      expect(events.some((e) => e.kind === 'exit')).toBe(false);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it('follows a session that fell far behind from a whole event near the end', async () => {
    // The live read took all new bytes at once: a 540 MB burst (a sparse hole of NUL bytes
    // here, no disk used) was one buffer and one string past V8's limit, so it threw and
    // every line in it, the last frames too, was lost.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    fs.writeFileSync(stdoutPath, `${HEADER}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const replayMaxBytes = 64 * 1024;
    const live: string[] = [];
    const errors: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager, { replayMaxBytes }).subscribe(
      's1',
      (event) => {
        if (event.kind === 'output' && !event.historical) live.push(event.data);
        if (event.kind === 'error') errors.push(event);
      }
    );
    try {
      const fd = fs.openSync(stdoutPath, 'r+');
      await vi.waitFor(
        () => {
          if (live.length === 0) {
            fs.writeSync(fd, `${JSON.stringify([0.1, 'o', 'ready'])}\n`, fs.fstatSync(fd).size);
          }
          expect(live.length).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 100 }
      );
      live.length = 0;

      const frames: string[] = [];
      for (let n = 1; n <= 2000; n++) frames.push(`\x1b[H<frame ${n} ─ é>${'x'.repeat(60)}\x1b[K`);
      const data = Buffer.from(
        `\n${frames.map((frame, i) => JSON.stringify([1 + i, 'o', frame])).join('\n')}\n`
      );
      expect(data.length).toBeGreaterThan(2 * replayMaxBytes);
      // One write past the end: the hole and the frames arrive together.
      fs.writeSync(fd, data, 0, data.length, fs.fstatSync(fd).size + 540 * 1024 * 1024);
      fs.closeSync(fd);

      await vi.waitFor(() => expect(live.at(-1)).toBe(frames.at(-1)), { timeout: 5000 });
      // Whole events only, in order, ending with the last one, no more than the window.
      expect(frames.slice(-live.length)).toEqual(live);
      expect(Buffer.byteLength(live.join(''))).toBeLessThanOrEqual(replayMaxBytes);
      expect(errors).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});

describe('CastOutputHub subscribe while the session is writing', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, RM_TEST_DIR);
    tmpDir = null;
  });

  async function subscribeDuringWrites(subscribers: number): Promise<number[][]> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    // Enough history that the replay read spans many ticks.
    const filler = 'x'.repeat(200);
    const lines = [HEADER];
    let next = 0;
    for (; next < 20000; next++) lines.push(JSON.stringify([next, 'o', `<${next}:${filler}>`]));
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    // All of it replayed (4 MB, past the client budget): every event is counted.
    const hub = new CastOutputHub(sessionManager, { historyMaxBytes: CAST_REPLAY_MAX_BYTES });

    const fd = fs.openSync(stdoutPath, 'a');
    const writeSome = () => {
      for (let i = 0; i < 20; i++, next++) {
        fs.writeSync(fd, `${JSON.stringify([next, 'o', `<${next}:${filler}>`])}\n`);
      }
    };

    const received: number[][] = [];
    const unsubscribes: Array<() => void> = [];
    for (let s = 0; s < subscribers; s++) {
      const seen: number[] = [];
      received.push(seen);
      unsubscribes.push(
        hub.subscribe('s1', (event) => {
          if (event.kind !== 'output') return;
          for (const m of event.data.matchAll(/<(\d+):/g)) seen.push(Number(m[1]));
        })
      );
      writeSome();
    }
    // Keep writing while the replays are still being read.
    for (let i = 0; i < 30; i++) {
      writeSome();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fs.closeSync(fd);
    const total = next;
    await vi.waitFor(
      () => {
        for (const seen of received) expect(seen.length).toBeGreaterThanOrEqual(total);
      },
      { timeout: 5000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const unsubscribe of unsubscribes) unsubscribe();
    return received;
  }

  it('delivers history then live output once each, in order', async () => {
    const received = await subscribeDuringWrites(2);
    for (const seen of received) {
      const expected = Array.from({ length: seen.length }, (_, i) => i);
      expect(seen.length).toBeGreaterThan(20000);
      expect(seen).toEqual(expected);
    }
  });
});

describe('CastOutputHub replay of a cast too big for memory', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, RM_TEST_DIR);
    tmpDir = null;
  });

  it('replays only the end of the history, from a whole event, at the size in effect there', async () => {
    // 2026-10-04: 430 MB after the last clear were all kept in memory and queued on the
    // socket. A 600 MB hole of NUL bytes (sparse: no disk used) stands for that history.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const hole = 600 * 1024 * 1024;
    const replayMaxBytes = 64 * 1024;
    const frames: string[] = [];
    for (let n = 1; n <= 2000; n++) frames.push(`\x1b[H<frame ${n} ─ é>${'x'.repeat(60)}\x1b[K`);
    const tail = [
      JSON.stringify([1, 'r', '91x33']),
      ...frames.map((data, i) => JSON.stringify([2 + i, 'o', data])),
    ];
    const fd = fs.openSync(stdoutPath, 'w');
    fs.writeSync(fd, `${HEADER}\n`);
    fs.ftruncateSync(fd, hole);
    const data = Buffer.from(`\n${tail.join('\n')}\n`);
    fs.writeSync(fd, data, 0, data.length, hole);
    fs.closeSync(fd);
    expect(data.length).toBeGreaterThan(2 * replayMaxBytes);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager, { replayMaxBytes }).subscribe(
      's1',
      (event) => events.push(event)
    );
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'header')).toBe(true));
    unsubscribe();

    const header = events.find((e) => e.kind === 'header');
    expect(header).toMatchObject({ header: { width: 91, height: 33 } });
    const outputs = events
      .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
      .map((e) => e.data);
    // Whole events only, ending with the last one, and no more than the window.
    // (Joined into larger chunks for the socket, so compared as text.)
    expect(outputs.length).toBeGreaterThan(0);
    const replayed = outputs.join('');
    const whole = frames.findIndex((_, i) => frames.slice(i).join('') === replayed);
    expect(whole).toBeGreaterThan(0);
    expect(Buffer.byteLength(outputs.join(''))).toBeLessThanOrEqual(replayMaxBytes);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('opens a long session within the client replay budget (perf budget)', async () => {
    // User report 2026-10-14: «Cargando historial» was slow to go away. A new subscriber got
    // the last 16 MB of the cast, all written before its screen was painted, where its
    // terminal keeps only the last few hundred rows. 50 MB of TUI repaints stand for the cast.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hub-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const repaint = (n: number) =>
      `\x1b[H\x1b[2K\x1b[38;2;200;100;50m⏺ línea ${n}\x1b[0m ${'x'.repeat(120)}\r\n`;
    const lines = [HEADER];
    let size = 0;
    for (let n = 0; size < 50 * 1024 * 1024; n++) {
      const line = JSON.stringify([
        n / 100,
        n % 500 === 0 ? 'r' : 'o',
        n % 500 === 0 ? '91x33' : repaint(n),
      ]);
      lines.push(line);
      size += line.length + 1;
    }
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;

    const started = performance.now();
    const events: CastOutputHubEvent[] = [];
    const unsubscribe = new CastOutputHub(sessionManager).subscribe('s1', (e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'replay-end')).toBe(true), {
      timeout: 10_000,
    });
    const elapsed = performance.now() - started;
    unsubscribe();

    const replayed = events
      .filter((e): e is Extract<CastOutputHubEvent, { kind: 'output' }> => e.kind === 'output')
      .map((e) => e.data)
      .join('');
    expect(CAST_CLIENT_REPLAY_MAX_BYTES).toBeLessThan(CAST_REPLAY_MAX_BYTES);
    expect(Buffer.byteLength(replayed)).toBeLessThanOrEqual(CAST_CLIENT_REPLAY_MAX_BYTES);
    // The newest output, ending with the last repaint.
    expect(replayed.endsWith(JSON.parse(lines.at(-1) as string)[2])).toBe(true);
    // About 60 ms on an M-series Mac (16 MB took about 250 ms); loose for slower machines.
    expect(elapsed).toBeLessThan(2000);
  }, 30_000);
});
