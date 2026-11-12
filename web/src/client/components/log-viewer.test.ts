/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverConfigService } from '../services/server-config-service.js';
import './log-viewer.js';

type Viewer = HTMLElement & { logs: unknown[]; loading: boolean };

const LINE = '2026-11-10T10:00:00.000Z LOG [server] hello';

function respond(body: string) {
  return { ok: true, text: async () => body, json: async () => ({ sizeHuman: '1 KB' }) };
}

describe('log-viewer polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(serverConfigService, 'loadConfig').mockResolvedValue({} as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('asks only for the end of the log, never the whole file', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return respond(LINE);
      })
    );
    const viewer = document.createElement('log-viewer') as Viewer;
    document.body.append(viewer);
    await vi.advanceTimersByTimeAsync(0);
    const raw = urls.find((u) => u.startsWith('/api/logs/raw'));
    expect(raw).toBe('/api/logs/raw?tail=4194304');
    expect(viewer.logs).toHaveLength(1);
  });

  it('does not start a second poll while one is still in flight', async () => {
    let rawCalls = 0;
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/logs/raw')) {
          rawCalls++;
          await new Promise<void>((resolve) => releases.push(resolve));
        }
        return respond(LINE);
      })
    );
    document.body.append(document.createElement('log-viewer'));
    await vi.advanceTimersByTimeAsync(0);
    expect(rawCalls).toBe(1);
    // Three ticks pass while the first download is still going.
    await vi.advanceTimersByTimeAsync(6000);
    expect(rawCalls).toBe(1);
    for (const release of releases) release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rawCalls).toBe(2);
  });

  it('drops a response that arrives after the viewer left the page', async () => {
    let release: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/logs/raw')) await new Promise<void>((r) => (release = r));
        return respond(LINE);
      })
    );
    const viewer = document.createElement('log-viewer') as Viewer;
    document.body.append(viewer);
    await vi.advanceTimersByTimeAsync(0);
    viewer.remove();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(viewer.logs).toHaveLength(0);
  });
});
