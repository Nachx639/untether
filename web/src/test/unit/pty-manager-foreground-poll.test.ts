import * as fs from 'fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { foregroundPollDue, PtyManager } from '../../server/pty/pty-manager';
import { ShieldTmux } from '../../server/services/shielded-tmux';
import { TitleMode } from '../../shared/types';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

// 2026-11-02 (CPU measurement): the foreground poll ran `ps` twice a second, mostly for
// shielded sessions whose terminal only ever holds the tmux client.
describe('foreground process poll', () => {
  let controlPath: string;
  let manager: PtyManager;

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  beforeEach(() => {
    controlPath = fs.mkdtempSync('/tmp/vtf.');
    vi.spyOn(ShieldTmux.prototype, 'isAvailable').mockReturnValue(true);
    vi.spyOn(ShieldTmux.prototype, 'create').mockResolvedValue(undefined as never);
    vi.spyOn(ShieldTmux.prototype, 'has').mockResolvedValue(true);
    vi.spyOn(ShieldTmux.prototype, 'kill').mockResolvedValue(undefined as never);
    vi.spyOn(ShieldTmux.prototype, 'attachCommand').mockReturnValue({
      command: '/usr/bin/tmux',
      args: ['attach-session'],
    });
    vi.spyOn(ShieldTmux.prototype, 'panePid').mockResolvedValue(100);
    manager = new PtyManager(controlPath);
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.restoreAllMocks();
    fs.rmSync(controlPath, RM_TEST_DIR);
  });

  it('tracks plain sessions, never shielded ones (their tmux client stays in the foreground)', async () => {
    const internals = manager as unknown as {
      getProcessPgid: (pid: number) => Promise<number | null>;
      foregroundTracked: Set<{ id: string }>;
    };
    const pgid = vi.spyOn(internals, 'getProcessPgid').mockResolvedValue(4242);
    const options = { workingDir: controlPath, cols: 80, rows: 24, titleMode: TitleMode.NONE };
    await manager.createSession(['claude'], { ...options, sessionId: 'shielded1', shielded: true });
    await manager.createSession(['zsh'], { ...options, sessionId: 'plain1' });
    await vi.waitFor(() => expect(internals.foregroundTracked.size).toBe(1));
    expect([...internals.foregroundTracked].map((session) => session.id)).toEqual(['plain1']);
    expect(pgid).toHaveBeenCalledTimes(1);
  });

  it('tells a finished command at once, without running anything to ask for its exit code (2026-11-11)', async () => {
    // A `sh -c "ps -o pid,stat -p <pgid> || echo NOTFOUND"` ran per finished command and its
    // answer was thrown away: the code told was always 0.
    const internals = manager as unknown as {
      execFileAsync: (...args: unknown[]) => Promise<unknown>;
      handleCommandFinished: (session: unknown, pgid: number) => Promise<void>;
    };
    const ran = vi.spyOn(internals, 'execFileAsync');
    const finished: Array<{ command: string; exitCode: number }> = [];
    manager.on('commandFinished', (event) => finished.push(event));
    const session = { id: 's1', currentCommand: 'make build', commandStartTime: Date.now() - 5000 };
    const told = internals.handleCommandFinished(session, 4242);
    // Told before anything else could run: nothing is awaited on the way.
    expect(finished).toMatchObject([{ sessionId: 's1', command: 'make build', exitCode: 0 }]);
    await told;
    expect(ran).not.toHaveBeenCalled();
    expect(session.currentCommand).toBeUndefined();
  });

  it('looks at a session every tick after input, every 2 s while a command prints, every 15 s when quiet', () => {
    const now = 1_000_000;
    expect(
      foregroundPollDue({ lastOutputTimestamp: now - 1000, lastForegroundPollAt: now - 500 }, now)
    ).toBe(true);
    expect(
      foregroundPollDue({ lastInputTimestamp: now - 4000, lastForegroundPollAt: now - 500 }, now)
    ).toBe(true);
    expect(
      foregroundPollDue({ lastOutputTimestamp: now - 6000, lastForegroundPollAt: now - 500 }, now)
    ).toBe(false);
    expect(
      foregroundPollDue(
        { lastOutputTimestamp: now - 60_000, lastForegroundPollAt: now - 14_000 },
        now
      )
    ).toBe(false);
    expect(
      foregroundPollDue(
        { lastOutputTimestamp: now - 60_000, lastForegroundPollAt: now - 15_000 },
        now
      )
    ).toBe(true);
    // A command runs and prints all the time (Claude): every 2 s, unless there was input.
    const running = { shellPgid: 10, currentForegroundPgid: 20, lastOutputTimestamp: now - 100 };
    expect(foregroundPollDue({ ...running, lastForegroundPollAt: now - 1000 }, now)).toBe(false);
    expect(foregroundPollDue({ ...running, lastForegroundPollAt: now - 2000 }, now)).toBe(true);
    expect(
      foregroundPollDue(
        { ...running, lastInputTimestamp: now - 100, lastForegroundPollAt: now - 500 },
        now
      )
    ).toBe(true);
    // Output at the shell prompt: every tick (a command may start).
    expect(
      foregroundPollDue(
        { ...running, currentForegroundPgid: 10, lastForegroundPollAt: now - 500 },
        now
      )
    ).toBe(true);
    // Never looked at: now.
    expect(foregroundPollDue({}, now)).toBe(true);
  });
});

// 2026-11-11 (server audit): a server started by hand in a terminal (pnpm run dev) listened to
// that terminal's size (a leftover of the forwarder) and gave it to every running session,
// past their size owners.
describe('the terminal the server was started in', () => {
  it('is not listened to: resizing it resizes no session', async () => {
    await PtyManager.initialize();
    const wasTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const listeners = () => [
      process.listenerCount('SIGWINCH'),
      process.stdout.listenerCount('resize'),
    ];
    const before = listeners();
    const dir = fs.mkdtempSync('/tmp/vtf.');
    const manager = new PtyManager(dir);
    try {
      expect(listeners()).toEqual(before);
    } finally {
      await manager.shutdown();
      if (wasTTY) Object.defineProperty(process.stdout, 'isTTY', wasTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});
