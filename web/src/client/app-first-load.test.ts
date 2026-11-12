/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UntetherApp } from './app.js';

type AppInternals = {
  sessions: unknown[];
  previews: unknown[];
  currentView: string;
  loadSessions(): Promise<void>;
};

const session = {
  id: 's1',
  name: 'claude',
  status: 'running',
  command: ['claude'],
  workingDir: '/tmp',
  startedAt: new Date().toISOString(),
};

function stubServer(previews: () => Promise<unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/previews'
        ? new Response(JSON.stringify({ previews: await previews() }), { status: 200 })
        : new Response(JSON.stringify([session]), { status: 200 })
    )
  );
}

describe('the first load of the session list', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the sessions together with the previews above them, not before', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    stubServer(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ id: 'p1', port: 5180 }]);
        })
    );
    const app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'list';
    const load = app.loadSessions();
    await vi.advanceTimersByTimeAsync(300);
    expect(app.sessions).toHaveLength(0);
    release();
    await vi.advanceTimersByTimeAsync(10);
    await load;
    expect(app.previews).toHaveLength(1);
    expect(app.sessions).toHaveLength(1);
  });

  it('asks for the previews alongside the sessions, not after them', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        asked.push(url.split('?')[0]);
        return new Promise<Response>(() => {});
      })
    );
    const app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'list';
    void app.loadSessions();
    await Promise.resolve();
    expect(asked).toEqual(expect.arrayContaining(['/api/sessions', '/api/previews']));
  });

  it('waits only a moment for previews that are slow', async () => {
    vi.useFakeTimers();
    stubServer(() => new Promise(() => {}));
    const app = new UntetherApp() as unknown as AppInternals;
    app.currentView = 'list';
    void app.loadSessions();
    await vi.advanceTimersByTimeAsync(1600);
    expect(app.sessions).toHaveLength(1);
  });
});
