import * as net from 'node:net';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

function tryToListen(port: number): Promise<string> {
  return new Promise((resolve) => {
    const thief = net.createServer();
    thief.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    thief.listen(port, '127.0.0.1', () => thief.close(() => resolve('bound')));
  });
}

/** src/test/loopback-servers.ts (2026-10-04: route tests answered by another process). */
describe('test servers on loopback', () => {
  it("supertest's server holds its port on 127.0.0.1, so no other listener can take it", async () => {
    const app = express();
    app.get('/where', async (req, res) => {
      res.json({
        address: req.socket.localAddress,
        // On the wildcard this bind succeeded and then received the test's connections.
        second: await tryToListen(req.socket.localPort ?? 0),
      });
    });

    const response = await request(app).get('/where').query({ q: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ address: '127.0.0.1', second: 'EADDRINUSE' });
  });

  it('an agent shares one server across requests started before it listens', async () => {
    const agent = request.agent(express().get('/ok', (_req, res) => res.send('ok')));
    const [first, second] = await Promise.all([agent.get('/ok'), agent.get('/ok')]);
    expect([first.text, second.text]).toEqual(['ok', 'ok']);
  });

  it('refuses a port-0 listen on the wildcard', () => {
    const server = net.createServer();
    expect(() => server.listen(0)).toThrow(/without a host/);
    expect(() => server.listen({ port: 0 })).toThrow(/without a host/);
  });
});
