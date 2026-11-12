// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Session, SessionMultiplexer } from '@/shared/types';
import {
  resetViewport,
  setupFetchMock,
  setViewport,
  waitForAsync,
  waitForCondition,
} from '@/test/utils/component-helpers';
import { createMockSession } from '@/test/utils/lit-test-utils';
import { resetFactoryCounters } from '@/test/utils/test-factories';

const terminalSocketClientMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => true),
  onConnectionStateChange: vi.fn(() => () => {}),
  sendInputText: vi.fn().mockReturnValue(true),
  sendInputKey: vi.fn().mockReturnValue(true),
  sendResize: vi.fn().mockReturnValue(true),
  sendResetSize: vi.fn().mockReturnValue(true),
  setViewingSession: vi.fn(),
  clearViewingSession: vi.fn(),
}));

vi.mock('../services/terminal-socket-client.js', () => ({
  terminalSocketClient: terminalSocketClientMock,
}));

// Import component type
import type { ClaudeChatView } from './claude-chat-view.js';
import type { SessionView } from './session-view';
import type { UIState } from './session-view/ui-state-manager.js';
import type { Terminal } from './terminal';
import type { TerminalChatView } from './terminal-chat-view.js';

// SessionView's private managers and handlers that these tests read or drive directly
interface SessionViewInternals {
  loadingAnimationManager: {
    isLoading: () => boolean;
    startLoading: () => void;
    stopLoading: () => void;
  };
  uiStateManager: {
    getState: () => UIState;
    setIsMobile: (value: boolean) => void;
    setShowQuickKeys: (value: boolean) => void;
    setKeyboardHeight: (value: number) => void;
    setTerminalCols: (value: number) => void;
    setTerminalRows: (value: number) => void;
    setShowWidthSelector: (value: boolean) => void;
    setTerminalMaxCols: (value: number) => void;
    setShowFileBrowser: (value: boolean) => void;
  };
  connectionManager?: {
    getIsConnected: () => boolean;
    connectToStream: () => void;
    cleanupStreamConnection: () => void;
    setTerminal: (terminal: Terminal | null) => void;
    setSession: (session: unknown) => void;
    setConnected: (connected: boolean) => void;
  };
  terminalLifecycleManager?: {
    getTerminal: () => Terminal | null;
  };
  terminalSettingsManager: {
    getCurrentWidthLabel: () => string;
    getWidthTooltip: () => string;
    handleWidthSelect: (width: number) => void;
  };
  inputManager: {
    cleanup: () => void;
  };
  getTerminalElement: () => Terminal | null;
  ensureTerminalInitialized: () => void;
  handleTerminalClick: (event: Event) => void;
  updateTerminalTransform: () => void;
  _updateTerminalTransformTimeout: ReturnType<typeof setTimeout> | null;
}

const internals = (view: SessionView) => view as unknown as SessionViewInternals;

describe('SessionView', () => {
  let element: SessionView;
  let fetchMock: ReturnType<typeof setupFetchMock>;

  beforeAll(async () => {
    // Import components to register custom elements
    await import('./session-view');
    await import('./terminal');
    await import('./session-view/terminal-renderer');
  });

  beforeEach(async () => {
    // Reset factory counters for test isolation
    resetFactoryCounters();

    // Reset viewport
    resetViewport();

    // Clear localStorage to prevent test pollution
    localStorage.clear();
    terminalSocketClientMock.sendInputText.mockClear();
    terminalSocketClientMock.sendInputKey.mockClear();
    terminalSocketClientMock.subscribe.mockClear();

    // Reset matchMedia mock for consistent behavior
    if (vi.isMockFunction(window.matchMedia)) {
      vi.mocked(window.matchMedia).mockReset();
      vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }

    // Setup fetch mock
    fetchMock = setupFetchMock();

    // Create component
    element = await fixture<SessionView>(html` <session-view></session-view> `);

    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    fetchMock.clear();
    // Clear all spy/mock calls but don't restore globals
    vi.clearAllMocks();
  });

  describe('session prop from the polled list', () => {
    it('keeps the git counts from the stream when the same session comes back without them', async () => {
      const withCounts = {
        ...createMockSession({ id: 'git-1' }),
        gitModifiedCount: 99,
        gitUntrackedCount: 12,
        gitInsertionCount: 15008,
        gitDeletionCount: 6011,
      } as Session;
      element.session = withCounts;
      await element.updateComplete;

      const polled = { ...withCounts } as Session;
      delete polled.gitModifiedCount;
      delete polled.gitUntrackedCount;
      delete polled.gitInsertionCount;
      delete polled.gitDeletionCount;
      element.session = polled;
      await element.updateComplete;

      expect(element.session?.gitModifiedCount).toBe(99);
      expect(element.session?.gitUntrackedCount).toBe(12);
      expect(element.session?.gitInsertionCount).toBe(15008);
      expect(element.session?.gitDeletionCount).toBe(6011);

      element.session = { ...createMockSession({ id: 'git-2' }) } as Session;
      await element.updateComplete;
      expect(element.session?.gitModifiedCount).toBeUndefined();
    });

    it('does not strip box-shadows (menus, focus rings) outside the terminal surface', async () => {
      element.session = createMockSession({ id: 'shadow-1' });
      await element.updateComplete;
      const css = Array.from(element.querySelectorAll('style'))
        .map((style) => style.textContent ?? '')
        .join('\n');
      expect(css).not.toMatch(/session-view \*\s*,/);
      expect(css).toContain('session-view terminal-renderer *');
    });
  });

  describe('initialization', () => {
    it('should create component with default state', () => {
      expect(element).toBeDefined();
      expect(element.session).toBeNull();

      const testElement = internals(element);
      // Check UI state through the manager
      const uiState = testElement.uiStateManager.getState();
      // Connected is set to true in connectedCallback
      expect(uiState.connected).toBe(true);

      // Loading animation should be active when no session
      expect(testElement.loadingAnimationManager.isLoading()).toBe(true);
    });

    it('should detect mobile environment', async () => {
      // Mock touch capabilities
      const originalMaxTouchPoints = navigator.maxTouchPoints;
      const originalMatchMedia = window.matchMedia;

      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 2,
        configurable: true,
      });

      // Mock matchMedia to simulate touch device
      window.matchMedia = (query: string) => {
        if (query === '(any-pointer: coarse)' || query === '(pointer: coarse)') {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          } as MediaQueryList;
        }
        if (query === '(any-pointer: fine)') {
          return {
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          } as MediaQueryList;
        }
        if (query === '(any-hover: hover)') {
          return {
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          } as MediaQueryList;
        }
        return originalMatchMedia(query);
      };

      let mobileElement: SessionView | undefined;
      try {
        // The default fixture can own focus. Remove it so terminal-ready starts from
        // the same neutral document focus as a newly opened mobile session.
        element.remove();
        mobileElement = await fixture<SessionView>(html` <session-view></session-view> `);
        await mobileElement.updateComplete;

        // Component detects mobile based on touch capabilities
        const mobileTestElement = internals(mobileElement);
        const uiState = mobileTestElement.uiStateManager.getState();
        expect(uiState.isMobile).toBe(true);
        expect(document.activeElement).not.toBe(mobileElement);

        const mockSession = createMockSession({
          id: 'mobile-hardware-keyboard-session',
          status: 'running',
        });
        mobileElement.session = mockSession;
        await mobileElement.updateComplete;
        const terminal = mobileElement.querySelector('ut-terminal');
        await vi.waitFor(() => expect(terminal?.getAttribute('data-ready')).toBe('true'));
        await vi.waitFor(() => expect(document.activeElement).toBe(mobileElement));

        const terminalContainer = terminal?.querySelector('#terminal-container') as HTMLElement;
        const pasteInput = terminal?.querySelector('.terminal-paste-input') as HTMLTextAreaElement;
        pasteInput.focus();
        terminalContainer.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true })
        );
        await vi.waitFor(() => expect(document.activeElement).toBe(pasteInput));

        pasteInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'x', bubbles: true, composed: true })
        );
        await vi.waitFor(() =>
          expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
            'mobile-hardware-keyboard-session',
            'x'
          )
        );
      } finally {
        mobileElement?.remove();
        Object.defineProperty(navigator, 'maxTouchPoints', {
          value: originalMaxTouchPoints,
          configurable: true,
        });
        window.matchMedia = originalMatchMedia;
      }
    });

    it('cancels deferred terminal initialization when disconnected', async () => {
      vi.useFakeTimers();
      const testElement = internals(element);
      const getTerminalElementSpy = vi
        .spyOn(testElement, 'getTerminalElement')
        .mockReturnValue(null);
      const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame');

      try {
        element.session = createMockSession({ status: 'running' });
        testElement.ensureTerminalInitialized();
        const frameCallsBeforeDisconnect = requestAnimationFrameSpy.mock.calls.length;

        element.remove();
        await vi.advanceTimersByTimeAsync(100);

        expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(frameCallsBeforeDisconnect);
      } finally {
        getTerminalElementSpy.mockRestore();
        requestAnimationFrameSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('leaves terminal touchend available to mobile swipe navigation', () => {
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(true);
      const touchEnd = new Event('touchend', { bubbles: true, cancelable: true });
      const stopPropagation = vi.spyOn(touchEnd, 'stopPropagation');
      const preventDefault = vi.spyOn(touchEnd, 'preventDefault');

      testElement.handleTerminalClick(touchEnd);

      expect(stopPropagation).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(touchEnd.defaultPrevented).toBe(false);
    });

    it('leaves mobile terminal links to native navigation', () => {
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(true);
      const anchor = document.createElement('a');
      anchor.href = 'https://example.com';
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      vi.spyOn(click, 'composedPath').mockReturnValue([anchor]);
      const stopPropagation = vi.spyOn(click, 'stopPropagation');
      const preventDefault = vi.spyOn(click, 'preventDefault');

      testElement.handleTerminalClick(click);

      expect(stopPropagation).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(click.defaultPrevented).toBe(false);
    });

    it('still consumes ordinary mobile terminal clicks', () => {
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(true);
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });

      testElement.handleTerminalClick(click);

      expect(click.defaultPrevented).toBe(true);
    });
  });

  describe('session loading', () => {
    it('should load session when session property is set', async () => {
      const mockSession = createMockSession({
        id: 'test-session-123',
        name: 'Test Session',
        status: 'running',
      });

      // Mock fetch responses
      fetchMock.mockResponse('/api/sessions/test-session-123', mockSession);
      element.session = mockSession;
      await element.updateComplete;

      // Should render terminal
      const terminal = element.querySelector('ut-terminal') as Terminal;
      expect(terminal).toBeTruthy();
      expect(terminal?.sessionId).toBe('test-session-123');
    });

    it('replaces the terminal when switching sessions', async () => {
      element.session = createMockSession({ id: 'first-session' });
      await element.updateComplete;
      const firstTerminal = element.querySelector('ut-terminal');
      const terminalLifecycleManager = internals(element).terminalLifecycleManager;
      await waitForCondition(() => terminalLifecycleManager?.getTerminal() === firstTerminal, {
        message: 'first terminal was not initialized',
      });

      element.session = createMockSession({ id: 'second-session' });
      await element.updateComplete;
      const secondTerminal = element.querySelector('ut-terminal') as Terminal;
      await waitForCondition(() => terminalLifecycleManager?.getTerminal() === secondTerminal, {
        message: 'replacement terminal was not initialized',
      });

      expect(secondTerminal).toBeTruthy();
      expect(secondTerminal).not.toBe(firstTerminal);
      expect(secondTerminal.sessionId).toBe('second-session');
    });

    it('reports the session on screen so its pushes are held back', async () => {
      terminalSocketClientMock.setViewingSession.mockClear();
      terminalSocketClientMock.clearViewingSession.mockClear();
      element.session = createMockSession({ id: 'first-session' });
      await element.updateComplete;
      expect(terminalSocketClientMock.setViewingSession).toHaveBeenLastCalledWith('first-session');

      element.session = createMockSession({ id: 'second-session' });
      await element.updateComplete;
      expect(terminalSocketClientMock.clearViewingSession).toHaveBeenCalledWith('first-session');
      expect(terminalSocketClientMock.setViewingSession).toHaveBeenLastCalledWith('second-session');

      element.remove();
      expect(terminalSocketClientMock.clearViewingSession).toHaveBeenLastCalledWith(
        'second-session'
      );
    });

    it('should show loading state while connecting', async () => {
      const mockSession = createMockSession();

      // Start loading before session
      internals(element).loadingAnimationManager.startLoading();
      await element.updateComplete;

      // Verify loading is active
      expect(internals(element).loadingAnimationManager.isLoading()).toBe(true);

      // Then set session
      element.session = mockSession;
      await element.updateComplete;

      // Loading should be false after session is set and firstUpdated is called
      expect(internals(element).loadingAnimationManager.isLoading()).toBe(false);
    });

    it('should handle session not found error', async () => {
      const errorHandler = vi.fn();
      element.addEventListener('error', errorHandler);

      const mockSession = createMockSession({ id: 'not-found' });

      // Mock 404 responses for various endpoints the component might call
      fetchMock.mockResponse(
        '/api/sessions/not-found',
        { error: 'Session not found' },
        { status: 404 }
      );
      fetchMock.mockResponse(
        '/api/sessions/not-found/size',
        { error: 'Session not found' },
        { status: 404 }
      );
      fetchMock.mockResponse(
        '/api/sessions/not-found/input',
        { error: 'Session not found' },
        { status: 404 }
      );

      element.session = mockSession;
      await element.updateComplete;

      // Wait for async operations and potential error events
      await waitForAsync(100);

      // A 404 on the side endpoints is logged, never surfaced as an 'error' event.
      expect(errorHandler).not.toHaveBeenCalled();
      expect(element.session).toBeTruthy();
    });
  });

  describe('session header layout', () => {
    it('should constrain header content for long path and branch names', async () => {
      const mockSession = {
        ...createMockSession({ id: 'header-session-1' }),
        gitRepoPath: '/tmp/repo',
        gitBranch: 'feature/super-long-branch-name',
      } as Session;

      fetchMock.mockResponse('/api/sessions/header-session-1', mockSession);
      element.session = mockSession;
      await element.updateComplete;
      await waitForAsync();

      const header = element.querySelector('session-header');
      expect(header).toBeTruthy();

      // Desktop toolbar (session.css .ut-session-header*): the bar is capped at 100vw and the
      // path and branch chip shrink (min-width: 0) instead of pushing the buttons out.
      const headerContainer = header?.querySelector('.session-header-container');
      expect(headerContainer?.classList.contains('ut-session-header')).toBe(true);

      const path = header?.querySelector('clickable-path');
      expect(path?.classList.contains('ut-session-header-path')).toBe(true);
      expect(path?.getAttribute('variant')).toBe('middle');

      const badge = header?.querySelector('git-status-badge');
      expect(badge).toBeTruthy();
      expect(badge?.classList.contains('min-w-0')).toBe(true);
      expect(badge?.classList.contains('flex-shrink')).toBe(true);
      expect(badge?.querySelector('[data-testid="git-branch-chip"]')?.textContent?.trim()).toBe(
        'feature/super-long-branch-name'
      );
    });
  });

  describe('layers under the session header', () => {
    // The grid child that holds `el`: its z-index is what competes with the header's.
    const gridLayer = (el: Element) => {
      let node: Element | null = el;
      while (node?.parentElement && !node.parentElement.classList.contains('session-view-grid')) {
        node = node.parentElement;
      }
      return node?.parentElement ? (node as HTMLElement) : null;
    };
    const cssZIndices = (selector: string) => {
      const css = [...element.querySelectorAll('style')].map((s) => s.textContent).join('\n');
      const rule = new RegExp(
        `${selector.replace('.', '\\.')}\\s*\\{[^}]*?z-index:\\s*(\\d+)`,
        'g'
      );
      return [...css.matchAll(rule)].map((m) => Number(m[1]));
    };

    it('draws "Session ended" under the header, whose ⋮ menu covered it', async () => {
      // 2026-10-03, iPhone: the badge was in the overlay container (z 60, above the header's
      // 50) and covered the menu's "Chat mode"; no z-index inside the header could win.
      const exited = createMockSession({ id: 'exited-1', status: 'exited' });
      fetchMock.mockResponse('/api/sessions/exited-1', exited);
      element.session = exited;
      await element.updateComplete;

      const badge = [...element.querySelectorAll('span')].find((span) =>
        span.textContent?.includes('Session exited')
      );
      expect(badge).toBeTruthy();
      expect(badge?.closest('.overlay-container')).toBeNull();

      const layer = gridLayer(badge as Element);
      const headerZ = cssZIndices('.session-header-area');
      expect(layer?.style.position).toBe('absolute');
      expect(layer?.style.zIndex).not.toBe('');
      expect(headerZ.length).toBeGreaterThan(0);
      for (const z of headerZ) expect(Number(layer?.style.zIndex)).toBeLessThan(z);
    });

    it('resumes the Claude conversation from the badge', async () => {
      const exited: Session = {
        ...createMockSession({ id: 'exited-2', status: 'exited' }),
        claudeSessionId: 'c1',
        // The badge offers it only when the server says it can be resumed.
        claudeResumable: true,
      };
      fetchMock.mockResponse('/api/sessions/exited-2', exited);
      element.session = exited;
      await element.updateComplete;
      const resume = vi
        .spyOn(
          element as unknown as { handleResumeClaude: () => Promise<void> },
          'handleResumeClaude'
        )
        .mockResolvedValue();

      const button = [...element.querySelectorAll('session-exited-badge button')].find((b) =>
        b.textContent?.includes('Resume Claude conversation')
      ) as HTMLButtonElement | undefined;
      // Past the badge's first second, when taps still belong to whatever ended the session.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1500);
      button?.click();

      expect(resume).toHaveBeenCalledOnce();
    });

    it('draws the "Reconnecting…" pill under the header too', async () => {
      // The app's pill (z 1500 over the whole view) covered the ⋮ menu's "New session".
      const running = createMockSession({ id: 'running-1' });
      fetchMock.mockResponse('/api/sessions/running-1', running);
      element.session = running;
      element.reconnecting = true;
      await element.updateComplete;

      const pill = element.querySelector('.reconnecting-pill');
      expect(pill).toBeTruthy();
      const layer = gridLayer(pill as Element);
      expect(layer?.style.zIndex).not.toBe('');
      for (const z of cssZIndices('.session-header-area')) {
        expect(Number(layer?.style.zIndex)).toBeLessThan(z);
      }

      element.reconnecting = false;
      await element.updateComplete;
      expect(element.querySelector('.reconnecting-pill')).toBeNull();
    });
  });

  describe('quick actions strip', () => {
    it('types a tapped action into the session, then presses Enter', async () => {
      vi.mocked(localStorage.getItem).mockImplementation((key) =>
        key === 'untether_quick_actions_shown' ? '1' : null
      );
      const session = createMockSession({
        id: 'quick-actions-session',
        status: 'running',
        claudeStatus: { status: 'idle' },
      });
      fetchMock.mockResponse(`/api/sessions/${session.id}/quick-actions`, {
        source: 'file',
        path: '/repo/.untether/quick-actions.json',
        actions: [{ id: 'status', emoji: '📊', label: 'Estado', prompt: '¿Cómo vamos?' }],
        warnings: [],
      });
      internals(element).uiStateManager.setIsMobile(true);
      element.session = session;
      await element.updateComplete;

      const button = await vi.waitFor(() => {
        const found = element.querySelector<HTMLButtonElement>(
          '[data-testid="quick-action-status"]'
        );
        expect(found).not.toBeNull();
        return found as HTMLButtonElement;
      });
      terminalSocketClientMock.sendInputText.mockClear();
      terminalSocketClientMock.sendInputKey.mockClear();
      button.click();

      await vi.waitFor(() =>
        expect(terminalSocketClientMock.sendInputKey).toHaveBeenCalledWith(session.id, 'enter')
      );
      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        session.id,
        '¿Cómo vamos?'
      );
      expect(terminalSocketClientMock.sendInputText.mock.invocationCallOrder[0]).toBeLessThan(
        terminalSocketClientMock.sendInputKey.mock.invocationCallOrder[0]
      );
    });
  });

  describe('terminal interaction', () => {
    beforeEach(async () => {
      const mockSession = createMockSession();
      element.session = mockSession;
      await element.updateComplete;
    });

    it('should send keyboard input to terminal', async () => {
      // Use the input manager directly instead of simulating keyboard events
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property for testing
      const inputManager = (element as any).inputManager;
      await inputManager.sendInputText('a');

      // Wait for async operation
      await waitForAsync();

      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        (element.session as { id: string }).id,
        'a'
      );
    });

    it('should handle special keys', async () => {
      // Use the input manager directly instead of simulating keyboard events
      // biome-ignore lint/suspicious/noExplicitAny: need to access private property for testing
      const inputManager = (element as any).inputManager;

      // Test Enter key
      await inputManager.sendInput('enter');
      await waitForAsync();
      expect(terminalSocketClientMock.sendInputKey).toHaveBeenCalledWith(
        (element.session as { id: string }).id,
        'enter'
      );

      // Clear mock calls
      terminalSocketClientMock.sendInputKey.mockClear();

      // Test Escape key
      await inputManager.sendInput('escape');
      await waitForAsync();
      expect(terminalSocketClientMock.sendInputKey).toHaveBeenCalledWith(
        (element.session as { id: string }).id,
        'escape'
      );
    });

    it('sends text pasted into the terminal to the session', async () => {
      const terminal = element.querySelector('ut-terminal');
      expect(terminal).toBeTruthy();
      // What the terminal setup does when the view opens.
      internals(element).terminalLifecycleManager.setTerminal(terminal as unknown as Terminal);
      terminalSocketClientMock.sendInputText.mockClear();

      terminal?.dispatchEvent(
        new CustomEvent('terminal-paste', { detail: { text: 'pasted text' }, bubbles: true })
      );
      await waitForAsync();

      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        (element.session as { id: string }).id,
        'pasted text'
      );
    });

    it('should handle terminal resize', async () => {
      const terminal = element.querySelector('ut-terminal');
      expect(terminal).toBeTruthy();
      internals(element).terminalLifecycleManager.setTerminal(terminal as unknown as Terminal);

      terminal?.dispatchEvent(
        new CustomEvent('terminal-resize', {
          detail: {
            cols: 100,
            rows: 30,
            isMobile: false,
            isHeightOnlyChange: false,
            source: 'test',
          },
          bubbles: true,
        })
      );
      await waitForAsync();

      const uiState = internals(element).uiStateManager.getState();
      expect(uiState.terminalCols).toBe(100);
      expect(uiState.terminalRows).toBe(30);
    });
  });

  describe('stream connection', () => {
    it('should establish v3 subscription for running session', async () => {
      const mockSession = createMockSession({ status: 'running' });

      element.session = mockSession;
      await element.updateComplete;

      const testElement = internals(element);
      expect(testElement.connectionManager).toBeTruthy();

      const terminal = element.querySelector('ut-terminal');
      expect(terminal).toBeTruthy();

      testElement.connectionManager?.setTerminal(terminal as unknown as Terminal);
      testElement.connectionManager?.setSession(mockSession);
      testElement.connectionManager?.setConnected(true);
      testElement.connectionManager?.connectToStream();

      expect(terminalSocketClientMock.subscribe).toHaveBeenCalledWith(
        mockSession.id,
        expect.objectContaining({ stdout: true })
      );
    });

    it('a git update keeps the latest session state (killed and renamed elsewhere)', async () => {
      const running = createMockSession({ status: 'running', name: 'old name' });
      element.session = running;
      await element.updateComplete;
      const testElement = internals(element);
      const terminal = element.querySelector('ut-terminal');
      expect(terminal).toBeTruthy();
      // What the terminal setup does when the view opens.
      testElement.connectionManager?.setTerminal(terminal as unknown as Terminal);
      testElement.connectionManager?.setSession(running);
      testElement.connectionManager?.setConnected(true);
      testElement.connectionManager?.connectToStream();
      const calls = terminalSocketClientMock.subscribe.mock.calls as unknown as Array<
        [string, { onEvent: (event: unknown) => void }]
      >;
      const { onEvent } = calls[calls.length - 1][1];

      // The list poll brings the session killed and renamed from another device.
      element.session = { ...running, status: 'exited', name: 'new name' };
      await element.updateComplete;

      onEvent({ type: 'git-status-update', sessionId: running.id, gitModifiedCount: 4 });
      await element.updateComplete;

      expect(element.session?.status).toBe('exited');
      expect(element.session?.name).toBe('new name');
      expect(element.session?.gitModifiedCount).toBe(4);
    });

    it('should handle session exit event', async () => {
      const mockSession = createMockSession({ status: 'running' });
      const navigateHandler = vi.fn();
      element.addEventListener('navigate-to-list', navigateHandler);

      element.session = mockSession;
      await element.updateComplete;

      // Wait for initial setup
      await waitForAsync();

      // Session status update happens via terminal event
      const terminal = element.querySelector('ut-terminal');
      if (terminal) {
        terminal.dispatchEvent(
          new CustomEvent('session-exit', {
            detail: {
              sessionId: mockSession.id,
              status: 'exited',
              exitCode: 0,
            },
            bubbles: true,
          })
        );
        await element.updateComplete;
      }

      expect(element.session?.status).toBe('exited');
    });
  });

  describe('mobile interface', () => {
    beforeEach(async () => {
      // Set mobile viewport
      setViewport(375, 667);

      const mockSession = createMockSession();
      element.session = mockSession;
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(true);
      await element.updateComplete;
    });

    // 2026-10-12: in phone landscape the column scrolled 34 px (the Keyboard button's proxy
    // field overflowed it), drawing the header over the terminal; on a touch iPad the fixed
    // column covered the expanded sidebar; and its chrome inherited a mono font.
    it('keeps the phone column unscrolled, beside the sidebar, in the UI font', async () => {
      const grid = element.querySelector<HTMLElement>('.session-view-grid') as HTMLElement;
      grid.scrollTop = 34;
      grid.dispatchEvent(new Event('scroll'));
      expect(grid.scrollTop).toBe(0);
      expect(grid.scrollHeight).toBeLessThanOrEqual(grid.clientHeight);
      // The view's own styles (its first <style>; children bring theirs).
      const css = element.querySelector('style')?.textContent ?? '';
      expect(css).toMatch(
        /\.session-view-grid\[data-mobile="true"\] \{[^}]*overflow: hidden !important/
      );
      expect(css).toMatch(/left: var\(--sidebar-w, 0px\) !important/);
      expect(css).not.toContain('ui-monospace');
      expect(css).toContain('font-family: var(--font-ui)');
    });

    it('should render mobile action bar', async () => {
      await element.updateComplete;

      const mobileActionBar = element.querySelector('mobile-action-bar') as
        | (HTMLElement & { visible: boolean })
        | null;
      const grid = element.querySelector<HTMLElement>('.session-view-grid');
      expect(mobileActionBar).toBeTruthy();
      expect(mobileActionBar?.visible).toBe(true);
      expect(grid?.dataset.mobile).toBe('true');
    });

    it("sends the clipboard sheet's chosen text to the session (2026-11-10: it sent nothing)", async () => {
      const bar = element.querySelector('mobile-action-bar') as
        | (HTMLElement & { callbacks: { onPaste?: (text: string) => void } | null })
        | null;
      expect(bar?.callbacks?.onPaste).toBeTypeOf('function');
      terminalSocketClientMock.sendInputText.mockClear();

      bar?.callbacks?.onPaste?.('chosen text');
      await waitForAsync();

      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        (element.session as { id: string }).id,
        'chosen text'
      );
    });

    describe('phone chat composer', () => {
      const enterChatMode = async () => {
        (
          element as unknown as { uiStateManager: { setChatMode(on: boolean): void } }
        ).uiStateManager.setChatMode(true);
        element.requestUpdate();
        await element.updateComplete;
      };

      it("reads no menu off the phone's copy once the stream says the PTY got wider", async () => {
        // QA 2026-10-04 (trunk 093ccb3e): another client resized the PTY to 53x56 under the
        // phone's 45 columns; until a touch took it back, the chat kept the cut labels as
        // buttons ("/Users/apublicdemouser/… fproject") instead of the "wider screen" hint.
        const sessionId = element.session?.id ?? '';
        fetchMock.mockResponse(`/api/sessions/${sessionId}/claude-chat`, {
          available: true,
          status: 'waiting',
          waitingFor: 'permission prompt',
          messages: [],
        });
        const screen = [
          ' Do you want to proceed?',
          ' ❯ 1. Yes',
          '   2. Yes, and always allow access to /Users/',
          '      apublicdemouser/.untether-qa/qa-git f',
          '      project',
          '   3. No',
          '',
          ' Esc to cancel · Tab to amend',
        ].join('\n');
        const terminal = element.querySelector('ut-terminal') as Terminal | null;
        if (!terminal) throw new Error('no terminal');
        // The phone's terminal as it is: 45 columns, and the rows it holds.
        terminal.getScreenText = () => screen;
        terminal.getScreenWrapped = () => screen.split('\n').map(() => false);
        terminal.getTerminalSize = () => ({ cols: 45, rows: 32 });
        // What the view does when its terminal opens: the stream it reads the PTY's size from.
        const testElement = internals(element);
        const lifecycle = testElement.terminalLifecycleManager as unknown as {
          setTerminal(terminal: Terminal): void;
        };
        lifecycle.setTerminal(terminal);
        testElement.connectionManager?.setTerminal(terminal);
        testElement.connectionManager?.setSession(element.session);
        testElement.connectionManager?.setConnected(true);
        testElement.connectionManager?.connectToStream();
        const calls = terminalSocketClientMock.subscribe.mock.calls as unknown as Array<
          [string, { onEvent: (event: unknown) => void }]
        >;
        const { onEvent } = calls[calls.length - 1][1];
        onEvent({ kind: 'header', header: { width: 45, height: 32 } });

        await enterChatMode();
        const chat = element.querySelector('claude-chat-view') as ClaudeChatView | null;
        if (!chat) throw new Error('chat mode not rendered');
        const card = () => chat.shadowRoot?.querySelector('.question');
        const waiting = () => chat.shadowRoot?.querySelector('.waiting')?.textContent ?? '';
        const repoll = async () => {
          await (chat as unknown as { poll(): Promise<void> }).poll();
          await chat.updateComplete;
        };
        await repoll();
        expect(card()?.textContent).toContain('apublicdemouser');

        // Another client resizes the PTY; Claude redraws for 53 columns (the same cut rows here).
        // No poll in between: the next one may be seconds away, the card must go at once.
        onEvent({ kind: 'resize', dimensions: '53x56' });
        await element.updateComplete;
        await chat.updateComplete;
        expect(card()).toBeNull();
        expect(waiting()).toContain('wider screen');

        // Taken back to the phone's width: the menu is read again, at once too.
        terminal.getScreenText = () =>
          [
            ' Do you want to proceed?',
            ' ❯ 1. Yes',
            '   2. Yes, and always allow access to',
            '      /Users/alexandrapublicdemouser/.untethe',
            '      r-qa/qa-git from this project',
            '   3. No',
            '',
            ' Esc to cancel · Tab to amend',
          ].join('\n');
        onEvent({ kind: 'resize', dimensions: '45x32' });
        await element.updateComplete;
        await chat.updateComplete;
        expect(card()?.textContent).toContain('alexandrapublicdemouser');
      });

      it('clears the home indicator only while the soft keyboard is down', async () => {
        await enterChatMode();
        const grid = element.querySelector<HTMLElement>('.session-view-grid');
        expect(element.querySelector('terminal-chat-view[composeronly]')).toBeTruthy();
        expect(grid?.dataset.softKeyboard).toBe('false');

        internals(element).uiStateManager.setKeyboardHeight(336);
        element.requestUpdate();
        await element.updateComplete;
        expect(grid?.dataset.softKeyboard).toBe('true');

        // Keyboard up: no home-indicator padding on top of the keyboard (a gap under the field).
        const css = [...element.querySelectorAll('style')].map((el) => el.textContent).join('');
        expect(css).toMatch(
          /\[data-soft-keyboard="true"\] > terminal-chat-view \{\s*--composer-safe-bottom: 0px;/
        );
        expect(css).toMatch(/--composer-safe-bottom: env\(safe-area-inset-bottom/);
      });

      it('hides the "while you were away" card while the chat asks a question', async () => {
        // On an iPhone SE it covered the top of the question card: what an answer approves.
        await enterChatMode();
        const chat = element.querySelector('claude-chat-view');
        const away = () => element.querySelector<HTMLElement>('away-summary-card');
        expect(away()?.style.display).not.toBe('none');
        chat?.dispatchEvent(
          new CustomEvent('claude-chat-asking', { detail: true, bubbles: true, composed: true })
        );
        await element.updateComplete;
        expect(away()?.style.display).toBe('none');
        chat?.dispatchEvent(
          new CustomEvent('claude-chat-asking', { detail: false, bubbles: true, composed: true })
        );
        await element.updateComplete;
        expect(away()?.style.display).not.toBe('none');
      });

      it('shows the "while you were away" card again once out of chat mode', async () => {
        // The chat view asked, then the card's "Open terminal" left chat mode: the flag stayed
        // and the card stayed hidden in the terminal (review of 2026-10-03).
        await enterChatMode();
        element
          .querySelector('claude-chat-view')
          ?.dispatchEvent(
            new CustomEvent('claude-chat-asking', { detail: true, bubbles: true, composed: true })
          );
        await element.updateComplete;
        (
          element as unknown as { uiStateManager: { setChatMode(on: boolean): void } }
        ).uiStateManager.setChatMode(false);
        element.requestUpdate();
        await element.updateComplete;
        expect(element.querySelector<HTMLElement>('away-summary-card')?.style.display).not.toBe(
          'none'
        );
      });

      it('neither paints the terminal under the chat view nor lets it take the focus', async () => {
        // Nothing of the terminal may show around the composer (its cursor) or take its focus
        // (a hidden input of it) while Claude's chat view covers it (2026-10-03).
        await enterChatMode();
        const terminal = () => element.querySelector<HTMLElement>('terminal-renderer');
        const covered = (on: boolean) =>
          element
            .querySelector('claude-chat-view')
            ?.dispatchEvent(
              new CustomEvent('claude-chat-availability', { detail: on, bubbles: true })
            );

        // The direct keyboard's input sits on document.body, outside the terminal (2026-10-04:
        // iOS offered ↑ ↓ arrows to it from the composer).
        const directInput = () =>
          document.querySelector<HTMLTextAreaElement>('textarea[data-direct-keyboard-input]');

        covered(true);
        await element.updateComplete;
        expect(terminal()?.style.visibility).toBe('hidden');
        expect(terminal()?.hasAttribute('inert')).toBe(true);
        expect(directInput()?.inert).toBe(true);
        expect(directInput()?.disabled).toBe(true);

        // A session without Claude Code: the chat view steps aside, the terminal shows.
        covered(false);
        await element.updateComplete;
        expect(terminal()?.style.visibility).not.toBe('hidden');
        expect(terminal()?.hasAttribute('inert')).toBe(false);
        expect(directInput()?.inert).toBe(false);
        expect(directInput()?.disabled).toBe(false);

        // Back in terminal mode it is the terminal again.
        covered(true);
        await element.updateComplete;
        (
          element as unknown as { uiStateManager: { setChatMode(on: boolean): void } }
        ).uiStateManager.setChatMode(false);
        element.requestUpdate();
        await element.updateComplete;
        expect(terminal()?.style.visibility).not.toBe('hidden');
        expect(terminal()?.hasAttribute('inert')).toBe(false);
        expect(directInput()?.inert).toBe(false);
        expect(directInput()?.disabled).toBe(false);
      });

      it('paints the session column in the chat background only while the chat covers it', async () => {
        // User request, 2026-10-12: the header, its safe area, the strips beside the chat and the
        // composer kept the terminal's color around the chat. data-chat-surface switches
        // session.css's one-surface rules; terminal mode keeps the terminal-colored header.
        await enterChatMode();
        const grid = () => element.querySelector<HTMLElement>('.session-view-grid');
        const covered = (on: boolean) =>
          element
            .querySelector('claude-chat-view')
            ?.dispatchEvent(
              new CustomEvent('claude-chat-availability', { detail: on, bubbles: true })
            );

        covered(true);
        await element.updateComplete;
        expect(grid()?.dataset.chatSurface).toBe('true');
        // Out over the terminal's side inset, so the chat runs edge to edge.
        const inset = element.querySelector<HTMLElement>('claude-chat-view')?.getAttribute('style');
        expect(inset).toContain('calc(-1 * var(--ut-term-inset-left, 0px))');
        expect(inset).toContain('calc(-1 * var(--ut-term-inset-right, 0px))');

        // No agent chat: the terminal shows under the composer, in its own frame.
        covered(false);
        await element.updateComplete;
        expect(grid()?.dataset.chatSurface).toBe('false');

        // Terminal mode: the terminal's header again, at once.
        covered(true);
        await element.updateComplete;
        (
          element as unknown as { uiStateManager: { setChatMode(on: boolean): void } }
        ).uiStateManager.setChatMode(false);
        element.requestUpdate();
        await element.updateComplete;
        expect(grid()?.dataset.chatSurface).toBe('false');
      });

      it('shows the end of the conversation when the composer is focused', async () => {
        await enterChatMode();
        const chat = element.querySelector('claude-chat-view') as
          | (HTMLElement & { followLatest: () => void })
          | null;
        expect(chat).toBeTruthy();
        if (!chat) return;
        const followLatest = vi.spyOn(chat, 'followLatest');

        const field = element
          .querySelector('terminal-chat-view[composeronly]')
          ?.shadowRoot?.querySelector('textarea');
        field?.dispatchEvent(new FocusEvent('focus'));

        expect(followLatest).toHaveBeenCalledTimes(1);
      });

      it('shows a message sent from the composer in the chat at once; Retry goes back to it', async () => {
        const sessionId = element.session?.id ?? '';
        fetchMock.mockResponse(`/api/sessions/${sessionId}/claude-chat`, {
          available: true,
          status: 'idle',
          messages: [],
        });
        await enterChatMode();
        const chat = element.querySelector('claude-chat-view') as ClaudeChatView | null;
        const composer = element.querySelector(
          'terminal-chat-view[composeronly]'
        ) as TerminalChatView | null;
        if (!chat || !composer) throw new Error('chat mode not rendered');
        await composer.updateComplete;
        const field = composer.shadowRoot?.querySelector('textarea');
        if (!field) throw new Error('no composer field');

        field.value = 'hola';
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await chat.updateComplete;
        expect(
          chat.shadowRoot?.querySelector('.row.user[data-send="sending"]')?.textContent
        ).toContain('hola');

        const failed = vi.spyOn(chat, 'markSendFailed');
        const ref = { sessionId, id: 'p1' };
        composer.dispatchEvent(
          new CustomEvent('chat-message-failed', { detail: ref, bubbles: true, composed: true })
        );
        expect(failed).toHaveBeenCalledWith(ref);
        const resend = vi.spyOn(composer, 'resendMessage');
        chat.dispatchEvent(
          new CustomEvent('chat-message-retry', { detail: ref, bubbles: true, composed: true })
        );
        expect(resend).toHaveBeenCalledWith(ref);
      });
    });

    it('should hide the mobile action bar while quick keys are visible', async () => {
      const testElement = internals(element);
      testElement.uiStateManager.setShowQuickKeys(true);
      await element.updateComplete;

      const mobileActionBar = element.querySelector('mobile-action-bar') as
        | (HTMLElement & { visible: boolean })
        | null;
      expect(mobileActionBar?.visible).toBe(false);
    });

    it('opens the keyboard with quick keys when the terminal is tapped', async () => {
      const testElement = internals(element);
      expect(testElement.uiStateManager.getState().showQuickKeys).toBe(false);

      const renderer = element.querySelector('terminal-renderer');
      renderer?.dispatchEvent(new CustomEvent('terminal-tap', { bubbles: true, composed: true }));
      await element.updateComplete;

      expect(testElement.uiStateManager.getState().showQuickKeys).toBe(true);
      expect(element.querySelector('.mobile-keyboard-button')).toBeNull();
    });

    it('leaves a catcher tap to the catcher focus, which opens the keyboard', async () => {
      const testElement = internals(element);
      const renderer = element.querySelector('terminal-renderer');

      renderer?.dispatchEvent(
        new CustomEvent('terminal-tap', {
          bubbles: true,
          composed: true,
          detail: { keyboardCatcher: true },
        })
      );
      await element.updateComplete;
      expect(testElement.uiStateManager.getState().showQuickKeys).toBe(false);

      renderer?.dispatchEvent(
        new CustomEvent('terminal-keyboard-request', { bubbles: true, composed: true })
      );
      await element.updateComplete;
      expect(testElement.uiStateManager.getState().showQuickKeys).toBe(true);
    });

    it('pins the phone layout to the visual viewport with the quick keys in flow', async () => {
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(true);
      await element.updateComplete;

      const styles = Array.from(element.querySelectorAll('style'))
        .map((style) => style.textContent ?? '')
        .join('\n');
      expect(styles).toContain('top: var(--vv-top, 0px) !important;');
      expect(styles).toContain('height: var(--app-height, 100dvh) !important;');

      // Quick keys are a row of the pinned column, not fixed via a keyboard-height offset.
      const quickKeys = element.querySelector('.session-view-grid > terminal-quick-keys');
      expect(quickKeys?.hasAttribute('docked')).toBe(true);
    });

    it('still opens the keyboard when only non-menu toggles are expanded', async () => {
      const testElement = internals(element);
      // e.g. the sidebar collapse button reports aria-expanded="true"
      const sidebarToggle = document.createElement('button');
      sidebarToggle.setAttribute('aria-expanded', 'true');
      document.body.appendChild(sidebarToggle);

      try {
        element
          .querySelector('terminal-renderer')
          ?.dispatchEvent(new CustomEvent('terminal-tap', { bubbles: true, composed: true }));
        await element.updateComplete;

        expect(testElement.uiStateManager.getState().showQuickKeys).toBe(true);
      } finally {
        sidebarToggle.remove();
      }
    });

    it('closes an open menu instead of opening the keyboard when the terminal is tapped', async () => {
      const testElement = internals(element);
      const menuToggle = document.createElement('button');
      menuToggle.setAttribute('aria-haspopup', 'menu');
      menuToggle.setAttribute('aria-expanded', 'true');
      document.body.appendChild(menuToggle);
      const outsideClick = vi.fn();
      document.addEventListener('click', outsideClick);

      try {
        element
          .querySelector('terminal-renderer')
          ?.dispatchEvent(new CustomEvent('terminal-tap', { bubbles: true, composed: true }));
        await element.updateComplete;

        expect(outsideClick).toHaveBeenCalledOnce();
        expect(testElement.uiStateManager.getState().showQuickKeys).toBe(false);
      } finally {
        document.removeEventListener('click', outsideClick);
        menuToggle.remove();
      }
    });
  });

  // 2026-10-12: desktop chat mode showed a Claude Code session as one bubble of spinner frames
  // ("Musing…", counters, block glyphs) parsed from the terminal's output, while the phone
  // showed the conversation from Claude's transcript.
  describe('desktop chat mode', () => {
    const enterDesktopChat = async (session: Session, available = true) => {
      fetchMock.mockResponse(`/api/sessions/${session.id}/claude-chat`, {
        available,
        status: 'idle',
        messages: [],
      });
      element.session = session;
      internals(element).uiStateManager.setIsMobile(false);
      (
        element as unknown as { uiStateManager: { setChatMode(on: boolean): void } }
      ).uiStateManager.setChatMode(true);
      element.requestUpdate();
      await element.updateComplete;
    };
    const agentChat = () =>
      element.querySelector<HTMLElement>('[data-testid="desktop-agent-chat"]');
    const parsedChat = () =>
      element.querySelector<TerminalChatView & HTMLElement>(
        'terminal-chat-view:not([composeronly])'
      );
    const announce = async (available: boolean) => {
      const chat = element.querySelector('claude-chat-view') as ClaudeChatView;
      chat.dispatchEvent(
        new CustomEvent('claude-chat-availability', { detail: available, bubbles: true })
      );
      await element.updateComplete;
    };

    it("shows a Claude session's own conversation with the composer, not the parsed output", async () => {
      await enterDesktopChat(createMockSession({ command: ['claude'] }));
      const chat = element.querySelector('claude-chat-view') as ClaudeChatView | null;
      expect(chat?.hasAttribute('desktop')).toBe(true);
      expect(chat?.phone).toBe(false);
      expect(agentChat()?.style.display).toBe('flex');
      const composer = element.querySelector<TerminalChatView & HTMLElement>(
        'terminal-chat-view[composeronly]'
      );
      expect(composer?.hasAttribute('desktop')).toBe(true);
      expect(composer?.active).toBe(true);
      // The chat parsed from the terminal neither shows nor listens.
      expect(parsedChat()?.style.display).toBe('none');
      expect(parsedChat()?.active).toBe(false);
      // The desktop layout stays: the terminal is hidden, not under a phone overlay.
      expect(element.querySelector<HTMLElement>('terminal-renderer')?.style.display).toBe('none');
    });

    it('sends what the composer sends through the session input', async () => {
      await enterDesktopChat(createMockSession({ command: ['claude'] }));
      const composer = element.querySelector('terminal-chat-view[composeronly]') as unknown as {
        onSend: (data: string) => void;
      };
      terminalSocketClientMock.sendInputText.mockClear();
      composer.onSend('hola');
      await waitForAsync();
      expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
        element.session?.id,
        'hola'
      );
    });

    it('falls back to the parsed chat for a session without an agent conversation', async () => {
      await enterDesktopChat(createMockSession({ command: ['/bin/zsh', '-l'] }), false);
      expect(agentChat()?.style.display).toBe('none');
      expect(parsedChat()?.style.display).not.toBe('none');
      expect(parsedChat()?.active).toBe(true);

      // A Claude session whose transcript the server cannot read falls back too, once the
      // chat view has asked…
      await enterDesktopChat(createMockSession({ command: ['claude'] }), false);
      expect(agentChat()?.style.display).toBe('flex');
      await vi.waitFor(async () => {
        await element.updateComplete;
        expect(agentChat()?.style.display).toBe('none');
      });
      expect(parsedChat()?.active).toBe(true);
      // …and a shell where Claude started is shown as its chat once the view finds it.
      await announce(true);
      expect(agentChat()?.style.display).toBe('flex');
      expect(parsedChat()?.active).toBe(false);
    });

    it('starts a message in the composer from a key typed on the page', async () => {
      await enterDesktopChat(createMockSession({ command: ['claude'] }));
      const composer = element.querySelector(
        'terminal-chat-view[composeronly]'
      ) as TerminalChatView & HTMLElement;
      await composer.updateComplete;
      terminalSocketClientMock.sendInputText.mockClear();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
      const field = composer.shadowRoot?.querySelector<HTMLTextAreaElement>('#chat-input-field');
      expect(field?.value).toBe('h');
      expect(terminalSocketClientMock.sendInputText).not.toHaveBeenCalled();
    });

    it('keeps the phone chat as it was', async () => {
      element.session = createMockSession({ command: ['claude'] });
      internals(element).uiStateManager.setIsMobile(true);
      (
        element as unknown as { uiStateManager: { setChatMode(on: boolean): void } }
      ).uiStateManager.setChatMode(true);
      element.requestUpdate();
      await element.updateComplete;
      expect(agentChat()).toBeNull();
      expect(element.querySelector('claude-chat-view')?.hasAttribute('desktop')).toBe(false);
      expect(
        element.querySelector('terminal-chat-view[composeronly]')?.hasAttribute('desktop')
      ).toBe(false);
      expect(parsedChat()).toBeNull();
    });

    // 2026-10-12: with a plain 1fr column the session's contents widened it and squeezed the
    // sidebar to a sliver in a 900 px window.
    it("doesn't let what is inside widen the desktop column", async () => {
      await enterDesktopChat(createMockSession({ command: ['claude'] }));
      const css = [...element.querySelectorAll('style')].map((s) => s.textContent).join('\n');
      expect(css).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    });
  });

  describe('quick-key layout', () => {
    it('should keep the desktop terminal inside its grid row', async () => {
      element.session = createMockSession();
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(false);
      testElement.uiStateManager.setShowQuickKeys(true);
      await element.updateComplete;

      const terminalArea = element.querySelector<HTMLElement>('.terminal-area');
      expect(terminalArea?.dataset.quickkeysVisible).toBe('true');
      expect(getComputedStyle(terminalArea as HTMLElement).transform).toBe('none');
    });
  });

  describe('file browser', () => {
    it('should show file browser when triggered', async () => {
      const mockSession = createMockSession();
      element.session = mockSession;
      const testElement = internals(element);
      testElement.uiStateManager.setShowFileBrowser(true);
      await element.updateComplete;

      const fileBrowser = element.querySelector('file-browser');
      expect(fileBrowser).toBeTruthy();
    });

    it('should handle file selection', async () => {
      const mockSession = createMockSession();
      element.session = mockSession;
      const testElement = internals(element);
      testElement.uiStateManager.setShowFileBrowser(true);
      await element.updateComplete;

      const fileBrowser = element.querySelector('file-browser');
      if (fileBrowser) {
        // Dispatch insert-path event (the correct event name)
        const fileEvent = new CustomEvent('insert-path', {
          detail: { path: '/home/user/file.txt', type: 'file' },
          bubbles: true,
        });
        fileBrowser.dispatchEvent(fileEvent);

        await waitForAsync();

        // Component sends the path as text
        expect(terminalSocketClientMock.sendInputText).toHaveBeenCalledWith(
          mockSession.id,
          '/home/user/file.txt'
        );
        // Note: showFileBrowser is not automatically closed on insert-path
      }
    });

    it('should close file browser on cancel', async () => {
      const mockSession = createMockSession();
      element.session = mockSession;
      const testElement = internals(element);
      testElement.uiStateManager.setShowFileBrowser(true);
      await element.updateComplete;

      const fileBrowser = element.querySelector('file-browser');
      expect(fileBrowser).toBeTruthy();
      fileBrowser?.dispatchEvent(new Event('browser-cancel', { bubbles: true }));

      expect(testElement.uiStateManager.getState().showFileBrowser).toBe(false);
    });
  });

  describe('toolbar actions', () => {
    beforeEach(async () => {
      const mockSession = createMockSession();
      element.session = mockSession;
      await element.updateComplete;
    });

    it('refits the terminal when a width is selected', async () => {
      const testElement = internals(element);
      testElement.uiStateManager.setShowWidthSelector(true);
      await element.updateComplete;

      const terminal = element.querySelector('ut-terminal') as Terminal;
      const refitSpy = vi.spyOn(terminal, 'refitToChosenWidth');

      // Simulate width selection
      testElement.terminalSettingsManager.handleWidthSelect(100);
      await element.updateComplete;

      expect(refitSpy).toHaveBeenCalledTimes(1);
      expect(terminal.maxCols).toBe(100);
      expect(testElement.uiStateManager.getState().terminalMaxCols).toBe(100);
    });

    it('refits to unlimited width too', async () => {
      const testElement = internals(element);
      testElement.uiStateManager.setShowWidthSelector(true);
      await element.updateComplete;

      const terminal = element.querySelector('ut-terminal') as Terminal;
      const refitSpy = vi.spyOn(terminal, 'refitToChosenWidth');

      // Select unlimited (0)
      testElement.terminalSettingsManager.handleWidthSelect(0);
      await element.updateComplete;

      expect(refitSpy).toHaveBeenCalledTimes(1);
      expect(terminal.maxCols).toBe(0);
      expect(testElement.uiStateManager.getState().terminalMaxCols).toBe(0);
    });
  });

  describe('navigation', () => {
    it('should navigate back to list', async () => {
      const navigateHandler = vi.fn();
      element.addEventListener('navigate-to-list', navigateHandler);

      const mockSession = createMockSession();
      element.session = mockSession;
      await element.updateComplete;

      const backButton = element.querySelector<HTMLElement>('[data-testid="session-back-button"]');
      expect(backButton).toBeTruthy();
      backButton?.click();

      expect(navigateHandler).toHaveBeenCalled();
    });

    it('should handle escape key for navigation', async () => {
      const navigateHandler = vi.fn();
      element.addEventListener('navigate-to-list', navigateHandler);

      const mockSession = createMockSession({ status: 'exited' });
      element.session = mockSession;
      await element.updateComplete;

      // Ensure we're in desktop mode by setting localStorage preference
      localStorage.setItem('touchKeyboardPreference', 'never');

      // Force the lifecycle manager to re-evaluate mobile status
      window.dispatchEvent(new Event('resize'));
      await waitForAsync();

      // Press escape on exited session - dispatch on document since lifecycle manager listens there
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        composed: true,
      });
      document.dispatchEvent(event);
      await waitForAsync();

      expect(navigateHandler).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should cleanup on disconnect', async () => {
      const unsubscribeSpy = vi.fn();
      const inputCleanupSpy = vi.spyOn(internals(element).inputManager, 'cleanup');
      terminalSocketClientMock.subscribe.mockReturnValueOnce(unsubscribeSpy);

      const mockSession = createMockSession();
      element.session = mockSession;
      await element.updateComplete;

      // Create a v3 subscription via ConnectionManager
      const connectionManager = (element as unknown as { connectionManager: unknown })
        .connectionManager as {
        setTerminal: (t: unknown) => void;
        setSession: (s: unknown) => void;
        setConnected: (c: boolean) => void;
        connectToStream: () => void;
      };
      connectionManager.setTerminal({
        write: vi.fn(),
        holdPaint: vi.fn(),
        releasePaint: vi.fn(),
        isPaintHeld: () => false,
      });
      connectionManager.setSession(mockSession);
      connectionManager.setConnected(true);
      connectionManager.connectToStream();

      // Disconnect
      element.disconnectedCallback();

      expect(unsubscribeSpy).toHaveBeenCalled();
      expect(inputCleanupSpy).toHaveBeenCalled();
      inputCleanupSpy.mockRestore();
    });
  });

  describe('updateTerminalTransform debounce', () => {
    let fitTerminalSpy: ReturnType<typeof vi.fn>;
    let terminalElement: {
      fitTerminal: ReturnType<typeof vi.fn>;
      scrollToBottom: ReturnType<typeof vi.fn>;
      isFollowingCursor: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };
    let quickKeysElement: {
      getBoundingClientRect: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
      // Mock matchMedia to handle all queries properly
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width: 768px')
          ? false
          : !!query.includes('orientation: landscape'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      const mockSession = createMockSession();
      element.session = mockSession;
      await element.updateComplete;

      // Mock the terminal element and fitTerminal method
      terminalElement = {
        fitTerminal: vi.fn(),
        scrollToBottom: vi.fn(),
        isFollowingCursor: vi.fn(() => true),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      quickKeysElement = {
        getBoundingClientRect: vi.fn(() => ({ height: 112 })),
      };

      fitTerminalSpy = terminalElement.fitTerminal;

      // Override querySelector to return appropriate mocks
      vi.spyOn(element, 'querySelector').mockImplementation((selector: string) => {
        if (selector === '.terminal-quick-keys-container') {
          return quickKeysElement as unknown as HTMLElement;
        }
        if (selector === 'terminal-renderer') {
          // Return a mock terminal-renderer that also has querySelector
          return {
            querySelector: (innerSelector: string) => {
              if (innerSelector.includes('terminal')) {
                return terminalElement;
              }
              return null;
            },
          } as unknown as Element;
        }
        if (selector.includes('terminal')) {
          return terminalElement as unknown as Element;
        }
        // Let other selectors go through normally
        return HTMLElement.prototype.querySelector.call(element, selector);
      });
    });

    afterEach(() => {
      // Ensure timers are always restored even if a test fails
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('should debounce multiple rapid calls to updateTerminalTransform', {
      timeout: 10000,
    }, async () => {
      // Enable fake timers
      vi.useFakeTimers();

      // Call updateTerminalTransform multiple times rapidly
      internals(element).updateTerminalTransform();
      internals(element).updateTerminalTransform();
      internals(element).updateTerminalTransform();
      internals(element).updateTerminalTransform();
      internals(element).updateTerminalTransform();

      // Verify fitTerminal hasn't been called yet
      expect(fitTerminalSpy).not.toHaveBeenCalled();

      // Advance timers by 50ms (less than debounce time)
      vi.advanceTimersByTime(50);
      expect(fitTerminalSpy).not.toHaveBeenCalled();

      // Advance timers past the debounce time (100ms total)
      vi.advanceTimersByTime(60);

      // Wait for requestAnimationFrame
      await vi.runAllTimersAsync();

      // Now fitTerminal should have been called exactly once
      expect(fitTerminalSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should reserve and reset the measured quick-key height on mobile', async () => {
      vi.useFakeTimers();
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(true);
      testElement.uiStateManager.setShowQuickKeys(true);

      testElement.updateTerminalTransform();
      await vi.advanceTimersByTimeAsync(20);
      await element.updateComplete;

      const containerElement = HTMLElement.prototype.querySelector.call(
        element,
        '.session-view-grid'
      ) as HTMLElement | null;
      expect(quickKeysElement.getBoundingClientRect).toHaveBeenCalledOnce();
      expect(containerElement?.style.getPropertyValue('--quickkeys-height')).toBe('112px');

      testElement.uiStateManager.setShowQuickKeys(false);
      testElement.updateTerminalTransform();
      await vi.advanceTimersByTimeAsync(20);
      await element.updateComplete;

      expect(containerElement?.style.getPropertyValue('--quickkeys-height')).toBe('0px');
    });

    it('should not force scroll-to-bottom while the user is reading scrollback', async () => {
      vi.useFakeTimers();
      const testElement = internals(element);
      terminalElement.isFollowingCursor.mockReturnValue(false);
      testElement.uiStateManager.setIsMobile(true);
      testElement.uiStateManager.setShowQuickKeys(true);

      testElement.updateTerminalTransform();
      await vi.runAllTimersAsync();

      expect(fitTerminalSpy).toHaveBeenCalled();
      expect(terminalElement.scrollToBottom).not.toHaveBeenCalled();
    });

    it('carries the keyboard height as a CSS variable of the grid', async () => {
      const testElement = internals(element);
      testElement.uiStateManager.setIsMobile(true);
      testElement.uiStateManager.setShowQuickKeys(true);
      testElement.uiStateManager.setKeyboardHeight(300);
      await element.updateComplete;
      expect(element.querySelector('.session-view-grid')?.getAttribute('style')).toContain(
        '--keyboard-height: 300px'
      );

      testElement.uiStateManager.setKeyboardHeight(0);
      await element.updateComplete;
      expect(element.querySelector('.session-view-grid')?.getAttribute('style')).toContain(
        '--keyboard-height: 0px'
      );
    });

    it('should clear pending timeout on disconnect', { timeout: 10000 }, async () => {
      vi.useFakeTimers();

      // Call updateTerminalTransform to set a timeout
      internals(element).updateTerminalTransform();

      // Verify timeout is set
      expect(internals(element)._updateTerminalTransformTimeout).toBeTruthy();

      // Disconnect the element
      element.disconnectedCallback();

      // Verify timeout was cleared
      expect(internals(element)._updateTerminalTransformTimeout).toBeNull();

      vi.useRealTimers();
    });
  });

  it('tells the header the server platform, so a session in a Mac window says "On the Mac"', async () => {
    setViewport(375, 667);
    const session = createMockSession({ id: 'fwd_1759500000_20085' });
    session.macWindow = { app: 'Terminal' };
    element.serverPlatform = 'darwin';
    element.session = session;
    internals(element).uiStateManager.setIsMobile(true);
    await element.updateComplete;
    const header = element.querySelector('session-header') as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await header.updateComplete;
    expect(header.querySelector('[data-testid="header-mac-window"]')?.textContent?.trim()).toBe(
      'On the Mac · Terminal'
    );
  });

  // A tmux session opened from "On this Mac" to watch: tmux drops what this client types.
  describe('an opened tmux session', () => {
    const tmux = (mode: SessionMultiplexer['mode']): SessionMultiplexer => ({
      type: 'tmux',
      socketPath: '/tmp/tmux-501/default',
      serverPid: 15674,
      serverStartedAt: 1727426400,
      sessionId: '$0',
      sessionName: '0',
      mode,
      sizing: 'others',
      source: 'mac-sessions',
    });
    let session: Session;
    let modeCalls: unknown[];
    let answerMode: () => Promise<Response>;

    beforeEach(async () => {
      setViewport(375, 667);
      modeCalls = [];
      answerMode = async () => Response.json({ mode: 'control', sizing: 'others' });
      const others = global.fetch;
      // Given back when the test ends, so no later test talks to this block's server.
      onTestFinished(() => {
        global.fetch = others;
      });
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/mac-sessions/attached/tmux-open/mode') {
          modeCalls.push(JSON.parse(String(init?.body)));
          return answerMode();
        }
        return others(url, init);
      }) as unknown as typeof fetch;
      session = createMockSession({ id: 'tmux-open', name: 'tmux: 0' });
      session.multiplexer = tmux('watch');
      element.session = session;
      internals(element).uiStateManager.setIsMobile(true);
      await element.updateComplete;
    });

    const banner = () => element.querySelector<HTMLElement>('[data-testid="watch-banner"]');
    const enterChatMode = async () => {
      (
        element as unknown as { uiStateManager: { setChatMode(on: boolean): void } }
      ).uiStateManager.setChatMode(true);
      element.requestUpdate();
      await element.updateComplete;
    };

    it('says it only watches, and offers nothing that would type', async () => {
      expect(banner()?.getAttribute('role')).toBe('status');
      expect(banner()?.textContent).toContain('Watching: what you type isn’t sent.');
      const actionBar = element.querySelector('mobile-action-bar') as
        | (HTMLElement & { visible: boolean })
        | null;
      expect(actionBar?.visible).toBe(false);

      // A tap on the terminal raises no keyboard.
      element
        .querySelector('terminal-renderer')
        ?.dispatchEvent(new CustomEvent('terminal-tap', { bubbles: true, composed: true }));
      await element.updateComplete;
      expect(internals(element).uiStateManager.getState().showQuickKeys).toBe(false);

      await enterChatMode();
      expect(element.querySelector('terminal-chat-view[composeronly]')).toBeNull();
      expect(
        (element.querySelector('claude-chat-view') as HTMLElement & { readOnly: boolean }).readOnly
      ).toBe(true);
    });

    it('takes control at once, and keeps it once tmux has done it', async () => {
      let answer: (response: Response) => void = () => {};
      answerMode = () =>
        new Promise((resolve) => {
          answer = resolve;
        });
      await enterChatMode();
      element.querySelector<HTMLButtonElement>('[data-testid="watch-take-control"]')?.click();
      await element.updateComplete;
      expect(banner()).toBeNull();
      expect(element.querySelector('terminal-chat-view[composeronly]')).not.toBeNull();
      expect(modeCalls).toEqual([{ mode: 'control' }]);

      answer(Response.json({ mode: 'control', sizing: 'others' }));
      await vi.waitFor(() => expect(session.multiplexer?.mode).toBe('control'));
      await element.updateComplete;
      expect(banner()).toBeNull();
      expect(
        (element.querySelector('claude-chat-view') as HTMLElement & { readOnly: boolean }).readOnly
      ).toBe(false);
    });

    it('goes back to watching and says why when tmux refuses', async () => {
      answerMode = async () => Response.json({ error: 'client-not-found' }, { status: 409 });
      const errors: string[] = [];
      element.addEventListener('error', (e: Event) => errors.push((e as CustomEvent).detail));
      element.querySelector<HTMLButtonElement>('[data-testid="watch-take-control"]')?.click();
      await vi.waitFor(() =>
        expect(errors).toEqual([
          'This session is no longer attached to tmux. Open it again from the list.',
        ])
      );
      await element.updateComplete;
      expect(banner()).not.toBeNull();
      expect(session.multiplexer?.mode).toBe('watch');
    });

    it('starts watching from the session menu', async () => {
      session.multiplexer = tmux('control');
      element.requestUpdate();
      await element.updateComplete;
      expect(banner()).toBeNull();

      answerMode = async () => Response.json({ mode: 'watch', sizing: 'others' });
      element.querySelector('compact-menu')?.dispatchEvent(
        new CustomEvent('attach-mode-change', {
          detail: { mode: 'watch' },
          bubbles: true,
          composed: true,
        })
      );
      await element.updateComplete;
      expect(banner()).not.toBeNull();
      await vi.waitFor(() => expect(session.multiplexer?.mode).toBe('watch'));
      expect(modeCalls).toEqual([{ mode: 'watch' }]);
    });
  });
});
