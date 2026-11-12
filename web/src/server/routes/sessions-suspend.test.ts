// 2026-10-31: "Suspender" in a session's menu (web and phone). POST /api/sessions/:id/suspend
// runs the suspender's own rules and safe stop without the idle time; anything that keeps the
// session awake answers 409 with its reasons, and nothing is suspended.
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSuspension } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  type ClaudeLook,
  type ScreenLook,
  SessionSuspender,
  type SuspendCandidate,
} from '../services/session-suspender.js';
import { createSessionRoutes } from './sessions';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const NOW = Date.now();
const START = NOW - 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function setup(
  over: {
    screen?: ScreenLook;
    claude?: Partial<ClaudeLook>;
    heldBy?: string | null;
    session?: Partial<SuspendCandidate>;
  } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suspend-route-'));
  const transcript = path.join(dir, 'conv-1.jsonl');
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', timestamp: iso(START + 1000), message: { role: 'user', content: 'hola' } })}\n${JSON.stringify(
      {
        type: 'assistant',
        timestamp: iso(START + 2000),
        message: { role: 'assistant', content: [{ type: 'text', text: 'hecho' }] },
      }
    )}\n`
  );
  const sessions = new Map<string, SuspendCandidate>([
    [
      's1',
      {
        id: 's1',
        status: 'running',
        shielded: true,
        command: ['claude'],
        workingDir: dir,
        claudeSessionId: 'conv-1',
        // Used a minute ago: the idle look would not touch it.
        lastOutputAt: NOW - 60_000,
        lastInputAt: NOW - 60_000,
        ...over.session,
      },
    ],
  ]);
  let claude: ClaudeLook | undefined = {
    status: 'idle',
    sessionId: 'conv-1',
    since: NOW - 60_000,
    pid: 100,
    startedAt: START,
    ...over.claude,
  };
  const suspend = vi.fn(async (id: string, record: SessionSuspension) => {
    const s = sessions.get(id) as SuspendCandidate;
    sessions.set(id, { ...s, status: 'exited', suspended: record });
    claude = undefined;
    return { heldInput: [] };
  });
  const suspender = new SessionSuspender({
    enabled: () => false,
    idleMinutes: () => 120,
    sessions: () => [...sessions.values()],
    claude: async () => claude,
    transcriptPath: () => transcript,
    screen: async () => over.screen ?? { draft: false, menu: false },
    watched: () => true,
    processView: async () => ({
      children: new Map([[100, [101]]]),
      args: new Map([
        [100, 'claude'],
        [101, 'npm exec some-mcp'],
      ]),
      startMs: () => START,
    }),
    heldBy: () => over.heldBy ?? null,
    suspend,
    resume: async () => ({ ok: true }),
    setSuspension: () => {},
    liveElsewhere: async () => false,
    log: () => {},
    warn: () => {},
  });
  const ptyManager = {
    getSession: (id: string) => sessions.get(id),
    setKeepAwake: () => true,
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createSessionRoutes({
      ptyManager: ptyManager as never,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
      suspendByUser: (id) => suspender.suspendByUser(id),
    })
  );
  return { app, dir, sessions, suspend };
}

describe('POST /api/sessions/:id/suspend', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, RM_TEST_DIR);
  });

  it('suspends a shielded Claude session right away, and it is listed as suspended', async () => {
    const h = setup();
    dir = h.dir;
    const res = await request(h.app).post('/api/sessions/s1/suspend');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 's1', suspended: true });
    expect(h.suspend).toHaveBeenCalledTimes(1);
    const listed = await request(h.app).get('/api/sessions/s1');
    expect(listed.body.suspended).toMatchObject({ claudeSessionId: 'conv-1', byUser: true });
    // Asked again: already suspended, nothing more happens.
    const again = await request(h.app).post('/api/sessions/s1/suspend');
    expect(again.body).toEqual({ sessionId: 's1', suspended: true, already: true });
    expect(h.suspend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['text typed in its input box', { screen: { draft: true, menu: false } }, 'draft'],
    ['a menu on screen', { screen: { draft: false, menu: true } }, 'question'],
    ['a turn running', { claude: { status: 'busy' } }, 'busy'],
    ['open tasks', { heldBy: 'it orchestrates 1 open task(s)' }, 'tasks'],
    ['a plain shell', { session: { command: ['zsh'] } }, 'notAllowed'],
  ] as const)(
    'answers 409 with the reasons for %s and suspends nothing',
    async (_name, over, kind) => {
      const h = setup(over as Parameters<typeof setup>[0]);
      dir = h.dir;
      const res = await request(h.app).post('/api/sessions/s1/suspend');
      expect(res.status).toBe(409);
      expect(res.body.error).toBeTruthy();
      expect(res.body.blockers.map((b: { kind: string }) => b.kind)).toContain(kind);
      expect(res.body.blockers.every((b: { reason: string }) => typeof b.reason === 'string')).toBe(
        true
      );
      expect(h.suspend).not.toHaveBeenCalled();
      expect(h.sessions.get('s1')?.suspended).toBeUndefined();
    }
  );

  it('404 for an unknown session', async () => {
    const h = setup();
    dir = h.dir;
    expect((await request(h.app).post('/api/sessions/nope/suspend')).status).toBe(404);
  });
});
