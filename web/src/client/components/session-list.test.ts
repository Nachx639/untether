// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// import { setupFetchMock } from '@/test/utils/component-helpers'; // Removed - doesn't exist
import { createMockSession } from '@/test/utils/lit-test-utils';
import { createTestTask } from '@/test/utils/test-factories';
import type { AuthClient } from '../services/auth-client';
import { serverConfigService } from '../services/server-config-service.js';
import { taskStore } from '../services/task-store';

// Mock AuthClient
vi.mock('../services/auth-client');

// Confirms go through utils/confirm-dialog.ts (2026-10-12).
const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => false) }));
vi.mock('../utils/confirm-dialog', () => ({ confirmDialog }));

import type { AskClaudeBox } from './ask-claude-box';
import type { FileBrowser } from './file-browser';
import type { SessionCard } from './session-card';
// Import component types
import type { SessionList } from './session-list';

// Helper function to get all elements of a specific type
function getAllElements<T extends Element>(parent: Element, selector: string): T[] {
  return Array.from(parent.querySelectorAll(selector));
}

describe('SessionList', () => {
  let element: SessionList;
  let fetchMock: { calls: Map<string, number> };
  let mockAuthClient: AuthClient;
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    // Import components to register custom elements
    await import('./session-list');
    await import('./session-card');
    await import('./session-create-form');
    // The app loads the views chunk once the list is up (utils/lazy-views.ts).
    const { lazyViews } = await import('../utils/lazy-views');
    await lazyViews.fileBrowser.load();
  });

  beforeEach(async () => {
    // Setup fetch mock
    originalFetch = global.fetch;
    fetchMock = { calls: new Map() };
    global.fetch = vi.fn((url: string | URL | Request, _options?: RequestInit) => {
      const urlString = typeof url === 'string' ? url : url.toString();
      fetchMock.calls.set(urlString, (fetchMock.calls.get(urlString) || 0) + 1);

      // Default responses
      if (urlString.includes('/api/sessions')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (urlString.includes('/api/cleanup-exited')) {
        return new Promise((resolve) =>
          setTimeout(
            () => resolve(new Response(JSON.stringify({ removed: 1 }), { status: 200 })),
            100
          )
        );
      }

      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as typeof fetch;

    // Create mock auth client
    mockAuthClient = {
      getAuthHeader: vi.fn(() => ({ Authorization: 'Bearer test-token' })),
    } as unknown as AuthClient;

    // Create component
    element = await fixture<SessionList>(html`
      <session-list .authClient=${mockAuthClient}></session-list>
    `);

    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create component with default state', async () => {
      expect(element).toBeDefined();
      // Wait for the component to be fully initialized
      await element.updateComplete;

      // Check if the element is actually a SessionList
      expect(element.tagName.toLowerCase()).toBe('session-list');
      expect(element.sessions).toBeDefined();
      expect(element.sessions).toEqual([]);
      expect(element.loading).toBe(false);
      expect(element.hideExited).toBe(true);
      expect(element.compactMode).toBe(false);
    });
  });

  describe('session display', () => {
    it('should display session cards', async () => {
      const mockSessions = [
        createMockSession({ id: 'session-1', name: 'Session 1', status: 'running' }),
        createMockSession({ id: 'session-2', name: 'Session 2', status: 'running' }),
      ];

      element.sessions = mockSessions;
      await element.updateComplete;

      const sessionCards = getAllElements(element, 'session-card');
      expect(sessionCards).toHaveLength(2);
    });

    it('should filter exited sessions when hideExited is true', async () => {
      const mockSessions = [
        createMockSession({ id: 'session-1', status: 'running' }),
        createMockSession({ id: 'session-2', status: 'exited' }),
        createMockSession({ id: 'session-3', status: 'running' }),
      ];

      element.sessions = mockSessions;
      element.hideExited = true;
      await element.updateComplete;

      const sessionCards = getAllElements(element, 'session-card');
      expect(sessionCards).toHaveLength(2);
    });

    it('should show all sessions when hideExited is false', async () => {
      const mockSessions = [
        createMockSession({ id: 'session-1', status: 'running' }),
        createMockSession({ id: 'session-2', status: 'exited' }),
      ];

      element.sessions = mockSessions;
      element.hideExited = false;
      await element.updateComplete;

      const sessionCards = getAllElements(element, 'session-card');
      expect(sessionCards).toHaveLength(2);
    });

    it('should show empty state when no sessions', async () => {
      element.sessions = [];
      await element.updateComplete;

      const empty = element.querySelector('[data-testid="desktop-empty"]');
      expect(empty?.textContent).toContain('Your Mac, from any browser');
      expect(empty?.querySelector('[data-testid="create-session-btn"]')).toBeTruthy();
      // The address is the one the page was opened at, never a hardcoded port.
      expect(empty?.textContent).toContain(`Open at ${window.location.host}`);
      expect(empty?.textContent).not.toContain('localhost:4020');
    });

    it('shows six skeleton cards only when loading takes more than 150ms', async () => {
      vi.useFakeTimers();
      try {
        element.loading = true;
        await element.updateComplete;
        expect(element.querySelector('[data-testid="list-skeleton"]')).toBeNull();
        vi.advanceTimersByTime(160);
        await element.updateComplete;
        expect(element.querySelectorAll('.ut-card-skeleton')).toHaveLength(6);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('session navigation', () => {
    it('should emit navigate event when session is clicked', async () => {
      const navigateHandler = vi.fn();
      element.addEventListener('navigate-to-session', navigateHandler);

      const mockSession = createMockSession({ id: 'test-session' });
      element.sessions = [mockSession];
      await element.updateComplete;

      const sessionCard = element.querySelector('session-card');
      expect(sessionCard).not.toBeNull();
      // Dispatch select event from session card
      sessionCard?.dispatchEvent(
        new CustomEvent('session-select', {
          detail: mockSession,
          bubbles: true,
        })
      );

      expect(navigateHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: { sessionId: 'test-session' },
        })
      );
    });
  });

  describe('session creation', () => {
    it("the empty state's button asks the app for the create dialog", async () => {
      const open = vi.fn();
      element.addEventListener('open-create-dialog', open);
      element.querySelector<HTMLButtonElement>('[data-testid="create-session-btn"]')?.click();
      expect(open).toHaveBeenCalled();
    });
  });

  describe('session management', () => {
    it('should handle session kill', async () => {
      const refreshHandler = vi.fn();
      element.addEventListener('refresh', refreshHandler);

      const mockSessions = [
        createMockSession({ id: 'session-1' }),
        createMockSession({ id: 'session-2' }),
      ];
      element.sessions = mockSessions;
      await element.updateComplete;

      // Dispatch kill event from session card
      const sessionCard = element.querySelector('session-card');
      expect(sessionCard).not.toBeNull();
      sessionCard?.dispatchEvent(
        new CustomEvent('session-killed', {
          detail: { sessionId: 'session-1' },
          bubbles: true,
        })
      );

      // Session should be removed from list
      expect(element.sessions).toHaveLength(1);
      expect(element.sessions[0].id).toBe('session-2');

      // Should trigger refresh
      expect(refreshHandler).toHaveBeenCalled();
    });

    it('should re-dispatch session-killed event to parent components', async () => {
      const sessionKilledHandler = vi.fn();
      element.addEventListener('session-killed', sessionKilledHandler);

      const mockSessions = [
        createMockSession({ id: 'session-1' }),
        createMockSession({ id: 'session-2' }),
      ];
      element.sessions = mockSessions;
      await element.updateComplete;

      // Dispatch kill event from session card (bubbling and composed, like the real one)
      const sessionCard = element.querySelector('session-card');
      expect(sessionCard).not.toBeNull();
      sessionCard?.dispatchEvent(
        new CustomEvent('session-killed', {
          detail: { sessionId: 'session-1' },
          bubbles: true,
          composed: true,
        })
      );

      // The parent hears about the kill once, with just the sessionId: the original
      // event must not bubble past the list as well.
      expect(sessionKilledHandler).toHaveBeenCalledTimes(1);
      expect(sessionKilledHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: 'session-1', // Just the sessionId, not an object
        })
      );
    });

    it('should handle session kill error', async () => {
      const errorHandler = vi.fn();
      element.addEventListener('error', errorHandler);

      const mockSession = createMockSession();
      element.sessions = [mockSession];
      await element.updateComplete;

      // Dispatch kill error
      const sessionCard = element.querySelector('session-card');
      expect(sessionCard).not.toBeNull();
      sessionCard?.dispatchEvent(
        new CustomEvent('session-kill-error', {
          detail: {
            sessionId: mockSession.id,
            error: 'Failed to terminate session: server error (500)',
          },
          bubbles: true,
        })
      );

      // Shown as the card worded it (session-action-service), not wrapped in English again.
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: 'Failed to terminate session: server error (500)',
        })
      );
    });

    it('should handle cleanup of exited sessions', async () => {
      // Mock successful cleanup - already handled in beforeEach
      // Reset call tracking
      fetchMock.calls.clear();

      const refreshHandler = vi.fn();
      element.addEventListener('refresh', refreshHandler);

      // Add some exited sessions
      element.sessions = [
        createMockSession({ id: 'session-1', status: 'running' }),
        createMockSession({ id: 'session-2', status: 'exited' }),
        createMockSession({ id: 'session-3', status: 'exited' }),
      ];
      element.hideExited = false; // Show exited sessions
      await element.updateComplete;

      // Mock querySelectorAll to return session cards
      const mockSessionCards = [
        { session: { id: 'session-2', status: 'exited' }, classList: { add: vi.fn() } },
        { session: { id: 'session-3', status: 'exited' }, classList: { add: vi.fn() } },
      ];
      vi.spyOn(element, 'querySelectorAll').mockReturnValue(
        mockSessionCards as unknown as NodeListOf<Element>
      );

      await element.handleCleanupExited();

      // Should apply black-hole animation to exited sessions
      expect(mockSessionCards[0].classList.add).toHaveBeenCalledWith('black-hole-collapsing');
      expect(mockSessionCards[1].classList.add).toHaveBeenCalledWith('black-hole-collapsing');

      // Should remove exited sessions from list
      expect(element.sessions).toHaveLength(1);
      expect(element.sessions[0].status).toBe('running');

      // Should trigger refresh after cleanup
      expect(refreshHandler).toHaveBeenCalled();
      expect(mockAuthClient.getAuthHeader).toHaveBeenCalled();
    });

    it('"Borrar todas" asks for every finished session, resumable ones too (2026-10-20)', async () => {
      const calls: string[] = [];
      global.fetch = vi.fn(async (url: string | URL | Request) => {
        calls.push(String(url));
        return Response.json({ cleaned: 2, kept: 0 });
      }) as typeof fetch;
      element.sessions = [createMockSession({ id: 'a', status: 'exited' })];
      await element.handleCleanupExited({ all: true });
      expect(calls).toContain('/api/cleanup-exited?all=1');
      await element.handleCleanupExited();
      expect(calls.at(-1)).toBe('/api/cleanup-exited');
    });

    it('keeps the resumable sessions the server kept and says how many', async () => {
      global.fetch = vi.fn(async () => Response.json({ cleaned: 1, kept: 2 })) as typeof fetch;
      element.sessions = [
        createMockSession({ id: 'a', status: 'exited' }),
        createMockSession({ id: 'b', status: 'exited' }),
      ];
      const refresh = vi.fn();
      element.addEventListener('refresh', refresh);
      await element.handleCleanupExited();
      // Not emptied and refilled: the refresh brings what is left.
      expect(element.sessions).toHaveLength(2);
      expect(refresh).toHaveBeenCalled();
      const toasts = [...document.querySelectorAll('.ut-toast-text')].map((el) => el.textContent);
      expect(toasts).toContain('2 sessions that can be resumed were kept');
    });

    it('should handle cleanup error', async () => {
      // Mock cleanup error
      global.fetch = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'Cleanup failed' }), { status: 500 }))
      ) as typeof fetch;

      const errorHandler = vi.fn();
      element.addEventListener('error', errorHandler);

      await element.handleCleanupExited();

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: "Couldn't clear the finished sessions",
        })
      );
    });

    it('should prevent concurrent cleanup operations', async () => {
      // Reset fetch mock calls tracking
      fetchMock.calls.clear();

      // Mock successful cleanup with delay (already set up in beforeEach)
      // The default mock already has a 100ms delay for /api/cleanup-exited

      // Start first cleanup
      const promise1 = element.handleCleanupExited();

      // Try to start second cleanup immediately
      const promise2 = element.handleCleanupExited();

      // Second call should return immediately without making a fetch
      await promise2;
      expect(fetchMock.calls.get('/api/cleanup-exited') || 0).toBe(1); // Only one fetch call

      // Wait for first cleanup to complete
      await promise1;
    });
  });

  describe('hide exited toggle', () => {
    it('should toggle hide exited state', async () => {
      const changeHandler = vi.fn();
      element.addEventListener('hide-exited-change', changeHandler);

      // Create some sessions
      element.sessions = [
        createMockSession({ status: 'running' }),
        createMockSession({ status: 'exited' }),
      ];
      await element.updateComplete;

      // Find toggle checkbox - when hideExited is true (default), checkbox is unchecked
      const toggleCheckbox = element.querySelector('#show-exited-toggle') as HTMLInputElement;
      expect(toggleCheckbox).toBeTruthy();

      toggleCheckbox.click();

      // The component doesn't directly change hideExited - it emits an event
      // The parent should handle the event and update the property
      expect(element.hideExited).toBe(true); // Still true because parent hasn't updated it
      expect(changeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: false, // Requesting to change to false
        })
      );
    });
  });

  describe('timer display', () => {
    it('should show static duration for exited sessions', async () => {
      const now = Date.now();
      const startTime = now - 60000; // 1 minute ago
      const exitTime = now - 30000; // Exited 30 seconds ago

      const mockSessions = [
        createMockSession({
          id: 'running-session',
          status: 'running',
          startedAt: new Date(startTime).toISOString(),
          lastModified: new Date().toISOString(),
        }),
        createMockSession({
          id: 'exited-session',
          status: 'exited',
          startedAt: new Date(startTime).toISOString(),
          lastModified: new Date(exitTime).toISOString(),
        }),
      ];

      element.sessions = mockSessions;
      element.hideExited = false;
      await element.updateComplete;

      const sessionCards = getAllElements<SessionCard>(element, 'session-card');
      expect(sessionCards).toHaveLength(2);

      // The exited session should show a static duration of ~30s
      // while the running session shows a live duration of ~60s
      // Verify we have sessions with the correct properties
      const exitedSessionCard = sessionCards.find(
        (card: SessionCard) => card.session && card.session.id === 'exited-session'
      );
      const runningSessionCard = sessionCards.find(
        (card: SessionCard) => card.session && card.session.id === 'running-session'
      );

      expect(exitedSessionCard).toBeTruthy();
      expect(runningSessionCard).toBeTruthy();

      // Verify the exited session has the correct properties
      const exitedSession = (exitedSessionCard as SessionCard).session;
      expect(exitedSession.status).toBe('exited');
      expect(exitedSession.lastModified).toBe(new Date(exitTime).toISOString());
    });

    it('should pass lastModified to session cards for exited sessions', async () => {
      const exitedSession = createMockSession({
        id: 'exited-session',
        status: 'exited',
        startedAt: new Date(Date.now() - 120000).toISOString(),
        lastModified: new Date(Date.now() - 60000).toISOString(),
      });

      element.sessions = [exitedSession];
      element.hideExited = false;
      await element.updateComplete;

      const sessionCard = element.querySelector('session-card');
      expect(sessionCard).toBeTruthy();

      // Verify the session card received the correct session data
      // The component should pass the full session object including lastModified
      expect((sessionCard as SessionCard)?.session).toEqual(exitedSession);
    });
  });

  describe('rendering', () => {
    it('should show session count', async () => {
      element.sessions = [
        createMockSession({ status: 'running' }),
        createMockSession({ status: 'running' }),
        createMockSession({ status: 'exited' }),
      ];
      element.hideExited = true;
      await element.updateComplete;

      // Look for the count in the rendered content
      const content = element.textContent;
      expect(content).toContain('2'); // Only running sessions shown
    });

    it('should render cleanup button when there are exited sessions', async () => {
      element.sessions = [
        createMockSession({ status: 'running' }),
        createMockSession({ status: 'exited' }),
      ];
      element.hideExited = false;
      await element.updateComplete;

      const cleanupButton = element.querySelector('#clean-exited-button');
      expect(cleanupButton).toBeTruthy();
    });
  });

  describe('phone new-session sheets', () => {
    const sheetButtons = () =>
      [...document.body.querySelectorAll('.psr-sheet-group button')].map((b) =>
        b.textContent?.trim()
      );
    // The global localStorage mock stores nothing; give these tests a real one.
    const store = new Map<string, string>();
    beforeEach(() => {
      vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
      vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
        store.set(key, value);
      });
    });
    afterEach(() => {
      store.clear();
      vi.mocked(localStorage.getItem).mockReset();
      vi.mocked(localStorage.setItem).mockReset();
      document.body.querySelector('.psr-sheet-cancel')?.dispatchEvent(new Event('click'));
    });

    it('asks before clearing finished sessions from the phone list', async () => {
      element.sessions = [createMockSession({ id: 'a', status: 'exited' })];
      const cleanup = vi.spyOn(element, 'handleCleanupExited').mockResolvedValue();
      const clear = (element as unknown as { confirmClearFinished: () => Promise<void> })
        .confirmClearFinished;
      confirmDialog.mockResolvedValueOnce(false);
      await clear();
      expect(confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Clear 1 finished session?', tone: 'danger' })
      );
      expect(cleanup).not.toHaveBeenCalled();
      confirmDialog.mockResolvedValueOnce(true);
      await clear();
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('a scroll of a sheet that starts on one of its buttons does nothing; a still tap acts', async () => {
      (
        element as unknown as { openFolderSheet: (entry: { command: string }) => void }
      ).openFolderSheet({ command: 'zsh' });
      const toggle = () =>
        document.body.querySelector('[data-testid="new-session-shield-toggle"]') as HTMLElement;
      const checked = toggle().getAttribute('aria-checked');
      // iOS ends a scroll that began on a button with a pointerup on it.
      const touch = (dy: number) => {
        const at = (y: number) => ({
          pointerType: 'touch',
          pointerId: 7,
          clientX: 40,
          clientY: y,
          bubbles: true,
        });
        toggle().dispatchEvent(new PointerEvent('pointerdown', at(300)));
        toggle().dispatchEvent(new PointerEvent('pointerup', at(300 + dy)));
      };
      const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000); // past the opening tap
      touch(-100);
      expect(toggle().getAttribute('aria-checked')).toBe(checked);
      touch(2);
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      later.mockRestore();
      expect(toggle().getAttribute('aria-checked')).not.toBe(checked);
    });

    it('puts the last tool first and keeps folders after their sessions are cleared', async () => {
      const list = element as unknown as {
        openToolSheet: () => void;
        openFolderSheet: (entry: { command: string }) => void;
      };
      element.sessions = [
        createMockSession({ id: 'a', status: 'exited', workingDir: '/work/app' }),
      ];
      await element.updateComplete;
      list.openFolderSheet({ command: 'zsh' });
      expect(sheetButtons()).toContain('/work/app');

      localStorage.setItem(
        'ut-phone-recent-starts',
        JSON.stringify({
          ...JSON.parse(localStorage.getItem('ut-phone-recent-starts') || '{}'),
          tool: 'zsh',
        })
      );
      element.sessions = [];
      await element.updateComplete;
      list.openFolderSheet({ command: 'zsh' });
      expect(sheetButtons()).toContain('/work/app');

      list.openToolSheet();
      expect(sheetButtons()[0]).toBe('zsh');
    });

    it('"Ask Claude" starts your Claude quick start there and hands the question to the server', async () => {
      const list = element as unknown as {
        quickStarts: Array<{ name?: string; command: string }>;
        quickStartsLoaded: boolean;
        handleAskClaude: (e: CustomEvent<{ text: string }>) => Promise<void>;
        askFolder: () => string;
      };
      list.quickStartsLoaded = true;
      list.quickStarts = [
        { command: 'zsh' },
        { name: '✨ claude', command: 'claude --dangerously-skip-permissions' },
      ];
      element.sessions = [
        createMockSession({ id: 'z', workingDir: '/work/other', command: ['zsh'] }),
        createMockSession({ id: 'c', workingDir: '/work/app', command: ['claude'] }),
      ];
      await element.updateComplete;
      // Default folder: where Claude ran last, not the most recent session of any tool.
      expect(list.askFolder()).toBe('/work/app');

      vi.mocked(global.fetch).mockImplementation(
        async () => new Response(JSON.stringify({ sessionId: 'new-1' }), { status: 200 })
      );
      const created = vi.fn();
      element.addEventListener('session-created', created);
      await list.handleAskClaude(new CustomEvent('ask-claude', { detail: { text: 'why?' } }));

      const [url, init] = vi.mocked(global.fetch).mock.calls.at(-1) as [string, RequestInit];
      expect(url).toBe('/api/sessions');
      expect(JSON.parse(init.body as string)).toMatchObject({
        command: ['claude', '--dangerously-skip-permissions'],
        workingDir: '/work/app',
        initialInput: 'why?',
      });
      expect(created).toHaveBeenCalled();
      expect(JSON.parse(store.get('untether_app_preferences') || '{}').chatMode).toBe(true);
    });

    // P6 (2026-10-18): Tarea mode in a repository routes the text (task-routing.ts) instead of
    // starting a session; outside a repository the box has no Tarea mode.
    it('"Ask" in Tarea mode sends the text as a task of the folder\'s repository', async () => {
      const list = element as unknown as {
        handleAskClaude: (
          e: CustomEvent<{ text: string; agent?: string; mode?: string }>
        ) => Promise<void>;
        askFolder: () => string;
        askRepoOf: (folder: string) => string | null | undefined;
      };
      element.sessions = [
        {
          ...createMockSession({ id: 'c', workingDir: '/work/app/web', command: ['claude'] }),
          gitRepoPath: '/work/app',
          gitMainRepoPath: '/work/app',
        },
      ];
      await element.updateComplete;
      expect(list.askFolder()).toBe('/work/app/web');
      expect(list.askRepoOf('/work/app/web')).toBe('/work/app');
      vi.mocked(global.fetch).mockImplementation(async (url) =>
        String(url) === '/api/tasks/route'
          ? new Response(
              JSON.stringify({ repoPath: '/work/app', decision: { kind: 'new' }, open: [] }),
              { status: 200 }
            )
          : new Response(JSON.stringify({ action: 'created', task: { id: 'n', name: 'x' } }), {
              status: 200,
            })
      );
      await list.handleAskClaude(
        new CustomEvent('ask-claude', { detail: { text: 'arregla el build', mode: 'task' } })
      );
      await vi.waitFor(() =>
        expect(vi.mocked(global.fetch).mock.calls.map(([url]) => String(url))).toContain(
          '/api/tasks/submit'
        )
      );
      const calls = vi.mocked(global.fetch).mock.calls as Array<[string, RequestInit]>;
      const routeCall = calls.find(([url]) => url === '/api/tasks/route');
      expect(JSON.parse(routeCall?.[1].body as string)).toEqual({
        repoPath: '/work/app',
        text: 'arregla el build',
      });
      const submit = calls.find(([url]) => url === '/api/tasks/submit');
      expect(JSON.parse(submit?.[1].body as string)).toEqual({
        repoPath: '/work/app',
        text: 'arregla el build',
        agent: 'claude',
        choice: 'new',
      });
      expect(calls.some(([url]) => url === '/api/sessions')).toBe(false);
    });

    it('"Ask Codex" starts your Codex quick start, else plain codex, waiting for Codex', async () => {
      const list = element as unknown as {
        quickStarts: Array<{ name?: string; command: string }>;
        quickStartsLoaded: boolean;
        handleAskClaude: (e: CustomEvent<{ text: string; agent?: string }>) => Promise<void>;
      };
      list.quickStartsLoaded = true;
      list.quickStarts = [{ command: 'claude' }, { name: 'Codex', command: 'codex --yolo' }];
      element.sessions = [];
      await element.updateComplete;
      vi.mocked(global.fetch).mockImplementation(
        async () => new Response(JSON.stringify({ sessionId: 'new-2' }), { status: 200 })
      );
      const ask = (detail: { text: string; agent?: string }) =>
        list.handleAskClaude(new CustomEvent('ask-claude', { detail }));
      const lastBody = () =>
        JSON.parse(
          (vi.mocked(global.fetch).mock.calls.at(-1) as [string, RequestInit])[1].body as string
        );

      await ask({ text: 'hola', agent: 'codex' });
      expect(lastBody()).toMatchObject({
        command: ['codex', '--yolo'],
        initialInput: 'hola',
        initialInputAgent: 'codex',
      });

      list.quickStarts = [{ command: 'claude' }];
      await ask({ text: 'otra', agent: 'codex' });
      expect(lastBody()).toMatchObject({ command: ['codex'], initialInputAgent: 'codex' });
    });

    it('leaves shielding to the server unless this device chose it (on by default since 2026-10-03)', async () => {
      const list = element as unknown as {
        quickStarts: Array<{ name?: string; command: string }>;
        quickStartsLoaded: boolean;
        newShieldedChoice: boolean | null;
        handleAskClaude: (e: CustomEvent<{ text: string }>) => Promise<void>;
      };
      list.quickStartsLoaded = true;
      list.quickStarts = [{ command: 'claude' }];
      vi.mocked(global.fetch).mockImplementation(
        async () => new Response(JSON.stringify({ sessionId: 'new-3' }), { status: 200 })
      );
      const lastBody = () =>
        JSON.parse(
          (vi.mocked(global.fetch).mock.calls.at(-1) as [string, RequestInit])[1].body as string
        );

      list.newShieldedChoice = null;
      await list.handleAskClaude(new CustomEvent('ask-claude', { detail: { text: 'a' } }));
      expect(lastBody()).not.toHaveProperty('shielded');

      list.newShieldedChoice = false;
      await list.handleAskClaude(new CustomEvent('ask-claude', { detail: { text: 'b' } }));
      expect(lastBody()).toMatchObject({ shielded: false });

      list.newShieldedChoice = true;
      await list.handleAskClaude(new CustomEvent('ask-claude', { detail: { text: 'c' } }));
      expect(lastBody()).toMatchObject({ shielded: true });
    });

    it('"Other folder…" ends the ask folder sheet and opens the folder picker; its pick becomes the ask folder', async () => {
      const phone = vi
        .spyOn(element as unknown as { usePhoneRows: () => boolean }, 'usePhoneRows')
        .mockReturnValue(true);
      element.sessions = [
        createMockSession({ id: 'c', workingDir: '/work/app', command: ['claude'] }),
      ];
      await element.updateComplete;
      const box = element.querySelector('ask-claude-box') as AskClaudeBox;
      expect(box.folder).toBe('/work/app');
      const items = () => [
        ...document.body.querySelectorAll<HTMLButtonElement>('.psr-sheet-group button'),
      ];
      // The sheet ignores the tap that opened it: tap its last item a second later.
      const tapLastItem = () => {
        const last = items().at(-1);
        const now = Date.now();
        const later = vi.spyOn(Date, 'now').mockReturnValue(now + 1000);
        last?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        later.mockRestore();
      };
      const picker = () => document.body.querySelector<FileBrowser>('file-browser');
      const pickerLoaded = () => new Promise((resolve) => setTimeout(resolve, 0));

      const question = box.querySelector('textarea') as HTMLTextAreaElement;
      question.focus();
      box.dispatchEvent(new CustomEvent('ask-pick-folder', { bubbles: true }));
      const other = items().at(-1);
      expect(other?.textContent?.trim()).toBe('Other folder…');
      // An action, not drawn as a monospace path like the folders above it.
      expect(items()[0].classList.contains('folder')).toBe(true);
      expect(other?.classList.contains('folder')).toBe(false);

      tapLastItem();
      expect(items()).toHaveLength(0);
      expect(picker()?.mode).toBe('select');
      expect(picker()?.session?.workingDir).toBe('/work/app');
      // The question's keyboard would cover the picker's Select button.
      expect(document.activeElement).not.toBe(question);

      await pickerLoaded();
      picker()?.dispatchEvent(new CustomEvent('directory-selected', { detail: '/else/where' }));
      await element.updateComplete;
      expect(picker()).toBeNull();
      expect(box.folder).toBe('/else/where');
      expect(JSON.parse(store.get('ut-phone-recent-starts') || '{}').claudeFolder).toBe(
        '/else/where'
      );

      // Cancelling the picker changes nothing.
      box.dispatchEvent(new CustomEvent('ask-pick-folder', { bubbles: true }));
      tapLastItem();
      await pickerLoaded();
      picker()?.dispatchEvent(new CustomEvent('browser-cancel'));
      await element.updateComplete;
      expect(picker()).toBeNull();
      expect(box.folder).toBe('/else/where');
      phone.mockRestore();
    });
  });

  describe('worktree loading', () => {
    const worktreeCalls = () =>
      [...fetchMock.calls.entries()]
        .filter(([url]) => url.includes('/api/worktrees'))
        .reduce((total, [, count]) => total + count, 0);
    const repoSessions = (suffix: string) =>
      ['a', 'b'].map((repo) => ({
        ...createMockSession({ id: `${repo}-${suffix}`, name: suffix }),
        gitRepoPath: `/repos/${repo}`,
      }));

    it('retries a failed repo at most once a minute, not on every session update', async () => {
      const failingFetch = global.fetch;
      global.fetch = vi.fn((url: string, init?: RequestInit) => {
        if (!String(url).includes('/api/worktrees')) return failingFetch(url, init);
        fetchMock.calls.set(String(url), (fetchMock.calls.get(String(url)) || 0) + 1);
        return Promise.resolve(new Response('{}', { status: 500 }));
      }) as typeof fetch;
      for (const suffix of ['1', '2', '3', '4']) {
        element.sessions = repoSessions(suffix);
        await element.updateComplete;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(worktreeCalls()).toBe(2);
    });

    it('does not fetch worktrees for the phone list, which never shows them', async () => {
      const list = element as unknown as { usePhoneRows: () => boolean };
      const phone = vi.spyOn(list, 'usePhoneRows').mockReturnValue(true);
      element.sessions = repoSessions('1');
      await element.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(worktreeCalls()).toBe(0);
      phone.mockRestore();
    });
  });

  describe('repo menu: follow mode and worktrees (2026-11-10)', () => {
    type RepoList = {
      loadWorktreesForRepo(repo: string, userRequested?: boolean): Promise<void>;
      handleFollowModeChange(repo: string, branch: string | undefined): Promise<void>;
      renderRepoPopover(repo: string): import('lit').TemplateResult;
      repoFollowMode: Map<string, string | undefined>;
    };
    const repo = '/repos/app';
    const worktrees = [
      { path: repo, branch: 'refs/heads/main', head: 'a', detached: false },
      { path: '/repos/.wt/app/feat', branch: 'refs/heads/feat', head: 'b', detached: false },
      { path: '/repos/.wt/app/other', branch: 'refs/heads/other', head: 'c', detached: false },
    ];
    const list = () => element as unknown as RepoList;
    let worktreeAnswers = 0;
    let followAnswer = 200;
    const stubWorktrees = (followBranch: string | undefined) => {
      worktreeAnswers = 0;
      global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.startsWith('/api/worktrees/follow')) {
          return new Response('{}', { status: followAnswer });
        }
        if (target.startsWith('/api/worktrees') && init?.method !== 'POST') {
          worktreeAnswers++;
          return Response.json({ worktrees, followBranch });
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
    };
    const checkedBranches = async () => {
      const host = document.createElement('div');
      const { render } = await import('lit');
      render(list().renderRepoPopover(repo), host);
      return [...host.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map((el) =>
        el.textContent?.trim()
      );
    };

    beforeEach(() => {
      followAnswer = 200;
    });

    it('marks the followed branch after a reload, whose answer has no refs/heads/', async () => {
      stubWorktrees('feat');
      await list().loadWorktreesForRepo(repo);
      expect(await checkedBranches()).toEqual(['feat']);
    });

    it('marks the branch just picked, and puts the old one back when the server refuses', async () => {
      stubWorktrees('feat');
      await list().loadWorktreesForRepo(repo);
      followAnswer = 500;
      await list().handleFollowModeChange(repo, 'refs/heads/other');
      expect(list().repoFollowMode.get(repo)).toBe('feat');
      expect(await checkedBranches()).toEqual(['feat']);
      followAnswer = 200;
      await list().handleFollowModeChange(repo, 'refs/heads/other');
      expect(list().repoFollowMode.get(repo)).toBe('other');
      expect(await checkedBranches()).toEqual(['other']);
    });

    it('reads loaded worktrees again only when the user opens the menu', async () => {
      stubWorktrees(undefined);
      await list().loadWorktreesForRepo(repo);
      await list().loadWorktreesForRepo(repo);
      expect(worktreeAnswers).toBe(1);
      stubWorktrees('feat');
      await list().loadWorktreesForRepo(repo, true);
      expect(worktreeAnswers).toBe(1);
      expect(list().repoFollowMode.get(repo)).toBe('feat');
    });
  });

  describe('launch config (2026-11-10)', () => {
    type LaunchList = {
      loadQuickStarts(): void;
      quickStartsLoaded: boolean;
      quickStarts: Array<{ command: string }>;
      repositoryBasePath: string;
    };

    it('asks again after a failed read instead of keeping the defaults until a reload', async () => {
      const list = element as unknown as LaunchList;
      const service = serverConfigService as unknown as { clearCache(): void };
      let answer: Response = new Response('{}', { status: 500 });
      global.fetch = vi.fn(async (url: string | URL | Request) =>
        String(url) === '/api/config' ? answer.clone() : new Response('{}', { status: 200 })
      ) as typeof fetch;
      service.clearCache();
      list.quickStartsLoaded = false;
      list.quickStarts = [];
      list.repositoryBasePath = '';
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000);
      try {
        list.loadQuickStarts();
        await vi.waitFor(() => expect(vi.mocked(global.fetch)).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(list.quickStartsLoaded).toBe(false);

        // Too soon: not asked again.
        const calls = vi.mocked(global.fetch).mock.calls.length;
        list.loadQuickStarts();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(
          vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url) === '/api/config')
        ).toHaveLength(
          vi
            .mocked(global.fetch)
            .mock.calls.slice(0, calls)
            .filter(([url]) => String(url) === '/api/config').length
        );

        // After the wait the server answers.
        answer = Response.json({
          serverConfigured: true,
          repositoryBasePath: '/work',
          quickStartCommands: [{ command: 'claude' }, { command: '  ' }],
        });
        clock.mockReturnValue(now + 20 * 60_000);
        list.loadQuickStarts();
        await vi.waitFor(() => expect(list.quickStartsLoaded).toBe(true));
        expect(list.quickStarts).toEqual([{ command: 'claude' }]);
        expect(list.repositoryBasePath).toBe('/work');
      } finally {
        clock.mockRestore();
        service.clearCache();
      }
    });
  });

  describe('task board: home by project (2026-10-18)', () => {
    const repo = '/repos/app';
    const inRepo = (id: string, extra: Record<string, unknown> = {}) => ({
      ...createMockSession({ id, name: id, status: 'running', command: ['claude'] }),
      gitRepoPath: repo,
      gitMainRepoPath: repo,
      gitBranch: 'main',
      ...extra,
    });
    const taskSession = (id: string) =>
      inRepo(id, {
        gitRepoPath: '/repos/.untether-worktrees/app/login-google',
        gitIsWorktree: true,
        gitBranch: 'ut/login-google',
      });

    afterEach(() => {
      taskStore.reset();
    });

    async function phone(sessions: ReturnType<typeof inRepo>[], tasks = [createTestTask()]) {
      vi.spyOn(
        element as unknown as { usePhoneRows: () => boolean },
        'usePhoneRows'
      ).mockReturnValue(true);
      taskStore.set(tasks);
      element.sessions = sessions as never;
      element.requestUpdate();
      await element.updateComplete;
    }

    it('phone: one group per project, its tasks first, the task session only in its row', async () => {
      await phone(
        [inRepo('loose'), taskSession('ts'), { ...createMockSession({ id: 'tmp' }) } as never],
        [createTestTask({ id: 't1', sessionId: 'ts', state: 'ready' })]
      );
      const groups = [...element.querySelectorAll<HTMLElement>('[data-testid="project-group"]')];
      expect(groups.map((g) => g.dataset.project)).toEqual([repo, '']);
      expect(groups[0].querySelector('.prj-name')?.textContent).toBe('app');
      expect(groups[1].querySelector('.prj-name')?.textContent).toBe('Other');
      expect(groups[0].querySelector('task-row')?.getAttribute('data-task')).toBe('t1');
      const rows = [...element.querySelectorAll('phone-session-row')].map(
        (row) => (row as HTMLElement & { session: { id: string } }).session.id
      );
      expect(rows).toEqual(['loose', 'tmp']);
    });

    it('a task push opens "Hechas" and clears a search that hides the task', async () => {
      const done = createTestTask({
        id: 'm1',
        state: 'merged',
        finishedAt: new Date().toISOString(),
      });
      await phone([inRepo('loose')], [done]);
      expect(element.querySelector('task-row[data-task="m1"]')).toBeNull();
      window.dispatchEvent(new CustomEvent('ut-task-unfold', { detail: { taskId: 'm1' } }));
      await element.updateComplete;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const section = element.querySelector('done-section') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await section?.updateComplete;
      expect(element.querySelector('task-row[data-task="m1"]')).not.toBeNull();
    });

    it('phone: tapping a task row opens its session like a session row', async () => {
      await phone([taskSession('ts')], [createTestTask({ id: 't1', sessionId: 'ts' })]);
      const navigate = vi.fn();
      element.addEventListener('navigate-to-session', (e) =>
        navigate((e as CustomEvent).detail.sessionId)
      );
      element.querySelector<HTMLElement>('task-row .tsk-main')?.click();
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith('ts');
    });

    it('phone: sessions outside any repo and no task keep the plain list, no header', async () => {
      await phone([{ ...createMockSession({ id: 'tmp' }) } as never], []);
      expect(element.querySelector('[data-testid="project-header"]')).toBeNull();
      expect(element.querySelectorAll('phone-session-row')).toHaveLength(1);
    });

    it('phone: a task on a provider shows its icon in the strip, in the logo place', async () => {
      vi.spyOn(serverConfigService, 'loadConfig').mockResolvedValue({
        modelProviders: [{ id: 'acme', label: 'Acme', models: [], priced: false, icon: '🦊' }],
      } as unknown as Awaited<ReturnType<typeof serverConfigService.loadConfig>>);
      await phone(
        [taskSession('ts')],
        [
          createTestTask({
            id: 't1',
            sessionId: 'ts',
            state: 'needs_you',
            modelProvider: 'acme',
            blocker: { kind: 'conflict', message: 'x' },
          }),
        ]
      );
      await vi.waitFor(() =>
        expect(
          element.querySelector('[data-testid="needs-you-task-pill"] [data-testid="provider-logo"]')
            ?.textContent
        ).toContain('🦊')
      );
    });

    it('phone: a task that needs you is in the strip once, as the task', async () => {
      await phone(
        [taskSession('ts'), inRepo('other', { claudeStatus: { status: 'waiting' } })],
        [
          createTestTask({
            id: 't1',
            sessionId: 'ts',
            state: 'needs_you',
            blocker: { kind: 'conflict', message: 'x' },
          }),
        ]
      );
      const strip = element.querySelector('[data-testid="needs-you-strip"]') as HTMLElement;
      expect(strip.querySelectorAll('[data-testid="needs-you-task-pill"]')).toHaveLength(1);
      expect(strip.querySelectorAll('[data-testid="needs-you-pill"]')).toHaveLength(1);
      expect(strip.querySelector('[data-testid="needs-you-task-pill"]')?.textContent).toContain(
        'Login con Google'
      );
      expect(strip.textContent).toContain('2');
    });

    it('phone: "+ Tarea" starts a task in that project; the gear opens its settings', async () => {
      const { lazyViews } = await import('../utils/lazy-views');
      const openTaskComposeSheet = vi.fn();
      const openProjectSettingsSheet = vi.fn();
      vi.spyOn(lazyViews.taskComposeSheet, 'use').mockImplementation((fn) =>
        fn({ openTaskComposeSheet } as never)
      );
      vi.spyOn(lazyViews.projectSettingsSheet, 'use').mockImplementation((fn) =>
        fn({ openProjectSettingsSheet } as never)
      );
      await phone([inRepo('loose')], []);
      element.querySelector<HTMLButtonElement>('[data-testid="project-new-task"]')?.click();
      expect(openTaskComposeSheet.mock.calls[0][0]).toMatchObject({ repo, repos: [repo] });
      element.querySelector<HTMLButtonElement>('[data-testid="project-settings"]')?.click();
      expect(openProjectSettingsSheet).toHaveBeenCalledWith({ repoPath: repo, name: 'app' });
    });

    // A project folder without git (2026-10-18): version control first, then the action.
    it('phone: a folder without git turns version control on, then goes on as a project', async () => {
      const { lazyViews } = await import('../utils/lazy-views');
      const folder = '/Users/n/Projects/tele';
      const openGitInitSheet = vi.fn();
      const openTaskComposeSheet = vi.fn();
      const openOrchestratorSheet = vi.fn();
      vi.spyOn(lazyViews.gitInitSheet, 'use').mockImplementation((fn) =>
        fn({ openGitInitSheet } as never)
      );
      vi.spyOn(lazyViews.taskComposeSheet, 'use').mockImplementation((fn) =>
        fn({ openTaskComposeSheet } as never)
      );
      vi.spyOn(lazyViews.orchestratorSheet, 'use').mockImplementation((fn) =>
        fn({ openOrchestratorSheet } as never)
      );
      const plain = {
        ...createMockSession({ id: 'tele', name: 'tele', status: 'running', command: ['claude'] }),
        workingDir: folder,
      };
      await phone([inRepo('loose'), plain as never], []);
      const group = () => element.querySelector(`[data-project="${folder}"]`) as HTMLElement;
      expect(group().querySelector('[data-testid="project-settings"]')).toBeNull();

      group().querySelector<HTMLButtonElement>('[data-testid="project-orchestrate"]')?.click();
      expect(openGitInitSheet.mock.calls[0][0]).toMatchObject({ folder, name: 'tele' });
      expect(openOrchestratorSheet).not.toHaveBeenCalled();
      openGitInitSheet.mock.calls[0][0].onActivated(folder);
      expect(openOrchestratorSheet).toHaveBeenCalledWith({
        repoPath: folder,
        name: 'tele',
        running: false,
        sessions: [],
      });

      const refresh = vi.fn();
      element.addEventListener('refresh', refresh);
      group().querySelector<HTMLButtonElement>('[data-testid="project-new-task"]')?.click();
      openGitInitSheet.mock.calls[1][0].onActivated(folder);
      expect(openTaskComposeSheet.mock.calls[0][0]).toMatchObject({ repo: folder });
      expect(refresh).toHaveBeenCalled();
      // A git project right away: branch and gear, not the folder group.
      await element.updateComplete;
      expect(group().querySelector('[data-testid="project-settings"]')).not.toBeNull();
      expect(group().querySelector('[data-testid="project-branch"]')?.textContent?.trim()).toBe(
        'main'
      );
    });

    // 2026-10-24: the split-view sidebar did not say which session was the orchestrator, and
    // its project header offered no Orquestar / + Tarea.
    it('sidebar: marks the orchestrator and its header orchestrates and adds tasks', async () => {
      const { lazyViews } = await import('../utils/lazy-views');
      const openOrchestratorSheet = vi.fn();
      vi.spyOn(lazyViews.orchestratorSheet, 'use').mockImplementation((fn) =>
        fn({ openOrchestratorSheet } as never)
      );
      const newTask = vi
        .spyOn(element as unknown as { openNewTask: (repo?: string) => void }, 'openNewTask')
        .mockImplementation(() => {});
      taskStore.set([], [{ repoPath: repo, sessionId: 'orch' }]);
      element.compactMode = true;
      element.sessions = [inRepo('loose'), inRepo('orch')] as never;
      element.requestUpdate();
      await element.updateComplete;
      const cards = [...element.querySelectorAll('compact-session-card')] as Array<
        HTMLElement & { session: { id: string }; orchestrator: boolean }
      >;
      expect(cards.map((card) => [card.session.id, card.orchestrator])).toEqual(
        expect.arrayContaining([
          ['orch', true],
          ['loose', false],
        ])
      );
      const header = element.querySelector('.ut-side-list repository-header') as HTMLElement;
      const orchestrate = header.querySelector<HTMLButtonElement>(
        '[data-testid="project-orchestrate"]'
      );
      expect(orchestrate?.classList.contains('running')).toBe(true);
      orchestrate?.click();
      // With one running: its menu (open, new goal, stop), as from the full header.
      expect(document.body.querySelector('[data-testid="orchestrator-menu"]')).not.toBeNull();
      header.querySelector<HTMLButtonElement>('[data-testid="project-new-task"]')?.click();
      expect(newTask).toHaveBeenCalledWith(repo);
    });

    // 2026-10-24: the project's app icon showed only on the phone.
    it("sidebar and desktop: the project's headers and its orchestrator get its app icon", async () => {
      taskStore.set([], [{ repoPath: repo, sessionId: 'orch' }]);
      taskStore.setProjects([{ repoPath: repo }]);
      const iconFor = vi.spyOn(taskStore, 'iconFor').mockReturnValue(null);
      try {
        element.compactMode = true;
        element.sessions = [inRepo('loose'), inRepo('orch')] as never;
        element.requestUpdate();
        await element.updateComplete;
        type WithIcon = HTMLElement & { projectIcon: string | null; session?: { id: string } };
        const header = () => element.querySelector('repository-header') as WithIcon;
        expect(header().projectIcon).toBeNull();
        // It arrives later: the list draws it then.
        iconFor.mockImplementation((path) => (path === repo ? 'blob:icon' : null));
        element.requestUpdate();
        await element.updateComplete;
        expect(header().projectIcon).toBe('blob:icon');
        const sidebarCards = [...element.querySelectorAll('compact-session-card')] as WithIcon[];
        expect(sidebarCards.map((card) => [card.session?.id, card.projectIcon])).toEqual(
          expect.arrayContaining([
            ['orch', 'blob:icon'],
            ['loose', null],
          ])
        );
        element.compactMode = false;
        await element.updateComplete;
        expect(header().projectIcon).toBe('blob:icon');
        const cards = [...element.querySelectorAll('session-card')] as WithIcon[];
        expect(cards.map((card) => [card.session?.id, card.projectIcon])).toEqual(
          expect.arrayContaining([
            ['orch', 'blob:icon'],
            ['loose', null],
          ])
        );
      } finally {
        iconFor.mockRestore();
      }
    });

    // 2026-11-07: the sidebar had no group menu; a move there regroups the row at once, and
    // every sidebar row (live, finished) gets the menu.
    it('sidebar: its group menu moves a row out of its project group at once', async () => {
      const loose = { ...createMockSession({ id: 'loose', name: 'loose', status: 'running' }) };
      const finished = { ...createMockSession({ id: 'done', name: 'done', status: 'exited' }) };
      element.compactMode = true;
      element.hideExited = false;
      element.sessions = [inRepo('a'), inRepo('b'), loose, finished] as never;
      element.requestUpdate();
      await element.updateComplete;
      type Card = HTMLElement & { session: { id: string }; groupMenu: unknown };
      const cards = () => [...element.querySelectorAll('compact-session-card')] as Card[];
      const card = (id: string) => cards().find((c) => c.session.id === id) as Card;
      const groupIds = (id: string) =>
        [...(card(id).closest('.ut-side-group')?.querySelectorAll('compact-session-card') ?? [])]
          .map((c) => (c as Card).session.id)
          .sort();
      expect(groupIds('a')).toEqual(['a', 'b']);
      for (const each of cards()) {
        expect(each.groupMenu).not.toBeNull();
        expect(each.querySelector('[data-testid="compact-group-pin-button"]')).not.toBeNull();
      }
      const realFetch = global.fetch;
      global.fetch = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith('/a/group-pin')
          ? new Response(JSON.stringify({ success: true, groupPin: { repoPath: null } }))
          : realFetch(url)
      ) as typeof fetch;
      vi.useFakeTimers();
      try {
        card('a')
          .querySelector<HTMLButtonElement>('[data-testid="compact-group-pin-button"]')
          ?.click();
        vi.advanceTimersByTime(600);
        document.body.querySelector<HTMLButtonElement>('[data-testid="group-pin-move"]')?.click();
        vi.advanceTimersByTime(600);
        document.body
          .querySelector<HTMLButtonElement>('[data-testid="group-pin-to-others"]')
          ?.click();
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(async () => {
        await element.updateComplete;
        expect(groupIds('a')).toEqual(['a', 'loose']);
      });
      expect(groupIds('b')).toEqual(['b']);
      global.fetch = realFetch;
    });

    // P7 (2026-10-18): the orchestrator's session pinned in its project; its menu.
    it('phone: "Orquestar" opens the goal sheet; a running one is pinned and has a menu', async () => {
      const { lazyViews } = await import('../utils/lazy-views');
      const openOrchestratorSheet = vi.fn();
      vi.spyOn(lazyViews.orchestratorSheet, 'use').mockImplementation((fn) =>
        fn({ openOrchestratorSheet } as never)
      );
      // An open Claude session of the project is offered as the orchestrator; a shell is not.
      await phone(
        [
          inRepo('loose'),
          inRepo('chat', {
            claudeSessionId: 'c-1',
            userTitle: 'Charla',
            claudeStatus: { status: 'idle' },
          }),
        ],
        []
      );
      element.querySelector<HTMLButtonElement>('[data-testid="project-orchestrate"]')?.click();
      expect(openOrchestratorSheet).toHaveBeenCalledWith({
        repoPath: repo,
        name: 'app',
        running: false,
        sessions: [{ id: 'chat', title: 'Charla' }],
      });

      vi.spyOn(
        element as unknown as { usePhoneRows: () => boolean },
        'usePhoneRows'
      ).mockReturnValue(true);
      taskStore.set([], [{ repoPath: repo, sessionId: 'orch' }]);
      element.sessions = [inRepo('loose'), inRepo('orch')] as never;
      element.requestUpdate();
      await element.updateComplete;
      const pinned = element.querySelector('[data-testid="project-orchestrator-row"]');
      expect(
        (pinned?.querySelector('phone-session-row') as HTMLElement & { session: { id: string } })
          ?.session.id
      ).toBe('orch');

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
      element.querySelector<HTMLButtonElement>('[data-testid="project-orchestrate"]')?.click();
      const menu = document.body.querySelector('[data-testid="orchestrator-menu"]') as HTMLElement;
      expect(menu).not.toBeNull();
      const navigate = vi.fn();
      element.addEventListener('navigate-to-session', (e) =>
        navigate((e as CustomEvent).detail.sessionId)
      );
      vi.mocked(Date.now).mockReturnValue(Date.now() + 10_000);
      menu.querySelector<HTMLButtonElement>('[data-testid="orchestrator-open"]')?.click();
      expect(navigate).toHaveBeenCalledWith('orch');

      vi.mocked(global.fetch).mockImplementation(
        async () => new Response(JSON.stringify({ sessionId: 'orch' }), { status: 200 })
      );
      element.querySelector<HTMLButtonElement>('[data-testid="project-orchestrate"]')?.click();
      vi.mocked(Date.now).mockReturnValue(Date.now() + 20_000);
      document.body.querySelector<HTMLButtonElement>('[data-testid="orchestrator-stop"]')?.click();
      vi.mocked(Date.now).mockReturnValue(Date.now() + 30_000);
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="orchestrator-stop-yes"]')
        ?.click();
      await vi.waitFor(() =>
        expect(
          (vi.mocked(global.fetch).mock.calls as Array<[string, RequestInit]>).some(
            ([url, init]) =>
              url === `/api/projects/orchestrator?repo=${encodeURIComponent(repo)}` &&
              init.method === 'DELETE'
          )
        ).toBe(true)
      );
    });

    it('phone: an action waiting for the OK is in "Te necesita" and opens its sheet (2026-10-18)', async () => {
      await phone([inRepo('loose')], []);
      taskStore.set(
        [],
        [],
        [],
        [
          {
            id: 'c1',
            kind: 'discard',
            createdAt: '2026-10-18T00:00:00.000Z',
            expiresAt: '2026-10-18T00:30:00.000Z',
            where: 'Login',
            summary: 'Discard: Login',
            detail: [],
            requestedBy: {},
          },
        ]
      );
      element.requestUpdate();
      await element.updateComplete;
      const opened = vi.fn();
      window.addEventListener('ut-open-task-confirm', opened);
      const pill = element.querySelector<HTMLButtonElement>(
        '[data-testid="needs-you-confirm-pill"]'
      );
      expect(pill?.textContent).toContain('Login');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
      pill?.click();
      expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'c1' });
      window.removeEventListener('ut-open-task-confirm', opened);
    });

    it("phone: the header's branch is the project's, not a task branch a fix merges into", async () => {
      await phone(
        [inRepo('loose', { gitBranch: 'dev' })],
        [
          createTestTask({
            id: 'fix',
            repoPath: repo,
            isolation: 'worktree',
            baseBranch: 'ut/etiqueta',
            branch: 'ut/fix',
            state: 'needs_you',
          }),
          createTestTask({
            id: 'orig',
            repoPath: repo,
            isolation: 'worktree',
            baseBranch: 'main',
            branch: 'ut/etiqueta',
          }),
        ]
      );
      expect(element.querySelector('[data-testid="project-branch"]')?.textContent?.trim()).toBe(
        'main'
      );
    });

    it('phone: the project name pins it on top; a pinned project comes first, empty or not', async () => {
      const other = '/repos/zeta';
      await phone(
        [inRepo('loose'), { ...inRepo('z'), gitRepoPath: other, gitMainRepoPath: other }],
        []
      );
      vi.mocked(global.fetch).mockImplementation(
        async () => new Response(JSON.stringify({ repoPath: other, pinned: true }), { status: 200 })
      );
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
      const header = element.querySelector(
        `[data-project="${other}"] [data-testid="project-menu"]`
      );
      (header as HTMLButtonElement | null)?.click();
      const pin = document.body.querySelector<HTMLButtonElement>('[data-testid="project-pin"]');
      expect(pin?.textContent?.trim()).toBe('Pin on top');
      vi.mocked(Date.now).mockReturnValue(Date.now() + 10_000);
      pin?.click();
      await vi.waitFor(() =>
        expect(
          (vi.mocked(global.fetch).mock.calls as Array<[string, RequestInit]>).some(
            ([url, init]) =>
              url === '/api/projects/pin' &&
              init.body === JSON.stringify({ repoPath: other, pinned: true })
          )
        ).toBe(true)
      );

      taskStore.set(
        [],
        [],
        [
          { repoPath: '/repos/empty', git: true },
          { repoPath: other, git: true },
        ]
      );
      element.requestUpdate();
      await element.updateComplete;
      expect(
        [...element.querySelectorAll('[data-testid="project-group"]')].map((g) =>
          g.getAttribute('data-project')
        )
      ).toEqual(['/repos/empty', other, repo]);
    });

    it('phone: merged tasks go to a collapsed "Hechas"; their sessions leave "Finished"', async () => {
      await phone(
        [inRepo('loose'), { ...taskSession('ts'), status: 'exited' } as never],
        [createTestTask({ id: 'm', sessionId: 'ts', state: 'merged' })]
      );
      const done = element.querySelector('[data-testid="done-section"]') as HTMLElement;
      expect(done.querySelector('[data-testid="done-toggle"]')?.textContent).toContain('Done (1)');
      expect(done.querySelector('task-row')).toBeNull();
      expect(element.querySelector('[data-testid="phone-finished"]')).toBeNull();
    });

    it('phone: an open task keeps the list up with nothing running yet', async () => {
      await phone([], [createTestTask({ id: 't1', state: 'preparing' })]);
      expect(element.querySelector('[data-testid="phone-empty"]')).toBeNull();
      expect(element.querySelector('task-row')).not.toBeNull();
    });

    it('desktop: a repo block shows its task cards first and no card for a task session', async () => {
      taskStore.set([createTestTask({ id: 't1', sessionId: 'ts', state: 'ready' })]);
      element.sessions = [inRepo('loose'), taskSession('ts')] as never;
      element.requestUpdate();
      await element.updateComplete;
      const block = element.querySelector('[data-testid="repo-group"]') as HTMLElement;
      expect(block.querySelector('[data-testid="desktop-task-list"] task-row')).not.toBeNull();
      expect(
        [...block.querySelectorAll('session-card')].map((card) => (card as SessionCard).session.id)
      ).toEqual(['loose']);
      expect(
        block.querySelector('repository-header [data-testid="project-new-task"]')
      ).not.toBeNull();
    });

    // 2026-11-11: any project with a task took two columns, so one with a single task and a
    // single session had a header twice as wide as its cards and an empty column beside them.
    it('desktop: a project is as many columns wide as its longest row of cards', async () => {
      const span = async (tasks: number, sessions: number) => {
        taskStore.set(
          Array.from({ length: tasks }, (_, at) =>
            createTestTask({ id: `t${at}`, sessionId: `ts${at}`, state: 'ready' })
          )
        );
        element.sessions = Array.from({ length: sessions }, (_, at) =>
          inRepo(`loose${at}`)
        ) as never;
        element.requestUpdate();
        await element.updateComplete;
        const block = element.querySelector('[data-testid="repo-group"]') as HTMLElement;
        return block.style.gridColumn;
      };
      expect(await span(1, 1)).toBe('span 1');
      expect(await span(0, 1)).toBe('span 1');
      expect(await span(1, 0)).toBe('span 1');
      expect(await span(3, 1)).toBe('span 3');
      expect(await span(1, 2)).toBe('span 2');
      // Never more than the grid has (4 until it is measured).
      expect(await span(6, 1)).toBe('span 4');
    });

    const confirmation = {
      id: 'c1',
      kind: 'merge',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      where: 'login-google',
      summary: 'Merge login-google',
      detail: [],
      requestedBy: {},
    } as const;

    // 2026-10-20 audit: with nothing running the confirmations and pinned projects vanished.
    it('phone: nothing running still shows a confirmation and the pinned projects', async () => {
      await phone([], []);
      taskStore.set([], [], [{ repoPath: repo, git: true }], [confirmation]);
      await element.updateComplete;
      expect(element.querySelector('[data-testid="phone-empty"]')).not.toBeNull();
      expect(element.querySelectorAll('[data-testid="needs-you-confirm-pill"]')).toHaveLength(1);
      const groups = [...element.querySelectorAll<HTMLElement>('[data-testid="project-group"]')];
      expect(groups.map((g) => g.dataset.project)).toEqual([repo]);
    });

    it('desktop: nothing running still shows a confirmation and the pinned projects', async () => {
      taskStore.set([], [], [{ repoPath: repo, git: true }], [confirmation]);
      element.sessions = [];
      element.requestUpdate();
      await element.updateComplete;
      expect(element.querySelector('[data-testid="desktop-empty"]')).not.toBeNull();
      expect(element.querySelectorAll('[data-testid="needs-you-confirm-pill"]')).toHaveLength(1);
      const pinned = element.querySelector('[data-testid="pinned-projects"]');
      expect(pinned?.querySelector('repository-header')).not.toBeNull();
    });

    it('desktop: a confirmation alone brings up the strip next to running sessions', async () => {
      taskStore.set([], [], [], [confirmation]);
      element.sessions = [inRepo('loose')] as never;
      element.requestUpdate();
      await element.updateComplete;
      expect(element.querySelectorAll('[data-testid="needs-you-confirm-pill"]')).toHaveLength(1);
    });

    it('Olvidar forgets the project on the server; open tasks are said in Spanish', async () => {
      const { setLocale } = await import('../i18n/index.js');
      await setLocale('es');
      try {
        confirmDialog.mockResolvedValue(true);
        const forget = vi
          .spyOn(taskStore, 'forgetProject')
          .mockResolvedValueOnce({ ok: false, status: 409, error: 'open-tasks', message: 'x' })
          .mockResolvedValueOnce({ ok: true, status: 200, data: { forgotten: true } });
        const refresh = vi.spyOn(taskStore, 'refresh').mockResolvedValue();
        const list = element as unknown as {
          forgetProject: (repoPath: string, name: string) => Promise<void>;
        };
        await list.forgetProject(repo, 'app');
        expect(forget).toHaveBeenCalledWith(repo);
        expect(document.body.textContent).toContain(
          'Tiene tareas abiertas: termínalas o descártalas antes'
        );
        expect(refresh).not.toHaveBeenCalled();
        await list.forgetProject(repo, 'app');
        expect(refresh).toHaveBeenCalled();
        expect(document.body.textContent).toContain('app olvidado');
      } finally {
        confirmDialog.mockResolvedValue(false);
        await setLocale('en');
      }
    });

    it('desktop: a project whose folder is gone offers no task buttons, only the notice and Olvidar', async () => {
      taskStore.setProjects([{ repoPath: repo, missingSince: '2026-10-20T10:00:00Z' }]);
      element.sessions = [inRepo('loose')] as never;
      element.requestUpdate();
      await element.updateComplete;
      const header = element.querySelector('repository-header') as HTMLElement & {
        updateComplete: Promise<unknown>;
      };
      await header.updateComplete;
      expect(header.querySelector('[data-testid="repo-missing"]')).not.toBeNull();
      for (const id of ['project-new-task', 'project-orchestrate', 'project-settings']) {
        expect(header.querySelector(`[data-testid="${id}"]`)).toBeNull();
      }
      expect(element.querySelector('[data-testid="project-notice"]')).not.toBeNull();
      expect(element.querySelector('[data-testid="project-forget"]')).not.toBeNull();
    });

    it('desktop: with nothing running, done tasks still show in «Hechas»', async () => {
      taskStore.set([
        createTestTask({ id: 'm1', state: 'merged', finishedAt: new Date().toISOString() }),
      ]);
      element.sessions = [];
      element.requestUpdate();
      await element.updateComplete;
      expect(element.querySelector('[data-testid="desktop-empty"]')).not.toBeNull();
      expect(element.querySelector('done-section')).not.toBeNull();
    });

    describe('«Te necesita» by urgency (2026-11-08)', () => {
      const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
      const keys = () =>
        [
          ...element.querySelectorAll<HTMLElement>(
            '[data-testid="needs-you-strip"] .ut-needs-item'
          ),
        ].map((item) => item.dataset.key);
      const tasks = () => [
        createTestTask({ id: 'ready', state: 'ready', stateSince: ago(40) }),
        createTestTask({
          id: 'failed',
          state: 'failed',
          stateSince: ago(60),
          blocker: { kind: 'setup', message: 'x' },
        }),
        createTestTask({
          id: 'paused',
          state: 'paused',
          stateSince: ago(90),
          blocker: { kind: 'halted', message: 'x' },
        }),
      ];

      it('phone: blocking first, then failures, ready, paused; a few rows, «+n más» for the rest', async () => {
        await phone(
          [
            inRepo('asks', { claudeStatus: { status: 'waiting', since: Date.now() - 1000 } }),
            inRepo('idle'),
          ],
          tasks()
        );
        expect(keys()).toEqual(['session:asks', 'task:failed', 'task:ready']);
        const more = element.querySelector<HTMLButtonElement>('#needs-you-more');
        expect(more?.textContent).toContain('1');
        const actions = [
          ...element.querySelectorAll<HTMLElement>('[data-testid="needs-you-action"]'),
        ].map((button) => button.dataset.action);
        expect(actions).toEqual(['answer', 'open', 'merge']);
        // Its own section: the project groups keep their order and their rows.
        expect(element.querySelectorAll('[data-testid="project-group"]').length).toBeGreaterThan(0);
        more?.click();
        await element.updateComplete;
        expect(keys()).toEqual(['session:asks', 'task:failed', 'task:ready', 'task:paused']);
      });

      it('phone: «Solo esto» shows only what needs you, «Ver todo» brings the list back', async () => {
        await phone([inRepo('idle')], tasks());
        const toggle = () =>
          element.querySelector<HTMLButtonElement>('#needs-you-only-toggle') as HTMLButtonElement;
        expect(toggle().getAttribute('aria-pressed')).toBe('false');
        toggle().click();
        await element.updateComplete;
        expect(toggle().getAttribute('aria-pressed')).toBe('true');
        expect(element.querySelector('[data-testid="project-group"]')).toBeNull();
        expect(element.querySelector('phone-session-row')).toBeNull();
        expect(keys()).toEqual(['task:failed', 'task:ready', 'task:paused']);
        toggle().click();
        await element.updateComplete;
        expect(element.querySelector('[data-testid="project-group"]')).not.toBeNull();
      });

      it('phone: Fusionar merges through the task row, or the store when the row is hidden', async () => {
        const act = vi
          .spyOn(taskStore, 'act')
          .mockResolvedValue({ ok: true, status: 200, data: {} } as never);
        vi.spyOn(taskStore, 'refresh').mockResolvedValue();
        await phone([inRepo('idle')], [createTestTask({ id: 'ready', state: 'ready' })]);
        const merge = () =>
          element.querySelector<HTMLButtonElement>(
            '[data-testid="needs-you-action"][data-action="merge"]'
          ) as HTMLButtonElement;
        expect(merge().textContent?.trim()).toBe('Merge');
        merge().click();
        await vi.waitFor(() => expect(act).toHaveBeenCalledWith('ready', 'merge'));
        act.mockClear();
        element.querySelector<HTMLButtonElement>('#needs-you-only-toggle')?.click();
        await element.updateComplete;
        expect(element.querySelector('task-row')).toBeNull();
        merge().click();
        await vi.waitFor(() => expect(act).toHaveBeenCalledWith('ready', 'merge'));
      });

      it('phone: «Abrir» on a task with «Solo esto» brings the list back and shows its row', async () => {
        await phone(
          [inRepo('idle')],
          [
            createTestTask({
              id: 'failed',
              state: 'failed',
              blocker: { kind: 'setup', message: 'x' },
            }),
          ]
        );
        element.querySelector<HTMLButtonElement>('#needs-you-only-toggle')?.click();
        await element.updateComplete;
        expect(element.querySelector('task-row')).toBeNull();
        const reveal = vi.fn();
        const proto = customElements.get('task-row')?.prototype as { reveal: () => void };
        const spy = vi.spyOn(proto, 'reveal').mockImplementation(reveal);
        element
          .querySelector<HTMLButtonElement>('[data-testid="needs-you-action"][data-action="open"]')
          ?.click();
        await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(1));
        expect(element.querySelector('task-row[data-task="failed"]')).not.toBeNull();
        spy.mockRestore();
      });

      it('phone: Responder opens the answer sheet of the session that asks', async () => {
        await phone([inRepo('asks', { claudeStatus: { status: 'waiting' } })], []);
        const opened = vi.fn();
        window.addEventListener('ut-open-answer-sheet', opened);
        element
          .querySelector<HTMLButtonElement>(
            '[data-testid="needs-you-action"][data-action="answer"]'
          )
          ?.click();
        window.removeEventListener('ut-open-answer-sheet', opened);
        expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'asks' });
      });

      it('desktop: the «Te necesitan» filter counts tasks too and shows only the section', async () => {
        taskStore.set(tasks());
        element.sessions = [
          inRepo('asks', { claudeStatus: { status: 'waiting' } }),
          inRepo('idle'),
        ] as never;
        element.requestUpdate();
        await element.updateComplete;
        expect(keys()).toEqual(['session:asks', 'task:failed', 'task:ready', 'task:paused']);
        const filter = element.querySelector<HTMLButtonElement>('[data-testid="filter-attention"]');
        expect(
          element.querySelector('[data-testid="filter-count-attention"]')?.textContent?.trim()
        ).toBe('4');
        expect(element.querySelector('session-card')).not.toBeNull();
        filter?.click();
        await element.updateComplete;
        expect(element.querySelector('session-card')).toBeNull();
        expect(element.querySelector('task-row')).toBeNull();
        expect(keys()).toHaveLength(4);
        element.querySelector<HTMLButtonElement>('#needs-you-only-toggle')?.click();
        await element.updateComplete;
        expect(element.querySelector('session-card')).not.toBeNull();
      });
    });

    it('desktop: the needs-you strip lists a task that needs you', async () => {
      taskStore.set([createTestTask({ id: 't1', state: 'needs_you' })]);
      element.sessions = [inRepo('loose')] as never;
      element.requestUpdate();
      await element.updateComplete;
      expect(element.querySelectorAll('[data-testid="needs-you-task-pill"]')).toHaveLength(1);
    });
  });

  describe('desktop home (2026-10-12)', () => {
    const repo = '/Users/me/Projects/untether';
    const running = (id: string, extra: Record<string, unknown> = {}) => ({
      ...createMockSession({ id, name: id, status: 'running' }),
      ...extra,
    });
    const cardIds = () =>
      [...element.querySelectorAll('session-card')].map((card) => (card as SessionCard).session.id);

    it('keeps a worktree with its main repo, names the group after it, and puts no-repo last', async () => {
      element.sessions = [
        running('plain'),
        running('main', { gitRepoPath: repo, gitMainRepoPath: repo, gitBranch: 'main' }),
        running('wt', {
          gitRepoPath: `${repo}-design`,
          gitMainRepoPath: `/private${repo}/`,
          gitIsWorktree: true,
          gitBranch: 'design',
        }),
      ];
      await element.updateComplete;
      const groups = [...element.querySelectorAll('[data-testid="repo-group"]')];
      expect(groups).toHaveLength(2);
      const header = groups[0].querySelector('repository-header') as HTMLElement & {
        label: string;
        count: number;
      };
      expect(header.label).toBe('untether');
      expect(header.count).toBe(2);
      expect(groups[1].textContent).toContain('No repository');
      expect(cardIds().slice(-1)).toEqual(['plain']);
    });

    it('keeps the repo group order while two repos are active within two minutes', async () => {
      const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
      const inRepo = (id: string, path: string, lastModified: string) =>
        running(id, { gitRepoPath: path, gitMainRepoPath: path, lastModified });
      const labels = () =>
        [...element.querySelectorAll('[data-testid="repo-group"] repository-header')].map(
          (header) => (header as HTMLElement & { label: string }).label
        );
      element.sessions = [
        inRepo('a', '/r/alpha', ago(10_000)),
        inRepo('b', '/r/beta', ago(70_000)),
        running('plain'),
      ];
      await element.updateComplete;
      expect(labels()).toEqual(['alpha', 'beta']);
      // beta becomes slightly more recent: no swap.
      element.sessions = [
        inRepo('a', '/r/alpha', ago(30_000)),
        inRepo('b', '/r/beta', ago(1_000)),
        running('plain'),
      ];
      await element.updateComplete;
      expect(labels()).toEqual(['alpha', 'beta']);
      // beta leads by more than two minutes: it moves up.
      element.sessions = [
        inRepo('a', '/r/alpha', ago(300_000)),
        inRepo('b', '/r/beta', ago(1_000)),
        running('plain'),
      ];
      await element.updateComplete;
      expect(labels()).toEqual(['beta', 'alpha']);
      // "No repository" takes its own last row.
      const blocks = [...element.querySelectorAll<HTMLElement>('[data-testid="repo-group"]')];
      expect(blocks.at(-1)?.style.gridColumn).toBe('1 / -1');
    });

    it('has no sticky footer on desktop; counts live in the filters', async () => {
      element.sessions = [
        running('a', { command: ['claude'] }),
        running('b', { command: ['zsh'] }),
        createMockSession({ id: 'x', status: 'exited' }),
      ];
      await element.updateComplete;
      expect(element.querySelector('[data-testid="session-list-footer"]')).toBeNull();
      expect(element.querySelector('[data-testid="filter-count-all"]')?.textContent).toBe('2');
      expect(element.querySelector('[data-testid="filter-count-agents"]')?.textContent).toBe('1');
      expect(element.querySelector('[data-testid="filter-count-terminals"]')?.textContent).toBe(
        '1'
      );
      expect(element.querySelector('[data-testid="exited-section-toggle"]')?.textContent).toContain(
        'Finished (1)'
      );
    });

    it('filters by kind and remembers the choice', async () => {
      element.sessions = [
        running('a', { command: ['claude'] }),
        running('b', { command: ['zsh'] }),
      ];
      await element.updateComplete;
      element.querySelector<HTMLButtonElement>('[data-testid="filter-terminals"]')?.click();
      await element.updateComplete;
      expect(cardIds()).toEqual(['b']);
      expect(localStorage.setItem).toHaveBeenCalledWith('ut-list-filter', 'terminals');
    });

    it('searches by branch, and says so when nothing matches', async () => {
      element.sessions = [
        running('a', { gitRepoPath: repo, gitBranch: 'feat/toolbar' }),
        running('b', { gitRepoPath: repo, gitBranch: 'main' }),
      ];
      await element.updateComplete;
      const input = element.querySelector('#session-search-input') as HTMLInputElement;
      input.value = 'toolbar';
      input.dispatchEvent(new Event('input'));
      await element.updateComplete;
      expect(cardIds()).toEqual(['a']);
      input.value = 'zzz';
      input.dispatchEvent(new Event('input'));
      await element.updateComplete;
      expect(element.querySelector('[data-testid="list-no-match"]')).toBeTruthy();
    });

    it('lists the sessions that need you above the sections, first in their group', async () => {
      element.sessions = [
        running('idle'),
        running('waiting', { claudeStatus: { status: 'waiting' } }),
      ];
      await element.updateComplete;
      const strip = element.querySelector('[data-testid="needs-you-strip"]');
      expect(strip?.querySelectorAll('[data-testid="needs-you-pill"]')).toHaveLength(1);
      expect(cardIds()[0]).toBe('waiting');
    });

    it('moves focus between cards with the arrows and opens one with Enter', async () => {
      element.sessions = [running('a'), running('b'), running('c')];
      await element.updateComplete;
      const navigate = vi.fn();
      element.addEventListener('navigate-to-session', (e) =>
        navigate((e as CustomEvent).detail.sessionId)
      );
      const roots = () => [
        ...element.querySelectorAll<HTMLElement>('session-card [data-testid="session-card"]'),
      ];
      // One Tab stop (roving tabindex)
      expect(roots().filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);
      roots()[0].focus();
      roots()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(document.activeElement).toBe(roots()[1]);
      roots()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(navigate).toHaveBeenCalledWith(roots()[1].dataset.sessionId);
    });

    it('closes all from the ⋯ menu through the app (which asks first)', async () => {
      element.sessions = [running('a')];
      await element.updateComplete;
      const killAll = vi.fn();
      element.addEventListener('kill-all-sessions', killAll);
      element.querySelector<HTMLButtonElement>('[data-testid="list-more-button"]')?.click();
      await element.updateComplete;
      document.body.querySelector<HTMLButtonElement>('[data-testid="kill-all-button"]')?.click();
      expect(killAll).toHaveBeenCalled();
      expect(document.body.querySelector('[data-testid="list-more-menu"]')).toBeNull();
    });

    it('the split-view sidebar shows 44px rows with their ⌘ numbers, and no footer', async () => {
      element.compactMode = true;
      element.sessions = [running('a'), running('b')];
      await element.updateComplete;
      const rows = element.querySelectorAll('compact-session-card');
      expect(rows).toHaveLength(2);
      expect((rows[1] as HTMLElement & { sessionNumber: number }).sessionNumber).toBe(2);
      expect(element.querySelector('[data-testid="session-list-footer"]')).toBeNull();
      expect(element.querySelector('.ut-side-list')?.classList.contains('ut-scroll-stable')).toBe(
        true
      );
    });
  });
});
