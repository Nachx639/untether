import { describe, expect, it } from 'vitest';
import {
  buildUpstreamHeaders,
  injectClientScript,
  PREVIEW_COOKIE,
  PREVIEW_SW_HEADER,
  parsePreviewUrl,
  previewAppOrigin,
  previewPortError,
  rewriteLocation,
  rewriteSetCookie,
  sanitizeResponseHeaders,
} from './preview-proxy.js';

describe('preview URL and port rules', () => {
  it('assigns a separate hostname per app and refuses single-host remote origins', () => {
    expect(previewAppOrigin('https://preview.example.com', 3000)).toBe(
      'https://ut-preview-3000.preview.example.com'
    );
    expect(previewAppOrigin('https://preview.example.com', 5173)).toBe(
      'https://ut-preview-5173.preview.example.com'
    );
    expect(previewAppOrigin('http://127.0.0.1:4021', 5173)).toBe(
      'http://ut-preview-5173.localhost:4021'
    );
    expect(previewAppOrigin('http://localhost:4021', 3000)).toBe(
      'http://ut-preview-3000.localhost:4021'
    );
    expect(previewAppOrigin('https://mac.tail.ts.net:4021', 5173)).toBeNull();
    expect(previewAppOrigin('http://100.100.100.100:4021', 5173)).toBeNull();
  });
  it('parses /preview/<port>/<path>', () => {
    expect(parsePreviewUrl('/preview/5173/src/main.ts?t=1')).toEqual({
      port: 5173,
      path: '/src/main.ts?t=1',
    });
    expect(parsePreviewUrl('/preview/5173')).toEqual({ port: 5173, path: '/' });
    expect(parsePreviewUrl('/preview/5173?x=1')).toEqual({ port: 5173, path: '/?x=1' });
    expect(parsePreviewUrl('/preview/evil.com/x')).toBeNull();
    expect(parsePreviewUrl('/preview/5173evil/x')).toBeNull();
    expect(parsePreviewUrl('/api/sessions')).toBeNull();
  });

  it('only allows unprivileged ports that are not Untether itself', () => {
    expect(previewPortError(5173, 4020)).toBeNull();
    expect(previewPortError(4020, 4020)).toMatch(/own port/);
    expect(previewPortError(22, 4020)).toMatch(/range/);
    expect(previewPortError(80, 4020)).toMatch(/range/);
    expect(previewPortError(70000, 4020)).toMatch(/range/);
    expect(previewPortError(18789, 4020, new Set([18789]))).toMatch(/denied/);
    expect(previewPortError(4021, [4020, 4021])).toMatch(/own port/);
  });
});

describe('header handling', () => {
  it('does not let upstream CORS or origin clustering weaken app isolation', () => {
    const out = sanitizeResponseHeaders(
      {
        'access-control-allow-origin': 'https://attacker.example',
        'access-control-allow-credentials': 'true',
        'origin-agent-cluster': '?0',
      },
      5173
    );
    expect(out).not.toHaveProperty('access-control-allow-origin');
    expect(out).not.toHaveProperty('access-control-allow-credentials');
    expect(out).not.toHaveProperty('origin-agent-cluster');
  });
  it('never forwards Untether credentials or identity to the dev server', () => {
    const headers = buildUpstreamHeaders(
      {
        host: 'mac.tail.ts.net',
        cookie: `${PREVIEW_COOKIE}_5173=secret; app=1; ut_preview_port=5173`,
        authorization: 'Bearer ut-jwt',
        'tailscale-user-login': 'me@example.com',
        'x-forwarded-for': '100.1.2.3',
        'x-untether-local': 'tok',
        origin: 'https://mac.tail.ts.net',
        referer: 'https://mac.tail.ts.net/preview/5173/about',
        [PREVIEW_SW_HEADER]: '1',
      },
      5173,
      { isUntetherAuthorization: (value) => value === 'Bearer ut-jwt' }
    );
    expect(headers.host).toBe('localhost:5173');
    expect(headers.cookie).toBe('app=1');
    expect(headers.authorization).toBeUndefined();
    expect(headers['tailscale-user-login']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['x-untether-local']).toBeUndefined();
    expect(headers[PREVIEW_SW_HEADER]).toBeUndefined();
    expect(headers.origin).toBe('http://localhost:5173');
    expect(headers.referer).toBe('http://localhost:5173/about');
  });

  it("passes the previewed app's own Authorization through", () => {
    const headers = buildUpstreamHeaders({ host: 'h', authorization: 'Bearer app-token' }, 3000, {
      isUntetherAuthorization: () => false,
    });
    expect(headers.authorization).toBe('Bearer app-token');
  });

  it('strips frame blocking and origin-wide headers from proxied responses', () => {
    const out = sanitizeResponseHeaders(
      {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'service-worker-allowed': '/',
        'clear-site-data': '"storage"',
        'strict-transport-security': 'max-age=1',
        'content-type': 'text/css',
        location: '/login',
      },
      5173
    );
    expect(out['x-frame-options']).toBeUndefined();
    expect(out['content-security-policy']).toBe("default-src 'self'");
    expect(out['service-worker-allowed']).toBeUndefined();
    expect(out['clear-site-data']).toBeUndefined();
    expect(out['strict-transport-security']).toBeUndefined();
    expect(out['content-type']).toBe('text/css');
    expect(out.location).toBe('/preview/5173/login');
  });

  it("scopes the app's cookies to its prefix and drops Domain", () => {
    expect(
      rewriteSetCookie(
        [
          'sid=abc; Path=/; Domain=localhost; HttpOnly',
          'x=1',
          'deep=2; path=/admin',
          `${PREVIEW_COOKIE}=forged; Path=/`,
        ],
        5173
      )
    ).toEqual([
      'sid=abc; Path=/preview/5173/; HttpOnly',
      'x=1; Path=/preview/5173/',
      'deep=2; Path=/preview/5173/admin',
    ]);
  });

  it('keeps redirects to the dev server inside the prefix, others untouched', () => {
    expect(rewriteLocation('http://localhost:5173/a?b=1', 5173)).toBe('/preview/5173/a?b=1');
    expect(rewriteLocation('http://127.0.0.1:5173/', 5173)).toBe('/preview/5173/');
    expect(rewriteLocation('https://accounts.example.com/x', 5173)).toBe(
      'https://accounts.example.com/x'
    );
    expect(rewriteLocation('http://localhost:9999/x', 5173)).toBe('http://localhost:9999/x');
  });

  it('injects the client script first in <head>', () => {
    expect(injectClientScript('<!doctype html><html><head><title>x</title>', 5173)).toBe(
      '<!doctype html><html><head><script src="/preview/5173/__ut_preview_client.js"></script><title>x</title>'
    );
  });
});
