import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo, SessionMultiplexer } from '../../shared/types';
import { readClaudeChat } from './claude-chat';
import { readCodexChat } from './codex-chat';
import { codexSessionRef } from './codex-process';
import { readGeminiChat } from './gemini-chat';
import { geminiSessionRef } from './gemini-process';
import { readSessionChat } from './session-chat';

vi.mock('./claude-chat', () => ({ readClaudeChat: vi.fn() }));
vi.mock('./codex-chat', async (importActual) => ({
  ...(await importActual<typeof import('./codex-chat')>()),
  readCodexChat: vi.fn(() => ({ available: true, agent: 'codex', messages: [] })),
}));
vi.mock('./gemini-chat', async (importActual) => ({
  ...(await importActual<typeof import('./gemini-chat')>()),
  readGeminiChat: vi.fn(() => ({ available: true, agent: 'gemini', messages: [] })),
}));
vi.mock('./codex-process', () => ({ codexSessionRef: vi.fn() }));
vi.mock('./gemini-process', () => ({ geminiSessionRef: vi.fn() }));

const multiplexer = (socketPath: string): SessionMultiplexer => ({
  type: 'tmux',
  socketPath,
  serverPid: 90,
  serverStartedAt: 1_790_000_000,
  sessionId: '$0',
  sessionName: 'work',
  mode: 'control',
  sizing: 'others',
  source: 'mac-sessions',
});

/** A session attached to `$0` of the tmux server at `socketPath` (`tmux -L <name>`). */
function attached(socketPath: string): SessionInfo & { pid: number } {
  return {
    id: 'attached',
    name: 'tmux: work',
    command: ['/usr/bin/tmux', '-u', '-N', '-S', socketPath, 'attach-session', '-t', '$0'],
    workingDir: '/Users/me/project',
    status: 'running',
    startedAt: '2026-10-03T10:00:00.000Z',
    pid: 500,
    multiplexer: multiplexer(socketPath),
  };
}

describe('readSessionChat', () => {
  const claudeChat = { available: true, status: 'idle', messages: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readClaudeChat).mockResolvedValue(claudeChat);
    vi.mocked(codexSessionRef).mockResolvedValue(null);
    vi.mocked(geminiSessionRef).mockResolvedValue(null);
  });

  it('reads an attached tmux session from its pane, whatever its socket is called', async () => {
    // `tmux -L codex` and `-L gemini` put "codex" and "gemini" in the client's command line.
    for (const socketPath of ['/tmp/tmux-501/codex', '/tmp/tmux-501/gemini']) {
      expect(await readSessionChat(attached(socketPath), 700)).toBe(claudeChat);
    }
    expect(readClaudeChat).toHaveBeenCalledWith(700);
    expect(readCodexChat).not.toHaveBeenCalled();
    expect(readGeminiChat).not.toHaveBeenCalled();
  });

  it("finds Codex in an attached session's pane from its process", async () => {
    vi.mocked(readClaudeChat).mockResolvedValue({ available: false, messages: [] });
    const ref = { id: 'proc:701:1790000000000', workingDir: '/x', startedAt: '2026-10-03' };
    vi.mocked(codexSessionRef).mockResolvedValue(ref);
    const chat = await readSessionChat(attached('/tmp/tmux-501/default'), 700);
    expect(codexSessionRef).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 700, multiplexer: expect.any(Object) })
    );
    expect(readCodexChat).toHaveBeenCalledWith(ref);
    expect(chat).toMatchObject({ agent: 'codex' });
  });

  it('still reads a session started with codex or gemini from its command', async () => {
    const started = (command: string[]) => ({
      ...attached('/unused'),
      multiplexer: undefined,
      command,
    });
    expect(await readSessionChat(started(['codex']), 500)).toMatchObject({ agent: 'codex' });
    expect(await readSessionChat(started(['gemini']), 500)).toMatchObject({ agent: 'gemini' });
    expect(readClaudeChat).not.toHaveBeenCalled();
  });
});
