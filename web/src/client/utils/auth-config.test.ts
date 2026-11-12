/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('fetchAuthConfig', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => Response.json({ noAuth: true }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('startup callers share one request; a later one asks again', async () => {
    const { fetchAuthConfig } = await import('./auth-config.js');
    const [app, socket] = await Promise.all([fetchAuthConfig(), fetchAuthConfig()]);
    expect(app).toEqual({ noAuth: true });
    expect(socket).toEqual({ noAuth: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);
    await fetchAuthConfig();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed request is not handed to the next caller', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
    const { fetchAuthConfig } = await import('./auth-config.js');
    await expect(fetchAuthConfig()).rejects.toThrow('Load failed');
    await expect(fetchAuthConfig()).resolves.toEqual({ noAuth: true });
  });

  it('an error status is null, as "no config"', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const { fetchAuthConfig } = await import('./auth-config.js');
    await expect(fetchAuthConfig()).resolves.toBeNull();
  });
});
