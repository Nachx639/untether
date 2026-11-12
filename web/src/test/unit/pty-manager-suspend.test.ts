import * as fs from 'fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyManager } from '../../server/pty/pty-manager';
import { ShieldTmux } from '../../server/services/shielded-tmux';
import type { SessionSuspension } from '../../shared/types';
import { TitleMode } from '../../shared/types';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';
import { markedTempDir } from '../helpers/test-dirs.js';

// node-pty is mocked (test setup) and the shield tmux is faked: no real tmux or process here.
// The real suspend/wake runs in src/test/e2e/session-suspend.e2e.test.ts.
describe('PtyManager suspend and wake of a shielded session', () => {
  let controlPath: string;
  let manager: PtyManager;
  let tmuxAlive: boolean;
  let killWorks: boolean;
  /**
   * Its tmux client ends, as the real attach client does once its tmux session is gone. The
   * mocked node-pty fires the exit 50 ms after kill(), so PtyManager's own exit handler marks
   * the session exited and drops it. 2026-11-02: without it the client never exited and
   * finishSuspension waited out its 5 s bound (50 x 100 ms) in two tests here.
   */
  const clientExits = () => {
    const internal = manager as unknown as {
      sessions: Map<string, { ptyProcess?: { kill: () => void } }>;
    };
    internal.sessions.get('sus1')?.ptyProcess?.kill();
  };
  const record = (dir: string): SessionSuspension => ({
    at: new Date().toISOString(),
    claudeSessionId: '11111111-2222-4333-8444-555555555555',
    command: ['claude', '--dangerously-skip-permissions'],
    workingDir: dir,
    shielded: true,
    idleMinutes: 130,
  });

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  beforeEach(async () => {
    controlPath = markedTempDir('/tmp/vtsus.');
    tmuxAlive = true;
    killWorks = true;
    vi.spyOn(ShieldTmux.prototype, 'isAvailable').mockReturnValue(true);
    vi.spyOn(ShieldTmux.prototype, 'create').mockImplementation(async () => {
      tmuxAlive = true;
      return undefined as never;
    });
    vi.spyOn(ShieldTmux.prototype, 'has').mockImplementation(async () => tmuxAlive);
    vi.spyOn(ShieldTmux.prototype, 'kill').mockImplementation(async () => {
      if (killWorks) {
        tmuxAlive = false;
        clientExits();
      }
      return undefined as never;
    });
    vi.spyOn(ShieldTmux.prototype, 'attachCommand').mockReturnValue({
      command: '/usr/bin/tmux',
      args: ['attach-session'],
    });
    vi.spyOn(ShieldTmux.prototype, 'panePid').mockResolvedValue(100);
    manager = new PtyManager(controlPath);
    await manager.createSession(['claude', '--dangerously-skip-permissions'], {
      sessionId: 'sus1',
      name: 'claude',
      workingDir: controlPath,
      cols: 80,
      rows: 24,
      titleMode: TitleMode.NONE,
      shielded: true,
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.restoreAllMocks();
    fs.rmSync(controlPath, RM_TEST_DIR);
  });

  it('a tmux that does not end leaves the session running, not suspended', async () => {
    killWorks = false;
    await expect(
      manager.suspendShieldedSession('sus1', record(controlPath), [], undefined)
    ).rejects.toThrow(/could not be ended/);
    const info = manager.getSession('sus1');
    expect(info?.suspended).toBeUndefined();
    expect(info?.status).toBe('running');
  });

  it('input typed while a suspension is cancelled is typed into the session, not lost', async () => {
    killWorks = false;
    const send = vi.spyOn(manager, 'sendInput');
    vi.mocked(ShieldTmux.prototype.kill).mockImplementationOnce(async () => {
      manager.sendInput('sus1', { text: 'tecleado' }); // arrives mid-stop: held
      return undefined as never;
    });
    await expect(
      manager.suspendShieldedSession('sus1', record(controlPath), [], undefined)
    ).rejects.toThrow(/could not be ended/);
    // Held once, then typed for real once the suspension was undone.
    expect(send.mock.calls.filter(([, input]) => input.text === 'tecleado')).toHaveLength(2);
    expect(manager.getSession('sus1')?.suspended).toBeUndefined();
  });

  it('input typed while it is being suspended is kept on disk with the suspension', async () => {
    vi.mocked(ShieldTmux.prototype.kill).mockImplementationOnce(async () => {
      manager.sendInput('sus1', { text: 'tarde' });
      tmuxAlive = false;
      clientExits();
      return undefined as never;
    });
    const result = await manager.suspendShieldedSession('sus1', record(controlPath), [], undefined);
    expect(result.heldInput).toEqual([{ text: 'tarde' }]);
    expect(manager.getSession('sus1')?.suspended?.pendingInput).toEqual([{ text: 'tarde' }]);
  });

  it('input newer than the last look cancels the suspension', async () => {
    manager.sendInput('sus1', { text: 'x' });
    await expect(
      manager.suspendShieldedSession('sus1', record(controlPath), [], undefined)
    ).rejects.toThrow(/Input arrived/);
    expect(manager.getSession('sus1')?.suspended).toBeUndefined();
  });

  it('a failed tmux start on wake stays on the session as its error', async () => {
    await manager.suspendShieldedSession('sus1', record(controlPath), [], undefined);
    // Its client exited (clientExits): the exit handler marked it exited and dropped it.
    const internal = manager as unknown as { sessions: Map<string, unknown> };
    expect(internal.sessions.has('sus1')).toBe(false);
    expect(manager.getSession('sus1')?.status).toBe('exited');
    vi.mocked(ShieldTmux.prototype.create).mockRejectedValueOnce(new Error('no tmux server'));
    const result = await manager.resumeSuspendedSession('sus1');
    expect(result.ok).toBe(false);
    const suspended = manager.getSession('sus1')?.suspended;
    expect(suspended?.resumeError).toContain('no tmux server');
    expect(suspended?.wakingAt).toBeUndefined();
  });
});
