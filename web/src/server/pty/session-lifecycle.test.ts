// Session lifecycle guards of the 2026-10-20 audit: pid reuse, sessions a crashed server left
// behind, lost session.json updates, input sent to nowhere, "clean up exited" deleting
// resumable sessions, and private permissions.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isForwardedSession } from '../../shared/forwarded-session';
import type { SessionInfo } from '../../shared/types';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { forwarderPidOf } from './forwarder-kill';
import { PERMS_MARKER, securePrivateTree, untetherStateRoot } from './private-perms';
import { isSameProcess, processStartTime } from './process-utils';
import { keptByExitedCleanup, PtyManager } from './pty-manager';
import { mergeConcurrentFields, SessionManager } from './session-manager';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const base = (id: string, extra: Partial<SessionInfo> & Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    command: ['zsh'],
    workingDir: '/tmp',
    status: 'running',
    startedAt: new Date().toISOString(),
    ...extra,
  }) as SessionInfo;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-life-'));
});
afterEach(() => {
  fs.rmSync(dir, RM_TEST_DIR);
});

describe('pid reuse', () => {
  it('tells the process a pid named from another one with the same pid', () => {
    const start = processStartTime(process.pid);
    expect(start).toBeTruthy();
    expect(isSameProcess(process.pid, start)).toBe(true);
    expect(isSameProcess(process.pid, 'Mon Jan  1 00:00:00 2001')).toBe(false);
    // Without a recorded start time only its existence counts.
    expect(isSameProcess(process.pid, undefined)).toBe(true);
  });

  it('a running session whose pid now names another process is exited', () => {
    const manager = new SessionManager(dir);
    fs.mkdirSync(path.join(dir, 'reused'));
    manager.saveSessionInfo(
      'reused',
      base('reused', { pid: process.pid, pidStartTime: 'Mon Jan  1 00:00:00 2001' })
    );
    const { sessions, zombies } = manager.listSessionsAndZombies();
    expect(zombies).toEqual(['reused']);
    expect(sessions[0].status).toBe('exited');
  });

  it('a shielded session re-attached by a new tmux client stays running', () => {
    // 2026-10-20: the first client's start time stayed after a re-attach and the next
    // listing called the live shielded session exited.
    const manager = new SessionManager(dir);
    fs.mkdirSync(path.join(dir, 'shield'));
    manager.saveSessionInfo(
      'shield',
      base('shield', {
        pid: process.pid,
        pidStartTime: 'Mon Jan  1 00:00:00 2001',
        shielded: true,
      })
    );
    const { sessions, zombies } = manager.listSessionsAndZombies();
    expect(zombies).toEqual([]);
    expect(sessions[0].status).toBe('running');
  });
});

describe('what the previous server left behind', () => {
  it('ends its PTY sessions and the ones stuck starting, keeps shielded and forwarded ones', () => {
    const manager = new SessionManager(dir);
    const save = (id: string, extra: Record<string, unknown>) => {
      fs.mkdirSync(path.join(dir, id));
      manager.saveSessionInfo(id, base(id, extra));
    };
    const start = processStartTime(process.pid) as string;
    save('own-pty', { pid: process.pid, pidStartTime: start });
    save('stuck-starting', { status: 'starting' });
    save('shielded', { pid: 999_999, pidStartTime: start, shielded: true });
    save('fwd_1_2', { pid: process.pid });
    save('web-terminal', { pid: process.pid, pidStartTime: start, forwarderPid: process.pid });
    save('legacy', { pid: process.pid });
    const swept = manager.sweepSessionsOfPreviousServer((info) => isForwardedSession(info));
    expect(swept.sort()).toEqual(['own-pty', 'stuck-starting']);
    expect(manager.loadSessionInfo('legacy')?.status).toBe('running');
    expect(manager.loadSessionInfo('shielded')?.status).toBe('running');
  });
});

describe('session.json written while others change it', () => {
  it('keeps a rename, a title, mute set meanwhile; and their clearing', () => {
    const memory = base('a', { name: 'old', userTitle: 'mine', claudeTitle: 'c' });
    const disk = base('a', { name: 'renamed', muted: true, claudeSessionId: 'conv' });
    mergeConcurrentFields(memory, disk);
    expect(memory).toMatchObject({ name: 'renamed', muted: true, claudeSessionId: 'conv' });
    expect(memory.userTitle).toBeUndefined();
    expect(memory.claudeTitle).toBeUndefined();
    expect(memory.status).toBe('running');
  });
});

describe('Terminal-window sessions spawned from the web', () => {
  it('are forwarded sessions by the pid their forwarder recorded', () => {
    expect(
      isForwardedSession({ id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', forwarderPid: 4242 })
    ).toBe(true);
    expect(forwarderPidOf('1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', { forwarderPid: 4242 })).toBe(
      4242
    );
    expect(isForwardedSession({ id: 'plain', forwarderPid: 'x' })).toBe(false);
    expect(forwarderPidOf('fwd_1_77')).toBe(77);
  });
});

describe('clean up exited', () => {
  it('keeps resumable Claude sessions and shielded ones that may come back', () => {
    expect(keptByExitedCleanup({ claudeSessionId: 'conv' })).toBe(true);
    // A Codex thread can be resumed too (2026-11-10).
    expect(keptByExitedCleanup({ codexThreadId: 'thread' })).toBe(true);
    expect(keptByExitedCleanup({ shielded: true, shieldEnd: 'tmux-lost' })).toBe(true);
    expect(keptByExitedCleanup({ shielded: true, shieldEnd: 'restore-failed' })).toBe(true);
    expect(keptByExitedCleanup({ shielded: true, shieldEnd: 'killed' })).toBe(false);
    expect(keptByExitedCleanup({})).toBe(false);
  });
});

describe('PtyManager', () => {
  beforeAll(async () => {
    await PtyManager.initialize();
  });

  it('input for a session without a control socket is an error, not a lost 200', () => {
    const manager = new PtyManager(dir);
    fs.mkdirSync(path.join(dir, 'fwd_1_2'));
    manager.getSessionManager().saveSessionInfo('fwd_1_2', base('fwd_1_2', { pid: process.pid }));
    expect(() => manager.sendInput('fwd_1_2', { text: 'yes\r' })).toThrow(/No socket/);
  });

  it('input for a shielded session between two tmux clients waits for the next one', () => {
    const manager = new PtyManager(dir);
    fs.mkdirSync(path.join(dir, 'sh-1'));
    manager.getSessionManager().saveSessionInfo('sh-1', base('sh-1', { shielded: true }));
    manager.markShieldReattachPending('sh-1');
    expect(() => manager.sendInput('sh-1', { text: '1' })).not.toThrow();
  });

  it('input for a shielded session with no re-attach coming is an error (2026-10-20)', () => {
    const manager = new PtyManager(dir);
    fs.mkdirSync(path.join(dir, 'sh-2'));
    manager.getSessionManager().saveSessionInfo('sh-2', base('sh-2', { shielded: true }));
    expect(() => manager.sendInput('sh-2', { text: '1' })).toThrow(/no tmux client/);
    // A re-attach that never came expires.
    manager.markShieldReattachPending('sh-2', -1);
    expect(() => manager.sendInput('sh-2', { text: '1' })).toThrow(/no tmux client/);
  });

  it('queued shield input ages per chunk (2026-10-20)', () => {
    vi.useFakeTimers();
    try {
      const manager = new PtyManager(dir);
      fs.mkdirSync(path.join(dir, 'sh-3'));
      manager.getSessionManager().saveSessionInfo('sh-3', base('sh-3', { shielded: true }));
      manager.markShieldReattachPending('sh-3', 120_000);
      manager.sendInput('sh-3', { text: 'old' });
      vi.advanceTimersByTime(25_000);
      manager.sendInput('sh-3', { text: 'new' });
      vi.advanceTimersByTime(10_000);
      const written: string[] = [];
      const session = {
        id: 'sh-3',
        inputQueue: { enqueue: (fn: () => void) => fn() },
        ptyProcess: { write: (data: string) => written.push(data) },
      };
      (manager as unknown as { flushShieldInput: (s: unknown) => void }).flushShieldInput(session);
      expect(written).toEqual(['new']);
      expect(manager.isShieldReattachPending('sh-3')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('input to a forwarder whose ipc.sock is stale fails instead of answering 200 (2026-10-20)', async () => {
    const manager = new PtyManager(dir);
    fs.mkdirSync(path.join(dir, 'fwd_1_9'));
    manager.getSessionManager().saveSessionInfo('fwd_1_9', base('fwd_1_9', { pid: process.pid }));
    // Left behind by a forwarder killed with -9: nothing listens on it.
    fs.writeFileSync(path.join(dir, 'fwd_1_9', 'ipc.sock'), '');
    await expect(manager.connectInput('fwd_1_9')).rejects.toThrow(/No socket connection/);
  });

  it('cleanup-exited keeps a resumable Claude session, ?all removes it', () => {
    const manager = new PtyManager(dir);
    const sm = manager.getSessionManager();
    for (const [id, extra] of [
      ['resumable', { claudeSessionId: 'conv' }],
      ['plain', {}],
    ] as const) {
      fs.mkdirSync(path.join(dir, id));
      sm.saveSessionInfo(id, base(id, { status: 'exited', ...extra }));
    }
    const kept: Array<[string, string]> = [];
    expect(
      manager.cleanupExitedSessions({
        onKept: (session, reason) => kept.push([session.id, reason]),
      })
    ).toEqual(['plain']);
    expect(kept).toEqual([['resumable', 'claude']]);
    kept.length = 0;
    expect(
      manager.cleanupExitedSessions({
        keep: () => true,
        onKept: (session, reason) => kept.push([session.id, reason]),
      })
    ).toEqual([]);
    expect(kept).toEqual([['resumable', 'task']]);
    expect(manager.cleanupExitedSessions({ all: true })).toEqual(['resumable']);
  });

  it("?all still keeps an open task's session and ends a shielded one's tmux (2026-10-20)", () => {
    const manager = new PtyManager(dir);
    const sm = manager.getSessionManager();
    for (const [id, extra] of [
      ['task-s', { claudeSessionId: 'conv-t' }],
      ['shield-s', { shielded: true, shieldEnd: 'tmux-lost' }],
    ] as const) {
      fs.mkdirSync(path.join(dir, id));
      sm.saveSessionInfo(id, base(id, { status: 'exited', ...extra }));
    }
    const shieldKill = vi
      .spyOn(
        (manager as unknown as { shieldTmux: { kill: (id: string) => Promise<unknown> } })
          .shieldTmux,
        'kill'
      )
      .mockResolvedValue(undefined);
    const kept: Array<[string, string]> = [];
    expect(
      manager.cleanupExitedSessions({
        all: true,
        keep: (session) => session.id === 'task-s',
        onKept: (session, reason) => kept.push([session.id, reason]),
      })
    ).toEqual(['shield-s']);
    expect(kept).toEqual([['task-s', 'task']]);
    expect(shieldKill).toHaveBeenCalledWith('shield-s');
    expect(fs.existsSync(path.join(dir, 'task-s'))).toBe(true);
  });

  it('cleaning up a running forwarded session ends its program before its files go', async () => {
    const manager = new PtyManager(dir);
    const sm = manager.getSessionManager();
    const program = spawn('sleep', ['30'], { stdio: 'ignore' });
    const id = 'fwd_1_3';
    fs.mkdirSync(path.join(dir, id));
    sm.saveSessionInfo(id, base(id, { pid: program.pid }));
    const ended = new Promise((resolve) => program.once('exit', resolve));
    manager.cleanupSession(id);
    expect(fs.existsSync(path.join(dir, id))).toBe(true); // not before the kill
    await ended;
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, id))).toBe(false), {
      timeout: 15_000,
    });
  }, 20_000);
});

describe('private permissions', () => {
  it('removes group and other bits once, keeps owner bits, follows no symlink', () => {
    const root = path.join(dir, '.untether');
    fs.mkdirSync(path.join(root, 'control', 's1'), { recursive: true, mode: 0o755 });
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(path.join(root, 'control', 's1', 'session.json'), '{}', { mode: 0o644 });
    fs.writeFileSync(path.join(root, 'tool'), '', { mode: 0o755 });
    const outside = path.join(dir, 'outside');
    fs.writeFileSync(outside, '', { mode: 0o644 });
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(untetherStateRoot(path.join(root, 'control'))).toBe(root);

    expect(securePrivateTree(root)).toBeGreaterThanOrEqual(4);
    const mode = (file: string) => fs.statSync(file).mode & 0o777;
    expect(mode(root)).toBe(0o700);
    expect(mode(path.join(root, 'control', 's1'))).toBe(0o700);
    expect(mode(path.join(root, 'control', 's1', 'session.json'))).toBe(0o600);
    expect(mode(path.join(root, 'tool'))).toBe(0o700);
    expect(mode(outside)).toBe(0o644);
    expect(fs.existsSync(path.join(root, PERMS_MARKER))).toBe(true);

    // Later starts only keep the folder itself private.
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(path.join(root, 'later'), '', { mode: 0o644 });
    securePrivateTree(root);
    expect(mode(root)).toBe(0o700);
    expect(mode(path.join(root, 'later'))).toBe(0o644);
  });

  it('new session files and folders are private', () => {
    const manager = new SessionManager(dir);
    const paths = manager.createSessionDirectory('p1');
    manager.saveSessionInfo('p1', base('p1'));
    expect(fs.statSync(paths.controlDir).mode & 0o077).toBe(0);
    expect(fs.statSync(paths.sessionJsonPath).mode & 0o077).toBe(0);
  });
});
