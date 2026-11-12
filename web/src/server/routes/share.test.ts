import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ShareStore } from '../services/share-store.js';
import { createShareApiRoutes, createShareViewRoutes, type ShareScreen } from './share.js';

function setup() {
  let now = 1_000_000;
  const store = new ShareStore({ now: () => now });
  const screens: Record<string, ShareScreen | null> = {
    s1: { title: 'tienda', running: true, text: '$ npm test\n<b>ok</b>', cols: 100 },
    s2: { title: 'otra', running: true, text: 'secreto de otra sesión', cols: 80 },
  };
  const config = {
    store,
    sessionExists: (id: string) => id in screens,
    readScreen: async (id: string) => screens[id] ?? null,
  };
  const app = express();
  app.use(express.json());
  app.use(createShareViewRoutes(config));
  // Stand-in for the login in front of /api.
  app.use('/api', (req, res, next) =>
    req.headers.authorization === 'Bearer ok' ? next() : res.status(401).json({ error: 'auth' })
  );
  app.use('/api', createShareApiRoutes(config));
  return { app, store, screens, advance: (ms: number) => (now += ms) };
}

const create = (app: express.Express, sessionId = 's1', minutes = 60) =>
  request(app)
    .post(`/api/sessions/${sessionId}/shares`)
    .set('Authorization', 'Bearer ok')
    .send({ minutes });

describe('read-only share links', () => {
  it('only a logged-in user creates, lists and revokes them', async () => {
    const { app } = setup();
    expect((await request(app).post('/api/sessions/s1/shares').send({})).status).toBe(401);
    const created = await create(app);
    expect(created.status).toBe(201);
    expect(created.body.share.path).toBe(`/share/${created.body.share.token}`);
    expect((await create(app, 'nope')).status).toBe(404);
    expect((await create(app, 's1', -5)).status).toBe(400);
    const list = await request(app)
      .get('/api/sessions/s1/shares')
      .set('Authorization', 'Bearer ok');
    expect(list.body.shares).toHaveLength(1);
    const revoked = await request(app)
      .delete(`/api/shares/${created.body.share.token}`)
      .set('Authorization', 'Bearer ok');
    expect(revoked.body.revoked).toBe(true);
    expect((await request(app).get(`${created.body.share.path}/screen`)).status).toBe(404);
  });

  it('the link shows that session’s screen only, as data, without the login', async () => {
    const { app } = setup();
    const { path } = (await create(app)).body.share;
    const page = await request(app).get(path);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    // The page itself carries no screen content; the feed does, as JSON.
    expect(page.text).not.toContain('npm test');
    const feed = await request(app).get(`${path}/screen`);
    expect(feed.body).toMatchObject({ title: 'tienda', running: true, cols: 100 });
    expect(feed.body.text).toBe('$ npm test\n<b>ok</b>');
    expect(JSON.stringify(feed.body)).not.toContain('secreto');
  });

  it('an unknown, malformed or expired link is a 404 page', async () => {
    const { app, advance } = setup();
    const { path } = (await create(app, 's1', 15)).body.share;
    expect((await request(app).get('/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await request(app).get('/share/..%2F..%2Fapi')).status).toBe(404);
    advance(15 * 60_000);
    const page = await request(app).get(path);
    expect(page.status).toBe(404);
    expect(page.text).toContain('expired');
    expect(page.text).not.toContain('id="meta"');
    expect((await request(app).get(`${path}/screen`)).status).toBe(404);
  });

  it('says the session ended when it is gone', async () => {
    const { app, screens } = setup();
    const { path } = (await create(app)).body.share;
    screens.s1 = null;
    const feed = await request(app).get(`${path}/screen`);
    expect(feed.body).toMatchObject({ ended: true });
  });
});
