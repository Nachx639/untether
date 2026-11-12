// @vitest-environment happy-dom
/**
 * The guard of 2026-11-09 (a question that stayed in «Te necesita» after it was answered): every
 * origin of «te necesita» clears when it is resolved, by every way it can be resolved, and a
 * push still held about it never goes out.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { needsYouItems } from '../../client/utils/needs-you.js';
import { isDoneTask } from '../../client/utils/task-status.js';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { NotificationPayload } from './push-notification-service.js';
import { TaskConfirmations } from './task-confirmations.js';
import { TaskScheduler } from './task-scheduler.js';

type Claude = Parameters<TaskScheduler['onClaudeTransition']>[3];

const busy: Claude = { status: 'busy' } as Claude;
const idle: Claude = { status: 'idle' } as Claude;

/** Each way a task comes to wait for the user, on a Claude last seen `busy`. */
const ORIGINS: Array<[string, (s: TaskScheduler) => string, RegExp]> = [
  [
    'a permission prompt',
    (scheduler) => {
      scheduler.onClaudeTransition('s1', 'busy', 'waiting', {
        status: 'waiting',
        waitingFor: 'Claude needs your permission to use Bash',
      } as Claude);
      return 'waiting';
    },
    /permission/,
  ],
  [
    "the agent's own menu",
    (scheduler) => {
      scheduler.onClaudeTransition('s1', 'busy', 'waiting', {
        status: 'waiting',
        waitingFor: 'Which option?',
      } as Claude);
      return 'waiting';
    },
    /question/,
  ],
  [
    '`ut task ask`, after the guard stopped a command',
    (scheduler) => {
      scheduler.ask('s1', 'El guard de Untether bloqueó el mv: ¿lo hago?');
      scheduler.onClaudeTransition('s1', 'busy', 'idle', idle);
      return 'idle';
    },
    /question/,
  ],
];

describe('«Te necesita» clears however it is resolved', () => {
  let dir: string;
  let withdrawn: Array<(payload: NotificationPayload) => boolean>;
  let schedulers: TaskScheduler[];

  const make = () => {
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: (async () => ({ sessionId: 's1' })) as never,
      notify: vi.fn(),
      sessionStatus: () => 'running',
      withdrawPush: (matches) => withdrawn.push(matches),
      now: () => Date.now(),
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const waiting = async (origin: (s: TaskScheduler) => string) => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create({
      name: 'Sustituir la app',
      prompt: 'Sustituye la app',
      workingDir: '/Users/me/Projects/app',
      command: ['claude'],
      agent: 'claude',
      shielded: true,
      notify: true,
    });
    scheduler.onClaudeTransition('s1', 'idle', 'busy', {
      ...busy,
      preview: { role: 'assistant', text: 'Sustituyo la app' },
    } as Claude);
    const status = origin(scheduler);
    expect(scheduler.get(created.id)?.state).toBe('needs_you');
    return { scheduler, id: created.id, status };
  };

  /** What the home shows for the task as it stands, with its session at `status`. */
  const shown = (task: TaskRecord, status: string) => {
    const session = {
      id: 's1',
      name: 'x',
      status: 'running',
      command: ['claude'],
      claudeStatus: { status },
    } as unknown as Session;
    return needsYouItems({
      sessions: [session],
      tasks: isDoneTask(task) ? [] : [task],
      closed: isDoneTask(task) ? [task] : [],
    });
  };

  const heldPushFor = (id: string): NotificationPayload => ({
    type: 'task-needs-you',
    title: 't',
    body: 'b',
    data: { taskId: id },
  });

  const expectCleared = (scheduler: TaskScheduler, id: string, status: string) => {
    const task = scheduler.get(id) as TaskRecord;
    expect(task.state).not.toBe('needs_you');
    expect(task.blocker).toBeUndefined();
    expect(shown(task, status)).toEqual([]);
    expect(withdrawn.some((matches) => matches(heldPushFor(id)))).toBe(true);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 2, 0));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-resolved-'));
    withdrawn = [];
    schedulers = [];
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  describe.each(ORIGINS)('%s', (_name, origin, kind) => {
    it('shows as waiting first, with its reason', async () => {
      const { scheduler, id, status } = await waiting(origin);
      const task = scheduler.get(id) as TaskRecord;
      expect(task.blocker?.kind).toMatch(kind);
      expect(shown(task, status).map((item) => item.tier)).toEqual(['asks']);
    });

    it('clears when answered in the terminal', async () => {
      const { scheduler, id, status } = await waiting(origin);
      scheduler.onClaudeTransition('s1', status, 'busy', {
        ...busy,
        preview: { role: 'user', text: 'Sí, hazlo' },
      } as Claude);
      expectCleared(scheduler, id, 'busy');
    });

    it('clears when the task ends', async () => {
      const { scheduler, id } = await waiting(origin);
      await scheduler.markDone('s1', 'Hecho desde fuera');
      expect(scheduler.get(id)?.state).toBe('done');
      // Its session may still show the menu until it is stopped: nothing of the task waits.
      expectCleared(scheduler, id, 'waiting');
    });

    it('clears when it is discarded', async () => {
      const { scheduler, id, status } = await waiting(origin);
      expect((await scheduler.discard(id)).ok).toBe(true);
      expectCleared(scheduler, id, status);
    });
  });

  it('a question answered in the terminal right after a restart clears too', async () => {
    // Nothing recorded to compare the conversation with: it stayed for the whole next turn.
    const { id } = await waiting(ORIGINS[2][1]);
    schedulers.pop()?.stop();
    const restarted = make();
    await restarted.start(0);
    expect(restarted.get(id)?.state).toBe('needs_you');
    restarted.onClaudeTransition('s1', 'idle', 'busy', {
      ...busy,
      preview: { role: 'user', text: 'Sí, hazlo' },
    } as Claude);
    expectCleared(restarted, id, 'busy');
  });

  it('a redraw of the terminal after a restart does not answer the question', async () => {
    const { id } = await waiting(ORIGINS[2][1]);
    schedulers.pop()?.stop();
    const restarted = make();
    await restarted.start(0);
    restarted.onClaudeTransition('s1', 'idle', 'busy', {
      ...busy,
      preview: { role: 'assistant', text: 'El guard bloqueó el mv' },
    } as Claude);
    expect(restarted.get(id)?.state).toBe('needs_you');
  });

  it('a prompt that goes straight to idle (answered No, timed out) does not stay', async () => {
    const { id } = await waiting(ORIGINS[0][1]);
    schedulers.pop()?.stop();
    const restarted = make();
    await restarted.start(0);
    restarted.onClaudeTransition('s1', undefined, 'waiting', {
      status: 'waiting',
      waitingFor: 'Claude needs your permission to use Bash',
    } as Claude);
    restarted.onClaudeTransition('s1', 'waiting', 'idle', idle);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarted.get(id)?.state).not.toBe('needs_you');
  });

  describe('an OK waiting for the user', () => {
    const request = {
      kind: 'discard' as const,
      where: 'Login',
      summary: 'Discard: Login',
      detail: [],
      taskId: 't1',
      requestedBy: {},
      action: 'discard',
      key: 'k',
    };
    const confirmPush = (confirmId: string): NotificationPayload => ({
      type: 'task-confirm',
      title: 't',
      body: 'b',
      data: { confirmId },
    });
    const store = () =>
      new TaskConfirmations<string, string>({
        run: async () => 'ran',
        notify: vi.fn(),
        withdrawPush: (matches) => withdrawn.push(matches),
        now: () => Date.now(),
      });

    it.each([
      ['approved', true],
      ['declined', false],
    ])('leaves the list and its held push when %s', async (_name, approve) => {
      const confirmations = store();
      await confirmations.submit(request);
      const [pending] = confirmations.list();
      expect(needsYouItems({ sessions: [], tasks: [], confirmations: [pending] })).toHaveLength(1);
      await confirmations.answer(pending.id, approve);
      expect(confirmations.list()).toEqual([]);
      expect(withdrawn.some((matches) => matches(confirmPush(pending.id)))).toBe(true);
    });

    it('leaves the list and its held push when it expires', async () => {
      const confirmations = store();
      await confirmations.submit(request);
      const [pending] = confirmations.list();
      vi.setSystemTime(Date.parse(pending.expiresAt) + 1);
      expect(confirmations.list()).toEqual([]);
      expect(withdrawn.some((matches) => matches(confirmPush(pending.id)))).toBe(true);
    });

    it('is not shown once its task ended, nor brings back an older one', async () => {
      const confirmations = store();
      await confirmations.submit(request);
      const [pending] = confirmations.list();
      const closed = [{ id: 't1', sessionId: 's1' }];
      expect(needsYouItems({ sessions: [], tasks: [], confirmations: [pending], closed })).toEqual(
        []
      );
      // Asked again with another id: only what is listed now shows, the old id is not kept.
      const again = { ...pending, id: 'other', taskId: 't2' };
      expect(
        needsYouItems({ sessions: [], tasks: [], confirmations: [again], closed }).map(
          (item) => item.key
        )
      ).toEqual(['confirm:other']);
    });
  });
});
