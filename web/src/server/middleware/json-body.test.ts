import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { apiJsonParsers, SMALL_JSON_PATHS, smallJsonParser } from './json-body.js';

/** The order server.ts mounts them in, with a stand-in auth middleware. */
function app(signedIn: boolean) {
  const seen = vi.fn();
  const server = express();
  server.use(SMALL_JSON_PATHS, smallJsonParser());
  server.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth') || signedIn) return next();
    // The body was never read: an unauthenticated client can't make the server parse it.
    seen(req.body);
    res.status(401).json({ error: 'unauthorized' });
  });
  const parsers = apiJsonParsers();
  server.use('/api', parsers.api);
  server.use(parsers.other);
  server.post(['/api/auth/login', '/api/logs/client', '/api/sessions', '/share/x'], (req, res) =>
    res.json({ size: JSON.stringify(req.body).length })
  );
  server.use(((error, _req, res, _next) =>
    res.status(error.status ?? 500).json({ error: error.type })) as express.ErrorRequestHandler);
  return { server, seen };
}

const body = (bytes: number) => ({ text: 'x'.repeat(bytes) });

describe('JSON body parsers', () => {
  it('client logs and login take at most 256 KB', async () => {
    const { server } = app(true);
    for (const route of ['/api/logs/client', '/api/auth/login']) {
      expect((await request(server).post(route).send(body(1000))).status, route).toBe(200);
      expect(
        (
          await request(server)
            .post(route)
            .send(body(300 * 1024))
        ).status,
        route
      ).toBe(413);
    }
  });

  it('signed-in API requests still take up to 10 MB', async () => {
    const { server } = app(true);
    const res = await request(server)
      .post('/api/sessions')
      .send(body(2 * 1024 * 1024));
    expect(res.status).toBe(200);
    expect(res.body.size).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('an unauthenticated API request is refused before its body is parsed', async () => {
    const { server, seen } = app(false);
    // The 401 goes out before the 2 MB body is read, so under load the client may still be
    // writing when the socket closes (EPIPE / ECONNRESET): that is the refusal too.
    try {
      const res = await request(server)
        .post('/api/sessions')
        .send(body(2 * 1024 * 1024));
      expect(res.status).toBe(401);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toMatch(/^(EPIPE|ECONNRESET)$/);
    }
    for (const [parsed] of seen.mock.calls) expect(parsed).toBeUndefined();
  });

  it('routes outside /api take small bodies only', async () => {
    const { server } = app(true);
    expect((await request(server).post('/share/x').send(body(1000))).status).toBe(200);
    expect(
      (
        await request(server)
          .post('/share/x')
          .send(body(300 * 1024))
      ).status
    ).toBe(413);
  });
});
