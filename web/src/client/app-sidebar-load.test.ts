/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UntetherApp } from './app.js';

const realWidth = window.innerWidth;
const realHeight = window.innerHeight;
const setWidth = (value: number) =>
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
const setHeight = (value: number) =>
  Object.defineProperty(window, 'innerHeight', { configurable: true, value });
const sidebarCollapsed = () =>
  (new UntetherApp() as unknown as { sidebarCollapsed: boolean }).sidebarCollapsed;

describe('the sidebar when the app loads', () => {
  beforeEach(() => {
    // The shared test setup stubs localStorage with no-op mocks; this needs one that stores.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
    });
  });
  afterEach(() => {
    setWidth(realWidth);
    setHeight(realHeight);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts closed on a phone even if it was left open, so a session link shows the session', () => {
    setWidth(390);
    localStorage.setItem('sidebarCollapsed', 'false');
    expect(sidebarCollapsed()).toBe(true);
  });

  it('keeps the saved state on a wider screen', () => {
    setWidth(1280);
    localStorage.setItem('sidebarCollapsed', 'false');
    expect(sidebarCollapsed()).toBe(false);
    localStorage.setItem('sidebarCollapsed', 'true');
    expect(sidebarCollapsed()).toBe(true);
  });

  // 2026-10-04: a Pro Max on its side is 956 pt wide, past the 768 pt breakpoint. As a
  // desktop the sidebar "opened" under the full-screen session view and the header's "›"
  // went away.
  it('a phone on its side is still a phone: the sidebar starts closed, as mobile', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15'
    );
    setWidth(956);
    setHeight(330);
    localStorage.setItem('sidebarCollapsed', 'false');
    const app = new UntetherApp() as unknown as {
      sidebarCollapsed: boolean;
      mediaState: { isMobile: boolean };
    };
    expect(app.sidebarCollapsed).toBe(true);
    expect(app.mediaState.isMobile).toBe(true);
  });

  it('a desktop window as wide keeps the desktop sidebar', () => {
    setWidth(956);
    setHeight(330);
    localStorage.setItem('sidebarCollapsed', 'false');
    const app = new UntetherApp() as unknown as {
      sidebarCollapsed: boolean;
      mediaState: { isMobile: boolean };
    };
    expect(app.sidebarCollapsed).toBe(false);
    expect(app.mediaState.isMobile).toBe(false);
  });

  // 2026-10-12, user request: back from a terminal must land on the home control center, not on the
  // compact sidebar list (a second list without the Ask box, the tab bar or the settings).
  describe('one list on a phone', () => {
    type App = {
      sidebarCollapsed: boolean;
      currentView: string;
      selectedSessionId: string | null;
      sessions: unknown[];
      handleToggleSidebar(): void;
      loadSessions(): Promise<boolean>;
      willUpdate(changed: Map<string, unknown>): void;
      sidebarClasses: string;
      showSplitView: boolean;
    };
    const phone = (width: number, height: number) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15'
      );
      setWidth(width);
      setHeight(height);
    };
    const inSession = () => {
      const app = new UntetherApp() as unknown as App;
      app.currentView = 'session';
      app.selectedSessionId = 's1';
      vi.spyOn(app, 'loadSessions').mockResolvedValue(true);
      return app;
    };

    for (const [label, w, h] of [
      ['portrait', 393, 852],
      ['landscape', 852, 393],
    ] as const) {
      it(`a sidebar toggle in a session goes home, the sidebar stays closed (${label})`, () => {
        phone(w, h);
        const pushState = vi.spyOn(window.history, 'pushState');
        const app = inSession();
        app.handleToggleSidebar();
        expect(app.currentView).toBe('list');
        expect(app.selectedSessionId).toBeNull();
        expect(app.sidebarCollapsed).toBe(true);
        expect(localStorage.getItem('sidebarCollapsed')).toBeNull();
        expect(pushState).toHaveBeenCalled();
      });
    }

    it('a stale open sidebar is closed before render and its classes are hidden', () => {
      phone(393, 852);
      const app = inSession();
      app.sidebarCollapsed = false;
      app.willUpdate(new Map());
      expect(app.sidebarCollapsed).toBe(true);
      Object.defineProperty(app, 'showSplitView', { configurable: true, value: true });
      expect(app.sidebarClasses.split(' ')).toContain('hidden');
    });

    it('on the list the toggle does nothing on a phone', () => {
      phone(393, 852);
      const app = inSession();
      app.currentView = 'list';
      app.selectedSessionId = null;
      app.handleToggleSidebar();
      expect(app.currentView).toBe('list');
      expect(app.sidebarCollapsed).toBe(true);
    });

    it('a desktop still toggles the sidebar and stays in the session', () => {
      setWidth(1440);
      setHeight(900);
      const app = inSession();
      const before = app.sidebarCollapsed;
      app.handleToggleSidebar();
      expect(app.sidebarCollapsed).toBe(!before);
      expect(app.currentView).toBe('session');
    });
  });
});
