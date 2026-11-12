import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PtyManager } from '../../server/pty/pty-manager';
import { SessionManager } from '../../server/pty/session-manager';
import type { SessionInfo } from '../../shared/types';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

// User report: a Claude started in a Mac Terminal window and forwarded into Untether (`fwd_`)
// exited with `claude --resume <id>` as its command but no recorded conversation, so the
// exited view offered no "Resume Claude".
describe('PtyManager Claude conversation from a --resume command', () => {
  let controlPath: string;
  let manager: PtyManager;

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  beforeEach(() => {
    controlPath = fs.mkdtempSync('/tmp/vtc.');
    manager = new PtyManager(controlPath);
  });

  afterEach(async () => {
    await manager.shutdown();
    fs.rmSync(controlPath, RM_TEST_DIR);
  });

  function writeSession(id: string, fields: Partial<SessionInfo>) {
    const sessionManager = manager.getSessionManager();
    sessionManager.createSessionDirectory(id);
    sessionManager.saveSessionInfo(id, {
      id,
      name: 'claude',
      command: ['/u/.local/bin/claude', '--dangerously-skip-permissions', '--resume', 'conv-1'],
      workingDir: controlPath,
      status: 'exited',
      exitCode: 0,
      startedAt: '2026-01-01T00:00:00Z',
      ...fields,
    } as SessionInfo);
  }

  it('reads it from the command and keeps it in session.json', () => {
    writeSession('fwd_1_2', {});

    expect(manager.getSession('fwd_1_2')?.claudeSessionId).toBe('conv-1');
    expect(manager.listSessions().find((s) => s.id === 'fwd_1_2')?.claudeSessionId).toBe('conv-1');
    // Persisted: a restarted server (a new manager) reads it from disk.
    expect(manager.getSessionManager().loadSessionInfo('fwd_1_2')?.claudeSessionId).toBe('conv-1');
  });

  it('keeps a conversation recorded from Claude itself, and leaves other commands alone', () => {
    writeSession('fwd_3_4', { claudeSessionId: 'live-conv' });
    writeSession('fwd_5_6', { command: ['/u/.local/bin/claude'] });

    expect(manager.getSession('fwd_3_4')?.claudeSessionId).toBe('live-conv');
    expect(manager.getSession('fwd_5_6')?.claudeSessionId).toBeUndefined();
    expect(manager.getSessionManager().loadSessionInfo('fwd_5_6')?.claudeSessionId).toBeUndefined();
  });

  // 2026-11-09: the doctor compared sessions against settings.json as it is now.
  it('keeps what settings.json said when the conversation started, on disk', () => {
    const claudeDir = fs.mkdtempSync('/tmp/vtc-claude.');
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const settings = (model: string) =>
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model }));
    try {
      writeSession('s1', { command: ['/u/.local/bin/claude'] });
      settings('claude-opus-5-5');
      manager.setClaudeSessionId('s1', 'conv-a');
      settings('fable');
      manager.setClaudeSessionId('s1', 'conv-a');
      expect(manager.getSessionManager().loadSessionInfo('s1')?.claudeStartSettings).toEqual({
        model: 'claude-opus-5-5',
        conversations: ['conv-a'],
      });
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  });

  // 2026-10-18 (user report "se pierde el nombre al recuperar una sesión cerrada"): resumed
  // sessions started with only "claude (~/Projects)"; the user typed "TRAVEL DESK",
  // "ATLAS" and "TELEVISIÓN" again by hand.
  describe("the titles of the conversation's earlier sessions", () => {
    it('are taken by a Mac window reopened with `ut claude --resume`', () => {
      writeSession('old', {
        claudeSessionId: 'conv-1',
        userTitle: 'ATLAS',
        claudeTitle: 'Flashear firmware',
        startedAt: '2026-01-01T00:00:00Z',
      });
      writeSession('fwd_7_8', { startedAt: '2026-01-02T00:00:00Z' });

      const session = manager.getSession('fwd_7_8');
      expect(session?.userTitle).toBe('ATLAS');
      expect(session?.claudeTitle).toBe('Flashear firmware');
      // Persisted, so a server restart still shows it.
      expect(manager.getSessionManager().loadSessionInfo('fwd_7_8')?.userTitle).toBe('ATLAS');
    });

    it('the group the user anchored it to: persisted, cleared, and taken on resume (2026-11-04)', () => {
      writeSession('old', { claudeSessionId: 'conv-1', startedAt: '2026-01-01T00:00:00Z' });
      const pin = { repoPath: '/Users/n/Projects/finanzas' };
      expect(manager.setGroupPin('old', pin)).toBe(true);
      expect(manager.getSession('old')?.groupPin).toEqual(pin);
      // A restarted server (a new manager) reads it from session.json.
      expect(new SessionManager(controlPath).loadSessionInfo('old')?.groupPin).toEqual(pin);
      writeSession('fwd_9_9', { startedAt: '2026-01-02T00:00:00Z' });
      expect(manager.getSession('fwd_9_9')?.groupPin).toEqual(pin);

      expect(manager.setGroupPin('old', null)).toBe(true);
      expect(manager.getSessionManager().loadSessionInfo('old')?.groupPin).toBeUndefined();
      expect(manager.setGroupPin('missing', pin)).toBe(false);
    });

    it('follow the newest session only: a title the user cleared there stays cleared', () => {
      writeSession('a', {
        claudeSessionId: 'conv-1',
        userTitle: 'Old name',
        startedAt: '2026-01-01T00:00:00Z',
      });
      writeSession('b', { claudeSessionId: 'conv-1', startedAt: '2026-01-02T00:00:00Z' });
      writeSession('c', { command: ['zsh'], startedAt: '2026-01-03T00:00:00Z' });

      manager.setClaudeSessionId('c', 'conv-1');
      expect(manager.getSessionManager().loadSessionInfo('c')?.userTitle).toBeUndefined();
    });

    it("never replace the session's own title, nor come from sessions started after it", () => {
      writeSession('mine', {
        command: ['zsh'],
        userTitle: 'My title',
        startedAt: '2026-01-01T00:00:00Z',
      });
      writeSession('older', { command: ['zsh'], startedAt: '2026-01-01T00:00:00Z' });
      writeSession('later', {
        claudeSessionId: 'conv-2',
        userTitle: 'Later title',
        startedAt: '2026-01-05T00:00:00Z',
      });

      manager.setClaudeSessionId('older', 'conv-2');
      manager.setClaudeSessionId('mine', 'conv-2');
      expect(manager.getSessionManager().loadSessionInfo('mine')?.userTitle).toBe('My title');
      expect(manager.getSessionManager().loadSessionInfo('older')?.userTitle).toBeUndefined();
    });

    it('are taken by a new session resuming the conversation, from its first write', async () => {
      writeSession('closed', {
        claudeSessionId: 'conv-9',
        userTitle: 'TRAVEL DESK',
        claudeTitle: 'Videos del curso',
      });
      // A stand-in `claude` (the real one must not run in a test).
      const bin = fs.mkdtempSync('/tmp/vtc-bin.');
      const claude = path.join(bin, 'claude');
      fs.writeFileSync(claude, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
      try {
        const { sessionId } = await manager.createSession([claude, '--resume', 'conv-9'], {
          name: 'claude (~/Projects)',
          workingDir: controlPath,
          cols: 80,
          rows: 24,
        });
        const info = manager.getSessionManager().loadSessionInfo(sessionId);
        expect(info?.userTitle).toBe('TRAVEL DESK');
        expect(info?.claudeTitle).toBe('Videos del curso');
        expect(info?.claudeSessionId).toBe('conv-9');
        await manager.killSession(sessionId);
      } finally {
        fs.rmSync(bin, RM_TEST_DIR);
      }
    });
  });
});
