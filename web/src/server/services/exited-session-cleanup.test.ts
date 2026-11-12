import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { SessionManager } from '../pty/session-manager.js';
import { ExitedSessionCleanup } from './exited-session-cleanup.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00Z');

describe('ExitedSessionCleanup', () => {
  let controlDir: string;
  let sessionManager: SessionManager;

  function addSession(id: string, status: 'running' | 'exited', ageDays: number) {
    const dir = path.join(controlDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date(NOW - ageDays * DAY_MS);
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({
        id,
        name: id,
        command: ['zsh'],
        workingDir: '/tmp',
        status,
        startedAt: at.toISOString(),
        // A live pid keeps a "running" session running for the listing.
        ...(status === 'running' ? { pid: process.pid, muted: true } : { exitCode: 0 }),
      })
    );
    fs.writeFileSync(path.join(dir, 'stdout'), '');
    for (const file of ['session.json', 'stdout']) {
      fs.utimesSync(path.join(dir, file), at, at);
    }
  }

  function cleanup(days: number | undefined, keep?: (id: string) => boolean) {
    return new ExitedSessionCleanup({
      controlPath: controlDir,
      listSessions: () => sessionManager.listSessions(),
      cleanupSession: (id) => sessionManager.cleanupSession(id),
      getDays: () => days,
      now: () => NOW,
      ...(keep ? { keep: (session) => keep(session.id) } : {}),
    });
  }

  const remaining = () => fs.readdirSync(controlDir).sort();

  beforeEach(() => {
    controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-exited-cleanup-'));
    sessionManager = new SessionManager(controlDir);
    addSession('old-exited', 'exited', 10);
    addSession('recent-exited', 'exited', 2);
    addSession('old-running', 'running', 30);
  });

  afterEach(() => {
    fs.rmSync(controlDir, RM_TEST_DIR);
  });

  it('removes exited sessions older than the chosen age and keeps the rest', () => {
    expect(cleanup(7).run()).toEqual(['old-exited']);
    expect(remaining()).toEqual(['old-running', 'recent-exited']);
    // The running session's metadata (mute included) is untouched.
    const running = JSON.parse(
      fs.readFileSync(path.join(controlDir, 'old-running', 'session.json'), 'utf8')
    );
    expect(running.muted).toBe(true);
  });

  it("never removes a session it is told to keep (an open task's), whatever its age", () => {
    addSession('old-task', 'exited', 30);
    expect(cleanup(7, (id) => id === 'old-task').run()).toEqual(['old-exited']);
    expect(remaining()).toEqual(['old-running', 'old-task', 'recent-exited']);
  });

  it('removes a resumable Claude session only once it is older than the age', () => {
    addSession('claude-recent', 'exited', 2);
    addSession('claude-old', 'exited', 10);
    for (const id of ['claude-recent', 'claude-old']) {
      const file = path.join(controlDir, id, 'session.json');
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = fs.statSync(path.join(controlDir, id, 'stdout')).mtime;
      fs.writeFileSync(file, JSON.stringify({ ...info, claudeSessionId: `conv-${id}` }));
      fs.utimesSync(file, at, at);
    }
    expect(cleanup(7).run().sort()).toEqual(['claude-old', 'old-exited']);
    expect(remaining()).toContain('claude-recent');
  });

  it('does nothing when off (0 or never set)', () => {
    expect(cleanup(0).run()).toEqual([]);
    expect(cleanup(undefined).run()).toEqual([]);
    expect(remaining()).toEqual(['old-exited', 'old-running', 'recent-exited']);
  });

  it('counts age from when the session last wrote output, not when it started', () => {
    // Started 10 days ago but finished an hour ago.
    const stdout = path.join(controlDir, 'old-exited', 'stdout');
    const recent = new Date(NOW - 60 * 60 * 1000);
    fs.utimesSync(stdout, recent, recent);
    expect(cleanup(1).run()).toEqual(['recent-exited']);
  });

  it('runs at start and then on its interval, without holding the process open', () => {
    vi.useFakeTimers();
    try {
      let days = 0;
      const removed: string[] = [];
      const job = new ExitedSessionCleanup({
        controlPath: controlDir,
        listSessions: () => sessionManager.listSessions(),
        cleanupSession: (id) => {
          removed.push(id);
          sessionManager.cleanupSession(id);
        },
        getDays: () => days,
        now: () => NOW,
        intervalMs: 1000,
      });
      job.start();
      vi.advanceTimersByTime(0);
      expect(removed).toEqual([]);

      days = 1;
      vi.advanceTimersByTime(1000);
      expect(removed.sort()).toEqual(['old-exited', 'recent-exited']);

      job.stop();
      addSession('later-exited', 'exited', 5);
      vi.advanceTimersByTime(5000);
      expect(removed).not.toContain('later-exited');
    } finally {
      vi.useRealTimers();
    }
  });

  it('trims finished recordings on the same timer, even with the removal off, one run at a time', async () => {
    vi.useFakeTimers();
    try {
      let release = () => {};
      const trimRecordings = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      const job = new ExitedSessionCleanup({
        controlPath: controlDir,
        listSessions: () => sessionManager.listSessions(),
        cleanupSession: () => {},
        getDays: () => 0,
        trimRecordings,
        intervalMs: 1000,
      });
      job.start();
      vi.advanceTimersByTime(0);
      expect(trimRecordings).toHaveBeenCalledTimes(1);
      // Still trimming: the next tick does not start another.
      vi.advanceTimersByTime(1000);
      expect(trimRecordings).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(trimRecordings).toHaveBeenCalledTimes(2);
      job.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
