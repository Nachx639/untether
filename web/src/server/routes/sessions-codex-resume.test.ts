// Codex like Claude (2026-11-10, audit row 3): an ended Codex session offered no Resume,
// "Reopen" started a new, empty Codex, and Blindar opened a second Codex next to the first
// instead of carrying its conversation on. Its thread is resumed with `codex resume <id>`,
// one session per thread.

import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { forgetCodexSession } from '../services/codex-chat.js';
import { createSessionRoutes } from './sessions';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../utils/git-info', () => ({ detectGitInfo: async () => ({}) }));

const THREAD = '01a1c497-b56f-7ba1-9bc9-8fb6315bfb28';
const OTHER = '01a1c204-7c19-7253-aa06-1baf548cd87a';
const CODEX = '/opt/homebrew/bin/codex';

interface FakeSession {
  id: string;
  name: string;
  command: string[];
  workingDir: string;
  status: 'running' | 'exited' | 'starting';
  startedAt: string;
  pid?: number;
  shielded?: boolean;
  userTitle?: string;
  codexThreadId?: string;
  claudeSessionId?: string;
  multiplexer?: unknown;
}

describe('Codex sessions: Resume, Reopen and Blindar go on with the thread', () => {
  type Handler = (req: Request, res: Response) => Promise<void>;
  let tmp: string;
  let codexHome: string;
  let previousCodexHome: string | undefined;
  let sessions: Map<string, FakeSession>;
  /** What happened, in order: a Kill, a session created. */
  let events: string[];
  let created: Array<{ command: string[]; options: Record<string, unknown> }>;
  let liveCodexThread: ReturnType<typeof vi.fn<(threadId: string) => Promise<number | null>>>;
  let holdCreate: Promise<void> | null;

  const session = (id: string, extra: Partial<FakeSession> = {}): FakeSession => {
    const made: FakeSession = {
      id,
      name: 'codex',
      command: [CODEX, '--no-alt-screen', '-m', 'gpt-6'],
      workingDir: tmp,
      status: 'exited',
      startedAt: '2026-11-10T08:33:52.000Z',
      ...extra,
    };
    sessions.set(id, made);
    return made;
  };

  /** A thread as Codex leaves it: its rollout, and its name when it has one. */
  const thread = (id: string, opts: { name?: string; prompt?: string; cwd?: string } = {}) => {
    const dayDir = path.join(codexHome, 'sessions', '2026', '11', '10');
    fs.mkdirSync(dayDir, { recursive: true });
    const lines = [
      JSON.stringify({
        timestamp: '2026-11-10T08:33:59.000Z',
        type: 'session_meta',
        payload: { id, timestamp: '2026-11-10T08:33:59.000Z', cwd: opts.cwd ?? tmp },
      }),
      JSON.stringify({
        timestamp: '2026-11-10T08:34:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: opts.prompt ?? 'hola primer mensaje' }],
        },
      }),
    ];
    fs.writeFileSync(
      path.join(dayDir, `rollout-2026-11-10T09-33-59-${id}.jsonl`),
      `${lines.join('\n')}\n`
    );
    if (opts.name) {
      fs.appendFileSync(
        path.join(codexHome, 'session_index.jsonl'),
        `${JSON.stringify({ id, thread_name: opts.name, updated_at: '2026-11-10T08:34:09Z' })}\n`
      );
    }
  };

  function routes() {
    const ptyManager = {
      listSessions: () => [...sessions.values()],
      getSession: (id: string) => sessions.get(id) ?? null,
      programRootPid: (found: FakeSession) => found.pid,
      isShieldAvailable: () => true,
      setSessionMuted: vi.fn(),
      setCodexThreadId: (id: string, threadId: string) => {
        const found = sessions.get(id);
        if (found) found.codexThreadId = threadId;
        return {};
      },
      killSession: async (id: string) => {
        events.push(`kill ${id}`);
        const found = sessions.get(id);
        if (found) found.status = 'exited';
      },
      createSession: async (command: string[], options: Record<string, unknown>) => {
        await holdCreate;
        const id = (options.sessionId as string) ?? `new-${created.length + 1}`;
        created.push({ command, options });
        events.push(`create ${command.join(' ')}`);
        session(id, { command, status: 'running', shielded: options.shielded === true });
        return { sessionId: id, sessionInfo: { pid: 1 } };
      },
    };
    const router = createSessionRoutes({
      ptyManager,
      terminalManager: {
        getTerminal: vi.fn(),
        getRecentText: vi.fn(async () => ({ text: '', rows: 24, cols: 80, wrappedRows: [] })),
      },
      remoteRegistry: null,
      isHQMode: false,
      liveCodexThread,
    } as unknown as Parameters<typeof createSessionRoutes>[0]);
    const handler = (method: 'get' | 'post', route: string): Handler => {
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: Record<string, boolean>;
              stack: Array<{ handle: Handler }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === route && r.route.methods[method]);
      if (!layer?.route) throw new Error(`no route ${method} ${route}`);
      return layer.route.stack[0].handle;
    };
    const call = (method: 'get' | 'post', route: string, req: unknown) => {
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      const done = handler(method, route)(req as Request, res as unknown as Response);
      return { res, done };
    };
    return {
      list: async () => {
        const { res, done } = call('get', '/sessions', { query: {} });
        await done;
        return res.json.mock.calls[0][0] as Array<
          FakeSession & { codexResumable?: boolean; codexTitle?: string }
        >;
      },
      resume: (threadId: string, body: Record<string, unknown> = {}) =>
        call('post', '/sessions', {
          body: {
            command: ['codex', 'resume', threadId],
            workingDir: tmp,
            spawn_terminal: false,
            ...body,
          },
        }),
      shield: (id: string) =>
        call('post', '/sessions/:sessionId/shield', { params: { sessionId: id }, body: {} }),
    };
  }

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-codex-resume-')));
    codexHome = path.join(tmp, '.codex');
    fs.mkdirSync(codexHome);
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    sessions = new Map();
    events = [];
    created = [];
    holdCreate = null;
    liveCodexThread = vi.fn(async () => null);
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    for (const id of sessions.keys()) forgetCodexSession(id);
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  describe('GET /sessions', () => {
    it('offers Resume on an ended Codex session whose thread is still there, with its title', async () => {
      thread(THREAD, { name: 'Nombre del laboratorio' });
      thread(OTHER, { prompt: 'arregla   el login' });
      session('named', { codexThreadId: THREAD });
      session('unnamed', { codexThreadId: OTHER });
      session('no-thread');
      const listed = Object.fromEntries((await routes().list()).map((s) => [s.id, s]));
      expect(listed.named.codexResumable).toBe(true);
      // P7: the name Codex (or /rename) gave the thread, not its first prompt.
      expect(listed.named.codexTitle).toBe('Nombre del laboratorio');
      expect(listed.unnamed.codexResumable).toBe(true);
      expect(listed.unnamed.codexTitle).toBe('arregla el login');
      expect(listed['no-thread'].codexResumable).toBeUndefined();
    });

    it('offers none when resuming would open the thread twice, or nowhere', async () => {
      thread(THREAD);
      thread(OTHER);
      // Resumed already: the thread runs in another session.
      session('resumed-old', { codexThreadId: THREAD });
      session('resumed-new', {
        codexThreadId: THREAD,
        status: 'running',
        command: [CODEX, 'resume', THREAD],
      });
      // A merged task's worktree is gone.
      session('folder-gone', { codexThreadId: OTHER, workingDir: path.join(tmp, 'removed') });
      // Codex's own files were cleaned.
      session('thread-gone', { codexThreadId: '01a1c228-cc81-77b0-a4b5-73234484ee65' });
      const listed = Object.fromEntries(
        (await routes().list()).map((s) => [s.id, s.codexResumable])
      );
      expect(listed).toEqual({
        'resumed-old': false,
        'resumed-new': undefined,
        'folder-gone': false,
        'thread-gone': false,
      });
    });
  });

  describe('POST /sessions with `codex resume <id>` (Resume, Reopen)', () => {
    it('goes on with the executable and options the ended session had, shielded when asked', async () => {
      thread(THREAD);
      session('old', { codexThreadId: THREAD, shielded: true });
      const { res, done } = routes().resume(THREAD, { shielded: true });
      await done;
      expect(created).toHaveLength(1);
      expect(created[0].command).toEqual([
        CODEX,
        'resume',
        THREAD,
        '--no-alt-screen',
        '-m',
        'gpt-6',
      ]);
      expect(created[0].options).toMatchObject({ shielded: true, workingDir: tmp });
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: expect.any(String), workingDir: tmp })
      );
    });

    it('starts a resume that brings options of its own as it was asked', async () => {
      session('old', { codexThreadId: THREAD });
      const { done } = routes().resume(THREAD, {
        command: ['codex', 'resume', THREAD, '-m', 'o3'],
      });
      await done;
      expect(created[0].command).toEqual(['codex', 'resume', THREAD, '-m', 'o3']);
    });

    it('starts it as asked when no ended session of it is known', async () => {
      const { done } = routes().resume(THREAD);
      await done;
      expect(created[0].command).toEqual(['codex', 'resume', THREAD]);
    });

    it('opens the session that already runs the thread instead of a second Codex on it', async () => {
      session('old', { codexThreadId: THREAD });
      session('live', { codexThreadId: THREAD, status: 'running' });
      const { res, done } = routes().resume(THREAD);
      await done;
      expect(res.json).toHaveBeenCalledWith({ sessionId: 'live', existing: true });
      expect(created).toHaveLength(0);
    });

    it('a double tap on Resume starts the thread once', async () => {
      session('old', { codexThreadId: THREAD });
      let release: () => void = () => {};
      holdCreate = new Promise((resolve) => {
        release = resolve;
      });
      const api = routes();
      const first = api.resume(THREAD);
      await vi.waitFor(() => expect(liveCodexThread).toHaveBeenCalledTimes(1));
      const second = api.resume(THREAD);
      release();
      await Promise.all([first.done, second.done]);
      expect(created).toHaveLength(1);
      const firstId = first.res.json.mock.calls[0][0].sessionId;
      expect(second.res.json).toHaveBeenCalledWith({ sessionId: firstId, existing: true });
    });

    it('never resumes a thread a Codex outside Untether resumed (a Terminal tab)', async () => {
      session('old', { codexThreadId: THREAD });
      liveCodexThread.mockResolvedValue(4242);
      const { res, done } = routes().resume(THREAD);
      await done;
      expect(liveCodexThread).toHaveBeenCalledWith(THREAD);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'live-elsewhere', live: { where: 'terminal' } })
      );
      expect(created).toHaveLength(0);
    });

    it('never resumes a thread outside its folder, once that folder is gone', async () => {
      session('old', { codexThreadId: THREAD });
      const { res, done } = routes().resume(THREAD, { workingDir: path.join(tmp, 'removed') });
      await done;
      expect(res.status).toHaveBeenCalledWith(400);
      expect(created).toHaveLength(0);
    });
  });

  describe('POST /sessions/:id/shield (Blindar)', () => {
    it('replaces a running Codex session: the old one ends, then its thread goes on shielded', async () => {
      thread(THREAD);
      session('old', {
        codexThreadId: THREAD,
        status: 'running',
        userTitle: 'Estilos Clay',
        command: [CODEX, '--no-alt-screen', '--search', 'el primer prompt'],
      });
      const { res, done } = routes().shield('old');
      await done;
      // Never two Codex on the thread: the Kill comes first.
      expect(events).toEqual([
        `kill old`,
        `create ${CODEX} resume ${THREAD} --no-alt-screen --search`,
      ]);
      expect(created[0].options).toMatchObject({
        shielded: true,
        userTitle: 'Estilos Clay',
        workingDir: tmp,
      });
      expect(res.json).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        replaced: true,
      });
      expect(sessions.get('old')?.status).toBe('exited');
    });

    // 2026-11-10 review: with another Codex in the folder the thread is a guess by times.
    it('never ends a Codex for a guessed thread: a new one opens next to it, as before', async () => {
      session('guess', { codexThreadId: THREAD, status: 'running' });
      session('rival', { status: 'running' });
      const { res, done } = routes().shield('guess');
      await done;
      expect(events).toEqual([`create ${CODEX} --no-alt-screen -m gpt-6`]);
      expect(sessions.get('guess')?.status).toBe('running');
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ replaced: false }));
    });

    it('…but does for the thread its own command resumes', async () => {
      session('resumed', {
        codexThreadId: THREAD,
        status: 'running',
        command: [CODEX, 'resume', '--no-alt-screen', THREAD],
      });
      session('rival', { status: 'running' });
      const { done } = routes().shield('resumed');
      await done;
      expect(events).toEqual(['kill resumed', `create ${CODEX} resume ${THREAD} --no-alt-screen`]);
    });

    it('finds the thread of a Codex nobody recorded yet (its first prompt a moment ago)', async () => {
      // The rollout Codex started in the session's folder after the session began.
      thread(THREAD);
      session('fresh', { status: 'running', pid: process.pid });
      const { res, done } = routes().shield('fresh');
      await done;
      expect(sessions.get('fresh')?.codexThreadId).toBe(THREAD);
      expect(events).toEqual([
        `kill fresh`,
        `create ${CODEX} resume ${THREAD} --no-alt-screen -m gpt-6`,
      ]);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ replaced: true }));
    });

    it('starts a Codex that has no conversation yet again, next to the old one, as before', async () => {
      session('empty', { status: 'running', pid: process.pid });
      const { res, done } = routes().shield('empty');
      await done;
      expect(events).toEqual([`create ${CODEX} --no-alt-screen -m gpt-6`]);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ replaced: false }));
    });

    it('opens the session that already runs the thread instead of a second one', async () => {
      session('old', { codexThreadId: THREAD, shielded: true });
      session('live', { codexThreadId: THREAD, status: 'running' });
      const { res, done } = routes().shield('old');
      await done;
      expect(res.json).toHaveBeenCalledWith({ sessionId: 'live', replaced: false, existing: true });
      expect(created).toHaveLength(0);
    });

    it('never resumes an ended session whose thread a Codex outside Untether resumed', async () => {
      session('old', { codexThreadId: THREAD, shielded: true });
      liveCodexThread.mockResolvedValue(4242);
      const { res, done } = routes().shield('old');
      await done;
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'live-elsewhere' }));
      expect(created).toHaveLength(0);
    });

    it('a resume asked while Blindar reopens it gets the shielded session', async () => {
      session('old', { codexThreadId: THREAD, status: 'running' });
      let release: () => void = () => {};
      holdCreate = new Promise((resolve) => {
        release = resolve;
      });
      const api = routes();
      const blindar = api.shield('old');
      await vi.waitFor(() => expect(events).toEqual(['kill old']));
      const resume = api.resume(THREAD);
      release();
      await Promise.all([blindar.done, resume.done]);
      expect(created).toHaveLength(1);
      const shieldedId = blindar.res.json.mock.calls[0][0].sessionId;
      expect(resume.res.json).toHaveBeenCalledWith({ sessionId: shieldedId, existing: true });
    });

    it('leaves a running Codex opened with ut in a terminal window where it is', async () => {
      session('fwd_1761400000000_4242', { codexThreadId: THREAD, status: 'running' });
      const { res, done } = routes().shield('fwd_1761400000000_4242');
      await done;
      expect(res.status).toHaveBeenCalledWith(409);
      expect(events).toEqual([]);
    });
  });
});
