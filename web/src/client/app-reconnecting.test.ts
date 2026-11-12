/**
 * @vitest-environment happy-dom
 */
import { nothing, render } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../shared/types.js';
import { UntetherApp } from './app.js';
// A chunk of its own in the app (utils/lazy-views.ts): defined here so the app renders it.
import './components/session-view.js';

vi.mock('./services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    initialize: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getConnectionStatus: vi.fn(() => true),
    onConnectionStateChange: vi.fn(() => () => {}),
    sendInputText: vi.fn(() => true),
    sendInputKey: vi.fn(() => true),
    sendResize: vi.fn(() => true),
    sendResetSize: vi.fn(() => true),
    setViewingSession: vi.fn(),
    clearViewingSession: vi.fn(),
    setSeenSource: vi.fn(),
    seenMayHaveChanged: vi.fn(),
  },
}));

type AppState = {
  sessions: Session[];
  currentView: string;
  selectedSessionId: string | null;
  reconnecting: boolean;
};

const running = {
  id: 'open-1',
  name: 'claude',
  command: ['claude'],
  workingDir: '/tmp',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
} as Session;

describe('"Reconnecting…" pill', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.unstubAllGlobals();
  });

  it('is drawn by the open session, under its header, not over its ⋮ menu', async () => {
    // 2026-10-03: the app's pill (z 1500) covered the menu's "New session".
    const app = new UntetherApp();
    const state = app as unknown as AppState;
    state.sessions = [running];
    state.selectedSessionId = running.id;
    state.currentView = 'session';
    state.reconnecting = true;
    render(app.render(), container, { host: app });
    const view = container.querySelector('session-view') as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    await view.updateComplete;

    const pills = container.querySelectorAll('.reconnecting-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].closest('session-view')).toBe(view);
  });

  it("stays the app's own on the session list", async () => {
    const app = new UntetherApp();
    const state = app as unknown as AppState;
    state.sessions = [running];
    state.currentView = 'list';
    state.reconnecting = true;
    render(app.render(), container, { host: app });

    const pills = container.querySelectorAll('.reconnecting-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].closest('session-view')).toBeNull();
  });
});
