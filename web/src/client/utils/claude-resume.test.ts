// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  ClaudeLiveOutsideError,
  claudeResumeCommand,
  findLiveClaudeSession,
  liveOutsideText,
  preferChatMode,
  resumableAgent,
  resumeClaudeConversation,
  resumeSession,
  userSkipsPermissions,
} from './claude-resume.js';

const session = (overrides: Partial<Session>): Session =>
  ({ id: 's', command: ['zsh'], workingDir: '/w', status: 'running', ...overrides }) as Session;

describe('claude-resume', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the resume command with the permissions flag only when asked', () => {
    expect(claudeResumeCommand('abc', false)).toEqual(['claude', '--resume', 'abc']);
    expect(claudeResumeCommand('abc', true)).toEqual([
      'claude',
      '--resume',
      'abc',
      '--dangerously-skip-permissions',
    ]);
  });

  it('follows how the newest Claude session was started', () => {
    expect(
      userSkipsPermissions([
        session({ command: ['claude'], startedAt: '2026-10-01T00:00:00Z' }),
        session({
          command: ['claude', '--dangerously-skip-permissions'],
          startedAt: '2026-10-02T00:00:00Z',
        }),
      ])
    ).toBe(true);
    expect(userSkipsPermissions([])).toBe(false);
    localStorage.setItem(
      'ut-phone-recent-starts',
      JSON.stringify({ tool: 'claude --dangerously-skip-permissions' })
    );
    expect(userSkipsPermissions([])).toBe(true);
  });

  it('finds a running session already showing the conversation', () => {
    const sessions = [
      session({ id: 'old', status: 'exited', claudeSessionId: 'c1' }),
      session({ id: 'live', claudeSessionId: 'c1' }),
    ];
    expect(findLiveClaudeSession(sessions, 'c1')?.id).toBe('live');
    expect(findLiveClaudeSession(sessions, 'c2')).toBeUndefined();
  });

  it('keeps other app preferences when asking for chat mode', () => {
    localStorage.setItem('untether_app_preferences', JSON.stringify({ theme: 'dark' }));
    preferChatMode();
    expect(JSON.parse(localStorage.getItem('untether_app_preferences') || '{}')).toEqual({
      theme: 'dark',
      chatMode: true,
    });
  });

  it('posts the session and reports server errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      resumeClaudeConversation({ claudeSessionId: 'c1', workingDir: '/w', skipPermissions: false })
    ).resolves.toMatchObject({ sessionId: 'new' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      command: ['claude', '--resume', 'c1'],
      workingDir: '/w',
      spawn_terminal: false,
    });
    await expect(
      resumeClaudeConversation({ claudeSessionId: 'c1', workingDir: '/w', skipPermissions: false })
    ).rejects.toThrow('nope');
  });

  it('says where a conversation runs when the server won’t resume it there', async () => {
    const live = { where: 'terminal', app: 'Terminal', chatId: 'a-530-1759395600' };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'live-elsewhere', live }), { status: 409 })
      )
    );
    const error = await resumeClaudeConversation({
      claudeSessionId: 'c1',
      workingDir: '/w',
      skipPermissions: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeLiveOutsideError);
    expect((error as ClaudeLiveOutsideError).live).toEqual(live);
    expect((error as Error).message).toBe(
      'Open in Terminal right now. Close it there to continue here.'
    );
  });

  // 2026-11-10: an ended Codex session offered no Resume, and Reopen started a new Codex.
  describe('an ended session: its Claude conversation, else its Codex thread', () => {
    const thread = '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28';
    const ended = (overrides: Partial<Session>) => session({ status: 'exited', ...overrides });

    it('tells what can be resumed, only when the server says it can', () => {
      expect(resumableAgent(ended({ claudeSessionId: 'c1', claudeResumable: true }))).toBe(
        'claude'
      );
      expect(resumableAgent(ended({ codexThreadId: thread, codexResumable: true }))).toBe('codex');
      expect(resumableAgent(ended({ codexThreadId: thread, codexResumable: false }))).toBeNull();
      expect(resumableAgent(ended({ codexThreadId: thread }))).toBeNull();
      expect(resumableAgent(ended({}))).toBeNull();
      // Still running: nothing to resume.
      expect(resumableAgent(session({ codexThreadId: thread, codexResumable: true }))).toBeNull();
      // Both (a shell where both ran): Claude, as before.
      expect(
        resumableAgent(
          ended({
            claudeSessionId: 'c1',
            claudeResumable: true,
            codexThreadId: thread,
            codexResumable: true,
          })
        )
      ).toBe('claude');
      // A Claude conversation that can't be resumed leaves the Codex thread.
      expect(
        resumableAgent(
          ended({
            claudeSessionId: 'c1',
            claudeResumable: false,
            codexThreadId: thread,
            codexResumable: true,
          })
        )
      ).toBe('codex');
    });

    it('resumes a Codex thread with `codex resume <id>`, shielded again when it was', async () => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 })
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        resumeSession(
          ended({
            command: ['/opt/homebrew/bin/codex', '--yolo'],
            name: 'codex (~/w)',
            codexThreadId: thread,
            codexResumable: true,
            shielded: true,
          }),
          { Authorization: 'Bearer t' }
        )
      ).resolves.toMatchObject({ sessionId: 'new' });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('/api/sessions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
      // Its options are the server's to add (the ended session's own).
      expect(JSON.parse(String(init.body))).toEqual({
        command: ['codex', 'resume', thread],
        workingDir: '/w',
        name: 'codex (~/w)',
        spawn_terminal: false,
        shielded: true,
      });
    });

    it('resumes a Claude conversation as before', async () => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 })
      );
      vi.stubGlobal('fetch', fetchMock);
      await resumeSession(
        ended({
          command: ['claude', '--dangerously-skip-permissions'],
          claudeSessionId: 'c1',
          claudeResumable: true,
        })
      );
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        command: ['claude', '--resume', 'c1', '--dangerously-skip-permissions'],
        workingDir: '/w',
        spawn_terminal: false,
      });
    });

    it('says where a Codex thread is open when the server won’t resume it', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: 'live-elsewhere', live: { where: 'terminal' } }), {
              status: 409,
            })
        )
      );
      const error = await resumeSession(
        ended({ codexThreadId: thread, codexResumable: true })
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ClaudeLiveOutsideError);
    });

    it('refuses a session with nothing to resume', async () => {
      await expect(resumeSession(ended({}))).rejects.toThrow('Nothing to resume');
    });
  });

  it('words where it runs: an app, tmux, or just outside Untether', () => {
    expect(liveOutsideText({ where: 'terminal', app: 'iTerm' })).toBe(
      'Open in iTerm right now. Close it there to continue here.'
    );
    expect(liveOutsideText({ where: 'terminal', app: 'SSH' })).toBe(
      'Open in SSH session right now. Close it there to continue here.'
    );
    expect(liveOutsideText({ where: 'terminal' })).toBe(
      'Running outside Untether right now. Close it there to continue here.'
    );
    expect(liveOutsideText({ where: 'tmux', tmuxId: 't-1-2-3' })).toBe(
      'Running in tmux right now. Open it from the list to continue.'
    );
  });
});
