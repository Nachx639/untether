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
  errorMessage: string;
};

/** A tmux session opened from "On this Mac" to watch. */
const watching = {
  id: 'tmux-open',
  name: 'tmux: work',
  command: ['/opt/homebrew/bin/tmux', 'attach-session'],
  workingDir: '/tmp',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
  multiplexer: {
    type: 'tmux',
    socketPath: '/tmp/tmux-501/default',
    serverPid: 15674,
    serverStartedAt: 1727426400,
    sessionId: '$0',
    sessionName: 'work',
    mode: 'watch',
    sizing: 'others',
    source: 'mac-sessions',
  },
} as Session;

describe('errors in the open session', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/mac-sessions/attached/tmux-open/mode'
          ? Response.json({ error: 'client-not-found' }, { status: 409 })
          : Response.json({})
      )
    );
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows why taking control of a watched tmux session failed', async () => {
    const app = new UntetherApp();
    const state = app as unknown as AppState;
    state.sessions = [watching];
    state.selectedSessionId = watching.id;
    state.currentView = 'session';
    render(app.render(), container, { host: app });
    const view = container.querySelector('session-view') as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    await view.updateComplete;

    view.querySelector<HTMLButtonElement>('[data-testid="watch-take-control"]')?.click();
    await vi.waitFor(() =>
      expect(state.errorMessage).toBe(
        'This session is no longer attached to tmux. Open it again from the list.'
      )
    );
  });
});
