import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { ClaudeStatus } from './claude-chat.js';
import {
  type ClaudeUpdateRestartDeps,
  ClaudeUpdateRestarter,
  claudeInputDraft,
  compareVersions,
  parseClaudeVersion,
  RESTART_IDLE_MS,
  type RestartableSession,
  type RestartResult,
  restartCommandOffered,
  type ScreenCell,
  type SessionScreenLook,
  updateNoticeOnScreen,
} from './claude-update-restart.js';

const NOW = 1_800_000_000_000;
/** Claude draws a no-break space after its ❯. */
const NBSP = String.fromCharCode(0xa0);

/** A screen row: plain text, `faint` from that column on (Claude's placeholder). */
function row(text: string, faintFrom = Number.POSITIVE_INFINITY): ScreenCell[] {
  return [...text].map((char, index) => ({ char, attributes: index >= faintFrom ? 0x08 : 0 }));
}

describe('screen reading', () => {
  it('an empty input box, or only its faint placeholder, is no draft', () => {
    expect(claudeInputDraft([row('output'), row(`❯${NBSP}`)])).toBe(false);
    // Claude 2.1.316: `❯ (no-break space) ESC[2m Try "create a util logging.py that..."` (seen 2026-10-31).
    expect(claudeInputDraft([row(`❯${NBSP}Try "fix typecheck errors"`, 2)])).toBe(false);
  });

  it('text the user wrote is a draft, even with the menu row above it', () => {
    expect(
      claudeInputDraft([row('  ❯ /restart     Restart Claude Code'), row('─'), row('❯ half a th')])
    ).toBe(true);
  });

  it('no input box on screen tells nothing', () => {
    expect(claudeInputDraft([row('Do you trust this folder?'), row('text ❯ inside')])).toBe(
      undefined
    );
  });

  it("Claude's update line and its /restart menu entry", () => {
    expect(updateNoticeOnScreen('  ✓ Update installed · /restart to apply')).toEqual({
      installed: true,
      restartCommand: true,
    });
    expect(updateNoticeOnScreen('nothing here').installed).toBe(false);
    expect(
      restartCommandOffered(
        '  ❯ /restart                                                Restart Claude Code and keep this session\n❯ /restart'
      )
    ).toBe(true);
    expect(restartCommandOffered('❯ /restart\n  /resume   Resume a conversation')).toBe(false);
  });

  it('versions', () => {
    expect(parseClaudeVersion('2.1.316 (Claude Code)\n')).toBe('2.1.316');
    expect(parseClaudeVersion('oops')).toBeUndefined();
    expect(compareVersions('2.1.310', '2.1.316')).toBe(-1);
    expect(compareVersions('2.1.316', '2.1.316')).toBe(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
  });
});

describe('ClaudeUpdateRestarter', () => {
  let dir: string;
  let sessions: RestartableSession[];
  let claudes: Map<string, ClaudeStatus>;
  let screens: Map<string, SessionScreenLook>;
  let held: Set<string>;
  let load: boolean;
  let restartInPlace: ReturnType<typeof vi.fn<(id: string) => Promise<RestartResult>>>;
  let reopen: ReturnType<typeof vi.fn<(id: string) => Promise<RestartResult>>>;
  let marked: Array<[string, string | undefined, string]>;
  let logs: string[];
  let clock: number;

  const idleOld = (overrides: Partial<ClaudeStatus> = {}): ClaudeStatus => ({
    status: 'idle',
    sessionId: 'conv-1',
    since: clock - RESTART_IDLE_MS - 1000,
    version: '2.1.310',
    pid: 4242,
    ...overrides,
  });
  const quietScreen: SessionScreenLook = { draft: false, menu: false, updateNotice: true };

  function restarter(overrides: Partial<ClaudeUpdateRestartDeps> = {}) {
    return new ClaudeUpdateRestarter({
      enabled: () => true,
      installedVersion: async () => '2.1.316',
      sessions: () => sessions,
      claudeStatus: async (id) => claudes.get(id),
      screen: async (id) => screens.get(id),
      heldBy: (id) => (held.has(id) ? 'task t1 is merging' : null),
      loadOk: () => load,
      restartInPlace,
      reopen,
      markUpdated: (id, from, to) => marked.push([id, from, to]),
      statePath: path.join(dir, 'claude-update-restarts.json'),
      log: (message) => logs.push(message),
      now: () => clock,
      // Each wait moves the clock, so the confirmation's deadline comes.
      sleep: async (ms) => {
        clock += ms;
      },
      confirmMs: 10_000,
      ...overrides,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-update-restart-'));
    clock = NOW;
    sessions = [{ id: 's1', status: 'running' }];
    claudes = new Map([['s1', idleOld()]]);
    screens = new Map([['s1', quietScreen]]);
    held = new Set();
    load = true;
    marked = [];
    logs = [];
    // /restart works: the same session's Claude comes back on the installed version.
    restartInPlace = vi.fn(async (id: string) => {
      claudes.set(id, idleOld({ version: '2.1.316', since: clock }));
      return { ok: true, sessionId: id } as RestartResult;
    });
    reopen = vi.fn(async () => ({ ok: false, error: 'not wanted' }) as RestartResult);
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('restarts an idle session behind the installed version, once, and marks it', async () => {
    const it1 = restarter();
    expect(await it1.tick()).toBe('s1');
    expect(restartInPlace).toHaveBeenCalledWith('s1');
    expect(reopen).not.toHaveBeenCalled();
    expect(marked).toEqual([['s1', '2.1.310', '2.1.316']]);
    expect(logs.some((line) => /restarted via \/restart, now on 2\.1\.316/.test(line))).toBe(true);
    // Up to date now: nothing more.
    expect(await it1.tick()).toBeNull();
    expect(restartInPlace).toHaveBeenCalledTimes(1);
  });

  it('is off unless the setting is on', async () => {
    expect(await restarter({ enabled: () => false }).tick()).toBeNull();
    expect(restartInPlace).not.toHaveBeenCalled();
  });

  it.each([
    ['busy', () => claudes.set('s1', idleOld({ status: 'busy' }))],
    ['waiting for a permission', () => claudes.set('s1', idleOld({ status: 'waiting' }))],
    ['background agents running', () => claudes.set('s1', idleOld({ waitingForBackground: true }))],
    ['idle only a moment', () => claudes.set('s1', idleOld({ since: clock - 30_000 }))],
    ['a draft in its box', () => screens.set('s1', { ...quietScreen, draft: true })],
    ['no input box seen', () => screens.set('s1', { ...quietScreen, draft: undefined })],
    ['a question on screen', () => screens.set('s1', { ...quietScreen, menu: true })],
    ['its screen unreadable', () => screens.delete('s1')],
    ['a client typed just now', () => (sessions[0].lastInputTimestamp = clock - 10_000)],
    ['a task merging on it', () => held.add('s1')],
    ['the Mac under load', () => (load = false)],
    ['already on the installed version', () => claudes.set('s1', idleOld({ version: '2.1.316' }))],
    ['exited', () => (sessions[0].status = 'exited')],
    ['not a Claude session', () => claudes.delete('s1')],
  ])('leaves it alone when %s', async (_name, arrange) => {
    arrange();
    expect(await restarter().tick()).toBeNull();
    expect(restartInPlace).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });

  it('an unknown running version goes by Claude’s own update line', async () => {
    claudes.set('s1', idleOld({ version: undefined }));
    screens.set('s1', { ...quietScreen, updateNotice: false });
    expect(await restarter().tick()).toBeNull();
    screens.set('s1', quietScreen);
    expect(await restarter().tick()).toBe('s1');
  });

  it('reopens it when Claude does not offer /restart', async () => {
    restartInPlace.mockResolvedValueOnce({ ok: false, error: 'no /restart', untouched: true });
    reopen.mockImplementationOnce(async () => {
      sessions.push({ id: 's2', status: 'running' });
      claudes.set('s2', idleOld({ version: '2.1.316', since: clock }));
      return { ok: true, sessionId: 's2' };
    });
    expect(await restarter().tick()).toBe('s1');
    expect(reopen).toHaveBeenCalledWith('s1');
    expect(marked).toEqual([['s2', '2.1.310', '2.1.316']]);
    expect(logs.some((line) => /via reopen as s2/.test(line))).toBe(true);
  });

  it('a /restart that went wrong after typing is not followed by a reopen', async () => {
    restartInPlace.mockResolvedValueOnce({ ok: false, error: 'input did not clear' });
    expect(await restarter().tick()).toBe('s1');
    expect(reopen).not.toHaveBeenCalled();
  });

  it('a failed restart is logged and never tried again for that version, across restarts', async () => {
    // Claude never reports the new version.
    restartInPlace.mockImplementation(async (id) => ({ ok: true, sessionId: id }));
    expect(await restarter().tick()).toBe('s1');
    expect(marked).toEqual([]);
    expect(
      logs.some((line) => /failed via \/restart: Claude still reports 2\.1\.310/.test(line))
    ).toBe(true);
    clock += 60 * 60_000;
    claudes.set('s1', idleOld());
    // A new server (a new restarter) reads the attempt from disk.
    expect(await restarter().tick()).toBeNull();
    expect(restartInPlace).toHaveBeenCalledTimes(1);
    // A newer installed version is a new attempt.
    expect(await restarter({ installedVersion: async () => '2.1.320' }).tick()).toBe('s1');
  });

  it('an attempt cut by a server restart midway is not tried again', async () => {
    restartInPlace.mockImplementationOnce(() => new Promise(() => {}));
    void restarter().tick();
    await vi.waitFor(() => expect(restartInPlace).toHaveBeenCalled());
    expect(await restarter().tick()).toBeNull();
    expect(restartInPlace).toHaveBeenCalledTimes(1);
  });

  it('a session that ends while restarting is a failure', async () => {
    restartInPlace.mockImplementationOnce(async (id) => {
      sessions[0].status = 'exited';
      return { ok: true, sessionId: id };
    });
    await restarter().tick();
    expect(logs.some((line) => /the session ended while restarting/.test(line))).toBe(true);
  });

  it('one session per look, one look at a time', async () => {
    sessions.push({ id: 's3', status: 'running' });
    claudes.set('s3', idleOld({ sessionId: 'conv-3' }));
    screens.set('s3', quietScreen);
    let release: () => void = () => {};
    restartInPlace.mockImplementationOnce(
      (id) =>
        new Promise((resolve) => {
          release = () => {
            claudes.set(id, idleOld({ version: '2.1.316' }));
            resolve({ ok: true, sessionId: id });
          };
        })
    );
    const shared = restarter();
    const first = shared.tick();
    await vi.waitFor(() => expect(restartInPlace).toHaveBeenCalledTimes(1));
    // A second look while the first runs does nothing.
    expect(await shared.tick()).toBeNull();
    release();
    expect(await first).toBe('s1');
    expect(restartInPlace).toHaveBeenCalledTimes(1);
    expect(await shared.tick()).toBe('s3');
  });
});
