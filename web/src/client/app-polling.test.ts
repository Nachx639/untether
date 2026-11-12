/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerEventType } from '../shared/types.js';
import { sessionRefreshDelay, UntetherApp } from './app.js';
import { serverEventService } from './services/server-event-service.js';

type AppInternals = {
  sessions: unknown[];
  currentView: string;
  initialLoadComplete: boolean;
  startAutoRefresh(): void;
  loadSessions(): Promise<void>;
  autoRefresh: { stop(): void };
};

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('session list polling', () => {
  let app: AppInternals;
  let fetchMock: ReturnType<typeof vi.fn>;

  const sessionRequests = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).split('?')[0] === '/api/sessions').length;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'list';
    app.initialLoadComplete = true;
  });

  afterEach(() => {
    app.autoRefresh.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops polling while the page is hidden and refreshes at once on return', async () => {
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(5_000);
    const visibleCount = sessionRequests();
    expect(visibleCount).toBeGreaterThanOrEqual(4);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionRequests()).toBe(visibleCount);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRequests()).toBe(visibleCount + 1);
  });

  it('a re-login does not start a second poll', async () => {
    app.startAutoRefresh();
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessionRequests()).toBeLessThanOrEqual(10);
  });

  it('coalesces overlapping loads into one follow-up request', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response('[]', { status: 200 }));
        })
    );
    const loads = [app.loadSessions(), app.loadSessions(), app.loadSessions()];
    expect(sessionRequests()).toBe(1);
    release();
    await Promise.all(loads);
    expect(sessionRequests()).toBe(2);
  });

  it('an open session missing for a moment (a server restart) stays open; gone for good, it is left (2026-10-20)', async () => {
    const view = app as unknown as {
      selectedSessionId: string | null;
      sessionLoadingState: string;
      errorMessage: string;
    };
    const session = { id: 'a', name: 'claude', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([session])));
    app.currentView = 'session';
    view.selectedSessionId = 'a';
    await app.loadSessions();
    expect(view.sessionLoadingState).toBe('loaded');

    // The server restarts: for a few seconds the shielded session is not in the list.
    fetchMock.mockImplementation(async () => new Response('[]'));
    await app.loadSessions();
    await vi.advanceTimersByTimeAsync(5_000);
    await app.loadSessions();
    expect(app.currentView).toBe('session');
    expect(view.errorMessage ?? '').toBe('');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([session])));
    await app.loadSessions();
    expect(app.currentView).toBe('session');

    // Really gone: once its grace is over, back to the list with the error.
    fetchMock.mockImplementation(async () => new Response('[]'));
    await app.loadSessions();
    await vi.advanceTimersByTimeAsync(11_000);
    await app.loadSessions();
    expect(app.currentView).toBe('list');
  });

  it('keeps the same sessions array (no re-render) when the list is identical', async () => {
    const session = { id: 'a', name: 'one', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([session])));
    await app.loadSessions();
    const shown = app.sessions;
    await app.loadSessions();
    expect(app.sessions).toBe(shown);

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([{ ...session, name: 'renamed' }]))
    );
    await app.loadSessions();
    expect(app.sessions).not.toBe(shown);
  });

  it('a killed session in a git repo gets a new object, so rows holding it re-render', async () => {
    const running = { id: 'a', name: 'claude', status: 'running', workingDir: '/repo' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running])));
    await app.loadSessions();
    const before = app.sessions[0] as Record<string, unknown>;
    // The git badge fills these in on the client; the server list doesn't send them.
    before.gitRepoPath = '/repo';
    before.gitModifiedCount = 3;

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([{ ...running, status: 'exited' }]))
    );
    await app.loadSessions();

    const after = app.sessions[0] as Record<string, unknown>;
    expect(after).not.toBe(before);
    expect(after.status).toBe('exited');
    expect(after.gitRepoPath).toBe('/repo');
    expect(after.gitModifiedCount).toBe(3);
  });

  it('shows a killed session as finished at once, even if the server still says running', async () => {
    const running = { id: 'k', name: 'zsh', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running])));
    await app.loadSessions();
    const internals = app as unknown as {
      handleSessionKilled(e: CustomEvent): void;
      showError(message: string): void;
    };
    const showError = vi.fn();
    internals.showError = showError;

    (app as unknown as { isAuthenticated: boolean }).isAuthenticated = true;
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    expect((app.sessions[0] as { status: string }).status).toBe('exited');
    await vi.advanceTimersByTimeAsync(1000); // a poll that still says running
    expect((app.sessions[0] as { status: string }).status).toBe('exited');
    expect(showError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(8000); // it really didn't die: say so
    await app.loadSessions();
    expect((app.sessions[0] as { status: string }).status).toBe('running');
    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('the follow-up refreshes after a kill stop at logout (no 401, no second logout)', async () => {
    const running = { id: 'k', name: 'zsh', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running])));
    await app.loadSessions();
    const internals = app as unknown as {
      isAuthenticated: boolean;
      handleSessionKilled(e: CustomEvent): void;
      handleLogout(): Promise<void>;
    };
    internals.isAuthenticated = true;
    const { authClient } = await import('./services/auth-client.js');
    vi.spyOn(authClient, 'logout').mockResolvedValue(undefined);

    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    await vi.advanceTimersByTimeAsync(0);
    await internals.handleLogout();
    const atLogout = sessionRequests();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sessionRequests()).toBe(atLogout);
  });

  it('a 401 on /api/sessions says the login expired, once, and logs out once', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ error: 'token_invalid' }, { status: 401 })
    );
    const internals = app as unknown as {
      isAuthenticated: boolean;
      showError(message: string): void;
      logOut(): Promise<void>;
    };
    internals.isAuthenticated = true;
    const showError = vi.spyOn(internals, 'showError').mockImplementation(() => {});
    let release!: () => void;
    const logOut = vi.spyOn(internals, 'logOut').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    // Two polls answered 401 while the first logout is still on its way.
    await app.loadSessions();
    await app.loadSessions();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toMatch(/login expired|sesión ha caducado/);
    expect(logOut).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a 401 that is not token_invalid counts as a failed load, not a logout (2026-10-20 review)', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ error: 'Authentication required' }, { status: 401 })
    );
    const internals = app as unknown as {
      isAuthenticated: boolean;
      loadFailures: number;
      logOut(): Promise<void>;
    };
    internals.isAuthenticated = true;
    const logOut = vi.spyOn(internals, 'logOut').mockResolvedValue(undefined);
    await app.loadSessions();
    expect(logOut).not.toHaveBeenCalled();
    expect(internals.loadFailures).toBe(1);
  });

  it('a list request that hangs times out into a failed load (2026-10-20 review)', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')));
        })
    );
    const load = app.loadSessions();
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
    expect(timeout).toHaveBeenCalledWith(8000);
    controller.abort();
    await load;
    expect((app as unknown as { loadFailures: number }).loadFailures).toBe(1);
  });

  describe('a session opened while the server restarts (2026-10-20 review)', () => {
    const session = { id: 'a', name: 'claude', status: 'running', workingDir: '/tmp' };
    type View = {
      selectedSessionId: string | null;
      sessionLoadingState: string;
      errorMessage: string;
      isAuthenticated: boolean;
      selectedSession: unknown;
      parseUrlAndSetState(): Promise<void>;
    };

    afterEach(() => window.history.replaceState(null, '', '/'));

    it('opened by URL while the list fails, it waits for the poll instead of leaving', async () => {
      const view = app as unknown as View;
      view.isAuthenticated = true;
      fetchMock.mockImplementation(async () => {
        throw new TypeError('Failed to fetch');
      });
      window.history.replaceState(null, '', '/session/a');
      await view.parseUrlAndSetState();
      expect(app.currentView).toBe('session');
      expect(view.selectedSessionId).toBe('a');
      expect(view.sessionLoadingState).toBe('loading');
      expect(view.errorMessage ?? '').toBe('');

      fetchMock.mockImplementation(async () => new Response(JSON.stringify([session])));
      await app.loadSessions();
      expect(view.sessionLoadingState).toBe('loaded');
      expect(app.currentView).toBe('session');
    });

    it('opened and not listed yet, it gets the same grace before "not found"', async () => {
      const view = app as unknown as View;
      app.currentView = 'session';
      view.selectedSessionId = 'a';
      await app.loadSessions();
      expect(view.sessionLoadingState).toBe('loading');
      await vi.advanceTimersByTimeAsync(5_000);
      await app.loadSessions();
      expect(app.currentView).toBe('session');
      expect(view.errorMessage ?? '').toBe('');

      await vi.advanceTimersByTimeAsync(6_000);
      await app.loadSessions();
      expect(app.currentView).toBe('list');
    });

    it('a shown session missing within its grace stays the selected session', async () => {
      const view = app as unknown as View;
      fetchMock.mockImplementation(async () => new Response(JSON.stringify([session])));
      app.currentView = 'session';
      view.selectedSessionId = 'a';
      await app.loadSessions();
      const shown = view.selectedSession;
      expect(shown).toMatchObject({ id: 'a' });

      fetchMock.mockImplementation(async () => new Response('[]'));
      await app.loadSessions();
      expect(view.selectedSession).toBe(shown);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(view.selectedSession).toBeUndefined();
    });
  });

  it('the follow-up refreshes after a kill skip a view that does not show sessions', async () => {
    const internals = app as unknown as {
      isAuthenticated: boolean;
      handleSessionKilled(e: CustomEvent): void;
    };
    internals.isAuthenticated = true;
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    await vi.advanceTimersByTimeAsync(0);
    app.currentView = 'settings';
    const before = sessionRequests();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sessionRequests()).toBe(before);
  });

  it('a cleared finished session leaves at once, even if a poll in flight still lists it', async () => {
    const done = { id: 'x', name: 'zsh', status: 'exited', workingDir: '/tmp' };
    const other = { id: 'o', name: 'other', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([done, other])));
    await app.loadSessions();
    const internals = app as unknown as { handleSessionKilled(e: CustomEvent): void };

    // Started before the DELETE landed: it still has the session.
    const stale = app.loadSessions();
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'x' }));
    expect(app.sessions.map((s) => (s as { id: string }).id)).toEqual(['o']);
    await stale;
    expect(app.sessions.map((s) => (s as { id: string }).id)).toEqual(['o']);

    // Not actually removed (the server still lists it later): it shows up again.
    await vi.advanceTimersByTimeAsync(6000);
    await app.loadSessions();
    expect(app.sessions.map((s) => (s as { id: string }).id)).toEqual(['x', 'o']);
  });

  it('takes down "Claude needs you" when that session ends, here or elsewhere', async () => {
    const { pushNotificationService } = await import('./services/push-notification-service.js');
    const clear = vi
      .spyOn(pushNotificationService, 'clearSessionNotifications')
      .mockResolvedValue(undefined);
    const waiting = (id: string) => ({
      id,
      name: id,
      status: 'running',
      workingDir: '/tmp',
      claudeStatus: { status: 'waiting', waitingFor: 'Bash', since: 1 },
    });
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([waiting('a'), waiting('b'), waiting('c')]))
    );
    await app.loadSessions();
    const internals = app as unknown as {
      attentionToast: { sessionId: string } | null;
      handleSessionKilled(e: CustomEvent): void;
    };
    internals.attentionToast = { sessionId: 'a' };
    expect(clear).not.toHaveBeenCalled();

    // Killed on another device ('a') and cleared there ('b'); 'c' keeps waiting.
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify([{ ...waiting('a'), status: 'exited' }, waiting('c')]))
    );
    await app.loadSessions();
    expect(clear.mock.calls).toEqual([
      ['a', { claudeOnly: true }],
      ['b', { claudeOnly: true }],
    ]);
    expect(internals.attentionToast).toBeNull();

    // Killed from this device: it shows as exited before any poll sees it end.
    clear.mockClear();
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'c' }));
    expect(clear.mock.calls).toEqual([['c', { claudeOnly: true }]]);
  });

  it('forgets a killed session once it is gone from the server list', async () => {
    const running = { id: 'k', name: 'zsh', status: 'running', workingDir: '/tmp' };
    const other = { id: 'o', name: 'other', status: 'running', workingDir: '/tmp' };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([running, other])));
    await app.loadSessions();
    const internals = app as unknown as {
      recentlyKilled: Map<string, number>;
      handleSessionKilled(e: CustomEvent): void;
    };
    internals.handleSessionKilled(new CustomEvent('session-killed', { detail: 'k' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(internals.recentlyKilled.has('k')).toBe(true);

    // Cleaned up before it ever showed as exited: the list no longer has it.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([other])));
    await app.loadSessions();
    expect(internals.recentlyKilled.has('k')).toBe(false);
  });

  it('sees a second, identical Claude prompt (only its start time differs)', async () => {
    const waiting = (since: number) => ({
      id: 'a',
      name: 'claude',
      status: 'running',
      workingDir: '/tmp',
      claudeStatus: { status: 'waiting', waitingFor: 'permission', since },
    });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([waiting(1)])));
    await app.loadSessions();
    const shown = app.sessions;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([waiting(2)])));
    await app.loadSessions();
    expect(app.sessions).not.toBe(shown);
  });

  it('sees a session being muted, and stays quiet about a muted session', async () => {
    const claude = (id: string, status: string, muted?: boolean) => ({
      id,
      name: id,
      status: 'running',
      workingDir: '/tmp',
      claudeStatus: { status },
      ...(muted ? { muted } : {}),
    });
    const toast = () =>
      (app as unknown as { attentionToast: { sessionId: string } | null }).attentionToast;
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify([claude('loud', 'busy'), claude('quiet', 'busy')]))
    );
    await app.loadSessions();
    const shown = app.sessions;
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify([claude('loud', 'busy'), claude('quiet', 'busy', true)]))
    );
    await app.loadSessions();
    expect(app.sessions).not.toBe(shown);

    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify([claude('loud', 'busy'), claude('quiet', 'waiting', true)]))
    );
    await app.loadSessions();
    expect(toast()).toBeNull();

    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify([claude('loud', 'waiting'), claude('quiet', 'waiting', true)]))
    );
    await app.loadSessions();
    expect(toast()?.sessionId).toBe('loud');
  });

  it('backs off to one poll every 3 s on an idle list: 60 -> about 20 per minute', async () => {
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    const firstMinute = sessionRequests();
    await vi.advanceTimersByTimeAsync(60_000);
    const secondMinute = sessionRequests() - firstMinute;
    expect(firstMinute).toBe(10 + 20 + 3); // 10 at 1 s (to 10 s), 20 at 2 s (to 50 s), 3 at 3 s
    expect(secondMinute).toBe(20);
    expect(sessionRefreshDelay(0)).toBe(1000);
    expect(sessionRefreshDelay(30)).toBe(3000);
  });

  it('returns to 1 s and refreshes at once when a session starts or exits', async () => {
    const handlers = new Map<string, () => void>();
    vi.spyOn(serverEventService, 'on').mockImplementation((type, handler) => {
      handlers.set(String(type), handler as () => void);
      return () => handlers.delete(String(type));
    });
    app.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(120_000);
    const before = sessionRequests();
    handlers.get(ServerEventType.SessionStart)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionRequests()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionRequests()).toBe(before + 2);
    expect(handlers.has(ServerEventType.SessionExit)).toBe(true);
  });
});
