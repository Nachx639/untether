import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { createPreviewRoutes } from '../routes/preview.js';
import type { PreviewProxy } from './preview-proxy.js';
import {
  createPreviewProxy,
  PREVIEW_SW_HEADER,
  PreviewTickets,
  PreviewTokens,
  parsePreviewUrl,
  safeNextPath,
} from './preview-proxy.js';
import { PreviewRegistry } from './preview-registry.js';
import {
  createPreviewServer,
  foreignApiRequestReason,
  isFromPreviewOrigin,
  mainOriginPreviewGuard,
  originMatchesHost,
  resolvePreviewPort,
} from './preview-server.js';

/** The test makes its https app's certificate with the openssl CLI; without it, that test skips. */
const opensslAvailable = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function throwawayLocalhostCertificate(): { key: Buffer; cert: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-preview-tls-'));
  try {
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        keyFile,
        '-out',
        certFile,
      ],
      { stdio: 'ignore' }
    );
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } finally {
    fs.rmSync(dir, RM_TEST_DIR);
  }
}

describe('preview listener config', () => {
  it('defaults to main port + 1, takes the flag before the env, refuses the main port', () => {
    expect(resolvePreviewPort(null, undefined, 4020)).toEqual({ port: 4021 });
    expect(resolvePreviewPort('4555', '4666', 4020)).toEqual({ port: 4555 });
    expect(resolvePreviewPort(null, '4666', 4020)).toEqual({ port: 4666 });
    expect(resolvePreviewPort(null, 'off', 4020)).toEqual({ port: null });
    expect(resolvePreviewPort('4020', undefined, 4020).port).toBeNull();
    expect(resolvePreviewPort('4020', undefined, 4020).error).toMatch(/differ/);
    expect(resolvePreviewPort('abc', undefined, 4020).error).toMatch(/invalid/);
  });

  it('recognizes requests coming from the preview origin', () => {
    expect(isFromPreviewOrigin('https://mac.ts.net:4021', 4021)).toBe(true);
    expect(isFromPreviewOrigin('http://127.0.0.1:4021', 4021)).toBe(true);
    expect(isFromPreviewOrigin('https://mac.ts.net:4020', 4021)).toBe(false);
    expect(isFromPreviewOrigin(undefined, 4021)).toBe(false);
    expect(isFromPreviewOrigin('https://p.example', null, 'https://p.example')).toBe(true);
  });

  it('refuses foreign browser requests to the main API, not Untether or its clients', () => {
    const reason = (headers: Record<string, string>) => foreignApiRequestReason(headers, 4021);
    // WebKit: no-cors POST from the (service-worker controlled) preview page.
    expect(reason({ origin: 'null', 'sec-fetch-site': 'same-site' })).toMatch(/opaque/);
    expect(reason({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' })).toMatch(
      /same-site/
    );
    expect(reason({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })).toMatch(
      /cross-site/
    );
    expect(reason({ origin: 'https://mac.ts.net:4021' })).toMatch(/preview/);
    expect(
      reason({ origin: 'https://mac.ts.net:4020', 'sec-fetch-site': 'same-origin' })
    ).toBeNull();
    expect(reason({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).toBeNull();
    expect(reason({ authorization: 'Bearer x' })).toBeNull(); // ut, the Mac app, HQ
  });

  // 2026-10-20 (security audit): without Sec-Fetch-* (older browsers) a cross-site page could
  // open /ws or POST, and a DNS-rebound page looks same-origin to the browser.
  it('refuses upgrades and writes whose Origin is not the host they were sent to', () => {
    const ws = { upgrade: 'websocket', connection: 'Upgrade' };
    expect(
      foreignApiRequestReason({ ...ws, origin: 'https://evil.example', host: 'mac.ts.net' }, 4021)
    ).toMatch(/cross-origin/);
    expect(
      foreignApiRequestReason(
        { origin: 'http://evil.example', host: 'localhost:4020' },
        4021,
        null,
        'POST'
      )
    ).toMatch(/cross-origin/);
    // Same origin, directly or behind tailscale serve (X-Forwarded-Host), default ports too.
    expect(
      foreignApiRequestReason(
        { ...ws, origin: 'http://localhost:4020', host: 'localhost:4020' },
        4021
      )
    ).toBeNull();
    expect(
      foreignApiRequestReason(
        { origin: 'https://mac.ts.net', host: 'localhost:4020', 'x-forwarded-host': 'mac.ts.net' },
        4021,
        null,
        'POST'
      )
    ).toBeNull();
    expect(
      foreignApiRequestReason(
        { origin: 'https://mac.ts.net', host: 'mac.ts.net:443' },
        4021,
        null,
        'DELETE'
      )
    ).toBeNull();
    // Reads and clients without Origin are not affected.
    expect(
      foreignApiRequestReason(
        { origin: 'http://evil.example', host: 'localhost:4020' },
        4021,
        null,
        'GET'
      )
    ).toBeNull();
    expect(foreignApiRequestReason({ ...ws, host: 'localhost:4020' }, 4021)).toBeNull();
    expect(originMatchesHost('javascript:alert(1)', { host: 'localhost' })).toBe(false);
  });
});

describe('upgrade sockets', () => {
  it('a client that resets while the upgrade still awaits does not leave an unhandled error', async () => {
    // 2026-11-10: the socket reached handleUpgrade with no 'error' listener, so a reset
    // during its awaits (the dev-server probes) was an uncaught exception: server down.
    let errorListeners = -1;
    let closed: () => void = () => {};
    const gone = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const pass = (_req: unknown, _res: unknown, next: () => void) => next();
    const proxy = {
      handleLogin: pass,
      redirectStrayLoad: pass,
      handleRequest: pass,
      handleUpgrade: async (_req: http.IncomingMessage, socket: net.Socket) => {
        errorListeners = socket.listenerCount('error');
        socket.once('close', closed);
        await gone;
        // What reject() does after the await, on a socket that is already gone.
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        socket.destroy();
      },
    } as unknown as PreviewProxy;
    const server = createPreviewServer(proxy);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = net.connect((server.address() as AddressInfo).port, '127.0.0.1', () => {
        client.write(
          'GET /preview/5173/ HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
        );
        setTimeout(() => client.resetAndDestroy(), 50);
      });
      client.on('error', () => {});
      await gone;
      expect(errorListeners).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('main API origin guard', () => {
  it.each(['/api', '/API', '/Api', '/aPI'])(
    'guards bodyless form POSTs under %s before Tailscale auth',
    async (prefix) => {
      const app = express();
      const cleanup = vi.fn((_req: express.Request, res: express.Response) => res.sendStatus(204));
      app.use(mainOriginPreviewGuard(() => null));
      app.use(
        '/api',
        createAuthMiddleware({
          enableSSHKeys: false,
          disallowUserPassword: false,
          noAuth: false,
          isHQMode: false,
          allowTailscaleAuth: true,
          tailscalePeerCheck: async () => true,
          tailscaleOwners: async () => ['owner@example.com'],
        })
      );
      const router = express.Router();
      router.post('/cleanup-exited', cleanup);
      app.use('/api', router);
      const headers = {
        'tailscale-user-login': 'owner@example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '100.64.0.7',
        'x-forwarded-host': 'mac.tailnet.ts.net',
      };
      const post = () =>
        request(app).post(`${prefix}/cleanup-exited?all=1`).set(headers).type('form');

      const foreign = await post()
        .set('Origin', 'https://evil.example')
        .set('Sec-Fetch-Site', 'cross-site')
        .set('Sec-Fetch-Mode', 'navigate');
      expect(foreign.status).toBe(403);
      expect(cleanup).not.toHaveBeenCalled();
      const noOrigin = await post()
        .set('Sec-Fetch-Site', 'cross-site')
        .set('Sec-Fetch-Mode', 'no-cors');
      expect(noOrigin.status).toBe(403);
      expect(cleanup).not.toHaveBeenCalled();

      const sameOrigin = await post()
        .set('Origin', 'https://mac.tailnet.ts.net')
        .set('Sec-Fetch-Site', 'same-origin');
      expect(sameOrigin.status).toBe(204);
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
  );
});

describe('tickets and sessions', () => {
  it('tickets are single-use and expire', async () => {
    const tickets = new PreviewTickets();
    const grant = { port: 5173, parentOrigin: 'https://ut' };
    const ticket = tickets.issue(grant);
    expect(tickets.redeem(ticket)).toEqual(grant);
    expect(tickets.redeem(ticket)).toBeNull();
    const short = new PreviewTickets(1);
    const old = short.issue(grant);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(short.redeem(old)).toBeNull();
    expect(tickets.redeem(undefined)).toBeNull();
  });

  it('a session only opens the port it was issued for', () => {
    const tokens = new PreviewTokens();
    const { token, maxAgeSeconds } = tokens.issue({ port: 5173, parentOrigin: 'https://ut' });
    expect(maxAgeSeconds).toBe(12 * 60 * 60);
    expect(tokens.verify(token, 5173)).not.toBeNull();
    expect(tokens.verify(token, 3000)).toBeNull();
  });

  it('login only redirects inside the ticket port', () => {
    expect(safeNextPath('/preview/5173/a?b=1', 5173)).toBe('/preview/5173/a?b=1');
    expect(safeNextPath('/preview/3000/', 5173)).toBe('/preview/5173/');
    expect(safeNextPath('//evil.com/preview/5173/', 5173)).toBe('/preview/5173/');
    expect(safeNextPath('https://evil.com/', 5173)).toBe('/preview/5173/');
    expect(safeNextPath(undefined, 5173)).toBe('/preview/5173/');
  });
});

describe('preview origin end to end', () => {
  let upstream: http.Server;
  let upstreamWss: WebSocketServer;
  let upstreamPort: number;
  let secureUpstream: https.Server;
  let secureWss: WebSocketServer;
  let securePort: number;
  let main: http.Server;
  let mainPort: number;
  let preview: http.Server;
  let previewPort: number;
  const parentOrigin = 'http://ut.test:4020';
  // What the Untether page's browser sends: its Origin and the Host it talks to (2026-10-20:
  // a write whose Origin is not its Host is refused).
  const fromParent = { origin: parentOrigin, host: 'ut.test:4020' };
  const seen: http.IncomingHttpHeaders[] = [];
  const registry = new PreviewRegistry();

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
          'set-cookie': 'sid=1; Path=/',
        });
        res.end('<html><head></head><body>app</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`// ${req.url}`);
    });
    upstreamWss = new WebSocketServer({ server: upstream });
    upstreamWss.on('connection', (ws, req) => {
      ws.send(JSON.stringify({ type: 'connected', url: req.url, host: req.headers.host }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    // An app that only serves https, like one behind an OAuth or banking callback, with a
    // throwaway certificate made here (no private key lives in the repository).
    secureUpstream = https.createServer(
      opensslAvailable ? throwawayLocalhostCertificate() : {},
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head></head><body>secure app</body></html>');
      }
    );
    secureWss = new WebSocketServer({ server: secureUpstream });
    secureWss.on('connection', (ws, req) => {
      ws.send(JSON.stringify({ type: 'connected', url: req.url, secure: true }));
    });
    await new Promise<void>((resolve) => secureUpstream.listen(0, '127.0.0.1', resolve));
    securePort = (secureUpstream.address() as AddressInfo).port;

    const proxy = createPreviewProxy({ getOwnPorts: () => [mainPort, previewPort] });

    // A stand-in for the main server: bearer auth, the origin guard and the real routes.
    const app = express();
    app.use(mainOriginPreviewGuard(() => previewPort));
    app.use(express.json());
    app.use('/api', (req, res, next) => {
      if (req.headers.authorization === 'Bearer good') return next();
      res.status(401).json({ error: 'auth' });
    });
    app.use(
      '/api',
      createPreviewRoutes({
        previewProxy: proxy,
        previewRegistry: registry,
        getOwnPort: () => mainPort,
        getPreviewPort: () => previewPort,
        sessionExists: () => false,
      })
    );
    main = http.createServer(app);
    await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve));
    mainPort = (main.address() as AddressInfo).port;

    preview = createPreviewServer(proxy);
    await new Promise<void>((resolve) => preview.listen(0, '127.0.0.1', resolve));
    previewPort = (preview.address() as AddressInfo).port;
  });

  afterAll(async () => {
    upstreamWss.close();
    secureWss.close();
    await new Promise((resolve) => upstream.close(resolve));
    secureUpstream.closeAllConnections?.();
    await new Promise((resolve) => secureUpstream.close(resolve));
    for (const server of [main, preview]) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // node:http, not fetch: fetch drops Origin/Sec-Fetch-* request headers.
  const request = (
    port: number,
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
  ) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        // Match the browser's per-app Host while all test connections go to loopback.
        const next = new URL(path, parentOrigin).searchParams.get('next');
        const appPort =
          parsePreviewUrl(next ?? path)?.port ??
          Number(/ut_preview_port=(\d+)/.exec(options.headers?.cookie ?? '')?.[1]);
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path,
            method: options.method ?? 'GET',
            headers: {
              ...(port === previewPort && appPort
                ? { host: `ut-preview-${appPort}.ut.test:${previewPort}` }
                : {}),
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...options.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              })
            );
          }
        );
        req.on('error', reject);
        req.end(body);
      }
    );

  const ticket = async (port = upstreamPort, path = '/') => {
    const res = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', ...fromParent },
      body: { port, path },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body).loginPath as string;
  };

  const login = async (port = upstreamPort) => {
    const res = await request(previewPort, await ticket(port));
    expect(res.status).toBe(302);
    return { res, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] };
  };

  it('binds each app to its own hostname even when both session cookies are supplied', async () => {
    const first = await login();
    const second = await login(securePort);
    const cookie = `${first.cookie}; ${second.cookie}`;
    const attackerOrigin = `http://ut-preview-${securePort}.ut.test:${previewPort}`;
    for (const method of ['GET', 'POST']) {
      for (const headers of [
        { host: new URL(attackerOrigin).host },
        { origin: attackerOrigin },
        { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' },
        { referer: `${attackerOrigin}/outside-the-service-worker` },
        { host: `ut.test:${previewPort}` },
        {
          host: new URL(attackerOrigin).host,
          'x-forwarded-host': `ut-preview-${upstreamPort}.ut.test:${previewPort}`,
        },
      ]) {
        const before = seen.length;
        const denied = await request(previewPort, `/preview/${upstreamPort}/private`, {
          method,
          headers: { cookie, ...headers },
        });
        expect(denied.status).toBe(401);
        expect(seen.length).toBe(before);
      }
    }
    const own = await request(previewPort, `/preview/${upstreamPort}/private`, {
      headers: {
        cookie: first.cookie,
        origin: `http://ut-preview-${upstreamPort}.ut.test:${previewPort}`,
      },
    });
    expect(own.status).toBe(200);
    expect(own.headers['origin-agent-cluster']).toBe('?1');
    expect(first.res.headers['set-cookie']?.[0]).not.toMatch(/Domain=/i);
  });

  it('cannot redeem an app ticket on the shared host or another app host', async () => {
    for (const host of [
      `ut.test:${previewPort}`,
      `ut-preview-${securePort}.ut.test:${previewPort}`,
    ]) {
      const result = await request(previewPort, await ticket(), { headers: { host } });
      expect(result.status).toBe(401);
      expect(result.headers['set-cookie']).toBeUndefined();
    }
  });

  it('returns distinct app origins and refuses a shared Tailscale origin', async () => {
    const origins = [];
    for (const port of [upstreamPort, securePort]) {
      const result = await request(mainPort, '/api/preview/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer good', ...fromParent },
        body: { port },
      });
      expect(result.status).toBe(200);
      origins.push(JSON.parse(result.body).loginOrigin);
    }
    expect(new Set(origins).size).toBe(2);
    expect(origins).not.toContain(parentOrigin);
    const denied = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: {
        authorization: 'Bearer good',
        origin: 'https://mac.tail.ts.net',
        host: 'mac.tail.ts.net',
      },
      body: { port: upstreamPort },
    });
    expect(denied.status).toBe(503);
    expect(JSON.parse(denied.body).error).toContain('separate hostname per app');
  });

  it('never shows another Untether server, and marks its own responses as Untether', async () => {
    // Stands in for a second Untether (a QA server on 4030): it says so in every response.
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'x-untether-server': '1' });
      res.end('// the other Untether');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherPort = (other.address() as AddressInfo).port;
    try {
      const { cookie } = await login(otherPort);
      const asset = await request(previewPort, `/preview/${otherPort}/bundle.js`, {
        headers: { cookie, 'sec-fetch-mode': 'no-cors', accept: '*/*' },
      });
      expect(asset.status).toBe(403);
      expect(asset.body).toContain('another Untether server');
      expect(asset.body).not.toContain('the other Untether');
      // From then on it isn't even offered.
      const again = await request(mainPort, '/api/preview/ticket', {
        method: 'POST',
        headers: { authorization: 'Bearer good', ...fromParent },
        body: { port: otherPort, path: '/' },
      });
      expect(again.status).toBe(403);
      // This preview origin says it is Untether too.
      expect(asset.headers['x-untether-server']).toBe('1');
    } finally {
      other.closeAllConnections?.();
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it('the main API reports the preview port and needs its own auth for tickets', async () => {
    const config = await request(mainPort, '/api/preview/config', {
      headers: { authorization: 'Bearer good' },
    });
    expect(JSON.parse(config.body)).toEqual({ enabled: true, port: previewPort, origin: null });
    const anon = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { ...fromParent },
      body: { port: upstreamPort },
    });
    expect(anon.status).toBe(401);
    const own = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', ...fromParent },
      body: { port: previewPort },
    });
    expect(own.status).toBe(403);
  });

  it('a ticket logs in once, sets a port-bound HttpOnly SameSite=Strict cookie', async () => {
    const loginPath = await ticket(upstreamPort, '/about?x=1');
    const first = await request(previewPort, loginPath);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`/preview/${upstreamPort}/about?x=1`);
    const cookie = String(first.headers['set-cookie']?.[0]);
    expect(cookie).toMatch(new RegExp(`^ut_preview_${upstreamPort}=`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(new RegExp(`Path=/preview/${upstreamPort}/`));
    expect(cookie).toMatch(/Max-Age=43200/);
    expect((await request(previewPort, loginPath)).status).toBe(401); // burnt
    expect((await request(previewPort, '/__ut_preview_login?ticket=forged')).status).toBe(401);
  });

  it('a saved preview opens with no session at all (ticket by preview id)', async () => {
    const { id } = registry.addManual(upstreamPort, '/about');
    const res = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', ...fromParent },
      body: { id, path: '/about' },
    });
    expect(res.status).toBe(200);
    const first = await request(previewPort, JSON.parse(res.body).loginPath);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`/preview/${upstreamPort}/about`);
    const cookie = String(first.headers['set-cookie']?.[0] ?? '').split(';')[0];
    const page = await request(previewPort, `/preview/${upstreamPort}/main.js`, {
      headers: { cookie, [PREVIEW_SW_HEADER]: '1' },
    });
    expect(page.status).toBe(200);
    expect(page.body).toBe('// /main.js');

    const unknown = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', ...fromParent },
      body: { id: 'pnothere1' },
    });
    expect(unknown.status).toBe(404);
    const anon = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { ...fromParent },
      body: { id },
    });
    expect(anon.status).toBe(401);
  });

  it('serves only previews: no API, no UI, nothing without the preview cookie', async () => {
    for (const path of ['/', '/api/sessions', '/api/preview/config', '/index.html']) {
      const res = await request(previewPort, path, { headers: { authorization: 'Bearer good' } });
      expect(res.status).toBe(404);
    }
    // The main origin's credentials mean nothing here.
    const bearer = await request(previewPort, `/preview/${upstreamPort}/main.js`, {
      headers: { authorization: 'Bearer good', 'tailscale-user-login': 'me@example.com' },
    });
    expect(bearer.status).toBe(401);
  });

  it('proxies with the cookie, only for its port, never forwarding it', async () => {
    const { cookie } = await login();
    const res = await request(previewPort, `/preview/${upstreamPort}/main.js?x=1`, {
      headers: { cookie: `${cookie}; app=1`, [PREVIEW_SW_HEADER]: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('// /main.js?x=1');
    expect(seen[seen.length - 1].cookie).toBe('app=1');
    // The same session value under another port's name opens nothing.
    const value = cookie.split('=')[1];
    const other = await request(previewPort, '/preview/3999/main.js', {
      headers: { cookie: `ut_preview_3999=${value}` },
    });
    expect(other.status).toBe(401);
  });

  it('the preview cookie is not accepted by the main API, and the main origin has no previews', async () => {
    const { cookie } = await login();
    expect((await request(mainPort, '/api/preview/config', { headers: { cookie } })).status).toBe(
      401
    );
    const old = await request(mainPort, `/preview/${upstreamPort}/`, {
      headers: { cookie, authorization: 'Bearer good' },
    });
    expect(old.status).toBe(404);
  });

  it('the main origin refuses requests made from the preview origin', async () => {
    const res = await request(mainPort, '/api/preview/config', {
      headers: { authorization: 'Bearer good', origin: `http://127.0.0.1:${previewPort}` },
    });
    expect(res.status).toBe(403);
    const opaque = await request(mainPort, '/api/preview/ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer good', origin: 'null' },
      body: { port: upstreamPort },
    });
    expect(opaque.status).toBe(403);
  });

  it('only the Untether origin that asked may frame the preview', async () => {
    const { cookie } = await login();
    const boot = await request(previewPort, `/preview/${upstreamPort}/`, {
      headers: { cookie, 'sec-fetch-mode': 'navigate' },
    });
    expect(boot.body).toContain('serviceWorker');
    expect(boot.headers['content-security-policy']).toBe(`frame-ancestors ${parentOrigin}`);
    const app = await request(previewPort, `/preview/${upstreamPort}/`, {
      headers: { cookie, 'sec-fetch-mode': 'navigate', [PREVIEW_SW_HEADER]: '1' },
    });
    expect(app.body).toContain(`<script src="/preview/${upstreamPort}/__ut_preview_client.js">`);
    expect(app.headers['x-frame-options']).toBeUndefined();
    // Node joins repeated CSP headers with ", ": the app's policy, then ours.
    expect(app.headers['content-security-policy']).toBe(
      `default-src 'self', frame-ancestors ${parentOrigin}`
    );
    const client = await request(previewPort, `/preview/${upstreamPort}/__ut_preview_client.js`, {
      headers: { cookie },
    });
    expect(client.body).toContain(JSON.stringify(parentOrigin));
  });

  it('sends a stray full load back under the last port', async () => {
    const res = await request(previewPort, '/about?x=1', {
      headers: { 'sec-fetch-dest': 'iframe', cookie: `ut_preview_port=${upstreamPort}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/preview/${upstreamPort}/about?x=1`);
    const own = await request(previewPort, '/about', {
      headers: { 'sec-fetch-dest': 'document', cookie: `ut_preview_port=${mainPort}` },
    });
    expect(own.status).toBe(404);
  });

  const openSocket = (port: number, path: string, headers: Record<string, string>) =>
    new Promise<{ ok: boolean; message?: string; status?: number }>((resolve) => {
      const appPort = parsePreviewUrl(path)?.port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
        headers: {
          ...(appPort ? { host: `ut-preview-${appPort}.ut.test:${previewPort}` } : {}),
          ...headers,
        },
      });
      ws.on('message', (data) => {
        resolve({ ok: true, message: String(data) });
        ws.close();
      });
      ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
      ws.on('error', () => resolve({ ok: false }));
    });

  it('WebSocket upgrades (HMR) need the preview cookie for that port', async () => {
    const path = `/preview/${upstreamPort}/?token=vite`;
    expect((await openSocket(previewPort, path, {})).status).toBe(401);
    expect((await openSocket(previewPort, path, { authorization: 'Bearer good' })).status).toBe(
      401
    );
    expect((await openSocket(previewPort, '/ws', {})).status).toBe(404);
    const { cookie } = await login();
    const result = await openSocket(previewPort, path, { cookie });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.message ?? '{}')).toEqual({
      type: 'connected',
      url: '/?token=vite',
      host: `localhost:${upstreamPort}`,
    });
  });

  it('refuses a sibling app WebSocket even with the target session cookie', async () => {
    const { cookie } = await login();
    const path = `/preview/${upstreamPort}/live`;
    expect(
      (
        await openSocket(previewPort, path, {
          cookie,
          host: `ut-preview-${securePort}.ut.test:${previewPort}`,
        })
      ).status
    ).toBe(401);
    expect(
      (
        await openSocket(previewPort, path, {
          cookie,
          origin: `http://ut-preview-${securePort}.ut.test:${previewPort}`,
        })
      ).status
    ).toBe(401);
  });
  it.skipIf(!opensslAvailable)(
    'reaches an app that only serves https over TLS, pages and WebSockets',
    async () => {
      const { cookie } = await login(securePort);
      const res = await request(previewPort, `/preview/${securePort}/`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.body).toContain('secure app');
      expect(res.body).toContain('__ut_preview_client.js');
      const result = await openSocket(previewPort, `/preview/${securePort}/live`, { cookie });
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.message ?? '{}')).toEqual({
        type: 'connected',
        url: '/live',
        secure: true,
      });
    }
  );
});
