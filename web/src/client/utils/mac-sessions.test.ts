// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_SESSION_VIEW_EVENT,
  MAC_SESSIONS_CHANGED_EVENT,
  type MacAgentSession,
  type MacSessionsResponse,
  type MacTmuxPaneAgent,
  type MacTmuxSession,
} from '../../shared/mac-sessions.js';
import {
  fetchMacSessions,
  isAttachedTmuxSession,
  isMacWindowSession,
  MacSessionsApiError,
  macItemBadge,
  macItemStatusText,
  macItemTime,
  macItemTitle,
  macItemWhere,
  macOpenErrorText,
  macRowLabel,
  macSessionsHeading,
  macSessionsPlatform,
  macSessionViewDetail,
  macWarningTexts,
  macWindowLabel,
  macWindowMarkerLabel,
  matchesMacQuery,
  openMacSession,
  readMacSectionCollapsed,
  rememberMacSessionsPlatform,
  showMacConversation,
  writeMacSectionCollapsed,
} from './mac-sessions.js';

const pane = (over: Partial<MacTmuxPaneAgent> = {}): MacTmuxPaneAgent => ({
  agent: 'claude',
  chatId: 'p-4100-1759490000-3',
  windowIndex: 1,
  windowName: 'zsh',
  inCurrentWindow: true,
  activePane: true,
  cwd: '/Users/u/project',
  ...over,
});

const tmux = (over: Partial<MacTmuxSession> = {}): MacTmuxSession => ({
  kind: 'tmux',
  id: 't-4100-1759490000-0',
  name: 'work',
  server: { label: '', isDefault: true },
  windows: 2,
  activityAt: '2026-10-03T19:39:58.000Z',
  current: {
    windowIndex: 1,
    windowName: 'zsh',
    command: 'npm',
    cwd: '/Users/u/project',
    width: 80,
    height: 24,
  },
  agents: [],
  alsoOpenIn: [],
  canOpen: true,
  ...over,
});

const agent = (over: Partial<MacAgentSession> = {}): MacAgentSession => ({
  kind: 'agent',
  id: 'a-20085-1759500000',
  chatId: 'a-20085-1759500000',
  agent: 'claude',
  app: 'Terminal',
  tty: 'ttys007',
  cwd: '/Users/u/docs',
  startedAt: '2026-10-03T14:00:00.000Z',
  ...over,
});

// The global localStorage mock stores nothing; give these tests a real one.
const store = new Map<string, string>();
beforeEach(() => {
  vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
    store.set(key, value);
  });
  vi.mocked(localStorage.removeItem).mockImplementation((key) => {
    store.delete(key);
  });
});
afterEach(() => {
  store.clear();
  vi.mocked(localStorage.getItem).mockReset();
  vi.mocked(localStorage.setItem).mockReset();
  vi.mocked(localStorage.removeItem).mockReset();
});

const response = (over: Partial<MacSessionsResponse> = {}): MacSessionsResponse => ({
  enabled: true,
  platform: 'darwin',
  openMode: 'control',
  items: [tmux()],
  warnings: [],
  ...over,
});

describe('Mac sessions: wording', () => {
  it('says "this Mac" only for a server on macOS', () => {
    expect(macSessionsHeading('darwin')).toBe('On this Mac');
    expect(macSessionsHeading('linux')).toBe('On this computer');
    expect(macSessionsHeading(null)).toBe('On this computer');
  });

  it('labels a session opened with ut in a terminal window by its app', () => {
    expect(macWindowLabel({ app: 'Terminal' }, 'darwin')).toBe('On the Mac · Terminal');
    expect(macWindowLabel({ app: null }, 'darwin')).toBe('On the Mac');
    expect(macWindowLabel({ app: 'kitty' }, 'linux')).toBe('On this computer · kitty');
    expect(macWindowLabel({ app: null }, null)).toBe('On this computer');
    expect(macWindowLabel({ app: 'SSH' }, 'darwin')).toBe('On the Mac · SSH session');
    expect(macWindowMarkerLabel('darwin')).toBe('Runs in a terminal window on this Mac');
    expect(macWindowMarkerLabel('linux')).toBe('Runs in a terminal window on this computer');
    expect(isMacWindowSession({ macWindow: { app: null } })).toBe(true);
    expect(isMacWindowSession({})).toBe(false);
  });

  it('knows the sessions attached to a tmux session outside Untether', () => {
    const multiplexer = {
      type: 'tmux',
      socketPath: '/tmp/tmux-501/default',
      serverPid: 4100,
      serverStartedAt: 1759490000,
      sessionId: '$0',
      sessionName: 'work',
      mode: 'control',
      sizing: 'others',
      source: 'mac-sessions',
    } as const;
    expect(isAttachedTmuxSession({ name: 'work', multiplexer })).toBe(true);
    // Opened from the tmux sessions modal before sessions carried `multiplexer`.
    expect(isAttachedTmuxSession({ name: 'tmux: work:1' })).toBe(true);
    expect(isAttachedTmuxSession({ name: 'claude (~/project)' })).toBe(false);
  });

  it('titles a tmux row by its agent, else its pane, else its name', () => {
    expect(
      macItemTitle(tmux({ agents: [pane({ status: { status: 'idle', title: 'Fix login' } })] }))
    ).toBe('Fix login');
    expect(macItemTitle(tmux({ agents: [pane({ title: 'Docs pass' })] }))).toBe('Docs pass');
    expect(
      macItemTitle(
        tmux({ current: { ...tmux().current, title: 'build | watch' }, agents: [pane()] })
      )
    ).toBe('build | watch');
    expect(macItemTitle(tmux())).toBe('work');
  });

  it('titles an agent row by its title, else its folder, else its name', () => {
    expect(macItemTitle(agent({ status: { status: 'idle', title: 'Docs pass' } }))).toBe(
      'Docs pass'
    );
    expect(macItemTitle(agent())).toBe('docs');
    expect(macItemTitle(agent({ agent: 'codex', cwd: undefined }))).toBe('Codex');
  });

  it('says where it runs', () => {
    expect(macItemWhere(tmux())).toBe('tmux · work');
    expect(macItemWhere(tmux({ server: { label: 'ci', isDefault: false } }))).toBe(
      'tmux (ci) · work'
    );
    expect(macItemWhere(agent())).toBe('Terminal');
    expect(macItemWhere(agent({ app: 'Visual Studio Code' }))).toBe('Visual Studio Code');
    expect(macItemWhere(agent({ app: 'SSH' }))).toBe('SSH session');
    expect(macItemWhere(agent({ app: undefined }))).toBe('Other terminal');
    expect(macItemWhere(agent({ app: undefined, inTmux: { server: '' } }))).toBe('tmux');
  });

  it('badges what is open here and what is read-only', () => {
    expect(macItemBadge(tmux())).toBe('');
    expect(macItemBadge(tmux({ utSessionId: 's1', utMode: 'control' }))).toBe('In Untether');
    expect(macItemBadge(tmux({ utSessionId: 's1', utMode: 'watch' }))).toBe('Watching');
    expect(macItemBadge(agent())).toBe('Read-only');
  });

  it("says what the agent is doing, or the pane's program and folder", () => {
    const waiting = pane({ status: { status: 'waiting', waitingFor: 'permission prompt' } });
    expect(macItemStatusText(tmux({ agents: [waiting] }))).toBe('Needs you · Permission request');
    const busy = agent({
      status: { status: 'busy', activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test' } },
    });
    expect(macItemStatusText(busy)).toContain('pnpm test');
    expect(macItemStatusText(agent({ status: { status: 'busy' } }))).toBe('Working');
    expect(
      macItemStatusText(
        agent({ status: { status: 'idle', preview: { role: 'user', text: 'hola' } } })
      )
    ).toBe('You: hola');
    expect(macItemStatusText(tmux())).toBe('npm · ~/project');
    // Opening shows the current window: say where the agent is when it is elsewhere.
    expect(
      macItemStatusText(
        tmux({ agents: [pane({ inCurrentWindow: false, windowIndex: 2, status: waiting.status })] })
      )
    ).toBe('Claude in window 2 · Needs you · Permission request');
  });

  it('dates a row by its status, else its activity or start', () => {
    const since = Date.parse('2026-10-03T19:00:00.000Z');
    expect(macItemTime(tmux({ agents: [pane({ status: { status: 'busy', since } })] }))).toBe(
      '2026-10-03T19:00:00.000Z'
    );
    expect(macItemTime(tmux())).toBe('2026-10-03T19:39:58.000Z');
    expect(macItemTime(agent())).toBe('2026-10-03T14:00:00.000Z');
  });

  it('reads the row as one label: title, where, status', () => {
    const item = tmux({
      agents: [
        pane({ status: { status: 'busy', title: 'Refactor parser' } }),
        pane({ agent: 'codex', chatId: 'p-4100-1759490000-4' }),
      ],
      alsoOpenIn: ['Terminal', 'Terminal'],
      utSessionId: 's1',
    });
    expect(macRowLabel(item, '5 min')).toBe(
      'Refactor parser, tmux · work · 2 windows · Also open in Terminal · In Untether, Working · +1 more · 5 min'
    );
    expect(macRowLabel(agent({ cwd: undefined }))).toBe('Claude, Terminal · Read-only');
  });

  it('finds rows by title, tmux name, folder, app and agent', () => {
    const item = tmux({
      name: 'café: 1',
      agents: [pane({ agent: 'gemini', status: { status: 'idle', title: 'Release notes' } })],
      alsoOpenIn: ['iTerm'],
    });
    for (const query of ['release', 'CAFÉ', '~/project', '/users/u/project', 'iterm', 'gemini']) {
      expect(matchesMacQuery(item, query)).toBe(true);
    }
    expect(matchesMacQuery(item, 'codex')).toBe(false);
    expect(matchesMacQuery(item, '  ')).toBe(true);
    expect(matchesMacQuery(agent({ app: 'Ghostty' }), 'ghost')).toBe(true);
    expect(matchesMacQuery(agent(), '~/docs')).toBe(true);
  });

  it('says each kind of warning once', () => {
    expect(
      macWarningTexts([
        { code: 'tmux-unreachable', detail: 'protocol version mismatch' },
        { code: 'tmux-unreachable' },
        { code: 'truncated' },
      ])
    ).toEqual(['A tmux server didn’t answer.', 'There are too many to show them all.']);
  });
});

describe('Mac sessions: the read-only conversation', () => {
  it('describes an agent row, or an agent in a tmux pane', () => {
    expect(macSessionViewDetail(agent())).toEqual({
      chatId: 'a-20085-1759500000',
      kind: 'agent',
      agent: 'claude',
      title: 'docs',
      app: 'Terminal',
      cwd: '/Users/u/docs',
    });
    const second = pane({ agent: 'codex', chatId: 'p-4100-1759490000-4', windowIndex: 3 });
    const item = tmux({ agents: [pane({ title: 'Fix login' }), second] });
    expect(macSessionViewDetail(item)).toMatchObject({
      chatId: 'p-4100-1759490000-3',
      kind: 'pane',
      title: 'Fix login',
      tmuxId: 't-4100-1759490000-0',
      tmuxName: 'work',
      windowIndex: 1,
    });
    expect(macSessionViewDetail(item, second)).toMatchObject({ agent: 'codex', windowIndex: 3 });
    expect(macSessionViewDetail(tmux())).toBeNull();
    // Under a tmux server that can't be listed: the sheet says tmux, as the row does.
    expect(
      macSessionViewDetail(agent({ app: undefined, inTmux: { server: 'work' } }))
    ).toMatchObject({ kind: 'agent', inTmux: { server: 'work' } });
  });

  it('asks the app to open it', () => {
    const opened = vi.fn();
    window.addEventListener(MAC_SESSION_VIEW_EVENT, opened);
    showMacConversation({ chatId: 'a-1-2', kind: 'agent', agent: 'claude' });
    window.removeEventListener(MAC_SESSION_VIEW_EVENT, opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      chatId: 'a-1-2',
      kind: 'agent',
      agent: 'claude',
    });
  });
});

describe('Mac sessions: server calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the list, and remembers the platform for the labels', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json(response({ platform: 'linux', warnings: undefined }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const list = await fetchMacSessions({ Authorization: 'Bearer t' });
    expect(list?.items).toHaveLength(1);
    expect(list?.warnings).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/mac-sessions');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer t' });
    expect(macSessionsPlatform()).toBe('linux');
    expect(localStorage.getItem('ut-mac-sessions-platform')).toBe('linux');
    expect(macSessionsHeading()).toBe('On this computer');

    fetchMock.mockImplementationOnce(async () => Response.json(response()));
    await fetchMacSessions({}, { force: true });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/mac-sessions?force=1');
    expect(macSessionsHeading()).toBe('On this Mac');
  });

  // 2026-11-11: a 404 was read as "an older server without the API" and hid the section;
  // server and client ship together, so it is a failure like any other.
  it('throws when the request fails', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'nope' }, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchMacSessions({})).rejects.toThrow('HTTP 404');
    fetchMock.mockImplementationOnce(async () => Response.json({}, { status: 500 }));
    await expect(fetchMacSessions({})).rejects.toThrow('HTTP 500');
    fetchMock.mockImplementationOnce(async () => new Response('<html>'));
    await expect(fetchMacSessions({})).rejects.toThrow();
  });

  it('opens a tmux session and says the list changed', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ sessionId: 'vt1', reused: false, mode: 'watch' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    window.addEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    try {
      const result = await openMacSession(
        't-4100-1759490000-0',
        { mode: 'watch' },
        { Authorization: 'Bearer t' }
      );
      expect(result).toEqual({ sessionId: 'vt1', reused: false, mode: 'watch' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/mac-sessions/t-4100-1759490000-0/open');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      });
      expect(JSON.parse(String(init?.body))).toEqual({ mode: 'watch' });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    }
  });

  it("turns the server's error codes into what the toast says", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'gone' }, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const failure = (await openMacSession('t-1-2-3', {}, {}).catch((e) => e)) as unknown;
    expect(failure).toBeInstanceOf(MacSessionsApiError);
    expect((failure as MacSessionsApiError).code).toBe('gone');
    expect(macOpenErrorText(failure)).toBe('That session is no longer running.');

    fetchMock.mockImplementationOnce(async () =>
      Response.json({ error: 'tmux-too-old' }, { status: 409 })
    );
    expect(macOpenErrorText(await openMacSession('t-1-2-3', {}, {}).catch((e) => e))).toBe(
      'Opening tmux sessions needs tmux 3.2 or newer.'
    );
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ error: 'open-failed', details: 'spawn failed' }, { status: 500 })
    );
    expect(macOpenErrorText(await openMacSession('t-1-2-3', {}, {}).catch((e) => e))).toBe(
      'Couldn’t open it: spawn failed'
    );
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Load failed');
    });
    const offline = (await openMacSession('t-1-2-3', {}, {}).catch(
      (e) => e
    )) as MacSessionsApiError;
    expect(offline.code).toBe('open-failed');
    expect(macOpenErrorText(offline)).toBe('Couldn’t open it: Load failed');
  });
});

describe('Mac sessions: kept on this device', () => {
  it('remembers whether the section is collapsed', () => {
    expect(readMacSectionCollapsed()).toBe(false);
    writeMacSectionCollapsed(true);
    expect(readMacSectionCollapsed()).toBe(true);
    writeMacSectionCollapsed(false);
    expect(readMacSectionCollapsed()).toBe(false);
  });

  it('works without storage', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.mocked(localStorage.getItem).mockImplementation(blocked);
    vi.mocked(localStorage.setItem).mockImplementation(blocked);
    vi.mocked(localStorage.removeItem).mockImplementation(blocked);
    expect(readMacSectionCollapsed()).toBe(false);
    expect(() => writeMacSectionCollapsed(true)).not.toThrow();
    expect(() => writeMacSectionCollapsed(false)).not.toThrow();
    expect(() => rememberMacSessionsPlatform('freebsd')).not.toThrow();
    expect(macSessionsPlatform()).toBe('freebsd');
  });
});
