/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_SESSION_VIEW_EVENT,
  MAC_SESSIONS_CHANGED_EVENT,
  MAC_TMUX_OPEN_EVENT,
  type MacSessionItem,
  type MacSessionsResponse,
  type MacTmuxSession,
} from '../shared/mac-sessions.js';
import { UntetherApp } from './app.js';
import { closeMacSessionView } from './components/mac-session-view.js';
import { authClient } from './services/auth-client.js';
import { lazyViews } from './utils/lazy-views.js';

type AppInternals = {
  sessions: Array<Record<string, unknown>>;
  macSessions: MacSessionsResponse | null;
  currentView: string;
  selectedSessionId: string | null;
  sidebarCollapsed: boolean;
  initialLoadComplete: boolean;
  isAuthenticated: boolean;
  errorMessage: string;
  startAutoRefresh(): void;
  loadSessions(): Promise<boolean>;
  loadMacSessions(force?: boolean): Promise<void>;
  setupNotificationHandlers(): void;
  handleLogout(): Promise<void>;
  autoRefresh: { stop(): void };
  handleMacSessionsChanged: EventListener;
  handleOpenMacSessionView: EventListener;
  handleOpenMacTmux: EventListener;
  handleSessionKilled(e: CustomEvent): void;
};

const TMUX_ID = 't-4100-1759490000-0';

const tmux = (over: Partial<MacTmuxSession> = {}): MacTmuxSession => ({
  kind: 'tmux',
  id: TMUX_ID,
  name: 'work',
  server: { label: '', isDefault: true },
  windows: 1,
  current: { windowIndex: 0, windowName: 'zsh', width: 80, height: 24 },
  agents: [
    {
      agent: 'claude',
      chatId: 'p-4100-1759490000-3',
      windowIndex: 0,
      windowName: 'zsh',
      inCurrentWindow: true,
      activePane: true,
    },
  ],
  alsoOpenIn: [],
  canOpen: true,
  ...over,
});

const listed = (
  items: MacSessionItem[] = [tmux()],
  over: Partial<MacSessionsResponse> = {}
): MacSessionsResponse => ({
  enabled: true,
  platform: 'darwin',
  scannedAt: new Date().toISOString(),
  openMode: 'control',
  items,
  warnings: [],
  ...over,
});

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** A phone: a coarse pointer and a short side under 600 px. */
function setScreen(phone: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query.includes('coarse'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: phone ? 390 : 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: phone ? 844 : 900 });
}

describe('"On this Mac" in the app', () => {
  let app: AppInternals;
  // The app loads the views chunk once the list is up (utils/lazy-views.ts).
  beforeAll(() => lazyViews.macSessionView.load());
  let fetchMock: ReturnType<typeof vi.fn>;
  let macAnswer: () => Response | Promise<Response>;
  let openAnswer: () => Response;
  let sessionsAnswer: unknown[];

  const macRequests = () =>
    fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url === '/api/mac-sessions' || url === '/api/mac-sessions?force=1');

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    setScreen(true);
    macAnswer = () => Response.json(listed());
    openAnswer = () => Response.json({ sessionId: 'ut-new', reused: false, mode: 'control' });
    sessionsAnswer = [];
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/mac-sessions/')) return openAnswer();
      if (url.startsWith('/api/mac-sessions')) return macAnswer();
      if (url.split('?')[0] === '/api/sessions') return Response.json(sessionsAnswer);
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'list';
    app.initialLoadComplete = true;
    app.isAuthenticated = true;
  });

  afterEach(() => {
    app.autoRefresh.stop();
    window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, app.handleMacSessionsChanged);
    window.removeEventListener(MAC_SESSION_VIEW_EVENT, app.handleOpenMacSessionView);
    window.removeEventListener(MAC_TMUX_OPEN_EVENT, app.handleOpenMacTmux);
    closeMacSessionView();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a phone asks for it at once, then with the session poll at most every 4 s, never while hidden', async () => {
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(macRequests()).toHaveLength(1);
    expect(app.macSessions?.items.map((item) => item.id)).toEqual([TMUX_ID]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(macRequests()).toHaveLength(3); // 0, 4 and 8 s

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(macRequests()).toHaveLength(3);
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(macRequests()).toHaveLength(4);
  });

  // 2026-10-12: a phone has one list, the home; no sidebar list over a session to fill.
  it('in a session it never asks, even with a stale open sidebar', async () => {
    app.currentView = 'session';
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(macRequests()).toHaveLength(0);
    app.sidebarCollapsed = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(macRequests()).toHaveLength(0);
  });

  it('a desktop never asks: the section is phone only', async () => {
    setScreen(false);
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(macRequests()).toHaveLength(0);
    expect(app.macSessions).toBeNull();
  });

  it('asks every 30 s while the server has it turned off', async () => {
    macAnswer = () => Response.json(listed([], { enabled: false, reason: 'disabled' }));
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(macRequests()).toHaveLength(1);
    expect(app.macSessions?.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(macRequests()).toHaveLength(2);
  });

  it('keeps the last list while requests fail, until a minute of failures hides it', async () => {
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(0);
    const shown = app.macSessions;
    expect(shown).not.toBeNull();

    macAnswer = () => new Response('', { status: 500 });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(app.macSessions).toBe(shown);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(app.macSessions).toBeNull();

    macAnswer = () => Response.json(listed());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(app.macSessions?.items).toHaveLength(1);
  });

  it('an answer that only has a newer scan time keeps the list shown (no re-render)', async () => {
    await app.loadMacSessions(true);
    const shown = app.macSessions;
    await vi.advanceTimersByTimeAsync(5_000);
    await app.loadMacSessions(true);
    expect(macRequests()).toHaveLength(2);
    expect(app.macSessions).toBe(shown);

    macAnswer = () => Response.json(listed([tmux({ name: 'renamed' })]));
    await app.loadMacSessions(true);
    expect(app.macSessions).not.toBe(shown);
    expect(app.macSessions?.items.map((item) => item.kind === 'tmux' && item.name)).toEqual([
      'renamed',
    ]);
  });

  it('opening, disconnecting or a settings save reloads it at once, past the server cache', async () => {
    app.setupNotificationHandlers();
    await app.loadMacSessions();
    window.dispatchEvent(new CustomEvent(MAC_SESSIONS_CHANGED_EVENT));
    await vi.advanceTimersByTimeAsync(0);
    expect(macRequests()).toEqual(['/api/mac-sessions', '/api/mac-sessions?force=1']);
  });

  it('logout forgets the list, and an answer asked for before it', async () => {
    vi.spyOn(authClient, 'logout').mockResolvedValue(undefined);
    await app.loadMacSessions();
    expect(app.macSessions).not.toBeNull();

    let release: () => void = () => {};
    macAnswer = () =>
      new Promise((resolve) => {
        release = () => resolve(Response.json(listed()));
      });
    const late = app.loadMacSessions(true);
    await app.handleLogout();
    expect(app.macSessions).toBeNull();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await late;
    expect(app.macSessions).toBeNull();
  });

  it("an agent's conversation opens in its sheet", () => {
    app.setupNotificationHandlers();
    window.dispatchEvent(
      new CustomEvent(MAC_SESSION_VIEW_EVENT, {
        detail: { chatId: 'a-20085-1759500000', kind: 'agent', agent: 'claude', title: 'Docs' },
      })
    );
    expect(document.body.querySelector('mac-session-view')).not.toBeNull();
  });

  describe('"Open and control" from a conversation sheet or the history', () => {
    const open = (detail: { id: string; mode?: 'control' | 'watch' }) =>
      window.dispatchEvent(new CustomEvent(MAC_TMUX_OPEN_EVENT, { detail }));
    const openRequest = () =>
      fetchMock.mock.calls.find(([url]) => String(url) === `/api/mac-sessions/${TMUX_ID}/open`);

    beforeEach(() => {
      app.setupNotificationHandlers();
      vi.mocked(localStorage.setItem).mockClear();
    });

    it('opens the tmux session and shows it once listed, in the chat view', async () => {
      sessionsAnswer = [{ id: 'ut-new', name: 'tmux: work', status: 'running', workingDir: '/' }];
      open({ id: TMUX_ID, mode: 'control' });
      await vi.advanceTimersByTimeAsync(0);
      expect(openRequest()?.[1]).toMatchObject({
        method: 'POST',
        body: JSON.stringify({ mode: 'control' }),
      });
      expect(app.selectedSessionId).toBe('ut-new');
      expect(app.currentView).toBe('session');
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'untether_app_preferences',
        JSON.stringify({ chatMode: true })
      );
    });

    it("without a mode it opens as the user's setting says", async () => {
      await app.loadMacSessions();
      app.macSessions = listed([tmux()], { openMode: 'watch' });
      open({ id: TMUX_ID });
      await vi.advanceTimersByTimeAsync(0);
      expect(openRequest()?.[1]).toMatchObject({ body: JSON.stringify({ mode: 'watch' }) });
    });

    it('goes straight to the session already attached to it', async () => {
      openAnswer = () => Response.json({ sessionId: 'ut-old', reused: true, mode: 'watch' });
      open({ id: TMUX_ID, mode: 'control' });
      await vi.advanceTimersByTimeAsync(0);
      expect(app.selectedSessionId).toBe('ut-old');
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).split('?')[0] === '/api/sessions')
      ).toBe(false);
    });

    it('a session that ended says so and reloads the list', async () => {
      openAnswer = () => Response.json({ error: 'gone' }, { status: 404 });
      open({ id: TMUX_ID, mode: 'control' });
      await vi.advanceTimersByTimeAsync(0);
      expect(app.errorMessage).toBe('That session is no longer running.');
      expect(app.selectedSessionId).toBeNull();
      expect(macRequests()).toContain('/api/mac-sessions?force=1');
    });

    it('a double tap opens it once', async () => {
      open({ id: TMUX_ID, mode: 'control' });
      open({ id: TMUX_ID, mode: 'control' });
      await vi.advanceTimersByTimeAsync(0);
      const opens = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/open'));
      expect(opens).toHaveLength(1);
    });
  });

  it('a session that moves into a terminal window on the Mac, or starts watching, re-renders', async () => {
    const running = { id: 'a', name: 'claude', status: 'running', workingDir: '/tmp' };
    sessionsAnswer = [running];
    await app.loadSessions();
    const before = app.sessions[0];

    sessionsAnswer = [{ ...running, macWindow: { app: 'Terminal' } }];
    await app.loadSessions();
    expect(app.sessions[0]).not.toBe(before);
    expect(app.sessions[0].macWindow).toEqual({ app: 'Terminal' });

    const attached = {
      ...running,
      multiplexer: {
        type: 'tmux',
        socketPath: '/tmp/tmux-501/default',
        serverPid: 4100,
        serverStartedAt: 1759490000,
        sessionId: '$0',
        sessionName: 'work',
        mode: 'control',
        sizing: 'others',
        source: 'mac-sessions',
      },
    };
    sessionsAnswer = [attached];
    await app.loadSessions();
    const controlling = app.sessions[0];
    sessionsAnswer = [{ ...attached, multiplexer: { ...attached.multiplexer, mode: 'watch' } }];
    await app.loadSessions();
    expect(app.sessions[0]).not.toBe(controlling);
  });

  it('disconnecting the open tmux session goes back to the list without "not found"', async () => {
    const attached = { id: 'ut-att', name: 'tmux: work', status: 'running', workingDir: '/' };
    const other = { id: 'ut-other', name: 'zsh', status: 'running', workingDir: '/' };
    sessionsAnswer = [attached, other];
    app.currentView = 'session';
    app.selectedSessionId = 'ut-att';
    await app.loadSessions();
    expect(app.currentView).toBe('session');

    // Disconnect ends Untether's client, and the server drops the session at once.
    app.handleSessionKilled(new CustomEvent('session-killed', { detail: { sessionId: 'ut-att' } }));
    sessionsAnswer = [other];
    await app.loadSessions();
    expect(app.currentView).toBe('list');
    expect(app.errorMessage).toBe('');

    // A session that vanishes on its own still says so, once its grace for a server restart
    // (a few seconds without it) is over.
    app.currentView = 'session';
    app.selectedSessionId = 'ut-other';
    await app.loadSessions();
    sessionsAnswer = [];
    await app.loadSessions();
    expect(app.currentView).toBe('session');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11_000);
    await app.loadSessions();
    clock.mockRestore();
    expect(app.currentView).toBe('list');
    expect(app.errorMessage).toContain('ut-other');
  });
});
