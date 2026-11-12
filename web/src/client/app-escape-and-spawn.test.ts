/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { UntetherApp } from './app.js';

type AppInternals = {
  currentView: string;
  hasActiveOverlay: boolean;
  showSettings: boolean;
  isAuthenticated: boolean;
  captureEscapeOverlay(e: KeyboardEvent): void;
  handleKeyDown(e: KeyboardEvent): void;
  handleNavigateToList(): void;
  handleSessionCreated(e: CustomEvent): Promise<void>;
  waitForSessionAndSwitch(id: string): Promise<void>;
  showSuccess(message: string): void;
  setupNotificationHandlers(): void;
  disconnectedCallback(): void;
};

const escapeKey = () => new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });

describe('Escape over a session', () => {
  // 2026-11-10: Escape on Settings closed it and ALSO left the session, because Settings
  // listens on document (before app's window handler) and app only checked showCreateModal.
  it('does not leave the session while a sheet was open when the key went down', () => {
    const app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'session';
    app.hasActiveOverlay = true;
    const leave = vi.spyOn(app, 'handleNavigateToList').mockImplementation(() => {});
    const e = escapeKey();
    app.captureEscapeOverlay(e);
    // Settings closes on the same key before app's handler runs.
    app.hasActiveOverlay = false;
    app.showSettings = false;
    app.handleKeyDown(e);
    expect(leave).not.toHaveBeenCalled();
  });

  it('still returns to the list with no overlay open', () => {
    const app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'session';
    const leave = vi.spyOn(app, 'handleNavigateToList').mockImplementation(() => {});
    const e = escapeKey();
    app.captureEscapeOverlay(e);
    app.handleKeyDown(e);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

describe('a session opened in a Terminal window', () => {
  // Decided 2026-11-11: it stays as it is, the app jumps to it (no "window opened" toast; the
  // server's answer carries no message to key one on).
  it('is switched to once it appears, with no toast', async () => {
    const app = new UntetherApp() as unknown as AppInternals;
    const success = vi.spyOn(app, 'showSuccess').mockImplementation(() => {});
    const wait = vi.spyOn(app, 'waitForSessionAndSwitch').mockResolvedValue(undefined);
    await app.handleSessionCreated(
      new CustomEvent('session-created', { detail: { sessionId: 's2' } })
    );
    expect(success).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledWith('s2');
  });
});

describe('app listeners', () => {
  // 2026-11-10: the preview listeners and the notification-action one were never removed.
  it('removes every listener it adds when it leaves the DOM', () => {
    const app = new UntetherApp() as unknown as AppInternals & HTMLElement;
    const added = new Map<string, unknown>();
    vi.spyOn(window, 'addEventListener').mockImplementation(((t: string, h: unknown) => {
      added.set(`window:${t}`, h);
    }) as never);
    vi.spyOn(app, 'addEventListener').mockImplementation(((t: string, h: unknown) => {
      added.set(`app:${t}`, h);
    }) as never);
    const removed = new Map<string, unknown>();
    vi.spyOn(window, 'removeEventListener').mockImplementation(((t: string, h: unknown) => {
      removed.set(`window:${t}`, h);
    }) as never);
    vi.spyOn(app, 'removeEventListener').mockImplementation(((t: string, h: unknown) => {
      removed.set(`app:${t}`, h);
    }) as never);
    app.setupNotificationHandlers();
    app.disconnectedCallback();
    expect(added.size).toBeGreaterThan(8);
    for (const [key, handler] of added) expect(removed.get(key), key).toBe(handler);
    vi.restoreAllMocks();
  });
});
