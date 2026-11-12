import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PreviewItem } from '../../shared/types.js';
import type { PortListener, ProbeAnswer } from '../services/preview-candidates.js';
import { PreviewHealthMonitor } from '../services/preview-health.js';
import { createPreviewProxy } from '../services/preview-proxy.js';
import { PreviewRegistry, previewReadyPush } from '../services/preview-registry.js';
import { mainOriginPreviewGuard } from '../services/preview-server.js';
import { createPreviewRoutes, createUtOpenHandler } from './preview.js';

/** Persistent previews (2026-10-03): list, add, pin, rename, delete, health. */
describe('previews API', () => {
  let main: http.Server;
  let mainPort = 0;
  let upstream: http.Server;
  let upstreamPort = 0;
  let registry: PreviewRegistry;
  let health: PreviewHealthMonitor;
  const running = new Set<string>();
  // GET /api/previews/candidates never runs lsof or probes a real port here.
  let listening: PortListener[] = [];
  let answers = new Map<number, ProbeAnswer>();
  const probed: number[] = [];

  const startUpstream = async (port = 0) => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Mi tienda &amp; demo</title></head><body>app</body></html>');
    });
    await new Promise<void>((resolve) => upstream.listen(port, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  };

  beforeAll(async () => {
    await startUpstream();
    registry = new PreviewRegistry();
    registry.setSessionNames((id) => `name-${id}`);
    health = new PreviewHealthMonitor({ registry });
    const app = express();
    app.use(mainOriginPreviewGuard(() => null));
    app.use(express.json());
    app.use('/api', (req, res, next) => {
      if (req.headers.authorization === 'Bearer good') return next();
      res.status(401).json({ error: 'auth' });
    });
    app.use(
      '/api',
      createPreviewRoutes({
        previewProxy: createPreviewProxy({
          getOwnPorts: () => [mainPort],
          deniedPorts: new Set([18789]),
        }),
        previewRegistry: registry,
        getOwnPort: () => mainPort,
        getPreviewPort: () => null,
        sessionExists: (id) => running.has(id),
        sessionRunning: (id) => running.has(id),
        sessionName: (id) => `live-${id}`,
        health,
        candidates: {
          listListeners: async () => listening,
          probe: async (port) => {
            probed.push(port);
            return answers.get(port) ?? null;
          },
        },
      })
    );
    // As server-static.ts serves the app's own preview view.
    app.get('/preview/:id', (_req, res) => {
      res.type('text/html').send('<!doctype html><title>app</title>');
    });
    main = http.createServer(app);
    await new Promise<void>((resolve) => main.listen(0, '127.0.0.1', resolve));
    mainPort = (main.address() as AddressInfo).port;
  });

  beforeEach(() => {
    for (const entry of registry.all()) registry.remove(entry.id);
    running.clear();
  });

  afterAll(async () => {
    for (const server of [main, upstream]) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const call = (path: string, method = 'GET', body?: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${mainPort}${path}`, {
      method,
      headers: {
        ...(auth ? { authorization: 'Bearer good' } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async () =>
    ((await (await call('/api/previews')).json()) as { previews: PreviewItem[] }).previews;

  it('a preview stays listed after its session exits, with its title and live state', async () => {
    running.add('s1');
    const { id } = registry.open('s1', upstreamPort, '/');
    await health.checkAll();
    expect(await list()).toEqual([
      expect.objectContaining({
        id,
        port: upstreamPort,
        sessionId: 's1',
        sessionName: 'live-s1',
        sessionAlive: true,
        state: 'live',
        title: 'Mi tienda & demo',
        pinned: false,
      }),
    ]);

    running.delete('s1'); // the session ends (or restarts with a new id)
    expect(await list()).toEqual([
      expect.objectContaining({ id, sessionName: 'name-s1', sessionAlive: false, state: 'live' }),
    ]);
  });

  it('marks a stopped dev server down, and Retry checks it again at once', async () => {
    const { id } = registry.addManual(upstreamPort);
    await health.checkAll();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    try {
      await health.checkAll();
      expect((await list())[0].state).toBe('down');
      const retry = await call(`/api/previews/${id}/check`, 'POST');
      expect(await retry.json()).toEqual({ state: 'down' });
    } finally {
      await startUpstream(upstreamPort);
    }
    const back = await call(`/api/previews/${id}/check`, 'POST');
    expect(await back.json()).toEqual({ state: 'live' });
    expect((await call('/api/previews/pnothere1/check', 'POST')).status).toBe(404);
  });

  it('every preview route needs Untether auth', async () => {
    const { id } = registry.addManual(5173);
    const anon = [
      await call('/api/previews', 'GET', undefined, false),
      await call('/api/previews', 'POST', { port: 3000 }, false),
      await call(`/api/previews/${id}`, 'PATCH', { pinned: true }, false),
      await call(`/api/previews/${id}`, 'DELETE', undefined, false),
      await call(`/api/previews/${id}/check`, 'POST', undefined, false),
      await call('/api/previews/candidates', 'GET', undefined, false),
    ];
    expect(anon.map((res) => res.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(registry.all()).toHaveLength(1);
    expect(registry.get(id)?.pinned).toBe(false);
  });

  it('adds a preview by port or localhost URL, never another host or a forbidden port', async () => {
    const added = await call('/api/previews', 'POST', { url: `localhost:${upstreamPort}/about` });
    expect(added.status).toBe(201);
    const { preview } = (await added.json()) as { preview: PreviewItem };
    expect(preview).toMatchObject({ port: upstreamPort, path: '/about', source: 'manual' });
    expect(preview.state).toBe('live');
    expect(preview.sessionId).toBeUndefined();

    const refused = [
      await call('/api/previews', 'POST', { url: 'https://example.com:5173/' }),
      await call('/api/previews', 'POST', { url: 'http://192.168.1.20:3000' }),
      await call('/api/previews', 'POST', {}),
      await call('/api/previews', 'POST', { port: 80 }),
      await call('/api/previews', 'POST', { port: 70000 }),
      await call('/api/previews', 'POST', { port: mainPort }),
      await call('/api/previews', 'POST', { port: 18789 }),
    ];
    expect(refused.map((res) => res.status)).toEqual([400, 400, 400, 403, 403, 403, 403]);
    expect(registry.all()).toHaveLength(1);

    // The same port again is the same preview, back on top.
    const again = await call('/api/previews', 'POST', { port: upstreamPort });
    expect(((await again.json()) as { preview: PreviewItem }).preview.id).toBe(preview.id);
    expect(registry.all()).toHaveLength(1);
  });

  it("offers the web servers on the Mac, minus Untether's own, denied and saved ports", async () => {
    registry.addManual(5180);
    const node = { pid: 10, command: 'node', host: '127.0.0.1' };
    listening = [
      { ...node, port: mainPort },
      { ...node, port: 18789 },
      { ...node, port: 5180, command: 'Python' },
      { ...node, port: 631, command: 'cupsd' },
      { ...node, port: 8501, command: 'Python', folder: 'decaycoin' },
      { ...node, port: 5173, host: '::1', folder: 'shop' },
      { ...node, port: 5173, pid: 11, host: '::1', folder: 'shop' },
      { ...node, port: 6379, command: 'redis-server' },
    ];
    answers = new Map<number, ProbeAnswer>([
      [mainPort, {}],
      [18789, {}],
      [5180, { title: 'Inicio' }],
      [631, {}],
      [5173, { title: 'Mi tienda' }],
      [8501, {}],
    ]);
    const res = await call('/api/previews/candidates');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      candidates: [
        { port: 5173, title: 'Mi tienda', process: 'node', folder: 'shop' },
        { port: 8501, process: 'Python', folder: 'decaycoin' },
      ],
    });
    expect(probed.sort((a, b) => a - b)).toEqual([5173, 6379, 8501]);
  });

  it('pins, renames and deletes; refuses bad changes', async () => {
    const { id } = registry.addManual(5173);
    const pin = await call(`/api/previews/${id}`, 'PATCH', {
      pinned: true,
      customName: ' Tienda ',
    });
    expect(pin.status).toBe(200);
    expect(((await pin.json()) as { preview: PreviewItem }).preview).toMatchObject({
      pinned: true,
      customName: 'Tienda',
    });
    const cleared = await call(`/api/previews/${id}`, 'PATCH', { customName: '' });
    expect(((await cleared.json()) as { preview: PreviewItem }).preview.customName).toBeUndefined();

    const bad = [
      await call(`/api/previews/${id}`, 'PATCH', { pinned: 'yes' }),
      await call(`/api/previews/${id}`, 'PATCH', { customName: 5 }),
      await call(`/api/previews/${id}`, 'PATCH', { customName: 'x'.repeat(201) }),
      await call(`/api/previews/${id}`, 'PATCH', {}),
    ];
    expect(bad.map((res) => res.status)).toEqual([400, 400, 400, 400]);
    expect((await call('/api/previews/pnothere1', 'PATCH', { pinned: true })).status).toBe(404);
    expect((await call('/api/previews/..%2Fx', 'PATCH', { pinned: true })).status).toBe(404);

    expect((await call(`/api/previews/${id}`, 'DELETE')).status).toBe(200);
    expect(registry.all()).toEqual([]);
    expect((await call(`/api/previews/${id}`, 'DELETE')).status).toBe(404);
  });

  it('serves /preview/<id> on the main origin, but not the old /preview/<port>/ paths', async () => {
    const { id } = registry.addManual(5173);
    expect((await call(`/preview/${id}`, 'GET', undefined, false)).status).toBe(200);
    // 2026-11-11: /preview/<session>/<port> was still served as a page of the app, which
    // has not read that form since previews have ids.
    expect((await call('/preview/0b1c-session/5173', 'GET', undefined, false)).status).toBe(404);
    expect((await call('/preview/5173/', 'GET', undefined, false)).status).toBe(404);
    expect((await call('/preview/5173/main.js', 'GET', undefined, false)).status).toBe(404);
  });

  it('"Preview ready" deep-links straight into /preview/<id>', () => {
    const push = previewReadyPush(
      { id: 'pshop123', sessionId: 's1', port: 5173, path: '/cart' },
      'web'
    );
    expect(push.data.url).toBe('/preview/pshop123?path=%2Fcart');
    expect(push.data.id).toBe('pshop123');
  });
});

describe('`ut open` over the API socket', () => {
  it('saves the preview, bumps it when opened again, and deep-links "Preview ready" to it', () => {
    let now = 1000;
    const registry = new PreviewRegistry({ now: () => now });
    registry.setSessionNames(() => 'tienda');
    const opened: Array<{ id: string; port: number; path: string }> = [];
    registry.on('open', (event) => opened.push(event));
    const utOpen = createUtOpenHandler({
      registry,
      sessionExists: (id) => id === 's1' || id === 's2',
      portError: (port) => (port === 4020 ? "Untether's own port" : null),
    });

    const first = utOpen({ sessionId: 's1', target: '5173' });
    expect(first).toMatchObject({ success: true, port: 5173, path: '/' });
    now = 2000;
    utOpen({ sessionId: 's1', target: '3000' });
    now = 3000;
    const again = utOpen({ sessionId: 's2', target: 'localhost:5173/cart' });
    expect(again).toEqual({ success: true, id: first.id, port: 5173, path: '/cart' });
    expect(registry.all().map((entry) => [entry.port, entry.sessionId])).toEqual([
      [5173, 's2'],
      [3000, 's1'],
    ]);
    const push = previewReadyPush(opened[2] as never, 'tienda');
    expect(push.data.url).toBe(`/preview/${first.id}?path=%2Fcart`);

    expect(utOpen({ sessionId: 'nope', target: '5173' })).toEqual({
      success: false,
      error: 'unknown session',
    });
    expect(utOpen({ sessionId: 's1', target: '4020' })).toEqual({
      success: false,
      error: "Untether's own port",
    });
    expect(utOpen({ sessionId: 's1', target: 'https://example.com' }).success).toBe(false);
  });
});
