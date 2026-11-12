import { describe, expect, it, vi } from 'vitest';
import { isGuardedNavigation, renderOfflinePage, respondToNavigation } from './sw-offline';

const origin = 'https://mac.example.ts.net';

function navigation(path: string, init: { mode?: string; method?: string } = {}) {
  return {
    url: `${origin}${path}`,
    mode: init.mode ?? 'navigate',
    method: init.method ?? 'GET',
  } as Request;
}

describe('offline fallback', () => {
  it('guards page loads only, never API calls, assets or other origins', () => {
    expect(isGuardedNavigation(navigation('/'), origin)).toBe(true);
    expect(isGuardedNavigation(navigation('/session/abc'), origin)).toBe(true);
    expect(isGuardedNavigation(navigation('/api/sessions'), origin)).toBe(false);
    expect(isGuardedNavigation(navigation('/bundle/app.js', { mode: 'cors' }), origin)).toBe(false);
    expect(isGuardedNavigation(navigation('/', { method: 'POST' }), origin)).toBe(false);
    expect(
      isGuardedNavigation(
        { url: 'https://other.example/', mode: 'navigate', method: 'GET' } as Request,
        origin
      )
    ).toBe(false);
  });

  it('passes network responses through untouched, error statuses included', async () => {
    const response = new Response('login required', { status: 401 });
    const cached = vi.fn();
    await expect(respondToNavigation(async () => response, cached)).resolves.toBe(response);
    expect(cached).not.toHaveBeenCalled();
  });

  it('serves the stored localized page when the server is unreachable', async () => {
    const stored = new Response('<p>No se puede conectar</p>');
    const result = await respondToNavigation(
      () => Promise.reject(new TypeError('Load failed')),
      async () => stored
    );
    expect(result).toBe(stored);
  });

  it('falls back to a built-in page when none was stored', async () => {
    const result = await respondToNavigation(
      () => Promise.reject(new TypeError('Load failed')),
      async () => undefined
    );
    expect(result.headers.get('Content-Type')).toContain('text/html');
    expect(await result.text()).toContain('reach your Mac');
  });

  it('escapes translated text', () => {
    const html = renderOfflinePage({
      lang: 'en',
      dir: 'ltr',
      title: '<img src=x onerror=alert(1)>',
      body: 'b',
      retrying: 'r',
      retryNow: 'n',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
