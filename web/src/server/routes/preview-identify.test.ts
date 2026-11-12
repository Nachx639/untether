import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isUntetherServer } from '../services/preview-health.js';
import { createPreviewProxy } from '../services/preview-proxy.js';
import { PreviewRegistry } from '../services/preview-registry.js';
import { createPreviewRoutes } from './preview.js';

// 2026-10-03: a preview of Untether itself got registered. Other Untether servers (a QA
// one on 4030) are found by asking the port, before anything is added or opened.
describe('another Untether server is never added or opened as a preview', () => {
  const servers: http.Server[] = [];
  let otherUntether = 0;
  let devServer = 0;
  const registry = new PreviewRegistry();
  const proxy = createPreviewProxy({
    getOwnPorts: () => [4020, 4021],
    onUntetherPort: () => registry.removeRefused(),
  });
  registry.setPortFilter((port) => proxy.portError(port));
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createPreviewRoutes({
      previewProxy: proxy,
      previewRegistry: registry,
      getOwnPort: () => 4020,
      getPreviewPort: () => 4021,
      sessionExists: (id) => id === 's1',
      identifyPort: async (port) => {
        if (await isUntetherServer(port)) proxy.noteUntetherPort(port);
      },
    })
  );

  const listen = async (headers: Record<string, string>) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', ...headers });
      res.end('<title>x</title>');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  beforeAll(async () => {
    otherUntether = await listen({ 'x-untether-server': '1' });
    devServer = await listen({});
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('"+ Añadir vista previa" and a ticket both refuse it', async () => {
    const add = await request(app).post('/api/previews').send({ port: otherUntether });
    expect(add.status).toBe(403);
    expect(add.body.error).toContain('another Untether server');
    const ticket = await request(app)
      .post('/api/preview/ticket')
      .set('Origin', 'http://ut.test:4020')
      .send({ port: otherUntether });
    expect(ticket.status).toBe(403);
    expect(registry.ports()).toEqual([]);
  });

  it('a dev server is still added', async () => {
    const add = await request(app).post('/api/previews').send({ port: devServer });
    expect(add.status).toBe(201);
    expect(registry.ports()).toEqual([devServer]);
  });

  it("Untether's own port is refused without asking it", async () => {
    const add = await request(app).post('/api/previews').send({ port: 4020 });
    expect(add.status).toBe(403);
    expect(add.body.error).toContain("Untether's own port");
  });
});
