import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { readClaudeSessionIds } from './claude-chat.js';
import {
  claudeResumeTarget,
  missingClaudeSessionId,
  recordMissingClaudeSessionIds,
} from './claude-session-id.js';

const session = (fields: Partial<Session>): Session =>
  ({
    id: 's1',
    name: 'claude',
    command: ['claude'],
    workingDir: '/w',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    ...fields,
  }) as Session;

describe('claudeResumeTarget', () => {
  it('reads --resume <id>, -r <id> and --resume=<id> from a claude command', () => {
    expect(
      claudeResumeTarget([
        '/u/.local/bin/claude',
        '--dangerously-skip-permissions',
        '--resume',
        'c1',
      ])
    ).toBe('c1');
    expect(claudeResumeTarget(['claude', '-r', 'c2'])).toBe('c2');
    expect(claudeResumeTarget(['claude', '--resume=c3'])).toBe('c3');
  });

  it('answers null for no id, another program or no command', () => {
    expect(claudeResumeTarget(['claude', '--resume'])).toBeNull();
    expect(claudeResumeTarget(['claude', '--resume', '--verbose'])).toBeNull();
    expect(claudeResumeTarget(['claude', '--resume='])).toBeNull();
    expect(claudeResumeTarget(['codex', 'resume', 'c1'])).toBeNull();
    expect(claudeResumeTarget(['claude'])).toBeNull();
    expect(claudeResumeTarget(undefined)).toBeNull();
  });
});

describe('missingClaudeSessionId', () => {
  it('takes the id from the command only when the session has none', () => {
    // User report: a forwarded Terminal-window `claude --resume <id>` exited without it.
    expect(
      missingClaudeSessionId({
        command: ['/u/.local/bin/claude', '--dangerously-skip-permissions', '--resume', 'c1'],
      })
    ).toBe('c1');
    expect(
      missingClaudeSessionId({ command: ['claude', '--resume', 'c1'], claudeSessionId: 'live' })
    ).toBeNull();
    expect(missingClaudeSessionId({ command: ['claude'] })).toBeNull();
  });
});

describe('recordMissingClaudeSessionIds', () => {
  it('saves what Claude reports for running sessions that lack it or moved on', async () => {
    const save = vi.fn();
    const readIds = vi.fn(
      async (pids: number[]) => new Map(pids.map((pid) => [pid, `conv-${pid}`]))
    );
    const saved = await recordMissingClaudeSessionIds({
      listSessions: () => [
        session({ id: 'fwd_1_2', pid: 10 }),
        session({ id: 'known', pid: 11, claudeSessionId: 'conv-11' }),
        session({ id: 'cleared', pid: 13, claudeSessionId: 'before-clear' }),
        session({ id: 'gone', pid: 12, status: 'exited' }),
        session({ id: 'nopid' }),
      ],
      rootPid: (s) => s.pid,
      save,
      readIds,
    });
    expect(saved).toBe(2);
    expect(readIds).toHaveBeenCalledWith([10, 11, 13]);
    expect(save).toHaveBeenCalledWith('fwd_1_2', 'conv-10');
    expect(save).toHaveBeenCalledWith('cleared', 'conv-13');
    expect(save).not.toHaveBeenCalledWith('known', expect.anything());
  });

  it('does not read anything when no session runs, and survives a failed save', async () => {
    const readIds = vi.fn(async () => new Map<number, string>());
    expect(
      await recordMissingClaudeSessionIds({
        listSessions: () => [session({ pid: 1, status: 'exited' })],
        rootPid: (s) => s.pid,
        save: vi.fn(),
        readIds,
      })
    ).toBe(0);
    expect(readIds).not.toHaveBeenCalled();

    expect(
      await recordMissingClaudeSessionIds({
        listSessions: () => [session({ pid: 1 })],
        rootPid: (s) => s.pid,
        save: () => {
          throw new Error('disk full');
        },
        readIds: async () => new Map([[1, 'c']]),
      })
    ).toBe(0);
  });
});

describe('readClaudeSessionIds', () => {
  it("reads the conversation from Claude's session file, with or without a status", async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-ids-'));
    try {
      fs.mkdirSync(path.join(claudeDir, 'sessions'));
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${process.pid}.json`),
        JSON.stringify({ sessionId: 'conv', cwd: '/x' })
      );
      const ids = await readClaudeSessionIds([process.pid, 999_999_999], claudeDir);
      expect(ids.get(process.pid)).toBe('conv');
      expect(ids.has(999_999_999)).toBe(false);
      expect((await readClaudeSessionIds([], claudeDir)).size).toBe(0);
    } finally {
      fs.rmSync(claudeDir, RM_TEST_DIR);
    }
  });
});
