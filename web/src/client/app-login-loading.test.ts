/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UntetherApp } from './app.js';
import { pushNotificationService } from './services/push-notification-service.js';
import { serverEventService } from './services/server-event-service.js';
import { terminalSocketClient } from './services/terminal-socket-client.js';

type AppInternals = HTMLElement & {
  loading: boolean;
  currentView: string;
  isAuthenticated: boolean;
  initializeServices(): Promise<void>;
  handleAuthSuccess(): Promise<void>;
};

describe('logging in', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the list as loading, not "Nothing running", until the sessions arrive', async () => {
    const app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'auth';
    // Services take a while to start right after logging in (seconds on a phone).
    vi.spyOn(app, 'initializeServices').mockReturnValue(new Promise(() => {}));
    void app.handleAuthSuccess();
    await Promise.resolve();
    expect(app.currentView).toBe('list');
    expect(app.loading).toBe(true);
  });

  it('loads the sessions even when push notifications never finish setting up', async () => {
    const app = new UntetherApp() as unknown as AppInternals & {
      loadSessions(): Promise<void>;
      startAutoRefresh(): void;
    };
    app.currentView = 'auth';
    vi.spyOn(terminalSocketClient, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(serverEventService, 'initialize').mockImplementation(() => {});
    // The home-screen app waits for the service worker; it may never be ready (2026-10-03).
    vi.spyOn(pushNotificationService, 'initialize').mockReturnValue(new Promise(() => {}));
    const loadSessions = vi.spyOn(app, 'loadSessions').mockResolvedValue(undefined);
    vi.spyOn(app, 'startAutoRefresh').mockImplementation(() => {});
    await app.handleAuthSuccess();
    expect(loadSessions).toHaveBeenCalled();
  });
});

describe('deep links and logging out', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
    document.body.innerHTML = '';
  });

  function signedIn() {
    const app = new UntetherApp() as unknown as AppInternals & {
      loadSessions(): Promise<void>;
      startAutoRefresh(): void;
      showTaskConfirmSheet(id: string): void;
      showTask(id: string): void;
      handleLogout(): Promise<void>;
      setupNotificationHandlers(): void;
      autoRefresh: { stop(): void };
    };
    app.currentView = 'auth';
    vi.spyOn(app, 'initializeServices').mockResolvedValue(undefined);
    vi.spyOn(app, 'loadSessions').mockResolvedValue(undefined);
    vi.spyOn(app, 'startAutoRefresh').mockImplementation(() => {});
    return app;
  }

  it('opens the confirm sheet of a push tapped while signed out once logged in', async () => {
    // 2026-10-20: /?confirm=<id> sat on the login screen and was lost after logging in.
    window.history.replaceState(null, '', '/?confirm=c1');
    const app = signedIn();
    const confirm = vi.spyOn(app, 'showTaskConfirmSheet').mockImplementation(() => {});
    await app.handleAuthSuccess();
    expect(confirm).toHaveBeenCalledWith('c1');
    // Once: a reload or Back must not open it again.
    expect(window.location.search).toBe('');
  });

  it("a task push (/?task=<id>) shows the task's row after logging in", async () => {
    window.history.replaceState(null, '', '/?task=t1');
    const app = signedIn();
    const show = vi.spyOn(app, 'showTask').mockImplementation(() => {});
    await app.handleAuthSuccess();
    expect(show).toHaveBeenCalledWith('t1');
    expect(window.location.search).toBe('');
  });

  it('a tapped task push in the open app goes to the task, even with no session', () => {
    const app = signedIn();
    const show = vi.spyOn(app, 'showTask').mockImplementation(() => {});
    app.setupNotificationHandlers();
    app.dispatchEvent(
      new CustomEvent('notification-action', {
        detail: { action: 'view-task', data: { type: 'task-missed', taskId: 't2' } },
      })
    );
    app.dispatchEvent(
      new CustomEvent('notification-action', {
        detail: { action: '', data: { type: 'task-ready', taskId: 't3', sessionId: 's1' } },
      })
    );
    expect(show.mock.calls).toEqual([['t2'], ['t3']]);
  });

  it("reveals the task's row once the list has it", async () => {
    vi.useFakeTimers();
    try {
      const app = signedIn();
      app.currentView = 'list';
      app.showTask('t9');
      const row = document.createElement('task-row') as HTMLElement & { reveal: () => void };
      row.setAttribute('data-task', 't9');
      row.reveal = vi.fn();
      await vi.advanceTimersByTimeAsync(300);
      expect(row.reveal).not.toHaveBeenCalled();
      document.body.appendChild(row);
      await vi.advanceTimersByTimeAsync(300);
      expect(row.reveal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // 2026-11-11: the token check made as the page loads signed out in silence; answered after
  // the stored login had been taken as good, the list stayed unreachable with no login screen.
  it('goes back to the login when the page-load token check refuses the stored login', async () => {
    const { authClient } = await import('./services/auth-client.js');
    let rejected = () => {};
    vi.spyOn(authClient, 'onTokenRejected').mockImplementation((handler) => {
      rejected = handler;
      return () => {};
    });
    vi.spyOn(authClient, 'logout').mockResolvedValue(undefined);
    const app = signedIn() as ReturnType<typeof signedIn> & {
      initializeApp(): Promise<void>;
      checkAuthenticationStatus(): Promise<void>;
      setupRouting(): void;
      errorMessage: string;
    };
    vi.spyOn(app, 'checkAuthenticationStatus').mockImplementation(async () => {
      app.isAuthenticated = true;
      app.currentView = 'list';
    });
    vi.spyOn(app, 'setupRouting').mockImplementation(() => {});
    await app.initializeApp();

    rejected();
    await vi.waitFor(() => expect(app.currentView).toBe('auth'));
    expect(app.isAuthenticated).toBe(false);
    expect(app.errorMessage).not.toBe('');
  });

  it('logging out stops the session poller', async () => {
    const app = signedIn();
    const stop = vi.spyOn(app.autoRefresh, 'stop');
    const { authClient } = await import('./services/auth-client.js');
    vi.spyOn(authClient, 'logout').mockResolvedValue(undefined);
    await app.handleLogout();
    expect(stop).toHaveBeenCalled();
    expect(app.currentView).toBe('auth');
  });
});
