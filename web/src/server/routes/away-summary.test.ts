import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import { createAuthMiddleware } from '../middleware/auth';
import type { ClaudeChat } from '../services/claude-chat';
import { createAwaySummaryRoutes } from './away-summary';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const SESSION = {
  id: 's1',
  pid: 100,
  status: 'running',
  command: ['claude'],
  workingDir: '/repo',
  name: 'claude',
  startedAt: '2026-10-02T09:00:00.000Z',
} as unknown as SessionInfo;

const CHAT: ClaudeChat = {
  available: true,
  status: 'busy',
  messages: [
    {
      id: 'm1',
      role: 'tool',
      tool: 'Edit',
      text: 'a.ts',
      detail: '/repo/a.ts',
      timestamp: '2026-10-02T10:10:00.000Z',
      result: 'ok',
    },
  ],
};

function appWith(options: { auth?: boolean } = {}) {
  const readChat = vi.fn(async () => CHAT);
  const app = express();
  if (options.auth) {
    app.use(
      '/api',
      createAuthMiddleware({
        enableSSHKeys: false,
        disallowUserPassword: false,
        noAuth: false,
        isHQMode: false,
      })
    );
  }
  app.use(
    '/api',
    createAwaySummaryRoutes({
      ptyManager: {
        getSession: (id: string) => (id === 's1' ? SESSION : null),
        programRootPid: () => 101,
      },
      readChat,
    })
  );
  return { app, readChat };
}

describe('GET /api/sessions/:id/away-summary', () => {
  it('summarizes the agent work since `since`', async () => {
    const { app, readChat } = appWith();
    const res = await request(app)
      .get('/api/sessions/s1/away-summary')
      .query({ since: '2026-10-02T10:00:30.000Z' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        available: true,
        status: 'working',
        toolCalls: 1,
        files: [{ path: '/repo/a.ts', edits: 1 }],
        since: '2026-10-02T10:00:00.000Z',
      })
    );
    expect(readChat).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }), 101);
    // Same session and minute: served from the cache.
    await request(app)
      .get('/api/sessions/s1/away-summary')
      .query({ since: '2026-10-02T10:00:50.000Z' });
    expect(readChat).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown session and 400s a missing or bad `since`', async () => {
    const { app } = appWith();
    const missing = await request(app)
      .get('/api/sessions/nope/away-summary')
      .query({ since: '2026-10-02T10:00:00.000Z' });
    expect(missing.status).toBe(404);
    expect((await request(app).get('/api/sessions/s1/away-summary')).status).toBe(400);
    expect(
      (await request(app).get('/api/sessions/s1/away-summary').query({ since: 'yesterday' })).status
    ).toBe(400);
  });

  it('requires authentication like the other session routes', async () => {
    const { app, readChat } = appWith({ auth: true });
    const res = await request(app)
      .get('/api/sessions/s1/away-summary')
      .query({ since: '2026-10-02T10:00:00.000Z' });
    expect(res.status).toBe(401);
    expect(readChat).not.toHaveBeenCalled();
  });
});
