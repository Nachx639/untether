/**
 * A task's brief that is not typed yet (2026-10-23, Codex tasks 9dfebf2d and 27a26521): the
 * task is not done meanwhile, a session gone before it went in is started again with it, and
 * a task its agent works on again after it settled is followed again.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { NotificationPayload } from './push-notification-service.js';
import {
  CODEX_IDLE_MS,
  type LaunchedSession,
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const T0 = new Date('2026-10-23T12:10:00Z').getTime();

function codexTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Security: remove unused ws',
    prompt: 'Remove ws',
    workingDir: '/Users/me/Projects/app',
    command: ['codex'],
    agent: 'codex',
    shielded: true,
    notify: true,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TaskScheduler: a brief not typed yet', () => {
  let dir: string;
  let statuses: Map<string, string>;
  let lastOutput: number;
  let typed: Array<ReturnType<typeof deferred<boolean>>>;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let commits: number;
  let schedulers: TaskScheduler[];

  const worktrees = (): TaskWorktrees => ({
    create: vi.fn(async () => ({
      repoPath: '/repo',
      baseBranch: 'main',
      baseSha: 'abc123',
      branch: 'ut/remove-ws',
      worktreePath: dir,
      clonedDirs: [],
    })),
    remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
    commitLeftovers: vi.fn(async () => false),
    changes: vi.fn(async () => ({
      files: commits ? ['package.json'] : [],
      stats: { commits, files: commits ? 1 : 0, insertions: 1, deletions: 1 },
    })),
    hasUnmergedWork: vi.fn(async () => commits > 0),
  });

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: (id) => statuses.get(id) ?? 'running',
      lastOutputAt: () => lastOutput,
      deliver: () => true,
      worktrees: worktrees(),
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      logDir: path.join(dir, 'logs'),
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  // Not settled(): it waits for every job, a brief's typing (pending here on purpose) too.
  const flush = async () => {
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
  };

  const create = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
    const created = await scheduler.create(codexTask(overrides));
    await flush();
    return scheduler.get(created.id) as TaskRecord;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-brief-'));
    statuses = new Map();
    lastOutput = T0;
    typed = [];
    commits = 0;
    let n = 0;
    launch = vi.fn(async (_task: TaskRecord, prompt: string): Promise<LaunchedSession> => {
      const typing = deferred<boolean>();
      typed.push(typing);
      return { sessionId: `s${++n}`, typed: typing.promise, text: prompt };
    });
    notify = vi.fn();
    pipeline = vi.fn(async () => ({ state: 'merged', mergedSha: 'def456', baseSha: 'abc999' }));
    schedulers = [];
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('is not done while its brief waits, however quiet its agent is; done once it went in', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await create(scheduler);
    // Codex on a menu for half an hour: its screen does not change.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS);
      await scheduler.checkExited();
    }
    expect(scheduler.get(created.id)).toMatchObject({ state: 'working' });
    expect(scheduler.get(created.id)?.blocker).toBeUndefined();

    // The brief goes in: the quiet counts from there.
    typed[0].resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS / 2);
    await scheduler.checkExited();
    expect(scheduler.get(created.id)?.state).toBe('working');
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS);
    await scheduler.checkExited();
    expect(scheduler.get(created.id)?.state).toBe('ready');
  });

  it('is started again with its brief when its session ends before the brief went in', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await create(scheduler, { isolation: 'worktree' });
    expect(created.sessionId).toBe('s1');
    const brief = launch.mock.calls[0][1] as string;

    // An Enter on its update menu: Codex updated itself and quit (exit 0).
    statuses.set('s1', 'exited');
    await scheduler.checkExited();
    expect(scheduler.get(created.id)?.state).toBe('working');
    typed[0].resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    await scheduler.checkExited();

    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][1]).toBe(brief);
    const again = scheduler.get(created.id) as TaskRecord;
    expect(again).toMatchObject({ state: 'working', sessionId: 's2', reopens: 1 });
    expect(again.pendingInput).toBeUndefined();
    expect(again.blocker?.kind).not.toBe('no-changes');
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('a session that ended with its brief typed and nothing done fails as session-exit', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await create(scheduler, { isolation: 'worktree' });
    typed[0].resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    statuses.set('s1', 'exited');
    await scheduler.checkExited();
    expect(scheduler.get(created.id)).toMatchObject({
      state: 'failed',
      blocker: { kind: 'session-exit' },
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('a ready Codex task whose agent works again is followed again and goes through the pipeline', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await create(scheduler, { isolation: 'worktree' });
    typed[0].resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS + 1);
    await scheduler.checkExited();
    await flush();
    expect(scheduler.get(created.id)).toMatchObject({
      state: 'ready',
      blocker: { kind: 'no-changes' },
    });

    // Its screen redrawn (the phone opened it): no new work, it stays ready.
    await vi.advanceTimersByTimeAsync(10_000);
    lastOutput = Date.now();
    await scheduler.checkExited();
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS + 1);
    await scheduler.checkExited();
    await flush();
    expect(scheduler.get(created.id)?.state).toBe('ready');

    // The agent works again (the user typed in its session) and commits.
    await vi.advanceTimersByTimeAsync(10_000);
    lastOutput = Date.now();
    commits = 1;
    await scheduler.checkExited();
    expect(scheduler.get(created.id)?.state).toBe('ready');
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS + 1);
    await scheduler.checkExited();
    await flush();
    expect(scheduler.get(created.id)?.state).toBe('working');
    await scheduler.checkExited();
    await flush();
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(scheduler.get(created.id)?.state).toBe('merged');
  });

  it('a ready Codex task is working again once something typed into it after it settled shows output', async () => {
    let sent = 0;
    const scheduler = make({
      deliver: () => {
        sent++;
        return true;
      },
    });
    await scheduler.start(0);
    const created = await create(scheduler);
    typed[0].resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    // A follow-up still waiting when the agent said it was done.
    (scheduler as unknown as { tasks: TaskRecord[] }).tasks[0].pendingInput = [
      { text: 'Also bump ws', at: new Date().toISOString() },
    ];
    await scheduler.markDone('s1', 'Removed ws');
    // A follow-up still to be typed: not done yet.
    expect(scheduler.get(created.id)?.state).toBe('ready');

    await vi.advanceTimersByTimeAsync(5_000);
    await (scheduler as unknown as { pumpInput(t: TaskRecord): Promise<void> }).pumpInput(
      (scheduler as unknown as { tasks: TaskRecord[] }).tasks[0]
    );
    expect(sent).toBe(1);
    lastOutput = Date.now();
    await scheduler.checkExited();
    expect(scheduler.get(created.id)?.state).toBe('working');
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS + 1);
    await scheduler.checkExited();
    // The follow-up typed and its agent quiet again: nothing left, so it is done (2026-10-24).
    expect(scheduler.get(created.id)?.state).toBe('done');
  });

  it('tells the user once that the agent waits for a choice on its screen', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await create(scheduler);
    scheduler.agentChoiceOnScreen('s1');
    scheduler.agentChoiceOnScreen('s1');
    const told = notify.mock.calls
      .map(([payload]) => payload as NotificationPayload)
      .filter((payload) => payload.body?.includes('waiting for a choice on its screen'));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      type: 'task-needs-you',
      body: expect.stringContaining('Codex is waiting for a choice on its screen'),
    });
    expect(scheduler.get(created.id)?.state).toBe('working');
    // Not for a session no task runs in.
    const before = notify.mock.calls.length;
    scheduler.agentChoiceOnScreen('other');
    expect(notify.mock.calls.length).toBe(before);
  });
});
