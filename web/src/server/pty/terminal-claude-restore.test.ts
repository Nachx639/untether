// 2026-11-08: a terminal running Claude under the user's own launcher came back as an empty
// shell after the shield tmux restarted. The restore path, end to end, with tmux stubbed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, TerminalClaude } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { PtyManager } from './pty-manager';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

describe('restoring a shielded terminal', () => {
  let dir: string;
  let manager: PtyManager;
  let create: ReturnType<typeof vi.fn>;
  const id = 'term-1';

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-restore-'));
    manager = new PtyManager(dir);
    create = vi.fn(async () => {});
    const internals = manager as unknown as {
      shieldTmux: { create: unknown; isAvailable: unknown; kill: unknown };
      reattachShieldedSession: unknown;
    };
    internals.shieldTmux.create = create;
    internals.shieldTmux.isAvailable = () => true;
    internals.shieldTmux.kill = vi.fn(async () => {});
    internals.reattachShieldedSession = vi.fn(async () => true);
  });

  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  const start = (terminalClaude?: TerminalClaude) => {
    const sessions = (manager as unknown as { sessionManager: PtyManager['sessionManager'] })
      .sessionManager;
    const paths = sessions.createSessionDirectory(id);
    fs.writeFileSync(paths.stdoutPath, '');
    sessions.saveSessionInfo(id, {
      id,
      name: 'terminal',
      command: ['/bin/zsh', '-l', '-i'],
      workingDir: dir,
      status: 'running',
      startedAt: new Date().toISOString(),
      shielded: true,
      claudeSessionId: 'old-conversation',
      ...(terminalClaude ? { terminalClaude } : {}),
    } as SessionInfo);
  };
  const created = () => create.mock.calls[0][0] as { command: string[]; cwd: string };
  const claude = (fields: Partial<TerminalClaude> = {}): TerminalClaude => ({
    conversationId: 'conv-live',
    pid: 42,
    cwd: dir,
    flags: ['--model', 'opus'],
    customEnv: [],
    ...fields,
  });

  // 2026-11-09: Codex's alternate screen could not be scrolled; every way back in runs it inline.
  describe('Codex runs inline', () => {
    const saveCodex = (fields: Partial<SessionInfo>) => {
      const sessions = (manager as unknown as { sessionManager: PtyManager['sessionManager'] })
        .sessionManager;
      fs.writeFileSync(sessions.createSessionDirectory(id).stdoutPath, '');
      sessions.saveSessionInfo(id, {
        id,
        name: 'codex',
        command: ['codex', '--yolo'],
        workingDir: dir,
        status: 'running',
        startedAt: new Date().toISOString(),
        shielded: true,
        ...fields,
      } as SessionInfo);
    };

    it('when restoring its thread', async () => {
      saveCodex({ codexThreadId: 'thread-1' });
      expect(await manager.restoreOrFinishShieldedSession(id, 'tmux-lost')).toBe(true);
      expect(created().command.join(' ')).toContain('resume --no-alt-screen thread-1 --yolo');
    });

    it('when restarting a session opened before the flag', async () => {
      saveCodex({ codexThreadId: undefined });
      vi.spyOn(
        manager as unknown as { findUnclaimedCodexThread: () => null },
        'findUnclaimedCodexThread'
      ).mockReturnValue(null);
      expect(await manager.restoreOrFinishShieldedSession(id, 'tmux-lost')).toBe(true);
      expect(created().command.join(' ')).toContain('--no-alt-screen');
    });

    it('leaves copy mode before what is typed after scrolling back, and only then', async () => {
      const order: string[] = [];
      const internals = manager as unknown as {
        sessions: Map<string, unknown>;
        shieldTmux: { leaveCopyMode: unknown };
      };
      internals.shieldTmux.leaveCopyMode = vi.fn(async () => {
        order.push('leave');
      });
      const queue: Array<() => Promise<void> | void> = [];
      internals.sessions.set(id, {
        ptyProcess: { write: (data: string) => order.push(data) },
        inputQueue: { enqueue: (task: () => Promise<void> | void) => queue.push(task) },
        sessionInfo: { command: ['codex', '--no-alt-screen'] },
      });
      const drain = async () => {
        for (const task of queue.splice(0)) await task();
      };
      const typed = (text: string) => manager.sendInput(id, { text });
      const press = '\u001b[<0;5;5M';
      const drag = '\u001b[<32;6;5M';
      const release = '\u001b[<0;6;5m';
      const focus = '\u001b[O';
      typed('a');
      typed('\u001b[<64;1;1M');
      typed('b');
      typed('c');
      // A drag selects in copy mode, entered without a wheel: mouse and focus never leave it.
      for (const report of [press, drag, release, focus]) typed(report);
      typed('d');
      await drain();
      expect(order).toEqual([
        'a',
        '\u001b[<64;1;1M',
        'leave',
        'b',
        'c',
        press,
        drag,
        release,
        focus,
        'leave',
        'd',
      ]);
    });

    // 2026-11-10: the thread was recorded for shielded sessions only, and never for a resume.
    describe('its thread', () => {
      const thread = '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28';
      const info = (sessionId: string) =>
        (
          manager as unknown as { sessionManager: PtyManager['sessionManager'] }
        ).sessionManager.loadSessionInfo(sessionId);

      it("is known from the start of a session that resumes it, with the user's title of it", async () => {
        saveCodex({ status: 'exited', codexThreadId: thread, userTitle: 'Estilos Clay' });
        await manager
          .createSession(['codex', 'resume', thread], {
            sessionId: 'resumed',
            workingDir: dir,
            shielded: true,
          })
          .catch(() => {});
        expect(created().command.join(' ')).toContain(`resume --no-alt-screen ${thread}`);
        expect(info('resumed')).toMatchObject({ codexThreadId: thread, userTitle: 'Estilos Clay' });
      });

      it('is recorded on any session, and brings the title the user gave it before', () => {
        saveCodex({ status: 'exited', codexThreadId: thread, userTitle: 'Estilos Clay' });
        const sessions = (manager as unknown as { sessionManager: PtyManager['sessionManager'] })
          .sessionManager;
        sessions.createSessionDirectory('shell');
        sessions.saveSessionInfo('shell', {
          id: 'shell',
          name: 'zsh',
          command: ['zsh'],
          workingDir: dir,
          status: 'running',
          startedAt: new Date(Date.now() + 1000).toISOString(),
        } as SessionInfo);
        expect(manager.setCodexThreadId('shell', thread)).toEqual({ userTitle: 'Estilos Clay' });
        expect(info('shell')).toMatchObject({ codexThreadId: thread, userTitle: 'Estilos Clay' });
        // The same thread again changes nothing.
        expect(manager.setCodexThreadId('shell', thread)).toEqual({});
      });

      it('is what a restore resumes, with the options the session had', async () => {
        saveCodex({
          codexThreadId: thread,
          command: ['codex', '-m', 'gpt-6', '--yolo', 'a prompt'],
        });
        expect(await manager.restoreOrFinishShieldedSession(id, 'tmux-lost')).toBe(true);
        expect(created().command.slice(1)).toEqual([
          'resume',
          '--no-alt-screen',
          thread,
          '-m',
          'gpt-6',
          '--yolo',
        ]);
      });
    });

    it('when a new shielded session starts it', async () => {
      await manager
        .createSession(['codex'], { sessionId: 'new-codex', workingDir: dir, shielded: true })
        .catch(() => {});
      expect(created().command.join(' ')).toContain('--no-alt-screen');
    });
  });

  it('resumes the Claude that was running and leaves the shell for afterwards', async () => {
    start(claude());
    expect(await manager.restoreOrFinishShieldedSession(id, 'tmux-lost')).toBe(true);
    expect(created().command[0]).toBe('/bin/sh');
    const words = created().command.slice(5);
    const claudeWords = Number(created().command[4]);
    expect(words.slice(claudeWords - 4, claudeWords)).toEqual([
      '--resume',
      'conv-live',
      '--model',
      'opus',
    ]);
    expect(words.slice(claudeWords)).toEqual(['/bin/zsh', '-l', '-i']);
    expect(created().cwd).toBe(dir);
  });

  it('brings back a plain shell when no Claude was running', async () => {
    start();
    expect(await manager.restoreOrFinishShieldedSession(id, 'tmux-lost')).toBe(true);
    expect(created().command.join(' ')).toContain('/bin/zsh');
    expect(created().command.join(' ')).not.toContain('--resume');
  });

  it('restores against a provider it can rebuild', async () => {
    start(claude({ customEnv: ['ANTHROPIC_BASE_URL'], modelProvider: { id: 'p1', model: '' } }));
    manager.setProviderEnvResolver(async () => ({ env: { ANTHROPIC_MODEL: 'm' }, unset: [] }));
    await manager.restoreOrFinishShieldedSession(id, 'tmux-lost');
    expect(created().command).toContain('--resume');
    expect(create.mock.calls[0][0]).toMatchObject({ overrideEnv: { ANTHROPIC_MODEL: 'm' } });
  });

  it('never falls back to the wrong backend when the provider cannot be rebuilt', async () => {
    start(claude({ customEnv: ['ANTHROPIC_BASE_URL'], modelProvider: { id: 'p1', model: '' } }));
    manager.setProviderEnvResolver(async () => null);
    expect(await manager.restoreOrFinishShieldedSession(id, 'tmux-lost')).toBe(true);
    expect(created().command).not.toContain('--resume');
    expect(created().command[4]).toContain('--resume conv-live');
    expect(create.mock.calls[0][0]).not.toHaveProperty('overrideEnv');
  });

  it('with an environment it cannot rebuild, restores the terminal and tells how', async () => {
    start(claude({ customEnv: ['ANTHROPIC_BASE_URL'] }));
    expect(await manager.restoreOrFinishShieldedSession(id, 'tmux-lost')).toBe(true);
    expect(created().command[4]).toContain('--resume conv-live');
    expect(created().command.slice(5)).toEqual(['/bin/zsh', '-l', '-i']);
  });
});
