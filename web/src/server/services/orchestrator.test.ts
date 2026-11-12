import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIGEST_MINUTES_DEFAULT,
  orchestratorRelayMessage,
} from '../../shared/orchestrator-prompt.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { forgetLoopFailuresForTests, loopFailures } from '../utils/periodic-loop.js';
import { MessageLedger } from './agent-messages.js';
import { BACKGROUND } from './claude-status-notifier.js';
import {
  BRIEF_WAIT_MS,
  DELIVERY_RETRY_MS,
  DELIVERY_SETTLE_MS,
  HELD_PUSH_MS,
  LONG_RUNNING_MS,
  ORCHESTRATOR_ALLOWED_TOOLS,
  Orchestrator,
  type OrchestratorDeps,
  orchestratorCommand,
  WATCH_INTERVAL_MS,
} from './orchestrator.js';
import { ProjectSettingsStore } from './project-settings.js';
import type { NotificationPayload } from './push-notification-service.js';
import { TaskCommands } from './task-commands.js';

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 'task-1234567890',
    name: 'Login con Google',
    prompt: 'x',
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude',
    shielded: false,
    notify: true,
    runAt: '2026-10-18T00:00:00.000Z',
    createdAt: '2026-10-18T00:00:00.000Z',
    state: 'ready',
    stateSince: '2026-10-18T00:00:00.000Z',
    isolation: 'worktree',
    origin: 'orchestrator',
    orchestratorSessionId: 'orch-1',
    repoPath: '/repo',
    branch: 'ut/login-google',
    followUps: [],
    files: [],
    ...over,
  };
}

function push(type: string, data: Record<string, unknown>, body = 'detail'): NotificationPayload {
  return { type, title: type, body, data: { type, ...data } } as NotificationPayload;
}

/** Let promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('Orchestrator', () => {
  let tmp: string;
  let settings: ProjectSettingsStore;
  let commands: TaskCommands;
  let tasks: TaskRecord[];
  let running: Set<string>;
  let delivered: Array<{ sessionId: string; text: string }>;
  let created: Array<{ command: string[]; options: Record<string, unknown> }>;
  let stopped: string[];
  let notified: NotificationPayload[];
  let clock: number;
  let timers: Array<{ fn: () => void; at: number; cleared: boolean }>;
  let orchestrator: Orchestrator;
  let pushMerged: boolean;
  let adopted: Array<[string, string]>;
  let gone: Set<string>;
  /** Replaces the default deliver (types at once while the session runs). */
  let deliver: OrchestratorDeps['deliver'] | null;

  const deps = (): OrchestratorDeps => ({
    commands,
    settings,
    tasks: () => ({
      get: (id) => tasks.find((entry) => entry.id === id),
      list: () => tasks,
    }),
    createSession: async (command, options) => {
      created.push({ command, options });
      const sessionId = `orch-${created.length}`;
      running.add(sessionId);
      return { sessionId };
    },
    deliver: (sessionId, text, options) => {
      if (deliver) return deliver(sessionId, text, options);
      if (!running.has(sessionId)) return false;
      delivered.push({ sessionId, text });
      return true;
    },
    sessionStatus: (sessionId) => (running.has(sessionId) ? 'running' : undefined),
    stopSession: async (sessionId) => {
      stopped.push(sessionId);
      running.delete(sessionId);
    },
    claudeCommand: () => ['/opt/bin/claude', '--model', 'opus'],
    resolveRepo: async (dir) => (dir.startsWith('/repo') ? '/repo' : null),
    adoptTasks: (sessionId, repoPath) => {
      adopted.push([sessionId, repoPath]);
      return 2;
    },
    pushMerged: () => pushMerged,
    notify: (payload) => notified.push(payload),
    claudeConversation: (sessionId) =>
      running.has(sessionId) && !sessionId.startsWith('shell') ? `conv-${sessionId}` : undefined,
    pathExists: (dir) => !gone.has(dir),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const make = (over: Partial<OrchestratorDeps> = {}) => new Orchestrator({ ...deps(), ...over });

  /** Move the clock and fire what is due. */
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((entry) => !entry.cleared && entry.at <= clock)) {
      timer.cleared = true;
      timer.fn();
    }
  };

  /** When the project's digest of informational notes is due, by default. */
  const DIGEST_MS = DIGEST_MINUTES_DEFAULT * 60_000;

  /** The task lines typed into the orchestrator so far. */
  const taskLines = () =>
    delivered
      .flatMap((entry) => entry.text.split('\n'))
      .filter((line) => /^\[untether\] (\d\d:\d\d )?task /.test(line));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-orchestrator-'));
    settings = new ProjectSettingsStore(path.join(tmp, 'projects.json'));
    tasks = [];
    running = new Set();
    delivered = [];
    created = [];
    stopped = [];
    notified = [];
    clock = 1_000_000;
    timers = [];
    pushMerged = true;
    adopted = [];
    gone = new Set();
    deliver = null;
    commands = new TaskCommands({ scheduler: () => null, settings, notify: vi.fn() });
    orchestrator = make();
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  /** Started, its brief typed and picked up (Claude worked on it and is idle again). */
  async function started(goal = 'Añade login con Google y GitHub') {
    const result = await orchestrator.start('/repo/web', goal);
    if (!result.ok) throw new Error(result.message);
    orchestrator.onClaudeTransition(result.sessionId, 'busy');
    orchestrator.onClaudeTransition(result.sessionId, 'idle');
    delivered = [];
    return result.sessionId;
  }

  it('starts Claude in the main checkout with only ut task / ut project allowed', async () => {
    const result = await orchestrator.start('/repo/web', 'Añade login con Google y GitHub');
    expect(result).toEqual({ ok: true, repoPath: '/repo', sessionId: 'orch-1', reused: false });
    expect(created[0].command).toEqual([
      '/opt/bin/claude',
      '--model',
      'opus',
      '--allowedTools',
      'Bash(ut task:*)',
      'Bash(ut project:*)',
    ]);
    expect(ORCHESTRATOR_ALLOWED_TOOLS).toEqual(['Bash(ut task:*)', 'Bash(ut project:*)']);
    expect(created[0].options).toEqual({
      name: 'orchestrator (repo)',
      userTitle: 'Añade login con Google y GitHub',
      workingDir: '/repo',
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('GOAL (from the user):\nAñade login con Google y GitHub');
    expect(settings.get('/repo').orchestratorSessionId).toBe('orch-1');
    expect(orchestrator.list()).toEqual([{ repoPath: '/repo', sessionId: 'orch-1' }]);
    expect(orchestrator.sessionFor('/repo')).toBe('orch-1');

    expect(await orchestrator.start('/tmp', 'x')).toMatchObject({ ok: false, code: 'bad-request' });
    expect(await orchestrator.start('/repo', '  ')).toMatchObject({ ok: false });
  });

  it("drops the quick start's permission bypass and tools (2026-10-20: pkill, curl, git)", () => {
    expect(
      orchestratorCommand([
        'claude',
        '--dangerously-skip-permissions',
        '--model',
        'opus',
        '--permission-mode',
        'bypassPermissions',
        '--permission-mode=acceptEdits',
        '--allowedTools',
        'Bash(*)',
        'Edit',
        '--allow-dangerously-skip-permissions',
        '--allowed-tools=Write',
        '--verbose',
      ])
    ).toEqual([
      'claude',
      '--model',
      'opus',
      '--verbose',
      '--allowedTools',
      'Bash(ut task:*)',
      'Bash(ut project:*)',
    ]);
  });

  it("uses plain claude when the user's quick start is something else", async () => {
    const other = make({ claudeCommand: () => ['codex'] });
    await other.start('/repo', 'x');
    expect(created[0].command[0]).toBe('claude');
  });

  it('gives the orchestrator its rights on the project, and takes them back on stop', async () => {
    const caller = { kind: 'cli' as const, sessionId: 'orch-1' };
    expect(commands.roleFor(caller, '/repo')).toBe('session');
    await orchestrator.start('/repo', 'x');
    expect(commands.roleFor(caller, '/repo')).toBe('orchestrator');
    expect(commands.roleFor(caller, '/other')).toBe('session');

    expect(await orchestrator.stop('/repo/web')).toEqual({ ok: true, sessionId: 'orch-1' });
    expect(stopped).toEqual(['orch-1']);
    expect(commands.roleFor(caller, '/repo')).toBe('session');
    expect(settings.get('/repo').orchestratorSessionId).toBeUndefined();
    expect(orchestrator.list()).toEqual([]);
    expect(await orchestrator.stop('/repo')).toMatchObject({ ok: false });
  });

  it('a second goal goes into the running orchestrator', async () => {
    const sessionId = await started();
    const again = await orchestrator.start('/repo', 'Y también el logout');
    expect(again).toEqual({ ok: true, repoPath: '/repo', sessionId, reused: true });
    expect(created).toHaveLength(1);
    expect(delivered).toEqual([
      { sessionId, text: '[untether] New goal from the user:\nY también el logout' },
    ]);
  });

  it('two starts at once make one orchestrator; the second goal goes into it (2026-10-20)', async () => {
    const [first, second] = await Promise.all([
      orchestrator.start('/repo', 'Login'),
      orchestrator.start('/repo/web', 'Logout'),
    ]);
    expect(created).toHaveLength(1);
    expect(first).toMatchObject({ ok: true, sessionId: 'orch-1', reused: false });
    expect(second).toMatchObject({ ok: true, sessionId: 'orch-1', reused: true });
    orchestrator.onClaudeTransition('orch-1', 'busy');
    orchestrator.onClaudeTransition('orch-1', 'idle');
    expect(delivered.at(-1)?.text).toBe('[untether] New goal from the user:\nLogout');
  });

  it("types its tasks' events into it instead of pushing them; merged still reaches the phone", async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId, summary: 'Hecho' }));
    tasks.push(task({ id: 'user-task', origin: 'user', orchestratorSessionId: undefined }));

    const ready = push('task-ready', { taskId: 'aaaa1111bbbb', detail: 'Hecho: botón' });
    expect(orchestrator.routeTaskPush(ready)).toBeNull();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].sessionId).toBe(sessionId);
    expect(taskLines()[0]).toMatch(
      /^\[untether\] \d\d:\d\d task aaaa1111 "Login con Google" \(ut\/login-google\): ready — Hecho\. Next: merge it/
    );

    // The user's own task pushes as always.
    const own = push('task-ready', { taskId: 'user-task' });
    expect(orchestrator.routeTaskPush(own)).toBe(own);
    // Not a task push at all.
    const other = push('claude-waiting', { sessionId });
    expect(orchestrator.routeTaskPush(other)).toBe(other);

    orchestrator.onClaudeTransition(sessionId, 'busy');
    tasks[0].state = 'merged';
    const merged = push('task-merged', { taskId: 'aaaa1111bbbb' });
    expect(orchestrator.routeTaskPush(merged)).toBe(merged);
    pushMerged = false;
    expect(orchestrator.routeTaskPush(merged)).toBeNull();
  });

  it('a quiet push: an auto-fix under way reaches the orchestrator as "nothing to do", never the phone (2026-10-20)', async () => {
    const sessionId = await started();
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        orchestratorSessionId: sessionId,
        state: 'failed',
        blocker: { kind: 'verify', message: 'The check failed' },
        autoFix: { attempts: 1, max: 2, reason: 'verify', at: 'x' },
      })
    );
    const quiet = push('task-failed', { taskId: 'aaaa1111bbbb', quiet: true });
    expect(orchestrator.routeTaskPush(quiet)).toBeNull();
    // The task moves on to working at once: the note is still news, for the digest (2026-11-02).
    tasks[0].state = 'working';
    expect(taskLines()).toHaveLength(0);
    advance(DIGEST_MS);
    expect(taskLines()[0]).toContain(
      'Next: nothing: Untether is already fixing it automatically (attempt 1/2)'
    );
    // A quiet push of a task with no orchestrator never reaches the phone either.
    tasks.push(task({ id: 'user-task', origin: 'user', orchestratorSessionId: undefined }));
    expect(
      orchestrator.routeTaskPush(push('task-ready', { taskId: 'user-task', quiet: true }))
    ).toBeNull();
    // After the automatic attempts, the event says it is the orchestrator's now.
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.onClaudeTransition(sessionId, 'idle');
    tasks[0].state = 'failed';
    delete tasks[0].autoFix;
    tasks[0].autoFixes = { verify: 2 };
    expect(orchestrator.routeTaskPush(push('task-failed', { taskId: 'aaaa1111bbbb' }))).toBeNull();
  });

  it('takes the blocker in full from the task record, not the push (2026-10-20)', async () => {
    const sessionId = await started();
    const long = `${'x'.repeat(400)} end`;
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        orchestratorSessionId: sessionId,
        state: 'needs_you',
        blocker: { kind: 'risk', message: long, detail: ['.env changed', 'ci.yml deleted'] },
      })
    );
    orchestrator.routeTaskPush(
      push('task-needs-you', { taskId: 'aaaa1111bbbb', detail: long.slice(0, 200) })
    );
    const line = taskLines()[0];
    expect(line).toContain(`needs you · risk — ${long} · .env changed · ci.yml deleted.`);
    expect(line).toContain('`ut task merge aaaa1111 --accept-risk` asks them');
  });

  it('queues events while it is busy or waiting, and types them in one message once idle', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId, state: 'failed' }));
    tasks.push(
      task({
        id: 'cccc2222dddd',
        name: 'Login con GitHub',
        branch: 'ut/login-github',
        state: 'needs_you',
        blocker: { kind: 'question', message: '¿Qué scope?' },
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(push('task-failed', { taskId: 'aaaa1111bbbb', detail: 'check' }));
    orchestrator.onClaudeTransition(sessionId, 'waiting');
    orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'cccc2222dddd' }));
    expect(delivered).toHaveLength(0);
    // One message, one line per task.
    expect(orchestrator.pending(sessionId)).toHaveLength(1);

    orchestrator.onClaudeTransition(sessionId, 'idle');
    expect(delivered).toHaveLength(1);
    expect(taskLines()).toHaveLength(2);
    expect(taskLines()[0]).toContain('"Login con Google" (ut/login-google): failed — check.');
    expect(taskLines()[1]).toContain(
      '"Login con GitHub" (ut/login-github): needs you · question — ¿Qué scope?. Next: answer'
    );
    expect(orchestrator.pending(sessionId)).toHaveLength(0);
  });

  it('a task that changed nothing brings its report and closes once it is typed in (2026-10-20)', async () => {
    const closed: string[] = [];
    orchestrator = make({ closeReported: (taskId) => closed.push(taskId) });
    const sessionId = await started();
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        name: 'Revisión: app iOS',
        orchestratorSessionId: sessionId,
        summary: 'Dos fallos: el login no guarda la sesión y el ajuste de voz no persiste.',
        blocker: { kind: 'no-changes', message: 'The agent changed nothing' },
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }));
    expect(closed).toEqual([]);
    orchestrator.onClaudeTransition(sessionId, 'idle');
    await settle();
    expect(taskLines()[0]).toContain('its report: Dos fallos: el login no guarda la sesión');
    expect(taskLines()[0]).toContain('Untether closes the task now');
    expect(closed).toEqual(['aaaa1111bbbb']);

    // Its close (done) is not told back to it.
    tasks[0].state = 'done';
    advance(60 * 60 * 1000);
    expect(orchestrator.pending(sessionId)).toHaveLength(0);
  });

  it('a reminder that a task still waits says so in its event (2026-10-31)', async () => {
    const sessionId = await started();
    tasks.push(
      task({
        id: 'cccc2222dddd',
        name: 'Arregla el login',
        orchestratorSessionId: sessionId,
        blocker: { kind: 'question', message: '¿OAuth o magic links?' },
        state: 'needs_you',
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(
      push('task-needs-you', {
        taskId: 'cccc2222dddd',
        reminder: 'Still waiting for you after 30 min, nobody acted on it',
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'idle');
    await settle();
    expect(taskLines()[0]).toContain(
      'Still waiting for you after 30 min, nobody acted on it · ¿OAuth o magic links?'
    );
  });

  it('a task without a worktree is done with its report, which reaches its orchestrator (2026-10-24)', async () => {
    const closed: string[] = [];
    orchestrator = make({ closeReported: (taskId) => closed.push(taskId) });
    const sessionId = await started();
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        name: 'Arreglar atlas-guard',
        isolation: 'none',
        branch: undefined,
        orchestratorSessionId: sessionId,
        summary: 'atlas-guard manda X-Atlas-Turn (commit 6456897).',
        state: 'done',
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'busy');
    expect(orchestrator.routeTaskPush(push('task-done', { taskId: 'aaaa1111bbbb' }))).toBeNull();
    orchestrator.onClaudeTransition(sessionId, 'idle');
    await settle();
    expect(taskLines()[0]).toContain(': done — atlas-guard manda X-Atlas-Turn');
    expect(taskLines()[0]).toContain('the task is closed');
    expect(taskLines()[0]).not.toContain('ut task merge');
    // Already closed: nothing for the orchestrator to discard.
    expect(closed).toEqual([]);
  });

  it('a ready task without a worktree (a question, no report) is closed with ut task merge (2026-10-24)', async () => {
    const closed: string[] = [];
    orchestrator = make({ closeReported: (taskId) => closed.push(taskId) });
    const sessionId = await started();
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        name: 'Mirar logs',
        isolation: 'none',
        branch: undefined,
        orchestratorSessionId: sessionId,
        summary: '¿Borro también los antiguos?',
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }));
    orchestrator.onClaudeTransition(sessionId, 'idle');
    await settle();
    expect(taskLines()[0]).toContain('`ut task send aaaa1111`');
    expect(taskLines()[0]).toContain('`ut task merge aaaa1111` closes it as done');
    expect(closed).toEqual([]);
  });

  it('a task with changes, or one the user reopened, is never closed by its report', async () => {
    const closed: string[] = [];
    orchestrator = make({ closeReported: (taskId) => closed.push(taskId) });
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    tasks.push(
      task({
        id: 'cccc2222dddd',
        orchestratorSessionId: sessionId,
        blocker: { kind: 'no-changes', message: 'The agent changed nothing' },
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }));
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'cccc2222dddd' }));
    tasks[1].state = 'working';
    orchestrator.onClaudeTransition(sessionId, 'idle');
    await settle();
    expect(delivered).toHaveLength(1);
    expect(closed).toEqual([]);
  });

  describe('a message that cannot be typed in says why and goes in on its own (m699vq7, 2026-11-10)', () => {
    const ledgerOf = () => ({
      delivered: vi.fn(),
      undeliverable: vi.fn(),
      waiting: vi.fn(),
    });

    // 2026-11-11: the doubles above are loose functions, so a method taken off the ledger
    // and called bare ("Cannot read properties of undefined (reading 'messages')", an uncaught
    // exception in the watch timer: the server stopped at least eight times) passed every
    // test. This one wires the ledger the server wires: the class itself.
    it('with the real ledger: busy and at its usage limit, the watch does not throw and the message says why it waits', async () => {
      const ledger = new MessageLedger({ sessionOf: () => undefined, now: () => clock });
      let halt: { kind: 'usage-limit'; message: string; resumeAt?: number } | undefined;
      orchestrator = make({ messages: ledger, halt: () => halt });
      const sessionId = await started();
      const recorded = ledger.record({
        from: { kind: 'project', repoPath: '/other' },
        to: { kind: 'project', repoPath: '/repo' },
        text: 'How do you name your branches?',
      });
      if (!recorded.ok) throw new Error(recorded.message);
      const id = recorded.message.id;
      orchestrator.onClaudeTransition(sessionId, 'busy');
      expect(() =>
        orchestrator.relay('/repo', `[untether] Message ${id} from …`, id)
      ).not.toThrow();
      expect(ledger.get(id)).toMatchObject({
        state: 'queued',
        waitingWhy: expect.stringContaining('in the middle of a turn'),
      });
      halt = {
        kind: 'usage-limit',
        message: "You've hit your session limit · resets 3pm",
        resumeAt: clock + 2 * 60 * 60_000,
      };
      // The timer that stopped the server: Orchestrator.watch → noteWaiting → ledger.waiting.
      expect(() => advance(WATCH_INTERVAL_MS)).not.toThrow();
      expect(ledger.get(id)).toMatchObject({
        state: 'queued',
        waitingWhy: expect.stringMatching(/stopped at its usage limit until \d\d:\d\d/),
      });
      expect(delivered).toHaveLength(0);
      // Its turn over and its limit reset: typed in, and the ledger knows.
      halt = undefined;
      orchestrator.onClaudeTransition(sessionId, 'idle');
      await settle();
      expect(delivered.map((entry) => entry.text)).toEqual([`[untether] Message ${id} from …`]);
      expect(ledger.get(id)?.state).toBe('delivered');
    });

    it('a watch that throws stops nothing: it is counted for the doctor and the next watch still runs', async () => {
      forgetLoopFailuresForTests();
      let broken = false;
      const list = deps().tasks;
      orchestrator = make({
        tasks: () => {
          if (broken) throw new TypeError('the watch broke');
          return list();
        },
      });
      await started();
      broken = true;
      expect(() => advance(WATCH_INTERVAL_MS)).not.toThrow();
      expect(() => advance(WATCH_INTERVAL_MS)).not.toThrow();
      expect(loopFailures()).toMatchObject([
        { name: 'orchestrator watch', count: 2, error: 'TypeError: the watch broke' },
      ]);
      // Armed again each time: once it works, it watches as before.
      broken = false;
      advance(WATCH_INTERVAL_MS);
      expect(loopFailures()[0].count).toBe(2);
      expect(timers.some((timer) => !timer.cleared)).toBe(true);
    });

    it('a turn going on: the ledger hears why, and it is typed when the turn ends', async () => {
      const ledger = ledgerOf();
      orchestrator = make({ messages: ledger });
      const sessionId = await started();
      orchestrator.onClaudeTransition(sessionId, 'busy');
      orchestrator.relay('/repo', '[untether] Message mbcd234 from …', 'mbcd234');
      expect(ledger.waiting).toHaveBeenCalledWith(
        'mbcd234',
        expect.stringContaining('in the middle of a turn')
      );
      // Said again while it lasts (the ledger tells its sender after a while).
      ledger.waiting.mockClear();
      advance(WATCH_INTERVAL_MS);
      expect(ledger.waiting).toHaveBeenCalledWith('mbcd234', expect.stringContaining('turn'));
      orchestrator.onClaudeTransition(sessionId, 'idle');
      await settle();
      expect(ledger.delivered).toHaveBeenCalledWith('mbcd234');
    });

    it('a prompt of its own on screen: the reason quotes it', async () => {
      const ledger = ledgerOf();
      orchestrator = make({
        messages: ledger,
        screenPrompt: async () => 'What do you want to do?',
      });
      const sessionId = await started();
      orchestrator.onClaudeTransition(sessionId, 'waiting');
      orchestrator.relay('/repo', '[untether] Message mbcd234 from …', 'mbcd234');
      await settle();
      expect(ledger.waiting).toHaveBeenCalledWith(
        'mbcd234',
        expect.stringContaining('«What do you want to do?»')
      );
      expect(delivered).toHaveLength(0);
    });

    it('its Claude stopped at its usage limit: never typed into the limit, typed after the reset', async () => {
      const ledger = ledgerOf();
      let halt: { kind: 'usage-limit'; message: string; resumeAt?: number } | undefined;
      orchestrator = make({ messages: ledger, halt: () => halt });
      const sessionId = await started();
      // Cut short by the limit: its turn is over (idle), its prompt would take the text.
      halt = {
        kind: 'usage-limit',
        message: "You've hit your session limit · resets 3pm",
        resumeAt: clock + 2 * 60 * 60_000,
      };
      orchestrator.onClaudeTransition(sessionId, 'busy');
      orchestrator.onClaudeTransition(sessionId, 'idle');
      orchestrator.relay('/repo', '[untether] Message mbcd234 from …', 'mbcd234');
      await settle();
      expect(delivered).toHaveLength(0);
      expect(ledger.waiting).toHaveBeenCalledWith(
        'mbcd234',
        expect.stringMatching(/stopped at its usage limit until \d\d:\d\d/)
      );
      // Looked at again meanwhile, still not typed.
      advance(60 * 60_000);
      await settle();
      expect(delivered).toHaveLength(0);
      // Past the reset: it goes in with nobody doing anything.
      for (let step = 0; step < 8 && !delivered.length; step++) {
        advance(10 * 60_000);
        await settle();
      }
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain('Message mbcd234');
      expect(ledger.delivered).toHaveBeenCalledWith('mbcd234');
    });

    it("a task stopped on its agent's prompt: the orchestrator reads what it asks and how to answer (3dc243e4)", async () => {
      const sessionId = await started();
      tasks.push(
        task({
          state: 'needs_you',
          orchestratorSessionId: sessionId,
          blocker: {
            kind: 'permission',
            message: 'permission prompt',
            fromPrompt: true,
            prompt: {
              question: 'Do you want to proceed?',
              options: ['Yes', 'No, and tell Claude what to do differently (esc)'],
              asks: 'Permission for Bash: rm -rf "$D"/*',
              deletes: true,
              since: '2026-11-10T08:19:33.000Z',
            },
          },
        })
      );
      orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'task-1234567890' }));
      await settle();
      const text = delivered.map((entry) => entry.text).join('\n');
      expect(text).toContain('its agent asks: Permission for Bash: rm -rf "$D"/*');
      expect(text).toContain('[1. Yes / 2. No, and tell Claude what to do differently (esc)]');
      expect(text).toContain('ut task answer task-123 approve | deny | <number> | --text');
      expect(text).toContain('only the user approves it');
      expect(text).toContain('Unanswered for 10 min, the user hears on the phone');
    });

    it('a prompt on a command Untether rewrote reaches the orchestrator whole, and says so (2026-11-11)', async () => {
      const sessionId = await started();
      const asks = `Permission for Bash: __ut_slot=$('/app/ut' check-slot acquire --pid $$)\n{ pnpm run test ${'x'.repeat(400)}\n}`;
      tasks.push(
        task({
          state: 'needs_you',
          orchestratorSessionId: sessionId,
          blocker: {
            kind: 'permission',
            message: 'permission prompt',
            fromPrompt: true,
            prompt: {
              question: 'Do you want to proceed?',
              options: ['Yes', 'No'],
              asks,
              wrapped: 'check slot',
              since: '2026-11-11T06:09:37.000Z',
            },
          },
        })
      );
      orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'task-1234567890' }));
      await settle();
      const text = delivered.map((entry) => entry.text).join('\n');
      // Whole (an event is one line), not its 300-character summary.
      expect(text).toContain(`its agent asks: ${asks.replace(/\s+/g, ' ')}`);
      expect(text).toContain('Untether itself rewrote this command (check slot)');
      expect(text).toContain("the user's phone was told at once");
    });

    it('a push marked for the user reaches the phone, whoever the task reports to', async () => {
      const sessionId = await started();
      tasks.push(task({ state: 'needs_you', orchestratorSessionId: sessionId }));
      const forUser = push('task-needs-you', { taskId: 'task-1234567890', toUser: true });
      expect(orchestrator.routeTaskPush(forUser)).toBe(forUser);
      expect(
        orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'task-1234567890' }))
      ).toBeNull();
    });
  });

  it("takes another project's message, already marked as an agent's, and tells the ledger once it is typed (ut project tell)", async () => {
    const ledger = { delivered: vi.fn(), undeliverable: vi.fn() };
    orchestrator = make({ messages: ledger });
    const sessionId = await started();
    const text = orchestratorRelayMessage({
      id: 'mbcd234',
      fromRepo: '/projects/atlas',
      text: 'posix_spawnp failed (tarea 0bd551ff)',
      expectsReply: true,
    });
    expect(orchestrator.relay('/nowhere', 'x', 'mzzzzzz')).toBe(false);
    orchestrator.onClaudeTransition(sessionId, 'busy');
    expect(orchestrator.relay('/repo', text, 'mbcd234')).toBe(true);
    // Queued while its Claude works: not delivered yet.
    expect(delivered).toHaveLength(0);
    expect(ledger.delivered).not.toHaveBeenCalled();
    orchestrator.onClaudeTransition(sessionId, 'idle');
    await settle();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain(
      '[untether] Message mbcd234 from the orchestrator of "atlas" (/projects/atlas), another agent, not the user:'
    );
    expect(delivered[0].text).toContain('posix_spawnp failed (tarea 0bd551ff)');
    expect(delivered[0].text).toContain('ut project tell atlas --reply-to mbcd234');
    expect(ledger.delivered).toHaveBeenCalledWith('mbcd234');
    expect(ledger.undeliverable).not.toHaveBeenCalled();
  });

  it('a queued message keeps its id across a restart, and one whose orchestrator ends is undeliverable (2026-11-10)', async () => {
    const statePath = path.join(tmp, 'control', 'orchestrators.json');
    const ledger = { delivered: vi.fn(), undeliverable: vi.fn() };
    orchestrator = make({ statePath, messages: ledger });
    const sessionId = await started();
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.relay('/repo', '[untether] Message mbcd234 from …', 'mbcd234');
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(saved.orchestrators[0].messages).toEqual(['[untether] Message mbcd234 from …']);
    expect(saved.orchestrators[0].messageIds).toEqual(['mbcd234']);

    // The server restarts with the message still queued: typed in afterwards, id and all.
    orchestrator = make({ statePath, messages: ledger });
    await orchestrator.restore();
    orchestrator.onClaudeTransition(sessionId, 'idle');
    await settle();
    expect(delivered.at(-1)?.text).toContain('[untether] Message mbcd234 from …');
    expect(ledger.delivered).toHaveBeenCalledWith('mbcd234');

    // Another one waits when the orchestrator's session ends: never typed, its sender hears.
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.relay('/repo', '[untether] Message mfgh567 from …', 'mfgh567');
    running.delete(sessionId);
    orchestrator.onSessionExited(sessionId);
    expect(ledger.undeliverable).toHaveBeenCalledWith('mfgh567', 'its orchestrator ended');
  });

  it("a task's push held for a busy orchestrator reaches the phone after 15 min; the event still waits for it (2026-10-20)", async () => {
    const sessionId = await started();
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        orchestratorSessionId: sessionId,
        state: 'needs_you',
        blocker: { kind: 'question', message: '¿Qué scope?' },
      })
    );
    orchestrator.onClaudeTransition(sessionId, 'busy');
    expect(
      orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'aaaa1111bbbb' }))
    ).toBeNull();
    advance(WATCH_INTERVAL_MS);
    expect(notified).toHaveLength(0);
    advance(HELD_PUSH_MS);
    expect(notified.map((payload) => payload.type)).toEqual(['task-needs-you']);
    advance(WATCH_INTERVAL_MS * 3);
    expect(notified).toHaveLength(1);
    orchestrator.onClaudeTransition(sessionId, 'idle');
    expect(taskLines()[0]).toContain('needs you · question');
  });

  it('types events in while its turn ended on background work (2026-10-20: Claude "shell")', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId, state: 'failed' }));
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(push('task-failed', { taskId: 'aaaa1111bbbb', detail: 'check' }));
    expect(delivered).toHaveLength(0);
    orchestrator.onClaudeTransition(sessionId, BACKGROUND);
    expect(delivered).toHaveLength(1);
    expect(orchestrator.pending(sessionId)).toHaveLength(0);
  });

  it("keeps only a task's newest event while it is busy (2026-10-18: ready twice, then merged)", async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    tasks.push(task({ id: 'cccc2222dddd', name: 'Login con GitHub', branch: 'ut/login-github' }));
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb', detail: 'No check' }));
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'cccc2222dddd', detail: 'listo' }));
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb', detail: 'No check' }));
    tasks[0].state = 'merged';
    orchestrator.routeTaskPush(push('task-merged', { taskId: 'aaaa1111bbbb', detail: 'logo' }));
    orchestrator.onClaudeTransition(sessionId, 'idle');
    // The merge is informational: it rides in the digest, ahead of the ready one that needs it.
    expect(taskLines().map((line) => line.replace(/^\[untether\] \d\d:\d\d /, ''))).toEqual([
      expect.stringContaining('task aaaa1111 "Login con Google" (ut/login-google): merged — logo.'),
      expect.stringContaining('task cccc2222 "Login con GitHub" (ut/login-github): ready — listo.'),
    ]);
    expect(
      delivered[0].text.split('\n').filter((line) => line.includes('not from the user'))
    ).toHaveLength(1);
  });

  it("a merged task's memory note: whole in its event when Untether did not save it, the file when it did (2026-11-03)", async () => {
    const sessionId = await started();
    const memoryNote = {
      name: 'flaky-check',
      description: 'checks flake under load',
      body: '# Flaky check\nWait for markers.',
    };
    const result = {
      outcome: 'done' as const,
      files: [{ path: 'src/a.ts', why: 'fix' }],
      tests: [{ command: 'pnpm test', result: 'passed' as const }],
      risks: [],
      followUps: [],
      memoryNote,
    };
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        orchestratorSessionId: sessionId,
        state: 'merged',
        result,
        memoryNote: { skipped: 'memoryDir is off for this project' },
      }),
      task({
        id: 'cccc2222dddd',
        orchestratorSessionId: sessionId,
        state: 'merged',
        result,
        memoryNote: { saved: '/mem/flaky-check.md', updated: true },
      })
    );
    orchestrator.routeTaskPush(push('task-merged', { taskId: 'aaaa1111bbbb' }));
    orchestrator.routeTaskPush(push('task-merged', { taskId: 'cccc2222dddd' }));
    advance(DIGEST_MS);
    const [off, saved] = taskLines();
    expect(off).toContain(
      'memory note not saved by Untether (memoryDir is off for this project): name flaky-check; description checks flake under load; body (\\n = new line): # Flaky check\\nWait for markers.'
    );
    expect(off).toContain('Next: save its memory note (above) as flaky-check.md');
    expect(saved).toContain('memory note updated by Untether: /mem/flaky-check.md');
    expect(saved).not.toContain('memory note not saved');
    expect(saved).toContain('Next: start the work that waited on it, if any.');
  });

  it('a finished task tells the model it really ran with, and the asked one when it differs (2026-11-08)', async () => {
    const sessionId = await started();
    const metrics = (model: string) => ({
      savings: { on: {} },
      quality: { autoFixRounds: 0, riskRules: [] },
      usage: {
        input: 1,
        cacheWrite: 0,
        cacheRead: 0,
        output: 1,
        turns: 1,
        maxContext: 1,
        compactions: 0,
        lastModel: { model, at: '2026-11-08T10:00:00.000Z' },
      },
    });
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        orchestratorSessionId: sessionId,
        state: 'merged',
        metrics: metrics('claude-opus-4-8'),
      }),
      task({
        id: 'cccc2222dddd',
        orchestratorSessionId: sessionId,
        state: 'merged',
        model: 'claude-opus-5-5',
        metrics: metrics('claude-opus-4-8'),
      })
    );
    orchestrator.routeTaskPush(push('task-merged', { taskId: 'aaaa1111bbbb' }));
    orchestrator.routeTaskPush(push('task-merged', { taskId: 'cccc2222dddd' }));
    advance(DIGEST_MS);
    const [defaulted, asked] = taskLines();
    expect(defaulted).toContain("model: claude-opus-4-8 (the agent's default)");
    expect(asked).toContain('model: claude-opus-4-8 (asked: claude-opus-5-5)');
  });

  it('drops events whose task moved on before they were typed (2026-10-20 bursts)', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId, state: 'needs_you' }));
    tasks.push(task({ id: 'cccc2222dddd', state: 'failed' }));
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'aaaa1111bbbb' }));
    orchestrator.routeTaskPush(push('task-failed', { taskId: 'cccc2222dddd' }));
    // The user answered the first from the phone; the second was discarded meanwhile.
    tasks[0].state = 'working';
    tasks[1].state = 'discarded';
    orchestrator.onClaudeTransition(sessionId, 'idle');
    expect(delivered).toHaveLength(0);
    expect(orchestrator.pending(sessionId)).toHaveLength(0);
  });

  it('an AI review blocker reaches it with what it may do: fix, never merge past it', async () => {
    const sessionId = await started();
    tasks.push(
      task({
        id: 'aaaa1111bbbb',
        orchestratorSessionId: sessionId,
        state: 'needs_you',
        blocker: { kind: 'review', message: 'Divide entre n-1' },
      })
    );
    const review = push('task-needs-you', { taskId: 'aaaa1111bbbb', blocker: 'review' });
    expect(orchestrator.routeTaskPush(review)).toBeNull();
    expect(taskLines()[0]).toContain(
      'needs you · review — Divide entre n-1. Next: `ut task fix aaaa1111` hands the issues to its agent; never merge past a review.'
    );
  });

  it('waits for Claude to pick up what was typed before typing more', async () => {
    // Every note at once: this is about pacing, not the digest.
    settings.update('/repo', { digestMinutes: 0 });
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }));
    expect(delivered).toHaveLength(1);
    // Claude has not started on it yet: the next event waits.
    tasks[0].state = 'merged';
    orchestrator.routeTaskPush(push('task-merged', { taskId: 'aaaa1111bbbb' }));
    expect(delivered).toHaveLength(1);
    advance(DELIVERY_SETTLE_MS - 1);
    expect(delivered).toHaveLength(1);
    advance(1);
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text).toContain(': merged');

    // Picked up (busy, then idle): the next one goes in at once.
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.onClaudeTransition(sessionId, 'idle');
    tasks[0].state = 'ready';
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }));
    expect(delivered).toHaveLength(3);
  });

  it('types one thing at a time and keeps it queued until it was typed (2026-10-20)', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    tasks.push(task({ id: 'cccc2222dddd', name: 'Docs' }));
    const calls: Array<{ text: string; resolve: (typed: boolean) => void }> = [];
    deliver = (_id, text) =>
      new Promise<boolean>((resolve) => {
        calls.push({ text, resolve });
      });
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }));
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'cccc2222dddd' }));
    // The second waits for the first delivery.
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('task aaaa1111');
    // Not typed (Claude never got ready): both go in again, together.
    calls[0].resolve(false);
    await settle();
    expect(calls).toHaveLength(1);
    advance(DELIVERY_RETRY_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('task aaaa1111');
    expect(calls[1].text).toContain('task cccc2222');
    calls[1].resolve(true);
    await settle();
    expect(orchestrator.pending(sessionId)).toHaveLength(0);
  });

  it('trusts the folder only for the brief of one it started, also after a restart (2026-10-23)', async () => {
    const statePath = path.join(tmp, 'control', 'orchestrators.json');
    const calls: Array<{ sessionId: string; text: string; trustFolder?: boolean }> = [];
    // Off: Claude sits on its trust dialog, the brief waits in the delivery.
    const typed = true;
    deliver = (sessionId, text, options) => {
      calls.push({ sessionId, text, trustFolder: options?.trustFolder });
      return typed ? running.has(sessionId) : new Promise<boolean>(() => {});
    };
    orchestrator = make({ statePath });
    const sessionId = await started();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId, trustFolder: true });
    // A new goal later, and events, wait for the user on any menu.
    await orchestrator.start('/repo', 'Logout');
    expect(calls[1]).toMatchObject({ text: '[untether] New goal from the user:\nLogout' });
    expect(calls[1].trustFolder).toBeUndefined();

    // An adopted session is the user's own: never.
    running.add('chat-1');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    await orchestrator.stop('/repo');
    await orchestrator.adopt('/repo', 'chat-1');
    expect(calls.at(-1)?.text).toContain('The user made you the orchestrator');
    expect(calls.at(-1)?.trustFolder).toBeUndefined();
    await orchestrator.stop('/repo');

    // Its brief not typed yet when the server restarts: the brief still trusts, for the one
    // Untether started only.
    for (const adoptedOne of [false, true]) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          orchestrators: [
            {
              sessionId: 'orch-9',
              repoPath: '/repo',
              messages: [],
              events: [],
              briefPending: true,
              brief: 'GOAL (from the user):\nOtra cosa',
            },
          ],
        })
      );
      settings.update('/repo', {
        orchestratorSessionId: 'orch-9',
        orchestratorAdopted: adoptedOne || null,
      });
      running.add('orch-9');
      calls.length = 0;
      const restarted = make({ statePath });
      await restarted.restore();
      restarted.onClaudeTransition('orch-9', 'idle');
      await settle();
      expect(calls).toHaveLength(1);
      expect(calls[0].text).toContain('GOAL (from the user):\nOtra cosa');
      expect(calls[0].trustFolder).toBe(adoptedOne ? undefined : true);
      await restarted.stop('/repo');
    }
  });

  it('starts from the status already seen: a busy adopted session waits (2026-10-20)', async () => {
    running.add('chat-1');
    orchestrator.onClaudeTransition('chat-1', 'busy');
    const result = orchestrator.adopt('/repo', 'chat-1');
    await settle();
    expect(delivered).toHaveLength(0);
    advance(BRIEF_WAIT_MS);
    expect(await result).toMatchObject({ ok: true, sessionId: 'chat-1', pending: true });
    expect(orchestrator.list()).toEqual([
      { repoPath: '/repo', sessionId: 'chat-1', adopted: true, pending: true },
    ]);
    orchestrator.onClaudeTransition('chat-1', 'idle');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('The user made you the orchestrator');
    expect(orchestrator.list()[0].pending).toBeUndefined();
  });

  it('refuses the adoption when the brief can never be typed (session gone)', async () => {
    running.add('chat-1');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    deliver = async () => {
      running.delete('chat-1');
      return false;
    };
    expect(await orchestrator.adopt('/repo', 'chat-1')).toMatchObject({ ok: false, code: 'error' });
    expect(settings.get('/repo').orchestratorSessionId).toBeUndefined();
    expect(commands.roleFor({ kind: 'cli', sessionId: 'chat-1' }, '/repo')).toBe('session');
  });

  it('keeps its reply on the phone unless it is the quiet marker (2026-10-20)', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId, state: 'failed' }));
    const finished = (detail: string) => push('claude-finished', { sessionId, detail }, detail);
    expect(orchestrator.rewritePush(finished('—'))).toBeNull();
    expect(
      orchestrator.rewritePush(push('claude-replied', { sessionId, detail: ' – ' }))
    ).toBeNull();
    // No text of its own ("Your turn"): nothing to tell.
    expect(
      orchestrator.rewritePush(push('claude-finished', { sessionId, detail: '' }, 'Your turn'))
    ).toBeNull();
    // A report while a task is still open (failed) reaches the phone.
    const report = finished('La tarea del login falló dos veces; la he dejado para ti.');
    expect(orchestrator.rewritePush(report)).toBe(report);
    const question = finished('¿Uso OAuth o magic links?');
    expect(orchestrator.rewritePush(question)).toBe(question);
    const waiting = push('claude-waiting', { sessionId });
    expect(orchestrator.rewritePush(waiting)).toBe(waiting);
    const elsewhere = push('claude-finished', { sessionId: 'someone-else', detail: '—' });
    expect(orchestrator.rewritePush(elsewhere)).toBe(elsewhere);
    // Another agent's pushes of other sessions go out as they are.
    const codex = push('codex-finished', { sessionId: 'someone-else', detail: '' });
    expect(orchestrator.rewritePush(codex)).toBe(codex);
  });

  it('an orchestrator whose session ended is forgotten; its tasks push to the phone again', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    running.delete(sessionId);
    orchestrator.onSessionExited(sessionId);
    expect(settings.get('/repo').orchestratorSessionId).toBeUndefined();
    expect(commands.roleFor({ kind: 'cli', sessionId }, '/repo')).toBe('session');
    const ready = push('task-ready', { taskId: 'aaaa1111bbbb' });
    expect(orchestrator.routeTaskPush(ready)).toBe(ready);
  });

  it('pushes the events it never got when it goes away (2026-10-20)', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId, state: 'failed' }));
    orchestrator.onClaudeTransition(sessionId, 'busy');
    const failed = push('task-failed', { taskId: 'aaaa1111bbbb' });
    expect(orchestrator.routeTaskPush(failed)).toBeNull();
    running.delete(sessionId);
    orchestrator.onSessionExited(sessionId);
    expect(notified).toEqual([failed]);
  });

  it('takes the role back when its ended conversation is resumed (2026-10-20)', async () => {
    running.add('chat-1');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    await orchestrator.adopt('/repo', 'chat-1');
    running.delete('chat-1');
    orchestrator.onSessionExited('chat-1');
    expect(orchestrator.list()).toEqual([]);
    running.add('chat-2');
    orchestrator.sessionReplaced('chat-1', 'chat-2');
    expect(orchestrator.list()).toEqual([
      { repoPath: '/repo', sessionId: 'chat-2', adopted: true },
    ]);
    expect(settings.get('/repo').orchestratorSessionId).toBe('chat-2');
    expect(commands.roleFor({ kind: 'cli', sessionId: 'chat-2' }, '/repo')).toBe('orchestrator');
    expect(delivered.at(-1)?.text).toContain('You orchestrate repo again');
  });

  it('a long working spell already told is not told again after a restart (2026-10-20 review)', async () => {
    const statePath = path.join(tmp, 'control', 'orchestrators.json');
    orchestrator = make({ statePath });
    const sessionId = await started();
    tasks.push(
      task({
        id: 'long1111aaaa',
        orchestratorSessionId: sessionId,
        state: 'working',
        stateSince: new Date(clock).toISOString(),
      })
    );
    advance(LONG_RUNNING_MS + WATCH_INTERVAL_MS);
    expect(taskLines().filter((line) => line.includes('still working after an hour'))).toHaveLength(
      1
    );
    // The server restarts; the same spell goes on.
    settings.update('/repo', { orchestratorSessionId: sessionId });
    const restarted = make({ statePath });
    await restarted.restore();
    restarted.onClaudeTransition(sessionId, 'idle');
    delivered = [];
    advance(WATCH_INTERVAL_MS * 2);
    expect(taskLines().filter((line) => line.includes('still working after an hour'))).toHaveLength(
      0
    );
  });

  it('a task push sent again with the same outbox id is ignored, also after a restart (2026-11-02)', async () => {
    // Task pushes are sent at least once (task-scheduler.ts post): a kill after the send and
    // before tasks.json was written sends the same entry again, with the same pushId.
    const statePath = path.join(tmp, 'control', 'orchestrators.json');
    orchestrator = make({ statePath });
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    orchestrator.onClaudeTransition(sessionId, 'busy');
    const first = push('task-ready', { taskId: 'aaaa1111bbbb', pushId: 'p-1' });
    expect(orchestrator.routeTaskPush(first)).toBeNull();
    // The same one again, in the same life: nothing more queued.
    expect(orchestrator.routeTaskPush({ ...first })).toBeNull();
    expect(orchestrator.pending(sessionId)).toHaveLength(1);
    // The server dies before the agent took it; the next one gets the resend.
    settings.update('/repo', { orchestratorSessionId: sessionId });
    delivered = [];
    const restarted = make({ statePath });
    await restarted.restore();
    expect(restarted.routeTaskPush({ ...first })).toBeNull();
    restarted.onClaudeTransition(sessionId, 'idle');
    await settle();
    advance(WATCH_INTERVAL_MS);
    await settle();
    // What it had queued is typed once; the resend added nothing.
    expect(taskLines().filter((line) => line.includes('Login con Google'))).toHaveLength(1);
    // Another push about the same task (another id) is news.
    restarted.onClaudeTransition(sessionId, 'busy');
    tasks[0].state = 'needs_you';
    restarted.routeTaskPush(push('task-needs-you', { taskId: 'aaaa1111bbbb', pushId: 'p-2' }));
    expect(restarted.pending(sessionId)).toHaveLength(1);
  });

  it('takes the role back on resume even after a restart in between (2026-10-20 review)', async () => {
    const statePath = path.join(tmp, 'control', 'orchestrators.json');
    orchestrator = make({ statePath });
    running.add('chat-1');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    await orchestrator.adopt('/repo', 'chat-1');
    running.delete('chat-1');
    orchestrator.onSessionExited('chat-1');
    // The server restarts; then the user resumes the conversation.
    const restarted = make({ statePath });
    await restarted.restore();
    running.add('chat-2');
    restarted.sessionReplaced('chat-1', 'chat-2');
    expect(restarted.list()).toEqual([{ repoPath: '/repo', sessionId: 'chat-2', adopted: true }]);
  });

  it('comes back after a restart for sessions that still run, and forgets the others', async () => {
    settings.update('/repo', { orchestratorSessionId: 'orch-live', mergePolicy: 'ask' });
    settings.update('/gone', { orchestratorSessionId: 'orch-gone' });
    settings.update('/moved-away', {
      orchestratorSessionId: 'orch-moved',
      pinnedAt: new Date(0).toISOString(),
    });
    running.add('orch-live');
    running.add('orch-moved');
    gone.add('/moved-away');
    const followMoves = vi.fn(async () => undefined);
    const restarted = make({ settings: Object.assign(settings, { followMoves }) });
    await restarted.restore();
    expect(followMoves).toHaveBeenCalled();
    expect(restarted.list()).toEqual([{ repoPath: '/repo', sessionId: 'orch-live' }]);
    expect(settings.get('/gone').orchestratorSessionId).toBeUndefined();
    // A folder that is gone loses its orchestrator, and only that.
    expect(settings.getStored('/moved-away')).toEqual({ pinnedAt: new Date(0).toISOString() });
    expect(commands.roleFor({ kind: 'cli', sessionId: 'orch-live' }, '/repo')).toBe('orchestrator');
  });

  it('makes an open session the orchestrator, keeping it: rights, brief, its earlier tasks', async () => {
    running.add('chat-1');
    const result = await orchestrator.adopt('/repo/web', 'chat-1');
    expect(result).toEqual({ ok: true, repoPath: '/repo', sessionId: 'chat-1', reused: false });
    expect(created).toHaveLength(0);
    expect(settings.get('/repo').orchestratorSessionId).toBe('chat-1');
    expect(commands.roleFor({ kind: 'cli', sessionId: 'chat-1' }, '/repo')).toBe('orchestrator');
    expect(adopted).toEqual([['chat-1', '/repo']]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('The user made you the orchestrator of the project "repo"');
    expect(delivered[0].text).toContain('YOUR PROJECT is /repo');
    expect(delivered[0].text).toContain('The 2 open tasks you started earlier report to you now');
    expect(delivered[0].text).toContain('what you and the user have been working on');

    // Its tasks' events reach it like a started orchestrator's.
    orchestrator.onClaudeTransition('chat-1', 'busy');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    delivered = [];
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: 'chat-1' }));
    expect(orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }))).toBeNull();
    expect(delivered[0].sessionId).toBe('chat-1');

    // Adopted again with a goal: the brief goes in again, with the goal.
    orchestrator.onClaudeTransition('chat-1', 'busy');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    delivered = [];
    expect(await orchestrator.adopt('/repo', 'chat-1', 'Termina el logout')).toMatchObject({
      reused: true,
    });
    expect(delivered[0].text).toContain('The user made you the orchestrator');
    expect(delivered[0].text).toContain('GOAL (from the user):\nTermina el logout');
  });

  it('adopting the current orchestrator again types its brief again (2026-10-20)', async () => {
    running.add('chat-1');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    await orchestrator.adopt('/repo', 'chat-1');
    orchestrator.onClaudeTransition('chat-1', 'busy');
    orchestrator.onClaudeTransition('chat-1', 'idle');
    delivered = [];
    const again = await orchestrator.adopt('/repo', 'chat-1');
    expect(again).toEqual({ ok: true, repoPath: '/repo', sessionId: 'chat-1', reused: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain('The user made you the orchestrator of the project "repo"');
  });

  it('adopting again while the brief still waits does not double it', async () => {
    running.add('chat-1');
    orchestrator.onClaudeTransition('chat-1', 'busy');
    const first = orchestrator.adopt('/repo', 'chat-1');
    await settle();
    expect(await orchestrator.adopt('/repo', 'chat-1')).toMatchObject({
      reused: true,
      pending: true,
    });
    advance(BRIEF_WAIT_MS);
    await first;
    orchestrator.onClaudeTransition('chat-1', 'idle');
    expect(delivered).toHaveLength(1);
  });

  it('a goal typed with the switch goes with the brief', async () => {
    running.add('chat-1');
    await orchestrator.adopt('/repo', 'chat-1', 'Login con GitHub');
    expect(delivered[0].text).toContain('GOAL (from the user):\nLogin con GitHub');
  });

  it("refuses a session that is gone, not Claude, a task's own session, and a second orchestrator", async () => {
    expect(await orchestrator.adopt('/repo', 'nope')).toMatchObject({
      ok: false,
      code: 'bad-request',
    });
    running.add('shell-1');
    expect(await orchestrator.adopt('/repo', 'shell-1')).toMatchObject({
      ok: false,
      message: 'That session is not running Claude',
    });
    running.add('task-session');
    tasks.push(task({ sessionId: 'task-session', state: 'working' }));
    expect(await orchestrator.adopt('/repo', 'task-session')).toMatchObject({
      ok: false,
      code: 'bad-request',
    });
    await started();
    running.add('chat-1');
    expect(await orchestrator.adopt('/repo', 'chat-1')).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(await orchestrator.adopt('/tmp', 'chat-1')).toMatchObject({ ok: false });
  });

  it('follows its session when Blindar reopens it, queued events included', async () => {
    const sessionId = await started();
    orchestrator.onClaudeTransition(sessionId, 'busy');
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    orchestrator.routeTaskPush(push('task-ready', { taskId: 'aaaa1111bbbb' }));
    expect(orchestrator.pending(sessionId)).toHaveLength(1);

    orchestrator.sessionReplacing(sessionId);
    running.delete(sessionId);
    orchestrator.onSessionExited(sessionId);
    expect(settings.get('/repo').orchestratorSessionId).toBe(sessionId);
    running.add('shielded-1');
    orchestrator.sessionReplaced(sessionId, 'shielded-1');
    expect(settings.get('/repo').orchestratorSessionId).toBe('shielded-1');
    expect(orchestrator.list()).toEqual([{ repoPath: '/repo', sessionId: 'shielded-1' }]);
    expect(commands.roleFor({ kind: 'cli', sessionId: 'shielded-1' }, '/repo')).toBe(
      'orchestrator'
    );
    expect(commands.roleFor({ kind: 'cli', sessionId }, '/repo')).toBe('session');
    expect(delivered.map((entry) => entry.sessionId)).toEqual(['shielded-1']);
    expect(notified).toEqual([]);
  });

  it('a failed reopen pushes what it never got', async () => {
    const sessionId = await started();
    orchestrator.onClaudeTransition(sessionId, 'busy');
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId }));
    const ready = push('task-ready', { taskId: 'aaaa1111bbbb' });
    orchestrator.routeTaskPush(ready);
    orchestrator.sessionReplacing(sessionId);
    orchestrator.sessionReplaced(sessionId, null);
    expect(notified).toEqual([ready]);
  });

  it('stopping an adopted orchestrator leaves its session open and tells it (2026-10-20)', async () => {
    running.add('chat-1');
    await orchestrator.adopt('/repo', 'chat-1');
    expect(orchestrator.list()).toEqual([
      { repoPath: '/repo', sessionId: 'chat-1', adopted: true },
    ]);
    expect(await orchestrator.stop('/repo')).toEqual({ ok: true, sessionId: 'chat-1', kept: true });
    expect(stopped).toEqual([]);
    expect(running.has('chat-1')).toBe(true);
    expect(settings.get('/repo').orchestratorAdopted).toBeUndefined();
    expect(delivered.at(-1)).toEqual({
      sessionId: 'chat-1',
      text: '[untether] You no longer orchestrate repo; task events go to the user from now on.',
    });
    // A started one is still ended.
    await orchestrator.start('/repo', 'x');
    expect(orchestrator.list()[0].adopted).toBeUndefined();
    await orchestrator.stop('/repo');
    expect(stopped).toEqual(['orch-1']);
  });

  it('notices discarded tasks and long working spells; taskEvent takes the rest', async () => {
    const sessionId = await started();
    tasks.push(task({ id: 'aaaa1111bbbb', orchestratorSessionId: sessionId, state: 'ready' }));
    tasks.push(
      task({
        id: 'cccc2222dddd',
        name: 'Docs',
        state: 'working',
        stateSince: new Date(clock).toISOString(),
      })
    );
    advance(WATCH_INTERVAL_MS);
    expect(delivered).toHaveLength(0);
    tasks[0].state = 'discarded';
    advance(WATCH_INTERVAL_MS);
    // A discard is informational: it waits for the digest.
    expect(taskLines()).toHaveLength(0);
    advance(DIGEST_MS);
    expect(taskLines()[0]).toContain(
      'task aaaa1111 "Login con Google" (ut/login-google): discarded.'
    );

    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.onClaudeTransition(sessionId, 'idle');
    delivered = [];
    advance(LONG_RUNNING_MS);
    expect(taskLines()).toHaveLength(1);
    expect(taskLines()[0]).toContain(
      '"Docs" (ut/login-google): still working after an hour — working for'
    );
    // Once per working spell.
    orchestrator.onClaudeTransition(sessionId, 'busy');
    orchestrator.onClaudeTransition(sessionId, 'idle');
    advance(WATCH_INTERVAL_MS);
    expect(taskLines()).toHaveLength(1);

    delivered = [];
    expect(
      orchestrator.taskEvent('cccc2222dddd', 'confirmation', 'approved: merge with risk')
    ).toBe(true);
    expect(taskLines()[0]).toContain(
      "your request was answered — approved: merge with risk. Next: follow the user's decision."
    );
    expect(orchestrator.taskEvent('nope', 'working-again')).toBe(false);
    expect(orchestrator.notice('/repo', 'Your check command change was approved')).toBe(true);
  });

  describe('digest of informational notes (2026-11-02)', () => {
    it('holds informational events until the digest is due, then types them in one note', async () => {
      const sessionId = await started();
      tasks.push(task({ id: 'q1aaaaaaaa', orchestratorSessionId: sessionId, state: 'queued' }));
      tasks.push(task({ id: 'm1aaaaaaaa', name: 'Logo', state: 'merged' }));
      const queuedPush = push('task-queued', { taskId: 'q1aaaaaaaa' });
      expect(orchestrator.routeTaskPush(queuedPush)).toBeNull();
      advance(5 * 60_000);
      orchestrator.routeTaskPush(push('task-merged', { taskId: 'm1aaaaaaaa' }));
      expect(delivered).toHaveLength(0);
      expect(orchestrator.waitingWork(sessionId)).toBe('2 queued task event(s) (2 for the digest)');
      // An idle orchestrator does not take it before it is due.
      orchestrator.onClaudeTransition(sessionId, 'idle');
      advance(DIGEST_MS - 5 * 60_000 - 1);
      expect(delivered).toHaveLength(0);
      advance(1);
      expect(delivered).toHaveLength(1);
      const lines = delivered[0].text.split('\n');
      expect(lines[0]).toMatch(/^\[untether\] Digest since \d\d:\d\d: 2 informational task note/);
      expect(lines[1]).toContain('task q1aaaaaa');
      expect(lines[2]).toContain('task m1aaaaaa');
      expect(delivered[0].text).not.toContain('Needs you now');
      // Held on purpose: never pushed to the phone as a held push, however long it waited.
      advance(HELD_PUSH_MS);
      expect(notified).toEqual([]);
    });

    it('an urgent event goes at once and takes the digest along, ahead of it', async () => {
      const sessionId = await started();
      tasks.push(task({ id: 's1aaaaaaaa', orchestratorSessionId: sessionId, state: 'working' }));
      tasks.push(task({ id: 'r1aaaaaaaa', name: 'Docs', state: 'ready' }));
      orchestrator.routeTaskPush(push('task-started', { taskId: 's1aaaaaaaa' }));
      expect(delivered).toHaveLength(0);
      orchestrator.routeTaskPush(push('task-ready', { taskId: 'r1aaaaaaaa' }));
      expect(delivered).toHaveLength(1);
      const lines = delivered[0].text.split('\n');
      expect(lines[0]).toContain('Digest since');
      expect(lines[1]).toContain('task s1aaaaaa "Login con Google" (ut/login-google): started');
      expect(lines[2]).toBe('[untether] Needs you now:');
      expect(lines[3]).toContain('task r1aaaaaa "Docs" (ut/login-google): ready');
      // Its timer was cleared: nothing comes again when it would have been due.
      orchestrator.onClaudeTransition(sessionId, 'busy');
      orchestrator.onClaudeTransition(sessionId, 'idle');
      advance(DIGEST_MS);
      expect(delivered).toHaveLength(1);
    });

    it('a message (a goal, a notice, a request) takes the digest along too', async () => {
      const sessionId = await started();
      tasks.push(task({ id: 'q1aaaaaaaa', orchestratorSessionId: sessionId, state: 'queued' }));
      orchestrator.routeTaskPush(push('task-queued', { taskId: 'q1aaaaaaaa' }));
      expect(delivered).toHaveLength(0);
      expect(orchestrator.notice('/repo', 'Doctor: fix the stale check')).toBe(true);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain('[untether] Doctor: fix the stale check');
      expect(delivered[0].text).toContain('task q1aaaaaa');
    });

    it('a newer urgent event of the same task replaces its held one', async () => {
      const sessionId = await started();
      tasks.push(task({ id: 'a1aaaaaaaa', orchestratorSessionId: sessionId, state: 'working' }));
      orchestrator.routeTaskPush(push('task-started', { taskId: 'a1aaaaaaaa' }));
      tasks[0].state = 'needs_you';
      tasks[0].blocker = { kind: 'risk', message: 'Toca auth' };
      orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'a1aaaaaaaa' }));
      expect(taskLines()).toHaveLength(1);
      expect(taskLines()[0]).toContain('needs you · risk');
      expect(delivered[0].text).not.toContain('Digest');
    });

    it('a stall told again, or a pause with no try left, is urgent; the first stall waits', async () => {
      const sessionId = await started();
      tasks.push(task({ id: 'st1aaaaaaa', orchestratorSessionId: sessionId, state: 'working' }));
      orchestrator.routeTaskPush(push('task-stalled', { taskId: 'st1aaaaaaa' }));
      expect(delivered).toHaveLength(0);
      orchestrator.routeTaskPush(push('task-stalled', { taskId: 'st1aaaaaaa', escalated: true }));
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain('stalled');

      orchestrator.onClaudeTransition(sessionId, 'busy');
      orchestrator.onClaudeTransition(sessionId, 'idle');
      delivered = [];
      tasks.push(
        task({
          id: 'pa1aaaaaaa',
          name: 'Docs',
          state: 'paused',
          halt: { kind: 'usage-limit', message: 'limit', since: 'x', attempts: 1, nextTryAt: 'y' },
        })
      );
      orchestrator.routeTaskPush(push('task-paused', { taskId: 'pa1aaaaaaa' }));
      expect(delivered).toHaveLength(0);
      delete tasks[1].halt?.nextTryAt;
      orchestrator.routeTaskPush(push('task-paused', { taskId: 'pa1aaaaaaa' }));
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain("Untether's automatic tries ran out");
    });

    it('an hour of work with recent progress waits; without it, it goes at once', async () => {
      const sessionId = await started();
      tasks.push(
        task({
          id: 'lr1aaaaaaa',
          orchestratorSessionId: sessionId,
          state: 'working',
          stateSince: new Date(clock).toISOString(),
        })
      );
      advance(LONG_RUNNING_MS - WATCH_INTERVAL_MS);
      tasks[0].progress = { at: new Date(clock).toISOString(), by: 'output' };
      advance(WATCH_INTERVAL_MS);
      expect(taskLines()).toHaveLength(0);
      advance(DIGEST_MS);
      expect(taskLines()).toHaveLength(1);
      expect(taskLines()[0]).toContain('task lr1aaaaa');
      expect(taskLines()[0]).toContain('still working after an hour');

      // Another one, its last real progress long ago: it needs a look now.
      orchestrator.onClaudeTransition(sessionId, 'busy');
      orchestrator.onClaudeTransition(sessionId, 'idle');
      delivered = [];
      tasks.push(
        task({
          id: 'lr2aaaaaaa',
          name: 'Docs',
          state: 'working',
          stateSince: new Date(clock - LONG_RUNNING_MS).toISOString(),
          progress: { at: new Date(clock - LONG_RUNNING_MS).toISOString(), by: 'output' },
        })
      );
      advance(WATCH_INTERVAL_MS);
      expect(taskLines()).toHaveLength(1);
      expect(taskLines()[0]).toContain('task lr2aaaaa');
      expect(delivered[0].text).not.toContain('Digest');
    });

    it('digestMinutes 0: every note at once', async () => {
      settings.update('/repo', { digestMinutes: 0 });
      const sessionId = await started();
      tasks.push(task({ id: 'q1aaaaaaaa', orchestratorSessionId: sessionId, state: 'queued' }));
      orchestrator.routeTaskPush(push('task-queued', { taskId: 'q1aaaaaaaa' }));
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain('Digest since');
    });

    it('a restart keeps the held digest and its due time', async () => {
      const statePath = path.join(tmp, 'control', 'orchestrators.json');
      orchestrator = make({ statePath });
      const sessionId = await started();
      tasks.push(task({ id: 'q1aaaaaaaa', orchestratorSessionId: sessionId, state: 'queued' }));
      orchestrator.routeTaskPush(push('task-queued', { taskId: 'q1aaaaaaaa' }));
      advance(10 * 60_000);
      // The old process is gone: its timers with it.
      for (const timer of timers) timer.cleared = true;
      const restarted = make({ statePath });
      await restarted.restore();
      restarted.onClaudeTransition(sessionId, 'idle');
      expect(delivered).toHaveLength(0);
      advance(DIGEST_MS - 10 * 60_000);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain('task q1aaaaaa');
    });
  });

  describe('moved projects (2026-10-25: toolshed renamed to bakery)', () => {
    it('a live orchestrator follows its project: found, its rights and file on the new folder', async () => {
      const statePath = path.join(tmp, 'control', 'orchestrators.json');
      orchestrator = make({ statePath });
      const sessionId = await started();
      expect(orchestrator.projectsMoved([{ from: '/repo', to: '/den' }])).toBe(1);
      expect(orchestrator.sessionFor('/den')).toBe(sessionId);
      expect(orchestrator.sessionFor('/repo')).toBeUndefined();
      expect(commands.roleFor({ kind: 'cli', sessionId }, '/den')).toBe('orchestrator');
      expect(commands.orchestratedRepos(sessionId)).toEqual(['/den']);
      expect(orchestrator.relay('/den', 'hola')).toBe(true);
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(saved.orchestrators.map((entry: { repoPath: string }) => entry.repoPath)).toEqual([
        '/den',
      ]);
      // Told again (the doctor's replay): nothing left to move.
      expect(orchestrator.projectsMoved([{ from: '/repo', to: '/den' }])).toBe(0);
    });

    it('a restart heals orchestrators.json left on the old folder: its queue is kept', async () => {
      const statePath = path.join(tmp, 'control', 'orchestrators.json');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          orchestrators: [
            {
              sessionId: 'chat-1',
              repoPath: '/toolshed',
              messages: ['[untether] pendiente'],
              events: [],
              manual: 99,
            },
          ],
          exited: [{ sessionId: 'old-1', repoPath: '/toolshed', adopted: true }],
        })
      );
      settings.update('/den', { orchestratorSessionId: 'chat-1', orchestratorAdopted: true });
      running.add('chat-1');
      const currentPath = (dir: string) => (dir === '/toolshed' ? '/den' : null);
      const restarted = make({ statePath, settings: Object.assign(settings, { currentPath }) });
      await restarted.restore();
      expect(restarted.sessionFor('/den')).toBe('chat-1');
      restarted.onClaudeTransition('chat-1', 'idle');
      expect(delivered.map((entry) => entry.text)).toContain('[untether] pendiente');
      expect(notified).toEqual([]);
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(saved.orchestrators[0].repoPath).toBe('/den');
      expect(saved.exited).toEqual([{ sessionId: 'old-1', repoPath: '/den', adopted: true }]);
    });
  });

  describe('round 3 (2026-10-20)', () => {
    it('a pending brief and a held-back event survive a restart (0600), and go in then', async () => {
      const statePath = path.join(tmp, 'control', 'orchestrators.json');
      orchestrator = make({ statePath });
      running.add('chat-1');
      orchestrator.onClaudeTransition('chat-1', 'busy');
      const adopting = orchestrator.adopt('/repo', 'chat-1');
      await settle();
      advance(BRIEF_WAIT_MS);
      expect(await adopting).toMatchObject({ ok: true, pending: true });
      tasks.push(
        task({
          id: 'q1aaaaaaaa',
          orchestratorSessionId: 'chat-1',
          state: 'needs_you',
          blocker: { kind: 'question', message: '¿A o B?' },
        })
      );
      expect(
        orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'q1aaaaaaaa' }))
      ).toBeNull();
      expect(delivered).toHaveLength(0);
      expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);

      // The server restarts; the session still runs.
      const restarted = make({ statePath });
      await restarted.restore();
      expect(restarted.list()).toEqual([{ repoPath: '/repo', sessionId: 'chat-1', adopted: true }]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toContain('The user made you the orchestrator');
      expect(delivered[0].text).toContain('task q1aaaaaa');
      expect(restarted.list()[0].pending).toBeUndefined();
      // Typed: nothing waits on disk any more.
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      expect(saved.orchestrators[0]).toMatchObject({ messages: [], events: [] });
    });

    it('an orchestrator briefed with an older manual hears what changed, once (2026-10-20)', async () => {
      const statePath = path.join(tmp, 'control', 'orchestrators.json');
      // Saved by a server before manual versions: none recorded.
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          orchestrators: [{ sessionId: 'chat-1', repoPath: '/repo', messages: [], events: [] }],
        })
      );
      settings.update('/repo', { orchestratorSessionId: 'chat-1', orchestratorAdopted: true });
      running.add('chat-1');
      const restarted = make({ statePath });
      await restarted.restore();
      restarted.onClaudeTransition('chat-1', 'idle');
      expect(delivered.map((entry) => entry.text).join('\n')).toContain('ut project tell');

      // Told once: the next restart says nothing.
      delivered = [];
      const again = make({ statePath });
      await again.restore();
      again.onClaudeTransition('chat-1', 'idle');
      expect(delivered).toEqual([]);
    });

    it('events of an orchestrator gone during the restart reach the phone', async () => {
      const statePath = path.join(tmp, 'orchestrators.json');
      orchestrator = make({ statePath });
      const sessionId = await started();
      orchestrator.onClaudeTransition(sessionId, 'busy');
      tasks.push(task({ id: 'f1aaaaaaaa', orchestratorSessionId: sessionId, state: 'failed' }));
      const payload = push('task-failed', { taskId: 'f1aaaaaaaa' });
      expect(orchestrator.routeTaskPush(payload)).toBeNull();
      running.delete(sessionId);
      const restarted = make({ statePath });
      await restarted.restore();
      expect(notified).toEqual([payload]);
    });

    it('a task made and discarded within one watch is told', async () => {
      const sessionId = await started();
      tasks.push(task({ id: 'd1aaaaaaaa', orchestratorSessionId: sessionId, state: 'discarded' }));
      advance(WATCH_INTERVAL_MS);
      advance(DIGEST_MS);
      expect(
        taskLines().some((line) => line.includes('task d1aaaaaa') && line.includes('discarded'))
      ).toBe(true);
      delivered = [];
      advance(WATCH_INTERVAL_MS * 2);
      expect(taskLines()).toHaveLength(0);
    });

    it("a question on the task's screen and fixes that ran out say so, with what to do", async () => {
      const sessionId = await started();
      tasks.push(
        task({
          id: 'm1aaaaaaaa',
          orchestratorSessionId: sessionId,
          state: 'needs_you',
          blocker: { kind: 'question', message: '¿A o B?', onScreen: true },
        }),
        task({
          id: 'v1aaaaaaaa',
          orchestratorSessionId: sessionId,
          state: 'failed',
          blocker: { kind: 'verify', message: 'The check failed' },
          autoFixes: { verify: 1, conflict: 2 },
        })
      );
      orchestrator.routeTaskPush(push('task-needs-you', { taskId: 'm1aaaaaaaa' }));
      advance(DELIVERY_SETTLE_MS);
      orchestrator.routeTaskPush(push('task-failed', { taskId: 'v1aaaaaaaa' }));
      advance(DELIVERY_SETTLE_MS);
      const lines = taskLines();
      expect(lines.find((line) => line.includes('m1aaaaaa'))).toContain('question (on its screen)');
      expect(lines.find((line) => line.includes('m1aaaaaa'))).toContain(
        'only the user can pick it there'
      );
      expect(lines.find((line) => line.includes('v1aaaaaa'))).toContain('(fixes ran out)');
    });
  });
});
