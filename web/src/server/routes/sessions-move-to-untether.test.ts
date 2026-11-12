// "Llevar a Untether" (2026-10-25): bakery's orchestrator ran with `ut claude` in a Terminal
// window and Blindar answered 409 "Session runs in a terminal window". Moving it must close
// the window's program, resume its conversation shielded and carry everything that pointed
// at the old id: the orchestrator role, the tasks that report to it, its confirmations.

import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { ClaudeStatus } from '../services/claude-chat.js';
import { replacedSessionsCheck } from '../services/doctor-checks.js';
import { Orchestrator } from '../services/orchestrator.js';
import { ProjectSettingsStore } from '../services/project-settings.js';
import { SessionReplacements } from '../services/session-replacements.js';
import { TaskCommands } from '../services/task-commands.js';
import { TaskScheduler } from '../services/task-scheduler.js';
import { createSessionRoutes } from './sessions';

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../utils/git-info', () => ({ detectGitInfo: async () => ({}) }));

const OLD = 'fwd_1761400000000_4242';
const CONVERSATION = '0d1f2e3c-1111-2222-3333-444455556666';

interface FakeSession {
  id: string;
  name: string;
  userTitle?: string;
  claudeTitle?: string;
  command: string[];
  workingDir: string;
  status: 'running' | 'exited';
  pid?: number;
  shielded?: boolean;
  muted?: boolean;
  claudeSessionId?: string;
}

describe('POST /sessions/:id/shield for a ut session in a terminal window', () => {
  type Handler = (req: Request, res: Response) => Promise<void>;
  let tmp: string;
  let sessions: Map<string, FakeSession>;
  let killed: string[];
  let created: Array<{ command: string[]; options: Record<string, unknown> }>;
  let claudeStatus: ClaudeStatus | undefined;
  let outlivesKill: boolean;
  /** The old session's end is heard after the move instead of during its Kill. */
  let exitHeardLate: boolean;
  let windows: Array<{ tty: string; app: string | null; notice: string }>;
  /** What each Kill asked the forwarder to write into its window. */
  let killNotices: Array<string | undefined>;
  let settings: ProjectSettingsStore;
  let commands: TaskCommands;
  let scheduler: TaskScheduler;
  let orchestrator: Orchestrator;
  let replacements: SessionReplacements;

  const status = (id: string) => sessions.get(id)?.status;

  beforeEach(async () => {
    // Real path: projects.json keys are (normalizeRepoPath), as resolveRepo gives them.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-move-')));
    sessions = new Map();
    killed = [];
    created = [];
    windows = [];
    killNotices = [];
    claudeStatus = { status: 'idle' };
    outlivesKill = false;
    exitHeardLate = false;
    sessions.set(OLD, {
      id: OLD,
      name: 'claude',
      userTitle: 'bakery orquestador',
      claudeTitle: 'Orquesta bakery',
      command: ['claude', '--dangerously-skip-permissions'],
      workingDir: tmp,
      status: 'running',
      pid: 4243,
      claudeSessionId: CONVERSATION,
    });
    sessions.set('task-1', {
      id: 'task-1',
      name: 'task',
      command: ['claude'],
      workingDir: tmp,
      status: 'running',
    });

    settings = new ProjectSettingsStore(path.join(tmp, 'projects.json'));
    scheduler = new TaskScheduler({
      storePath: path.join(tmp, 'tasks.json'),
      launch: async () => ({ sessionId: 'task-1' }),
      notify: vi.fn(),
      sessionStatus: status,
    });
    await scheduler.start(0);
    commands = new TaskCommands({ scheduler: () => scheduler, settings, notify: vi.fn() });
    orchestrator = new Orchestrator({
      commands,
      settings,
      tasks: () => ({
        get: (id) => scheduler.list().find((entry) => entry.id === id),
        list: () => scheduler.list() as TaskRecord[],
      }),
      createSession: async () => ({ sessionId: 'unused' }),
      deliver: (sessionId) => status(sessionId) === 'running',
      sessionStatus: status,
      stopSession: async () => {},
      claudeCommand: () => ['claude'],
      resolveRepo: async (dir) => (dir.startsWith(tmp) ? tmp : null),
      adoptTasks: () => 0,
      pushMerged: () => true,
      notify: vi.fn(),
      claudeConversation: (sessionId) => sessions.get(sessionId)?.claudeSessionId,
      pathExists: () => true,
    });
    // As server.ts registers them.
    replacements = new SessionReplacements();
    replacements.followedBy('tasks', scheduler.replacementFollower());
    replacements.followedBy('confirmations', commands.replacementFollower());
    replacements.followedBy('orchestrators', orchestrator.replacementFollower());

    expect(await orchestrator.adopt(tmp, OLD)).toMatchObject({ ok: true });
    await scheduler.create({
      name: 'Arregla el login',
      prompt: 'x',
      workingDir: tmp,
      command: ['claude'],
      agent: 'claude',
      shielded: true,
      notify: true,
      origin: 'orchestrator',
      orchestratorSessionId: OLD,
      repoPath: tmp,
    });
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  function route() {
    const ptyManager = {
      getSession: (id: string) => sessions.get(id) ?? null,
      listSessions: () => [...sessions.values()],
      isShieldAvailable: () => true,
      programRootPid: (session: FakeSession) => session.pid,
      killSession: vi.fn(
        async (id: string, _signal?: string, options?: { windowNotice?: string }) => {
          killed.push(id);
          killNotices.push(options?.windowNotice);
          const session = sessions.get(id);
          if (session && !outlivesKill) session.status = 'exited';
          if (!exitHeardLate) orchestrator.onSessionExited(id);
        }
      ),
      createSession: vi.fn(async (command: string[], options: Record<string, unknown>) => {
        created.push({ command, options });
        const sessionId = String(options.sessionId ?? 'new-1');
        sessions.set(sessionId, {
          id: sessionId,
          name: String(options.name),
          command,
          workingDir: String(options.workingDir),
          status: 'running',
          shielded: true,
          claudeSessionId: CONVERSATION,
        });
        return { sessionId };
      }),
      setSessionMuted: vi.fn(),
    };
    const router = createSessionRoutes({
      ptyManager: ptyManager as never,
      terminalManager: {} as never,
      remoteRegistry: null,
      isHQMode: false,
      sessionReplacements: replacements,
      claudeStatusOf: async () => claudeStatus,
      windowTtyOf: async (pid) => (pid === 4242 ? '/dev/ttys007' : null),
      macWindows: {
        macWindow: () => ({ app: 'Terminal' }),
        refresh: () => {},
        settled: async () => {},
      } as never,
      leaveWindow: async (window) => {
        windows.push(window);
        return { notice: 'forwarder', closed: 'closed' };
      },
    }) as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: Handler }>;
        };
      }>;
    };
    const layer = router.stack.find(
      (l) => l.route?.path === '/sessions/:sessionId/shield' && l.route.methods.post
    );
    if (!layer?.route) throw new Error('no shield route');
    const handle = layer.route.stack[0].handle;
    return async (body: unknown) => {
      let code = 200;
      let sent: Record<string, unknown> | undefined;
      const res = {
        status: vi.fn((value: number) => {
          code = value;
          return res;
        }),
        json: vi.fn((value: Record<string, unknown>) => {
          sent = value;
          return res;
        }),
      } as unknown as Response;
      await handle({ params: { sessionId: OLD }, body } as unknown as Request, res);
      // The window is handled after the answer.
      await new Promise((resolve) => setImmediate(resolve));
      return { code, body: sent };
    };
  }

  it('moves an orchestrator: role, tasks and window follow, the old one is closed', async () => {
    const call = route();
    const { code, body } = await call({ windowNotice: 'Esta sesión sigue en Untether.' });
    expect(code).toBe(200);
    const newId = String(body?.sessionId);
    expect(body).toMatchObject({ replaced: true });
    expect(newId).not.toBe(OLD);

    // The old program was closed (the forwarder's Kill) and nothing of it runs.
    expect(killed).toEqual([OLD]);
    expect(status(OLD)).toBe('exited');
    // The same conversation, shielded, with its titles and flags.
    expect(created).toHaveLength(1);
    expect(created[0].command).toEqual([
      'claude',
      '--resume',
      CONVERSATION,
      '--dangerously-skip-permissions',
    ]);
    expect(created[0].options).toMatchObject({
      shielded: true,
      userTitle: 'bakery orquestador',
      claudeTitle: 'Orquesta bakery',
      workingDir: tmp,
    });

    // Everything that pointed at the old id points at the new one.
    expect(orchestrator.sessionFor(tmp)).toBe(newId);
    expect(settings.get(tmp).orchestratorSessionId).toBe(newId);
    expect(scheduler.list().map((task) => task.orchestratorSessionId)).toEqual([newId]);
    expect(commands.roleFor({ kind: 'cli', sessionId: newId }, tmp)).toBe('orchestrator');
    expect(commands.roleFor({ kind: 'cli', sessionId: OLD }, tmp)).toBe('session');

    // The Kill carried the notice: the forwarder writes it once Claude ended, before `ut`
    // returns and the user's zsh wrapper closes the tab (2026-10-25: written 700 ms later by
    // the server, the tab was gone).
    expect(killNotices).toEqual(['Esta sesión sigue en Untether.']);
    expect(windows).toEqual([
      { tty: '/dev/ttys007', app: 'Terminal', notice: 'Esta sesión sigue en Untether.' },
    ]);
  });

  // 2026-10-25, first real move (bakery): "Session exited" for the old id at 19:20:04.445,
  // the new session at .520, "orchestrator … reopened" at .531; then the doctor "healed
  // replaced-sessions" every 5 minutes. Its own list counted the orchestrator's merged tasks,
  // which keep the session that ran them. After a move, in either order of the old session's
  // end, the doctor finds nothing: what the stores follow all moved.
  for (const order of ['exit before the move ends', 'exit heard after the move'] as const) {
    it(`leaves the doctor nothing to heal (${order})`, async () => {
      exitHeardLate = order === 'exit heard after the move';
      const tasks = (scheduler as unknown as { tasks: TaskRecord[] }).tasks;
      tasks.push({ ...tasks[0], id: 'merged-1', state: 'merged', sessionId: 'task-0' });
      const { code, body } = await route()({});
      expect(code).toBe(200);
      const newId = String(body?.sessionId);
      if (exitHeardLate) orchestrator.onSessionExited(OLD);

      expect(orchestrator.sessionFor(tmp)).toBe(newId);
      expect(settings.get(tmp).orchestratorSessionId).toBe(newId);
      const doctor = replacedSessionsCheck({
        sessions: () => [...sessions.values()],
        referenced: () => replacements.references(),
        follow: (from, to) => replacements.replaced(from, to),
      });
      expect(replacements.references()).not.toContain(OLD);
      expect(await doctor.run()).toEqual([]);
      // The merged task keeps the orchestrator it reported to.
      expect(scheduler.list().find((task) => task.id === 'merged-1')?.orchestratorSessionId).toBe(
        OLD
      );
    });
  }

  // 2026-10-25 review: the doctor's list no longer read projects.json, so an orchestrator
  // recorded there but no longer tracked (a restart that missed it) was never followed.
  it('follows a projects.json orchestrator no longer tracked, once', async () => {
    (sessions.get(OLD) as FakeSession).status = 'exited';
    orchestrator.onSessionExited(OLD);
    // As after a restart: the record stayed, the orchestrator forgot the session.
    (orchestrator as unknown as { exited: Map<string, unknown> }).exited.clear();
    settings.update(tmp, { orchestratorSessionId: OLD });
    sessions.set('resumed-1', {
      id: 'resumed-1',
      name: 'claude',
      command: ['claude', '--resume', CONVERSATION],
      workingDir: tmp,
      status: 'running',
      claudeSessionId: CONVERSATION,
    });
    const doctor = replacedSessionsCheck({
      sessions: () => [...sessions.values()],
      referenced: () => replacements.references(),
      follow: (from, to) => replacements.replaced(from, to),
    });
    expect(await doctor.run()).toEqual([
      expect.objectContaining({
        key: `replaced-sessions:${OLD}`,
        problem: expect.stringContaining('tasks (1), orchestrators (1)'),
      }),
    ]);
    expect(orchestrator.sessionFor(tmp)).toBe('resumed-1');
    expect(settings.get(tmp).orchestratorSessionId).toBe('resumed-1');
    expect(await doctor.run()).toEqual([]);
  });

  it('asks first while Claude works, and moves it once confirmed', async () => {
    claudeStatus = { status: 'busy' };
    const call = route();
    expect(await call({})).toEqual({
      code: 409,
      body: expect.objectContaining({ error: 'claude-busy', status: 'busy' }),
    });
    expect(killed).toEqual([]);
    expect(orchestrator.sessionFor(tmp)).toBe(OLD);

    const { code, body } = await call({ force: true });
    expect(code).toBe(200);
    expect(orchestrator.sessionFor(tmp)).toBe(body?.sessionId);
  });

  it('a program that outlives the close keeps its role, its tasks and its window', async () => {
    outlivesKill = true;
    const call = route();
    const { code } = await call({});
    expect(code).toBe(409);
    expect(created).toEqual([]);
    expect(orchestrator.sessionFor(tmp)).toBe(OLD);
    expect(settings.get(tmp).orchestratorSessionId).toBe(OLD);
    expect(scheduler.list().map((task) => task.orchestratorSessionId)).toEqual([OLD]);
    expect(windows).toEqual([]);
  });

  it('still refuses a ut session that does not run Claude', async () => {
    const session = sessions.get(OLD) as FakeSession;
    session.command = ['htop'];
    const { code, body } = await route()({});
    expect(code).toBe(409);
    expect(body).toMatchObject({ error: 'Session runs in a terminal window' });
    expect(killed).toEqual([]);
  });
});
