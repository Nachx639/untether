import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { SessionInfo, SessionMultiplexer } from '../../shared/types';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { createAuthMiddleware } from '../middleware/auth';
import { type ClaudeChat, parseProcessTable } from '../services/claude-chat';
import {
  type AttachableSession,
  MacAttach,
  type MacAttachDeps,
} from '../services/mac-sessions/attach';
import { MacSessionsScanner } from '../services/mac-sessions/scanner';
import type { MacSessionsSettings } from '../services/mac-sessions/settings';
import { type MacShare, MacShareError } from '../services/mac-sessions/share';
import type { TmuxAvailability } from '../services/mac-sessions/tmux-run';
import type { AttachedMode } from '../services/tmux-attach-tracker';
import { TMUX_FIELD_SEPARATOR } from '../services/tmux-manager';
import { createMacSessionsRoutes } from './mac-sessions';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// The scanner and the opener are the real ones over fake machines: nothing here lists a real
// tmux server or process, nor starts a session.
const SEP = TMUX_FIELD_SEPARATOR;
const TMUX = '/opt/homebrew/bin/tmux';
const DIR = '/private/tmp/tmux-501';
const SOCKET = `${DIR}/default`;
const LSTART = 'Fri Oct  2 09:00:00 2026';
const S = Date.UTC(2026, 9, 2, 9, 0, 0) / 1000;
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const TMUX_ID = `t-600-${S}-0`;
const PANE_ID = `p-600-${S}-0`;
const AGENT_ID = `a-530-${S}`;

const ps = (pid: number, ppid: number, tty: string, args: string, lstart = LSTART) =>
  `${pid} ${ppid} ${pid} 0 ${tty} S 501 ${lstart} ${args}`;

const MACHINE = [
  // The user's tmux server, a Claude in its session "work".
  ps(600, 1, '??', 'tmux new -s work'),
  ps(610, 600, '16/10', '-zsh'),
  ps(620, 610, '16/10', 'claude'),
  // A Claude in a Terminal tab.
  ps(500, 1, '??', TERMINAL),
  ps(520, 500, '16/1', '-zsh'),
  ps(530, 520, '16/1', 'claude'),
];

const LISTING = `${[
  'P',
  600,
  '$0',
  'work',
  0,
  1759480000,
  1759480100,
  1,
  '@0',
  0,
  1,
  120,
  40,
  'zsh',
  '%0',
  0,
  1,
  610,
  0,
  'claude',
  '/Users/me/project',
  '',
].join(SEP)}\n`;

const CHAT: ClaudeChat = {
  available: true,
  status: 'idle',
  title: 'Refactor parser',
  messages: [{ id: 'm1', role: 'assistant', text: 'Done.' }],
};

describe('Mac sessions routes', () => {
  let claudeDir: string;
  let settings: MacSessionsSettings;
  let machine: string[];
  let clock: number;
  let version: TmuxAvailability;
  let tableCalls: number;
  let sessions: AttachableSession[];
  let readChat: Mock<(session: SessionInfo & { pid: number }, pid: number) => Promise<ClaudeChat>>;
  let createSession: Mock<
    (command: string[], options: { multiplexer: SessionMultiplexer }) => Promise<unknown>
  >;
  let setAttachedMode: Mock<(id: string, change: Partial<AttachedMode>) => Promise<AttachedMode>>;

  beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtm-routes-'));
    fs.mkdirSync(path.join(claudeDir, 'sessions'));
    for (const [pid, sessionId] of [
      [530, 'conv-terminal'],
      [620, 'conv-tmux'],
    ] as const) {
      fs.writeFileSync(
        path.join(claudeDir, 'sessions', `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId,
          cwd: '/Users/me/project',
          entrypoint: 'cli',
          procStart: LSTART,
        })
      );
    }
    settings = {
      on: true,
      supported: true,
      enabled: true,
      openMode: 'control',
      includeHeadless: false,
    };
    machine = [...MACHINE];
    clock = Date.UTC(2026, 9, 3, 19, 40, 0);
    version = { available: true, version: '3.7c', canOpen: true };
    tableCalls = 0;
    sessions = [];
    readChat = vi.fn(async () => CHAT);
    createSession = vi.fn(async (_command, options) => {
      sessions.push({
        id: 'opened-1',
        pid: 7001,
        status: 'running',
        startedAt: new Date(clock).toISOString(),
        multiplexer: options.multiplexer,
      });
      return { sessionId: 'opened-1' };
    });
    setAttachedMode = vi.fn(
      async (): Promise<AttachedMode> => ({ mode: 'watch', sizing: 'others' })
    );
  });

  afterEach(() => {
    fs.rmSync(claudeDir, RM_TEST_DIR);
  });

  function appWith(
    options: { auth?: boolean; share?: Pick<MacShare, 'plan' | 'start' | 'job'> } = {}
  ) {
    const table = async () => {
      tableCalls++;
      return parseProcessTable(machine.join('\n'));
    };
    const scanner = new MacSessionsScanner({
      settings: () => settings,
      table,
      utSessions: () => sessions,
      tmuxVersion: async () => version,
      discovery: {
        uid: 501,
        socketDir: DIR,
        ownShieldSocket: null,
        listSockets: async () => [SOCKET],
        realpath: async (file) => (file === SOCKET ? file : null),
        socketId: async (file) => (file === SOCKET ? '1:2:3' : null),
        runTmux: async () => LISTING,
        socketsOf: async () => new Map(),
        startingEnvs: async () => new Map(),
        now: () => clock,
      },
      agents: {
        uid: 501,
        claudeDir: () => claudeDir,
        cwdsOf: async () => new Map(),
        untetherEnvOf: async () => new Set(),
        claudeStatus: async () => ({ status: 'idle', title: 'Refactor parser' }),
        codexChat: () => {
          throw new Error('no Codex here');
        },
        codexThreadId: () => null,
        geminiChat: () => {
          throw new Error('no Gemini here');
        },
      },
      serverPid: 4000,
      platform: 'darwin',
      env: {},
      realpath: (folder) => folder,
      now: () => clock,
    });
    const ptyManager = {
      listSessions: () => sessions,
      getSession: (id: string) => sessions.find((session) => session.id === id) ?? null,
      createSession,
      setAttachedMode,
    };
    const attach = new MacAttach({
      scanner,
      ptyManager: ptyManager as unknown as MacAttachDeps['ptyManager'],
      tmuxVersion: async () => version,
      tmuxBin: () => TMUX,
      runTmux: async () => LISTING,
      table,
      homeDir: () => '/Users/me',
      canStartIn: () => true,
      now: () => clock,
    });
    const app = express();
    app.use(express.json());
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
      createMacSessionsRoutes({
        settings: () => settings,
        scanner,
        attach,
        table,
        readChat,
        ...(options.share ? { share: options.share } : {}),
      })
    );
    return app;
  }

  it('lists what runs on this computer, never cached, scanning again when forced', async () => {
    const app = appWith();
    const res = await request(app).get('/api/mac-sessions');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      enabled: true,
      platform: 'darwin',
      openMode: 'control',
      tmux: { available: true, version: '3.7c', canOpen: true },
      warnings: [],
    });
    expect(res.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [AGENT_ID, TMUX_ID].sort()
    );
    const tmux = res.body.items.find((item: { id: string }) => item.id === TMUX_ID);
    expect(tmux).toMatchObject({
      kind: 'tmux',
      name: 'work',
      agents: [{ agent: 'claude', chatId: PANE_ID }],
      canOpen: true,
    });
    expect(tableCalls).toBe(1);

    await request(app).get('/api/mac-sessions');
    expect(tableCalls).toBe(1);
    clock += 1500;
    await request(app).get('/api/mac-sessions').query({ force: '1' });
    expect(tableCalls).toBe(2);
  });

  it('answers enabled:false and scans nothing while off', async () => {
    settings = { ...settings, on: false, enabled: false, reason: 'disabled', openMode: 'watch' };
    const app = appWith();
    const res = await request(app).get('/api/mac-sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      reason: 'disabled',
      platform: 'darwin',
      openMode: 'watch',
      items: [],
      warnings: [],
    });

    const chat = await request(app).get(`/api/mac-sessions/${AGENT_ID}/chat`);
    expect(chat.status).toBe(503);
    expect(chat.body).toEqual({ error: 'disabled' });
    const open = await request(app).post(`/api/mac-sessions/${TMUX_ID}/open`).send({});
    expect(open.status).toBe(503);
    expect(tableCalls).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('reads the conversation of the agent in a pane, not of the pane', async () => {
    const app = appWith();
    const res = await request(app).get(`/api/mac-sessions/${PANE_ID}/chat`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      available: true,
      title: 'Refactor parser',
      messages: CHAT.messages,
    });
    expect(readChat).toHaveBeenCalledWith(
      {
        id: `mac:${PANE_ID}`,
        name: '',
        command: [],
        workingDir: '/Users/me/project',
        status: 'running',
        startedAt: new Date(S * 1000).toISOString(),
        pid: 620,
      },
      620
    );

    // The client already shows these messages: they are left out.
    const again = await request(app)
      .get(`/api/mac-sessions/${PANE_ID}/chat`)
      .query({ have: res.body.messagesVersion });
    expect(again.body).toMatchObject({ messagesUnchanged: true });
    expect(again.body.messages).toBeUndefined();

    await request(app).get(`/api/mac-sessions/${AGENT_ID}/chat`);
    expect(readChat).toHaveBeenLastCalledWith(expect.objectContaining({ pid: 530 }), 530);
  });

  it('says gone once the agent’s pid belongs to another process', async () => {
    const app = appWith();
    await request(app).get('/api/mac-sessions');
    machine = MACHINE.map((line) =>
      line.startsWith('530 ') ? ps(530, 520, '16/1', 'claude', 'Sat Oct  3 18:00:00 2026') : line
    );
    const res = await request(app).get(`/api/mac-sessions/${AGENT_ID}/chat`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'gone' });
    expect(readChat).not.toHaveBeenCalled();
  });

  it('answers 400 to an id it never makes and 404 to one it doesn’t know', async () => {
    const app = appWith();
    for (const id of ['abc', 'x-1-2', '..%2F..%2Fetc', `t-600-${S}-0-1-2`]) {
      const chat = await request(app).get(`/api/mac-sessions/${id}/chat`);
      expect(chat.status, id).toBe(400);
      expect(chat.body).toEqual({ error: 'bad-id' });
      const open = await request(app).post(`/api/mac-sessions/${id}/open`).send({});
      expect(open.status, id).toBe(400);
    }
    const unknown = await request(app).get(`/api/mac-sessions/a-999-${S}/chat`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'gone' });
    // A tmux session has no conversation of its own: its panes do.
    const tmux = await request(app).get(`/api/mac-sessions/${TMUX_ID}/chat`);
    expect(tmux.status).toBe(400);
  });

  it('opens a tmux session of the list in the user’s mode, at the size asked', async () => {
    settings = { ...settings, openMode: 'watch' };
    const app = appWith();
    const res = await request(app)
      .post(`/api/mac-sessions/${TMUX_ID}/open`)
      .send({ cols: 52, rows: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'opened-1', reused: false, mode: 'watch' });
    const [command, options] = createSession.mock.calls[0];
    expect(command).toEqual([
      TMUX,
      '-u',
      '-N',
      '-S',
      SOCKET,
      'attach-session',
      '-E',
      '-f',
      'ignore-size,read-only',
      '-t',
      '$0',
    ]);
    expect(options).toMatchObject({ name: 'tmux: work', cols: 52, rows: 30 });

    // Asked again: the session already attached.
    const again = await request(app)
      .post(`/api/mac-sessions/${TMUX_ID}/open`)
      .send({ mode: 'control' });
    expect(again.body).toEqual({ sessionId: 'opened-1', reused: true, mode: 'watch' });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('opens only tmux sessions, with a tmux new enough', async () => {
    const app = appWith();
    const agent = await request(app).post(`/api/mac-sessions/${AGENT_ID}/open`).send({});
    expect(agent.status).toBe(422);
    expect(agent.body).toEqual({ error: 'not-openable' });

    await request(app).get('/api/mac-sessions');
    version = { available: true, version: '3.1c', canOpen: false };
    const old = await request(app).post(`/api/mac-sessions/${TMUX_ID}/open`).send({});
    expect(old.status).toBe(409);
    expect(old.body).toEqual({ error: 'tmux-too-old', details: '3.1c' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses what it can’t take', async () => {
    const app = appWith();
    const bad = async (url: string, body: object) => {
      const res = await request(app).post(url).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('bad-request');
    };
    const open = `/api/mac-sessions/${TMUX_ID}/open`;
    await bad(open, { mode: 'type' });
    await bad(open, { cols: 0 });
    await bad(open, { rows: 1001 });
    await bad(open, { cols: '80' });
    await bad(open, { cols: 80.5 });
    const mode = '/api/mac-sessions/attached/opened-1/mode';
    await bad(mode, { mode: 'type' });
    await bad(mode, { sizing: 'mine' });
    expect(createSession).not.toHaveBeenCalled();
    expect(setAttachedMode).not.toHaveBeenCalled();
  });

  it('switches a session it opened, and refuses others', async () => {
    sessions = [
      { id: 'plain', pid: 7100, status: 'running', startedAt: '2026-10-03T10:00:00.000Z' },
      {
        id: 'opened-1',
        pid: 7001,
        status: 'running',
        startedAt: '2026-10-03T10:00:00.000Z',
        multiplexer: {
          type: 'tmux',
          socketPath: SOCKET,
          serverPid: 600,
          serverStartedAt: S,
          sessionId: '$0',
          sessionName: 'work',
          mode: 'control',
          sizing: 'others',
          source: 'mac-sessions',
        },
      },
    ];
    const app = appWith();
    const plain = await request(app)
      .post('/api/mac-sessions/attached/plain/mode')
      .send({ mode: 'watch' });
    expect(plain.status).toBe(400);
    expect(plain.body).toEqual({ error: 'not-attached' });
    const odd = await request(app).post('/api/mac-sessions/attached/..%2Fx/mode').send({});
    expect(odd.status).toBe(400);

    const res = await request(app)
      .post('/api/mac-sessions/attached/opened-1/mode')
      .send({ mode: 'watch' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ mode: 'watch', sizing: 'others' });
    expect(setAttachedMode).toHaveBeenCalledWith('opened-1', { mode: 'watch' });

    setAttachedMode.mockRejectedValueOnce(new Error('timeout'));
    const failed = await request(app)
      .post('/api/mac-sessions/attached/opened-1/mode')
      .send({ sizing: 'here' });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'mode-failed', details: 'timeout' });
  });

  it('is behind the login like the rest of /api', async () => {
    const app = appWith({ auth: true });
    expect((await request(app).get('/api/mac-sessions')).status).toBe(401);
    expect((await request(app).get(`/api/mac-sessions/${AGENT_ID}/chat`)).status).toBe(401);
    expect((await request(app).post(`/api/mac-sessions/${TMUX_ID}/open`).send({})).status).toBe(
      401
    );
    expect(
      (await request(app).post('/api/mac-sessions/attached/opened-1/mode').send({})).status
    ).toBe(401);
    expect(tableCalls).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });
  describe('share with phone', () => {
    const JOB = 'j'.repeat(22);
    const TOKEN = 't'.repeat(22);
    const fakeShare = () => ({
      plan: vi.fn(async (_id: string, _options: { allowPrompt?: boolean }) => ({
        token: TOKEN,
        command: 'cd /x && ut claude --resume id',
      })),
      start: vi.fn(async (_token: unknown, _id?: string) => ({ jobId: JOB })),
      job: vi.fn((id: string) =>
        id === JOB ? { id: JOB, state: 'running', step: 'checking' } : undefined
      ),
    });
    const asShare = (share: ReturnType<typeof fakeShare>) =>
      share as unknown as Pick<MacShare, 'plan' | 'start' | 'job'>;

    it('plans, starts and polls; the client sends only the id, a flag and the token', async () => {
      const share = fakeShare();
      const app = appWith({ share: asShare(share) });
      const plan = await request(app)
        .post(`/api/mac-sessions/${AGENT_ID}/share/plan`)
        .send({ allowPrompt: 'yes', command: 'rm -rf /' });
      expect(plan.status).toBe(200);
      expect(plan.headers['cache-control']).toBe('no-store');
      expect(share.plan).toHaveBeenCalledWith(AGENT_ID, { allowPrompt: false });
      const started = await request(app)
        .post(`/api/mac-sessions/${AGENT_ID}/share`)
        .send({ token: TOKEN });
      expect(started.status).toBe(202);
      expect(started.body).toEqual({ jobId: JOB });
      expect(share.start).toHaveBeenCalledWith(TOKEN, AGENT_ID);
      const job = await request(app).get(`/api/mac-sessions/share/${JOB}`);
      expect(job.status).toBe(200);
      expect(job.body).toMatchObject({ id: JOB, state: 'running' });
      expect((await request(app).get(`/api/mac-sessions/share/${'k'.repeat(22)}`)).status).toBe(
        404
      );
      expect((await request(app).get('/api/mac-sessions/share/../../etc')).status).toBe(404);
    });

    it('answers each refusal with its status and code, and nothing else', async () => {
      const share = fakeShare();
      const app = appWith({ share: asShare(share) });
      const cases: Array<[ConstructorParameters<typeof MacShareError>[0], number]> = [
        ['no-auth', 403],
        ['disabled', 503],
        ['gone', 404],
        ['busy', 409],
        ['locked', 409],
        ['automation-ask', 409],
        ['unsupported-app', 422],
      ];
      for (const [code, status] of cases) {
        share.plan.mockRejectedValueOnce(new MacShareError(code));
        const res = await request(app).post(`/api/mac-sessions/${AGENT_ID}/share/plan`).send({});
        expect([res.status, res.body]).toEqual([status, { error: code }]);
      }
      share.plan.mockRejectedValueOnce(new MacShareError('unsupported-shell', 'tcsh'));
      const shell = await request(app).post(`/api/mac-sessions/${AGENT_ID}/share/plan`).send({});
      expect([shell.status, shell.body]).toEqual([
        422,
        { error: 'unsupported-shell', shell: 'tcsh' },
      ]);
      share.plan.mockRejectedValueOnce(new Error('/Users/me/secret path'));
      const failed = await request(app).post(`/api/mac-sessions/${AGENT_ID}/share/plan`).send({});
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain('secret');
      share.start.mockRejectedValueOnce(new MacShareError('plan-expired'));
      const expired = await request(app)
        .post(`/api/mac-sessions/${AGENT_ID}/share`)
        .send({ token: TOKEN });
      expect([expired.status, expired.body]).toEqual([409, { error: 'plan-expired' }]);
    });

    it('refuses an id it never makes, and answers disabled without the feature', async () => {
      const share = fakeShare();
      const app = appWith({ share: asShare(share) });
      const bad = await request(app).post('/api/mac-sessions/..%2Fx/share/plan').send({});
      expect([bad.status, bad.body]).toEqual([400, { error: 'bad-id' }]);
      expect(share.plan).not.toHaveBeenCalled();
      const off = appWith();
      const res = await request(off).post(`/api/mac-sessions/${AGENT_ID}/share/plan`).send({});
      expect([res.status, res.body]).toEqual([503, { error: 'disabled' }]);
    });

    it('is behind the login', async () => {
      const share = fakeShare();
      const app = appWith({ auth: true, share: asShare(share) });
      expect(
        (await request(app).post(`/api/mac-sessions/${AGENT_ID}/share/plan`).send({})).status
      ).toBe(401);
      expect(
        (await request(app).post(`/api/mac-sessions/${AGENT_ID}/share`).send({ token: TOKEN }))
          .status
      ).toBe(401);
      expect((await request(app).get(`/api/mac-sessions/share/${JOB}`)).status).toBe(401);
      expect(share.plan).not.toHaveBeenCalled();
      expect(share.start).not.toHaveBeenCalled();
    });
  });
});
