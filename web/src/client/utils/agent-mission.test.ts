/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  agentKind,
  type BroadcastIo,
  broadcast,
  broadcastBlocked,
  missionCards,
} from './agent-mission.js';

const session = (id: string, overrides: Partial<Session> = {}): Session =>
  ({
    id,
    name: id,
    command: ['zsh'],
    workingDir: '/Users/x/Projects',
    status: 'running',
    startedAt: '2026-10-02T10:00:00.000Z',
    lastModified: '2026-10-02T10:00:00.000Z',
    ...overrides,
  }) as Session;

const CLAUDE_PROMPT = '> \n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const CLAUDE_DIALOG =
  'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently\n  ⏵⏵ accept edits on';

describe('mission control cards', () => {
  it('finds Claude, Codex and Gemini sessions and leaves shells and finished ones out', () => {
    expect(agentKind(session('a', { claudeStatus: { status: 'idle' } }))).toBe('claude');
    expect(agentKind(session('b', { codexActive: true }))).toBe('codex');
    expect(agentKind(session('c', { command: ['/opt/homebrew/bin/gemini'] }))).toBe('gemini');
    expect(agentKind(session('d', { command: ['zsh', '-lic', 'claude --resume x'] }))).toBe(
      'claude'
    );
    expect(agentKind(session('e'))).toBeNull();
    expect(agentKind(session('f', { status: 'exited', claudeStatus: { status: 'idle' } }))).toBe(
      null
    );
  });

  it('puts the agents that need you first, then working, then idle', () => {
    const cards = missionCards([
      session('idle', { claudeStatus: { status: 'idle', since: 5 } }),
      session('shell'),
      session('busy', {
        claudeStatus: {
          status: 'busy',
          since: 10,
          activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test', since: 20 },
        },
      }),
      session('codex-busy', { codexActive: true, activityStatus: { isActive: true } }),
      session('wait-new', { claudeStatus: { status: 'waiting', since: 300 } }),
      session('wait-old', { claudeStatus: { status: 'waiting', since: 100 } }),
      session('gemini-idle', {
        geminiActive: true,
        activityStatus: { isActive: false, lastActivityAt: '2026-10-02T10:05:00.000Z' },
      }),
    ]);
    expect(cards.map((card) => [card.session.id, card.state])).toEqual([
      ['wait-old', 'waiting'],
      ['wait-new', 'waiting'],
      ['busy', 'working'],
      ['codex-busy', 'working'],
      ['gemini-idle', 'idle'],
      ['idle', 'idle'],
    ]);
    // Time in the current state: the running tool's start while working.
    expect(cards.find((card) => card.session.id === 'busy')?.since).toBe(20);
    expect(cards.find((card) => card.session.id === 'gemini-idle')?.since).toBe(
      Date.parse('2026-10-02T10:05:00.000Z')
    );
  });
});

describe('a Codex card', () => {
  it('follows Codex’s own state, not its terminal’s output', () => {
    const codex = (status: 'busy' | 'waiting' | 'idle', isActive: boolean) =>
      missionCards([
        session('c', {
          codexActive: true,
          agentStatus: { agent: 'codex', status, since: 42 },
          activityStatus: { isActive },
        }),
      ])[0];
    expect(codex('busy', false)).toMatchObject({ kind: 'codex', state: 'working', since: 42 });
    expect(codex('idle', true).state).toBe('idle');
    expect(codex('waiting', false)).toMatchObject({ state: 'waiting', since: 42 });
  });

  it('is never typed into while the server sees its menu up', () => {
    const card = {
      kind: 'codex' as const,
      session: session('c', {
        codexActive: true,
        agentStatus: {
          agent: 'codex',
          status: 'waiting',
          choices: { question: 'Trust this folder?', options: ['Trust and continue', 'Back'] },
        },
      }),
    };
    expect(broadcastBlocked(card, '› Ask Codex to do anything')).toBe(true);
  });
});

describe('broadcast', () => {
  const claude = (id: string, extra: Partial<Session> = {}) =>
    session(id, { claudeStatus: { status: 'idle' }, ...extra });

  it('never types into a session showing a dialog and reports each result', async () => {
    const screens: Record<string, string> = {
      ok: CLAUDE_PROMPT,
      dialog: CLAUDE_DIALOG,
      nomode: 'Select model\n  Sonnet\n  Opus',
      codex: '› Implement {feature}\n\n  ? for shortcuts',
      broken: CLAUDE_PROMPT,
    };
    const send = vi.fn(async (id: string) => {
      if (id === 'broken') throw new Error('HTTP 500');
    });
    const io: BroadcastIo = { readScreen: async (id) => screens[id], send };
    const cards = missionCards([
      claude('ok'),
      claude('dialog'),
      claude('nomode'),
      session('codex', { codexActive: true }),
      claude('broken'),
    ]);
    const results = await broadcast(cards, 'Sigue', io);
    expect(Object.fromEntries(results.map((r) => [r.sessionId, r.outcome]))).toEqual({
      ok: 'sent',
      dialog: 'blocked',
      nomode: 'blocked',
      codex: 'sent',
      broken: 'failed',
    });
    expect(send.mock.calls.map((call) => call[0]).sort()).toEqual(['broken', 'codex', 'ok']);
    expect(send).toHaveBeenCalledWith('ok', 'Sigue');
    expect(results.find((r) => r.sessionId === 'broken')?.error).toBe('HTTP 500');
  });

  it('skips a Codex or Gemini session that shows a numbered choice', () => {
    const card = { kind: 'codex' as const, session: session('c', { codexActive: true }) };
    expect(
      broadcastBlocked(card, 'Allow command?\n› 1. Yes, proceed\n  2. No, tell Codex what to do')
    ).toBe(true);
    expect(
      broadcastBlocked(
        { kind: 'gemini', session: session('g', { geminiActive: true }) },
        "Allow execution of: 'ls'?\n ● 1. Yes, allow once\n   2. No, suggest changes (esc)"
      )
    ).toBe(true);
    expect(broadcastBlocked(card, '› Write tests for @filename')).toBe(false);
  });

  it('skips a tmux session opened only to watch: tmux would drop the text', async () => {
    const io: BroadcastIo = { readScreen: vi.fn(async () => CLAUDE_PROMPT), send: vi.fn() };
    const multiplexer = {
      type: 'tmux',
      socketPath: '/tmp/tmux-501/default',
      serverPid: 15674,
      serverStartedAt: 1727426400,
      sessionId: '$0',
      sessionName: '0',
      sizing: 'others',
      source: 'mac-sessions',
    } as const;
    const results = await broadcast(
      missionCards([
        claude('watching', { multiplexer: { ...multiplexer, mode: 'watch' } }),
        claude('typing', { multiplexer: { ...multiplexer, mode: 'control' } }),
      ]),
      'Sigue',
      io
    );
    expect(Object.fromEntries(results.map((r) => [r.sessionId, r.outcome]))).toEqual({
      watching: 'watchOnly',
      typing: 'sent',
    });
    expect(io.send).toHaveBeenCalledTimes(1);
    expect(io.send).toHaveBeenCalledWith('typing', 'Sigue');
    expect(io.readScreen).not.toHaveBeenCalledWith('watching');
  });

  it('skips sessions that ended and ones the server already sees waiting on a choice', async () => {
    const io: BroadcastIo = { readScreen: async () => CLAUDE_PROMPT, send: vi.fn() };
    const waiting = claude('w', {
      claudeStatus: { status: 'waiting', choices: { question: 'Allow?', options: ['Yes', 'No'] } },
    });
    const ended = { ...claude('x'), status: 'exited' } as Session;
    const results = await broadcast(
      [
        { session: waiting, kind: 'claude', state: 'waiting' },
        { session: ended, kind: 'claude', state: 'idle' },
      ],
      'Sigue',
      io
    );
    expect(results.map((r) => r.outcome)).toEqual(['blocked', 'exited']);
    expect(io.send).not.toHaveBeenCalled();
  });
});
