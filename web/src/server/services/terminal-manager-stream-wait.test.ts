import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { TerminalManager } from './terminal-manager.js';

/**
 * 2026-11-02: the poll (one read a second in production) is shortened here, so tests that wait
 * on it, or prove it stopped, see several polls in a fraction of a second.
 */
const WATCH_POLL_MS = 50;

type Internals = {
  terminals: Map<string, unknown>;
  watchStreamFile(sessionId: string): Promise<void>;
  readNewOutput(...args: unknown[]): Promise<void>;
  destroy(): void;
};

describe('TerminalManager stream file of a brand-new session', () => {
  let dir: string;
  let manager: Internals | undefined;
  afterEach(() => {
    manager?.destroy();
    manager = undefined;
    rmSync(dir, RM_TEST_DIR);
  });

  it('waits for the cast file instead of leaving the screen empty for good', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-tm-'));
    manager = new TerminalManager(dir) as unknown as Internals;
    const written: string[] = [];
    const terminal = {
      write: (data: string) => written.push(data),
      resize: () => {},
      close: () => {},
      free: () => {},
    };
    manager.terminals.set('s1', { terminal, ghostty: {}, lastUpdate: Date.now() });

    // The terminal is asked for before the session wrote its first byte.
    await manager.watchStreamFile('s1');
    expect(written).toEqual([]);

    mkdirSync(path.join(dir, 's1'));
    writeFileSync(
      path.join(dir, 's1', 'stdout'),
      '{"version":2,"width":80,"height":24}\n[0.1,"o","hola"]\n'
    );
    await vi.waitFor(() => expect(written.join('')).toContain('hola'), { timeout: 2000 });
  });

  it('goes on from where it stopped when its watcher is set up again', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-tm-'));
    manager = new TerminalManager(dir) as unknown as Internals;
    const written: string[] = [];
    const sessionTerminal: { terminal: unknown; watcher?: { close(): void } } = {
      terminal: {
        write: (data: string) => written.push(data),
        resize: () => {},
        free: () => {},
      },
    };
    manager.terminals.set('s1', sessionTerminal);
    mkdirSync(path.join(dir, 's1'));
    const file = path.join(dir, 's1', 'stdout');
    writeFileSync(file, '{"version":2,"width":80,"height":24}\n[0.1,"o","hola"]\n');
    await manager.watchStreamFile('s1');

    // The watcher is closed (as flow control did until 2026-10-04), output keeps coming.
    sessionTerminal.watcher?.close();
    sessionTerminal.watcher = undefined;
    appendFileSync(file, '[0.2,"o","adiós"]\n');
    await manager.watchStreamFile('s1');

    // Until 2026-10-04 it read the whole file again from the start, writing every line twice.
    await vi.waitFor(() => expect(written.join('')).toBe('holaadiós'), { timeout: 2000 });
  });
});

// 2026-10-24: a terminal whose session folder was deleted kept polling its missing cast and
// logged "Error reading stream file ... ENOENT" every second (~2000 errors in 10 min).
describe('TerminalManager terminal of a session that is gone', () => {
  let dir: string;
  let manager: Internals | undefined;
  afterEach(() => {
    manager?.destroy();
    manager = undefined;
    vi.restoreAllMocks();
    rmSync(dir, RM_TEST_DIR);
  });

  function stubTerminal(written: string[] = []) {
    const free = vi.fn();
    const sessionTerminal: { terminal: unknown; watcher?: unknown; poll?: unknown } = {
      terminal: { write: (data: string) => written.push(data), resize: () => {}, free },
    };
    return { sessionTerminal, free };
  }

  it('closes the terminal without an error and stops reading once the folder is deleted', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-tm-'));
    manager = new TerminalManager(dir, { watchPollMs: WATCH_POLL_MS }) as unknown as Internals;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const written: string[] = [];
    const { sessionTerminal, free } = stubTerminal(written);
    manager.terminals.set('s1', sessionTerminal);
    mkdirSync(path.join(dir, 's1'));
    writeFileSync(
      path.join(dir, 's1', 'stdout'),
      '{"version":2,"width":80,"height":24}\n[0.1,"o","hola"]\n'
    );
    await manager.watchStreamFile('s1');
    await vi.waitFor(() => expect(written.join('')).toBe('hola'), { timeout: 10_000 });
    expect(sessionTerminal.watcher).toBeDefined();
    // A session that stays: its polls show when s1's would have run.
    const other = stubTerminal();
    manager.terminals.set('s2', other.sessionTerminal);
    mkdirSync(path.join(dir, 's2'));
    writeFileSync(path.join(dir, 's2', 'stdout'), '{"version":2,"width":80,"height":24}\n');
    await manager.watchStreamFile('s2');

    // DELETE /api/sessions/:id, or a finished task, removes the whole control folder.
    rmSync(path.join(dir, 's1'), RM_TEST_DIR);

    await vi.waitFor(() => expect(manager?.terminals.has('s1')).toBe(false), { timeout: 10_000 });
    expect(free).toHaveBeenCalledOnce();
    // No watcher event or poll reads it any more, while s2's poll went on (2026-11-02: was a
    // 2.5 s sleep, two polls of the 1 s production interval).
    const reads = vi.spyOn(manager, 'readNewOutput');
    await vi.waitFor(
      () => expect(reads.mock.calls.filter(([id]) => id === 's2').length).toBeGreaterThanOrEqual(5),
      { timeout: 10_000, interval: 10 }
    );
    expect(reads.mock.calls.filter(([id]) => id === 's1')).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('closes without an error the terminal of a session whose folder never comes', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-tm-'));
    manager = new TerminalManager(dir) as unknown as Internals;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sessionTerminal, free } = stubTerminal();
    manager.terminals.set('gone', sessionTerminal);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await manager.watchStreamFile('gone');
      // It waits for the cast of a brand-new session (its folder may not be there yet).
      expect(manager.terminals.has('gone')).toBe(true);
      await vi.advanceTimersByTimeAsync(11_000);
    } finally {
      vi.useRealTimers();
    }

    expect(manager.terminals.has('gone')).toBe(false);
    expect(free).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

// 2026-10-31: a suspended session woken runs again under the same id and writes on in the same
// cast, after its "exit" line. Its terminal stopped at that line for good: the screen stayed on
// "[exited]" (menus, the draft the suspender checks, every viewer frozen).
describe('TerminalManager terminal of a session that runs again', () => {
  let dir: string;
  let manager: Internals | undefined;
  afterEach(() => {
    manager?.destroy();
    manager = undefined;
    rmSync(dir, RM_TEST_DIR);
  });

  it('reads on when output comes after the exit line', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ut-tm-'));
    // After the exit line only the poll reads the cast.
    manager = new TerminalManager(dir, { watchPollMs: WATCH_POLL_MS }) as unknown as Internals;
    const written: string[] = [];
    const sessionTerminal: { terminal: unknown; ended?: boolean } = {
      terminal: { write: (data: string) => written.push(data), resize: () => {}, free: () => {} },
    };
    manager.terminals.set('s1', sessionTerminal);
    mkdirSync(path.join(dir, 's1'));
    const file = path.join(dir, 's1', 'stdout');
    writeFileSync(file, '{"version":2,"width":80,"height":24}\n[0.1,"o","antes"]\n');
    await manager.watchStreamFile('s1');
    await vi.waitFor(() => expect(written.join('')).toBe('antes'), { timeout: 10_000 });

    appendFileSync(file, '["exit",0,"s1"]\n');
    await vi.waitFor(() => expect(sessionTerminal.ended).toBe(true), { timeout: 10_000 });
    appendFileSync(file, '[5.0,"o","después"]\n');
    await vi.waitFor(() => expect(written.join('')).toBe('antesdespués'), { timeout: 10_000 });
    expect(sessionTerminal.ended).toBe(false);
  });
});
