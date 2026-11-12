import * as fs from 'fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessUtils } from '../../server/pty/process-utils';
import { PtyManager } from '../../server/pty/pty-manager';
import type { ClaudeStatus } from '../../server/services/claude-chat';
import {
  ClaudeStatusNotifier,
  watchedSessions,
} from '../../server/services/claude-status-notifier';
import { ShieldTmux } from '../../server/services/shielded-tmux';
import { TitleMode } from '../../shared/types';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';
import { markedTempDir } from '../helpers/test-dirs.js';

// node-pty is mocked (test setup) and the shield tmux is faked: no real tmux or process here.
describe('PtyManager shielded program pid after the pane is respawned', () => {
  let controlPath: string;
  let manager: PtyManager;
  /** What `tmux display-message #{pane_pid}` answers for the pane. */
  let panePid: number;
  const dead = new Set<number>();

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  beforeEach(() => {
    controlPath = markedTempDir('/tmp/vtp.');
    panePid = 100;
    dead.clear();
    vi.spyOn(ShieldTmux.prototype, 'isAvailable').mockReturnValue(true);
    vi.spyOn(ShieldTmux.prototype, 'create').mockResolvedValue(undefined as never);
    vi.spyOn(ShieldTmux.prototype, 'has').mockResolvedValue(true);
    vi.spyOn(ShieldTmux.prototype, 'kill').mockResolvedValue(undefined as never);
    vi.spyOn(ShieldTmux.prototype, 'attachCommand').mockReturnValue({
      command: '/usr/bin/tmux',
      args: ['attach-session'],
    });
    vi.spyOn(ShieldTmux.prototype, 'panePid').mockImplementation(async () => panePid);
    vi.spyOn(ProcessUtils, 'isProcessRunning').mockImplementation((pid) => !dead.has(pid));
    manager = new PtyManager(controlPath);
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.restoreAllMocks();
    fs.rmSync(controlPath, RM_TEST_DIR);
  });

  it('notifies for the Claude in the new pane once the old program pid died', async () => {
    const { sessionId } = await manager.createSession(['claude'], {
      sessionId: 'shield1',
      name: 'claude',
      workingDir: controlPath,
      cols: 80,
      rows: 24,
      titleMode: TitleMode.NONE,
      shielded: true,
    });
    const session = manager.getSession(sessionId);
    expect(session && manager.programRootPid(session)).toBe(100);

    // Claude statuses by the pid of the program they run under.
    const statuses = new Map<number, ClaudeStatus>([[100, { status: 'idle', since: 1 }]]);
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => watchedSessions(manager),
      notify,
      async (pids) =>
        new Map(
          pids.flatMap((pid) =>
            statuses.has(pid) ? [[pid, statuses.get(pid) as ClaudeStatus]] : []
          )
        ),
      undefined,
      undefined,
      { refreshPids: () => manager.refreshProgramPids() }
    );
    await notifier.tick();

    // `respawn-pane`: the old program is gone and a new Claude runs in the same pane.
    dead.add(100);
    statuses.delete(100);
    panePid = 200;
    statuses.set(200, { status: 'busy', since: 2 });
    await notifier.tick();
    expect(manager.programRootPid({ id: sessionId, shielded: true })).toBe(200);

    statuses.set(200, {
      status: 'idle',
      since: 3,
      preview: { role: 'assistant', text: 'Done.' },
    });
    await notifier.tick();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'claude-finished', body: 'Done.' })
    );
  });

  it('asks tmux nothing while the stored program pid lives', async () => {
    await manager.createSession(['claude'], {
      sessionId: 'shield2',
      name: 'claude',
      workingDir: controlPath,
      cols: 80,
      rows: 24,
      titleMode: TitleMode.NONE,
      shielded: true,
    });
    const asks = vi.mocked(ShieldTmux.prototype.panePid);
    asks.mockClear();
    for (let i = 0; i < 9; i++) await manager.refreshProgramPids();
    expect(asks).not.toHaveBeenCalled();
  });
});
