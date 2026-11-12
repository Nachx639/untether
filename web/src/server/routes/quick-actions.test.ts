import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { createQuickActionsRoutes } from './quick-actions';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

describe('quick actions routes', () => {
  let dir: string;
  let app: express.Express;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-quick-actions-route-')));
    const session = { id: 's1', workingDir: dir, status: 'running' } as unknown as SessionInfo;
    app = express();
    app.use(express.json());
    app.use(
      '/api',
      createQuickActionsRoutes({
        ptyManager: { getSession: (id: string) => (id === 's1' ? session : null) },
      })
    );
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('serves the defaults for a session whose project has no file', async () => {
    const res = await request(app).get('/api/sessions/s1/quick-actions');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('default');
    expect(res.body.actions.map((a: { id: string }) => a.id)).toContain('compact');
  });

  it('saves a valid list to the project and serves it after', async () => {
    const actions = [{ id: 'ship', emoji: '🚀', label: 'Ship', prompt: 'Ship it', confirm: true }];
    const put = await request(app).put('/api/sessions/s1/quick-actions').send({ actions });
    expect(put.status).toBe(200);
    expect(fs.existsSync(path.join(dir, '.untether', 'quick-actions.json'))).toBe(true);
    const res = await request(app).get('/api/sessions/s1/quick-actions');
    expect(res.body).toMatchObject({ source: 'file', actions, warnings: [] });
  });

  it('refuses an invalid list without writing anything', async () => {
    const res = await request(app)
      .put('/api/sessions/s1/quick-actions')
      .send({ actions: [{ id: 'x', emoji: '', label: 'X', prompt: 'p' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('action 1: emoji is required');
    expect(fs.existsSync(path.join(dir, '.untether'))).toBe(false);
  });

  it('answers 404 for an unknown session', async () => {
    expect((await request(app).get('/api/sessions/nope/quick-actions')).status).toBe(404);
    const put = await request(app).put('/api/sessions/nope/quick-actions').send({ actions: [] });
    expect(put.status).toBe(404);
  });
});
