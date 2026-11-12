// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVersionWatch } from './app-version.js';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('startVersionWatch', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setVisibility('visible');
  });

  /** Each check reads the bundle first: the n-th check serves the n-th build for every file. */
  function serveTags(...tags: string[]) {
    let check = -1;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('client-bundle.js')) check++;
      const tag = tags[Math.min(Math.max(check, 0), tags.length - 1)];
      return new Response(null, { status: 200, headers: { etag: `${tag} ${url}` } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('also reloads after a style-only update (the bundle unchanged)', async () => {
    let check = -1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('client-bundle.js')) check++;
        const etag = String(url).includes('styles.css') ? `"css${Math.min(check, 1)}"` : '"same"';
        return new Response(null, { status: 200, headers: { etag } });
      })
    );
    const reload = vi.fn();
    stop = startVersionWatch({ reload, onStale: vi.fn(), isBusy: () => false });
    await flush();
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when the app comes back to the foreground after a new build', async () => {
    serveTags('"v1"', '"v2"');
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, isBusy: () => false });
    await flush();
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('offers a reload instead when something is being typed', async () => {
    serveTags('"v1"', '"v2"');
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, isBusy: () => true });
    await flush();
    setVisibility('visible');
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the build is unchanged', async () => {
    serveTags('"v1"');
    const reload = vi.fn();
    const onStale = vi.fn();
    stop = startVersionWatch({ reload, onStale, isBusy: () => false });
    await flush();
    setVisibility('visible');
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('notices a new build while on screen and offers a reload', async () => {
    vi.useFakeTimers();
    serveTags('"v1"', '"v2"');
    const onStale = vi.fn();
    stop = startVersionWatch({ reload: vi.fn(), onStale, isBusy: () => false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  describe('a page the service worker served an older build (sw-shell.ts)', () => {
    let worker: EventTarget;
    const workerSays = (type: string) =>
      worker.dispatchEvent(new MessageEvent('message', { data: { type } }));

    beforeEach(() => {
      sessionStorage.clear();
      serveTags('"v2"'); // the server already has the new build
      worker = new EventTarget();
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
    });

    it('reloads at once while nobody has touched it, once a minute at most', async () => {
      const reload = vi.fn();
      const onStale = vi.fn();
      stop = startVersionWatch({ reload, onStale, isBusy: () => false });
      await flush();
      workerSays('ut-shell-updated');
      expect(reload).toHaveBeenCalledTimes(1);

      // The reloaded page is told the same (the worker got it wrong): no reload loop.
      stop();
      stop = startVersionWatch({ reload, onStale, isBusy: () => false });
      workerSays('ut-shell-updated');
      expect(reload).toHaveBeenCalledTimes(1);
      expect(onStale).toHaveBeenCalledTimes(1);
    });

    it('offers a reload instead once the page is in use', async () => {
      const reload = vi.fn();
      const onStale = vi.fn();
      stop = startVersionWatch({ reload, onStale, isBusy: () => false });
      window.dispatchEvent(new Event('pointerdown'));
      workerSays('ut-shell-updated');
      expect(reload).not.toHaveBeenCalled();
      expect(onStale).toHaveBeenCalledTimes(1);
    });

    it('in the background, reloads when it comes back', async () => {
      const reload = vi.fn();
      stop = startVersionWatch({ reload, onStale: vi.fn(), isBusy: () => false });
      await flush();
      setVisibility('hidden');
      workerSays('ut-shell-updated');
      expect(reload).not.toHaveBeenCalled();
      setVisibility('visible');
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("ignores the worker's other messages", async () => {
      const reload = vi.fn();
      const onStale = vi.fn();
      stop = startVersionWatch({ reload, onStale, isBusy: () => false });
      workerSays('notification-action');
      expect(reload).not.toHaveBeenCalled();
      expect(onStale).not.toHaveBeenCalled();
    });
  });
});
