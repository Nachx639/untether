// 2026-10-31: shielded Claude sessions kept open for days showed "Update installed · /restart
// to apply" and stayed on the old version. The session routes restart one: Claude's own
// /restart typed only once its menu offers it, or a reopen as Blindar does that keeps its
// flags, its shielding and its role (here an orchestrator with a task reporting to it).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { ClaudeRestartActions } from '../services/claude-update-restart.js';
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

const OLD = 'a1b2c3d4-0000-4000-8000-000000000001';
const CONVERSATION = '0d1f2e3c-1111-2222-3333-444455556666';

interface FakeSession {
  id: string;
  name: string;
  userTitle?: string;
  command: string[];
  workingDir: string;
  status: 'running' | 'exited';
  shielded?: boolean;
  muted?: boolean;
  claudeSessionId?: string;
}

const cells = (lines: string[]) =>
  lines.map((line) => [...line].map((char) => ({ char, width: 1, attributes: 0 })));

describe('restarting a Claude session on its updated version', () => {
  let tmp: string;
  let sessions: Map<string, FakeSession>;
  let created: Array<{ command: string[]; options: Record<string, unknown> }>;
  let killed: string[];
  let typed: Array<Record<string, unknown>>;
  /** What the screen shows given what was typed so far. */
  let screen: (typedText: string) => string[];
  let settings: ProjectSettingsStore;
  let commands: TaskCommands;
  let scheduler: TaskScheduler;
  let orchestrator: Orchestrator;
  let replacements: SessionReplacements;

  const status = (id: string) => sessions.get(id)?.status;
  const typedText = () =>
    typed.reduce((text, input) => {
      if (typeof input.text === 'string') return text + input.text;
      if (input.key === 'backspace') return text.slice(0, -1);
      return text;
    }, '');

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-claude-update-')));
    sessions = new Map();
    created = [];
    killed = [];
    typed = [];
    screen = (text) => [`❯ ${text}`];
    sessions.set(OLD, {
      id: OLD,
      name: 'claude',
      userTitle: 'bakery orquestador',
      command: ['claude', '--dangerously-skip-permissions', '--model', 'opus'],
      workingDir: tmp,
      status: 'running',
      shielded: true,
      muted: true,
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
    vi.useRealTimers();
    scheduler.stop();
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  /**
   * `inPlace` on fake time: the route looks at the screen every 500 ms for up to 3 s, then
   * waits 500 ms after taking the text out. The test is about what it types, not those
   * durations (it took 3.5 s of real time, 2026-11-02). Only setTimeout is faked, after the
   * real-timer setup in beforeEach.
   */
  async function inPlaceOnFakeTime(sessionId: string) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = actions().inPlace(sessionId);
    await vi.advanceTimersByTimeAsync(5000);
    return result;
  }

  function actions(): ClaudeRestartActions {
    const ptyManager = {
      getSession: (id: string) => sessions.get(id) ?? null,
      listSessions: () => [...sessions.values()],
      isShieldAvailable: () => true,
      programRootPid: () => undefined,
      sendInput: vi.fn((_id: string, input: Record<string, unknown>) => typed.push(input)),
      killSession: vi.fn(async (id: string) => {
        killed.push(id);
        const session = sessions.get(id);
        if (session) session.status = 'exited';
        orchestrator.onSessionExited(id);
      }),
      createSession: vi.fn(async (command: string[], options: Record<string, unknown>) => {
        created.push({ command, options });
        const sessionId = String(options.sessionId ?? 'new-1');
        sessions.set(sessionId, {
          id: sessionId,
          name: String(options.name),
          command,
          workingDir: String(options.workingDir),
          status: 'running',
          shielded: options.shielded === true,
          claudeSessionId: CONVERSATION,
        });
        return { sessionId };
      }),
      setSessionMuted: vi.fn(),
    };
    const terminalManager = {
      canSnapshotCheaply: () => true,
      getBufferSnapshot: async () => ({ cells: cells(screen(typedText())) }),
    };
    let exposed: ClaudeRestartActions | undefined;
    createSessionRoutes({
      ptyManager: ptyManager as never,
      terminalManager: terminalManager as never,
      remoteRegistry: null,
      isHQMode: false,
      sessionReplacements: replacements,
      exposeClaudeRestart: (given) => {
        exposed = given;
      },
    });
    if (!exposed) throw new Error('no restart actions');
    return exposed;
  }

  it('types /restart and presses Enter once Claude’s menu offers it', async () => {
    screen = (text) =>
      text === '/restart'
        ? ['  ❯ /restart                Restart Claude Code and keep this session', '❯ /restart']
        : [`❯ ${text}`];
    expect(await inPlaceOnFakeTime(OLD)).toEqual({ ok: true, sessionId: OLD });
    expect(typed).toEqual([{ text: '/restart' }, { key: 'enter' }]);
    // The same session: nothing reopened, nothing to follow.
    expect(killed).toEqual([]);
    expect(created).toEqual([]);
  });

  it('takes /restart back out when Claude does not offer it (an older Claude)', async () => {
    const result = await inPlaceOnFakeTime(OLD);
    expect(result).toEqual({ ok: false, error: 'Claude does not offer /restart', untouched: true });
    expect(typed.some((input) => input.key === 'enter')).toBe(false);
    expect(typedText()).toBe('');
  });

  it('reopens it with its flags, shielded and still the orchestrator', async () => {
    const result = await actions().reopen(OLD);
    expect(result.ok).toBe(true);
    const newId = result.ok ? result.sessionId : '';
    expect(newId).not.toBe(OLD);
    expect(killed).toEqual([OLD]);
    expect(created[0].command).toEqual([
      'claude',
      '--resume',
      CONVERSATION,
      '--dangerously-skip-permissions',
      '--model',
      'opus',
    ]);
    expect(created[0].options).toMatchObject({
      shielded: true,
      userTitle: 'bakery orquestador',
      workingDir: tmp,
    });
    expect(orchestrator.sessionFor(tmp)).toBe(newId);
    expect(settings.get(tmp).orchestratorSessionId).toBe(newId);
    expect(scheduler.list().map((task) => task.orchestratorSessionId)).toEqual([newId]);
  });

  it('a session that was not shielded is reopened unshielded', async () => {
    const old = sessions.get(OLD);
    if (old) old.shielded = false;
    const result = await actions().reopen(OLD);
    expect(result.ok).toBe(true);
    expect(created[0].options).toMatchObject({ shielded: false });
  });

  it('never reopens a session whose program is not Claude', async () => {
    const old = sessions.get(OLD);
    if (old) old.command = ['zsh'];
    expect(await actions().reopen(OLD)).toMatchObject({ ok: false });
    expect(killed).toEqual([]);
    expect(created).toEqual([]);
  });
});
