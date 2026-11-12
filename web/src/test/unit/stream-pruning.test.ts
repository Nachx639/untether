import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../server/pty/session-manager.js';
import type { AsciinemaHeader } from '../../server/pty/types.js';
import { CastOutputHub } from '../../server/services/cast-output-hub.js';
import {
  mockAsciinemaNoClears,
  mockAsciinemaWithClearMidLine,
  mockAsciinemaWithClears,
} from '../fixtures/test-data.js';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

// Type for asciinema events used in tests
type TestAsciinemaEvent = [number | 'exit', string | number, string?];

describe('CastOutputHub - Asciinema Stream Pruning', () => {
  let castOutputHub: CastOutputHub;
  let tempDir: string;
  let sessionManager: SessionManager;

  beforeEach(() => {
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-pruning-test-'));
    sessionManager = new SessionManager(tempDir);
    castOutputHub = new CastOutputHub(sessionManager);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, RM_TEST_DIR);
  });

  function ensureSessionInfo(sessionId: string) {
    sessionManager.createSessionDirectory(sessionId);
    sessionManager.saveSessionInfo(sessionId, {
      id: sessionId,
      name: 'test',
      command: ['bash'],
      workingDir: tempDir,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastClearOffset: 0,
    });
  }

  // Helper to create test asciinema file (writes to session stdout path)
  function createTestFile(
    filename: string,
    header: AsciinemaHeader,
    events: TestAsciinemaEvent[]
  ): string {
    const sessionId = filename.replace(/\.cast$/, '');
    ensureSessionInfo(sessionId);
    const paths = sessionManager.getSessionPaths(sessionId, true);
    if (!paths) throw new Error('session paths not found');

    const filepath = paths.stdoutPath;
    const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))];
    fs.writeFileSync(filepath, `${lines.join('\n')}\n`);
    return filepath;
  }

  /**
   * The replay of a session's existing content, up to the hub's replay-end (or an error).
   * 2026-11-02: this slept a fixed 250 ms (3 s for the real-world cast) and took whatever had
   * arrived; it now waits for the replay to say it is over, with a generous deadline.
   */
  async function collectExistingEvents(sessionId: string) {
    const events: Array<
      | { kind: 'header'; header: AsciinemaHeader }
      | { kind: 'output'; data: string }
      | { kind: 'resize'; dimensions: string }
      | { kind: 'exit'; exitCode: number }
      | { kind: 'error'; message: string }
    > = [];

    let finished = false;
    const unsubscribe = castOutputHub.subscribe(sessionId, (event) => {
      if (event.kind === 'replay-end' || event.kind === 'error') finished = true;
      // normalize to make tests simple
      if (event.kind === 'header') events.push({ kind: 'header', header: event.header });
      else if (event.kind === 'output') events.push({ kind: 'output', data: event.data });
      else if (event.kind === 'resize')
        events.push({ kind: 'resize', dimensions: event.dimensions });
      else if (event.kind === 'exit') events.push({ kind: 'exit', exitCode: event.exitCode });
      else if (event.kind === 'error') events.push({ kind: 'error', message: event.message });
    });

    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 10_000, interval: 10 });
    unsubscribe();
    return events;
  }

  it('should prune content before the last clear sequence', async () => {
    createTestFile(
      'with-clears.cast',
      mockAsciinemaWithClears.header as AsciinemaHeader,
      mockAsciinemaWithClears.events as TestAsciinemaEvent[]
    );

    const events = await collectExistingEvents('with-clears');

    const headerEvent = events.find((e) => e.kind === 'header') as
      | { kind: 'header'; header: AsciinemaHeader }
      | undefined;
    expect(headerEvent).toBeTruthy();

    // Header should be updated to last resize before the last clear
    const header = headerEvent?.header as AsciinemaHeader;
    expect(header.version).toBe(2);
    expect(header.width).toBe(100); // From last resize before clear
    expect(header.height).toBe(30);

    // Should only have content after the last clear
    const outputEvents = events.filter((e) => e.kind === 'output') as Array<{
      kind: 'output';
      data: string;
    }>;
    // The cursor-home written after the clear in the same event, then lines 9, 10, 11. A
    // replay joins consecutive output into large chunks, so compare the joined text.
    const replayed = outputEvents.map((e) => e.data).join('');
    expect(replayed.startsWith('\u001b[H')).toBe(true);
    for (const pruned of ['Line 1:', 'Line 5:', 'Line 7:']) expect(replayed).not.toContain(pruned);
    const order = [
      'Line 9: Final content',
      'Line 10: This should be visible',
      'Line 11: Last line',
    ];
    expect(order.map((line) => replayed.indexOf(line))).toEqual(
      order.map((line) => replayed.indexOf(line)).sort((a, b) => a - b)
    );
    for (const line of order) expect(replayed).toContain(line);

    // Should have exit event
    const exitEvent = events.find((e) => e.kind === 'exit');
    expect(exitEvent).toBeDefined();
  });

  it('should handle clear sequence in middle of line', async () => {
    createTestFile(
      'clear-mid-line.cast',
      mockAsciinemaWithClearMidLine.header as AsciinemaHeader,
      mockAsciinemaWithClearMidLine.events as TestAsciinemaEvent[]
    );

    // Only content after the clear, including the rest of the line that cleared
    const events = await collectExistingEvents('clear-mid-line');
    const outputEvents = events.filter((e) => e.kind === 'output') as Array<{
      kind: 'output';
      data: string;
    }>;
    const replayed = outputEvents.map((e) => e.data).join('');
    expect(replayed.startsWith(' in the middle')).toBe(true);
    expect(replayed).toContain('After clear');
  });

  it('should not prune streams without clear sequences', async () => {
    createTestFile(
      'no-clears.cast',
      mockAsciinemaNoClears.header as AsciinemaHeader,
      mockAsciinemaNoClears.events as TestAsciinemaEvent[]
    );

    // Should have all events
    const events = await collectExistingEvents('no-clears');
    const outputEvents = events.filter((e) => e.kind === 'output') as Array<{
      kind: 'output';
      data: string;
    }>;
    const replayed = outputEvents.map((e) => e.data).join(''); // All 3 lines, in order
    const lines = ['Line 1: No clears', 'Line 2: Just regular', 'Line 3: Should replay'];
    for (const line of lines) expect(replayed).toContain(line);
    expect(replayed.indexOf(lines[0])).toBeLessThan(replayed.indexOf(lines[1]));
    expect(replayed.indexOf(lines[1])).toBeLessThan(replayed.indexOf(lines[2]));
  });

  it('should surface errors for missing sessions', async () => {
    const events = await collectExistingEvents('does-not-exist');
    const error = events.find((e) => e.kind === 'error') as
      | { kind: 'error'; message: string }
      | undefined;
    expect(error).toBeTruthy();
  });

  // A synthetic recording with the shape of a Claude Code session: a shell, the welcome banner, a
  // turn, resizes, typed input and four full clears (Ctrl+R in and out of the transcript), with
  // the output after the last one cut mid-line as a PTY delivers it.
  it('should handle a Claude session with multiple clears', async () => {
    const fixturePath = path.join(
      __dirname,
      '../fixtures/asciinema/claude-session-with-clears.cast'
    );
    ensureSessionInfo('claude-clears');
    const paths = sessionManager.getSessionPaths('claude-clears', true);
    if (!paths) throw new Error('session paths not found');
    fs.copyFileSync(fixturePath, paths.stdoutPath);

    const events = await collectExistingEvents('claude-clears');

    // Should have pruned everything before the last clear
    expect(events.length).toBeGreaterThan(0);

    // First event should be header
    const headerEvent = events.find((e) => e.kind === 'header') as
      | { kind: 'header'; header: AsciinemaHeader }
      | undefined;
    expect(headerEvent).toBeTruthy();
    const header = headerEvent?.header as AsciinemaHeader;
    expect(header.version).toBe(2);

    // Check that we're getting content after the last clear
    const outputEvents = events.filter((e) => e.kind === 'output') as Array<{
      kind: 'output';
      data: string;
    }>;
    expect(outputEvents.length).toBeGreaterThan(0);

    // The file has 4 clear sequences, we should only see content after the last one
    // Check that we have the welcome banner (appears after the last clear)
    const welcomeContent = outputEvents.map((e) => e.data).join('');
    // Strip ANSI escape sequences for easier testing
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are necessary for terminal output
    const cleanContent = welcomeContent.replace(/\u001b\[[^m]*m/g, '');
    expect(cleanContent).toContain('Welcome to Claude Code');
    expect(cleanContent).toContain('/help for help');

    // We should NOT see content from before the clears
    expect(cleanContent).not.toContain('Some previous Claude output');
    expect(cleanContent).not.toContain('cd workspaces'); // This was at the beginning
  });
});
