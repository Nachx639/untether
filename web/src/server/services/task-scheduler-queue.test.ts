/**
 * A project's task limit (maxActiveTasks, 2026-11-01: bakery ran 5 to 6 tasks at once on a
 * 24 GB Mac, 7 to 9 GB of swap, checks of 7 to 18 min): tasks past it wait queued, start by
 * themselves first in first out, and can be started now, moved or discarded meanwhile.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import { TASK_QUEUE_NEEDS_YOU_HOLD_MS, type TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { queuedNote } from '../task-cli/format-task-line.js';
import type { NotificationPayload } from './push-notification-service.js';
import {
  createResourceMonitor,
  DEFAULT_TASK_ADMISSION,
  type ResourceSample,
  type TaskAdmissionSettings,
} from './resource-monitor.js';
import {
  fairest,
  fitsSlots,
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const REPO = '/Users/me/Projects/bakery';
const OTHER = '/Users/me/Projects/atlas';

function newTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Tarea',
    prompt: 'Haz algo',
    workingDir: REPO,
    command: ['claude'],
    agent: 'claude',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    repoPath: REPO,
    ...overrides,
  };
}

describe('TaskScheduler: project task limit (maxActiveTasks)', () => {
  let dir: string;
  let store: string;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let stopSession: ReturnType<typeof vi.fn>;
  let worktrees: TaskWorktrees & Record<string, ReturnType<typeof vi.fn>>;
  let limits: Map<string, number | undefined>;
  let statuses: Map<string, string>;
  let schedulers: TaskScheduler[];

  const settingsOf = (repoPath: string): ProjectSettings => ({
    ...DEFAULT_PROJECT_SETTINGS,
    ...(limits.get(repoPath) !== undefined ? { maxActiveTasks: limits.get(repoPath) } : {}),
  });

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: (id) => statuses.get(id) ?? 'running',
      stopSession: stopSession as unknown as TaskSchedulerDeps['stopSession'],
      deliver: () => true,
      worktrees,
      pipeline: (async () => ({
        state: 'merged',
        mergedSha: 'def456',
        baseSha: 'abc999',
      })) as unknown as TaskSchedulerDeps['pipeline'],
      settings: {
        get: settingsOf,
        list: () =>
          [...limits.keys()].map((repoPath) => ({ repoPath, settings: settingsOf(repoPath) })),
      },
      mainRepo: async (folder) => (folder.startsWith(OTHER) ? OTHER : REPO),
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 10,
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const create = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
    const task = await scheduler.create(newTask(overrides));
    await scheduler.settled();
    return scheduler.get(task.id) as TaskRecord;
  };

  const state = (scheduler: TaskScheduler, id: string) => scheduler.get(id)?.state;
  const pushes = () => notify.mock.calls.map(([payload]) => payload as NotificationPayload);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 21, 0));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-queue-'));
    store = path.join(dir, 'tasks.json');
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    notify = vi.fn();
    stopSession = vi.fn(async () => undefined);
    limits = new Map([[REPO, 2]]);
    statuses = new Map();
    schedulers = [];
    let w = 0;
    worktrees = {
      create: vi.fn(async () => {
        w++;
        return {
          repoPath: REPO,
          baseBranch: 'main',
          baseSha: 'abc123',
          branch: `ut/tarea-${w}`,
          worktreePath: `/wt/${w}`,
          clonedDirs: [],
        };
      }),
      remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
      commitLeftovers: vi.fn(async () => false),
      changes: vi.fn(async () => ({
        files: ['src/a.ts'],
        stats: { commits: 1, files: 1, insertions: 3, deletions: 1 },
      })),
      hasUnmergedWork: vi.fn(async () => false),
    };
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('limit 2 with 3 tasks: the third waits queued with its prompt, and starts when one finishes', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const b = await create(scheduler, { name: 'B' });
    const c = await create(scheduler, { name: 'C', prompt: 'El prompt de C' });
    expect(a.state).toBe('working');
    expect(b.state).toBe('working');
    expect(c.state).toBe('queued');
    expect(c.prompt).toBe('El prompt de C');
    expect(c.sessionId).toBeUndefined();
    expect(c.worktreePath).toBeUndefined();
    expect(c.queued).toMatchObject({ repoPath: REPO, limit: 2, position: 1, of: 1, active: 2 });
    expect(worktrees.create).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(2);
    // Whoever it reports to hears it is queued, and where.
    const queuedPush = pushes().find((p) => p.type === 'task-queued');
    expect(queuedPush?.body).toMatch(
      /Queued 1 of 1: 2 of 2 tasks of the project run. It starts by itself/
    );
    expect(queuedPush?.data).toMatchObject({ taskId: c.id, position: 1, of: 1, limit: 2 });

    // A fourth waits behind it, from another folder of the same project too.
    const d = await create(scheduler, { name: 'D', isolation: 'none', workingDir: `${REPO}/web` });
    expect(d.state).toBe('queued');
    expect(d.queued).toMatchObject({ position: 2, of: 2 });

    // Another project is not limited by this one's line.
    const other = await create(scheduler, { name: 'O', workingDir: OTHER, repoPath: OTHER });
    expect(other.state).toBe('working');

    // A finishes (merged): C starts by itself, D still waits, now first.
    await scheduler.markDone(a.sessionId as string, 'Hecho');
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('merged');
    expect(state(scheduler, c.id)).toBe('working');
    expect(scheduler.get(c.id)?.queued).toBeUndefined();
    expect(scheduler.get(d.id)?.queued).toMatchObject({ position: 1, of: 1 });
    const started = pushes().find((p) => p.type === 'task-started');
    expect(started?.data?.taskId).toBe(c.id);
    expect(started?.body).toMatch(/a slot of the project freed up/);
  });

  it('ready tasks free their slot; needs_you holds it only while its session runs and not for good', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const b = await create(scheduler, { name: 'B' });
    const c = await create(scheduler, { name: 'C' });
    expect(c.state).toBe('queued');
    // A asks a question: still holds its slot.
    scheduler.ask(a.sessionId as string, '¿Seguro?');
    await scheduler.checkExited();
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('needs_you');
    expect(state(scheduler, c.id)).toBe('queued');
    // Forgotten for half an hour: it stops holding it, C starts.
    await vi.advanceTimersByTimeAsync(TASK_QUEUE_NEEDS_YOU_HOLD_MS + 1000);
    await scheduler.checkExited();
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('needs_you');
    expect(state(scheduler, c.id)).toBe('working');
    expect(state(scheduler, b.id)).toBe('working');
  });

  it('«Empezar ya» starts only that queued task, past the limit; the next still waits', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await create(scheduler, { name: 'A' });
    await create(scheduler, { name: 'B' });
    const c = await create(scheduler, { name: 'C' });
    const d = await create(scheduler, { name: 'D' });
    // 2026-11-10: a plain retry (an orchestrator's script ran it on every queued task) starts
    // nothing: it says where the task stands and how to force it.
    const plain = await scheduler.retry(d.id);
    expect(plain).toMatchObject({ ok: false, code: 'limit' });
    expect(plain.ok ? '' : plain.message).toMatch(
      /waits in line \(2 of 2; 2 of 2 tasks of its project run\).*retry .* --force/
    );
    await scheduler.settled();
    expect(state(scheduler, d.id)).toBe('queued');
    const result = await scheduler.retry(d.id, { force: true });
    expect(result.ok).toBe(true);
    await scheduler.settled();
    expect(state(scheduler, d.id)).toBe('working');
    expect(state(scheduler, c.id)).toBe('queued');
    expect(scheduler.get(c.id)?.queued).toMatchObject({ position: 1, of: 1, active: 3 });
    expect(pushes().find((p) => p.type === 'task-started')?.body).toMatch(
      /past the project's limit/
    );
  });

  it('a failed task tried again does not go past the limit: it waits in line, or needs --force (2026-11-10)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    // A's setup fails (and its one automatic retry is far off): failed tasks hold no slot.
    worktrees.create.mockRejectedValueOnce(new Error('pnpm install failed'));
    const a = await create(scheduler, { name: 'A' });
    expect(a.state).toBe('failed');
    const b = await create(scheduler, { name: 'B' });
    const c = await create(scheduler, { name: 'C' });
    expect([b.state, c.state]).toEqual(['working', 'working']);

    // The project is full: the retry puts it in line instead of starting a third.
    expect((await scheduler.retry(a.id)).ok).toBe(true);
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('queued');
    expect(launch).toHaveBeenCalledTimes(2);
    // A slot frees up: it starts by itself.
    await scheduler.discard(b.id);
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('working');
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it('the automatic setup retry does not go past the limit either', async () => {
    const scheduler = make({ setupRetryMs: 60_000 });
    await scheduler.start(0);
    worktrees.create.mockRejectedValueOnce(new Error('pnpm install failed'));
    const a = await create(scheduler, { name: 'A' });
    expect(a.state).toBe('failed');
    const b = await create(scheduler, { name: 'B' });
    await create(scheduler, { name: 'C' });
    await vi.advanceTimersByTimeAsync(61_000);
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('queued');
    expect(launch).toHaveBeenCalledTimes(2);
    await scheduler.discard(b.id);
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('working');
  });

  it('moves a queued task in its line and discards one from it', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    await create(scheduler, { name: 'B' });
    const c = await create(scheduler, { name: 'C' });
    const d = await create(scheduler, { name: 'D' });
    const e = await create(scheduler, { name: 'E' });
    expect([c, d, e].map((task) => task.queued?.position)).toEqual([1, 2, 3]);

    expect(scheduler.moveQueued(e.id, 1).ok).toBe(true);
    expect([e, c, d].map((task) => scheduler.get(task.id)?.queued?.position)).toEqual([1, 2, 3]);
    expect(scheduler.moveQueued(a.id, 1)).toMatchObject({ ok: false, code: 'not-open' });

    // Discarded while queued: no session or worktree to drop, the line closes up.
    const discarded = await scheduler.discard(c.id);
    expect(discarded.ok).toBe(true);
    expect(state(scheduler, c.id)).toBe('discarded');
    expect(stopSession).not.toHaveBeenCalled();
    expect(worktrees.remove).not.toHaveBeenCalled();
    expect(scheduler.get(d.id)?.queued).toMatchObject({ position: 2, of: 2 });

    // The first slot that frees up goes to E, moved first.
    await scheduler.discard(a.id);
    await scheduler.settled();
    expect(state(scheduler, e.id)).toBe('working');
    expect(state(scheduler, d.id)).toBe('queued');
  });

  it('a restart keeps the queued tasks queued, in order, and they start as slots free up', async () => {
    const first = make();
    await first.start(0);
    const a = await create(first, { name: 'A' });
    const b = await create(first, { name: 'B' });
    const c = await create(first, { name: 'C' });
    const d = await create(first, { name: 'D' });
    first.stop();

    const second = make();
    await second.start(0);
    await second.settled();
    expect(state(second, a.id)).toBe('working');
    expect(state(second, b.id)).toBe('working');
    expect(second.get(c.id)?.queued).toMatchObject({ position: 1, of: 2 });
    expect(second.get(d.id)?.queued).toMatchObject({ position: 2, of: 2 });
    expect(launch).toHaveBeenCalledTimes(2);

    // B's session ended with the server down and does not come back: C takes its slot.
    await second.discard(b.id);
    await second.settled();
    expect(state(second, c.id)).toBe('working');
    expect(state(second, d.id)).toBe('queued');

    // The limit is raised by hand: D starts on the next look, no state change needed.
    limits.set(REPO, 4);
    await second.checkExited();
    await second.settled();
    expect(state(second, d.id)).toBe('working');
  });

  it('tasks running when the limit is lowered go on; only new ones wait', async () => {
    limits.set(REPO, 3);
    const scheduler = make();
    await scheduler.start(0);
    const tasks = [
      await create(scheduler, { name: 'A' }),
      await create(scheduler, { name: 'B' }),
      await create(scheduler, { name: 'C' }),
    ];
    limits.set(REPO, 1);
    await scheduler.checkExited();
    await scheduler.settled();
    for (const task of tasks) expect(state(scheduler, task.id)).toBe('working');
    const d = await create(scheduler, { name: 'D' });
    expect(d.state).toBe('queued');
    expect(d.queued).toMatchObject({ limit: 1, active: 3 });
  });

  it('a parallel group counts as N and starts together when there is room for all of it', async () => {
    limits.set(REPO, 3);
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const group = await scheduler.createGroup(newTask({ name: 'G' }), 3);
    await scheduler.settled();
    // 1 + 3 > 3: the whole group waits, as one entry of the line.
    for (const task of group) {
      expect(scheduler.get(task.id)?.state).toBe('queued');
      expect(scheduler.get(task.id)?.queued).toMatchObject({ position: 1, of: 1 });
    }
    expect(pushes().filter((p) => p.type === 'task-queued')).toHaveLength(1);
    expect(pushes().find((p) => p.type === 'task-queued')?.body).toMatch(
      /group of 3 starts together, when there is room for all/
    );
    // A single task after it waits behind it, though a slot is free (first in first out).
    const single = await create(scheduler, { name: 'S' });
    expect(single.state).toBe('queued');
    expect(single.queued).toMatchObject({ position: 2, of: 2 });

    await scheduler.discard(a.id);
    await scheduler.settled();
    for (const task of group) expect(state(scheduler, task.id)).toBe('working');
    expect(state(scheduler, single.id)).toBe('queued');
    expect(pushes().filter((p) => p.type === 'task-started')).toHaveLength(1);
  });

  it('a group larger than the limit starts when nothing else of the project runs, and says so', async () => {
    limits.set(REPO, 2);
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const group = await scheduler.createGroup(newTask({ name: 'G' }), 3);
    await scheduler.settled();
    expect(group.every((task) => state(scheduler, task.id) === 'queued')).toBe(true);
    expect(pushes().find((p) => p.type === 'task-queued')?.body).toMatch(
      /larger than the limit: it starts when no other task of the project runs/
    );
    await scheduler.discard(a.id);
    await scheduler.settled();
    expect(group.every((task) => state(scheduler, task.id) === 'working')).toBe(true);
  });

  it('a project without a limit starts every task at once, as before', async () => {
    limits.clear();
    const scheduler = make();
    await scheduler.start(0);
    const tasks = [];
    for (const name of ['A', 'B', 'C', 'D']) tasks.push(await create(scheduler, { name }));
    expect(tasks.every((task) => task.state === 'working')).toBe(true);
  });

  it('fitsSlots: room for all, or a group larger than the limit with nothing running', () => {
    expect(fitsSlots(1, 1, 2)).toBe(true);
    expect(fitsSlots(1, 2, 2)).toBe(false);
    expect(fitsSlots(3, 0, 2)).toBe(true);
    expect(fitsSlots(3, 1, 2)).toBe(false);
  });

  // --- the Mac's room (taskAdmission, 2026-11-01) -------------------------------------------

  const GB = 1024 ** 3;
  /** A roomy 24 GB, 12-core Mac; each test makes it short where it needs. */
  const roomy = (over: Partial<ResourceSample> = {}): ResourceSample => ({
    at: Date.now(),
    load: 3,
    cores: 12,
    memTotalBytes: 24 * GB,
    memAvailableBytes: 14 * GB,
    memFreePercent: 60,
    pressure: 'normal',
    swapUsedBytes: 1 * GB,
    swapTotalBytes: 4 * GB,
    ...over,
  });

  /** A scheduler judged by a monitor fed simulated samples (refresh() takes the next one). */
  const withRoom = async (settings: Partial<TaskAdmissionSettings> = {}) => {
    let next = roomy();
    const monitor = createResourceMonitor({
      sample: async () => ({ ...next, at: Date.now() }),
      settings: () => ({ ...DEFAULT_TASK_ADMISSION, ...settings }),
    });
    const scheduler = make({
      admission: { check: () => monitor.admission(), started: () => monitor.started() },
    });
    await monitor.refresh();
    await scheduler.start(0);
    return {
      scheduler,
      monitor,
      /** The Mac now looks like this; the line looks again (as its 5 s tick does). */
      async becomes(over: Partial<ResourceSample>) {
        next = roomy(over);
        await monitor.refresh();
        await scheduler.checkExited();
        await scheduler.settled();
      },
    };
  };

  it('short of memory: a new task waits queued, with no worktree nor session, says why, and starts by itself once there is room', async () => {
    limits.clear();
    const { scheduler, becomes } = await withRoom();
    await becomes({ memFreePercent: 9, memAvailableBytes: 2 * GB });
    const a = await create(scheduler, { name: 'A' });
    expect(a.state).toBe('queued');
    expect(a.sessionId).toBeUndefined();
    expect(a.worktreePath).toBeUndefined();
    expect(worktrees.create).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(a.queued?.limit).toBeUndefined();
    expect(a.queued?.resources).toMatchObject({ short: ['memory'] });
    expect(a.queued?.resources?.detail).toMatch(/memory 9 % free \(min 20 %\)/);
    // `ut task show`: why it waits and what can be done.
    expect(queuedNote(a)).toMatch(/waiting for memory on the Mac \(memory 9 % free/);
    expect(queuedNote(a)).toMatch(/ut task retry/);
    const queuedPush = pushes().find((p) => p.type === 'task-queued');
    expect(queuedPush?.body).toMatch(/the Mac is short of memory/);
    expect(queuedPush?.data).toMatchObject({ taskId: a.id, waitingFor: ['memory'] });

    // Swap hard and loaded too: it keeps waiting, now for all three, without a second push.
    await becomes({ memFreePercent: 9, swapUsedBytes: 9 * GB, load: 50 });
    expect(state(scheduler, a.id)).toBe('queued');
    expect(scheduler.get(a.id)?.queued?.resources?.short).toEqual(['memory', 'swap', 'cpu']);
    expect(pushes().filter((p) => p.type === 'task-queued')).toHaveLength(1);

    // Room again: it starts on its own, and the user hears it.
    await becomes({});
    expect(state(scheduler, a.id)).toBe('working');
    expect(scheduler.get(a.id)?.queued).toBeUndefined();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(pushes().find((p) => p.type === 'task-started')?.body).toMatch(/the Mac has room again/);
  });

  it('swap: growth holds tasks and says so; a high but still level only paces them (2026-11-08)', async () => {
    limits.clear();
    const { scheduler, becomes } = await withRoom();
    await becomes({ swapUsedBytes: 3 * GB });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await becomes({ swapUsedBytes: 3 * GB });
    // 3.9 GB 30 s later: growing within the window.
    await vi.advanceTimersByTimeAsync(30_000);
    await becomes({ swapUsedBytes: 3.9 * GB });
    const a = await create(scheduler, { name: 'A' });
    expect(a.queued?.resources?.short).toEqual(['swap']);
    expect(a.queued?.resources?.detail).toMatch(/swap growing \+0\.9 GB/);
    expect(queuedNote(a)).toMatch(/waiting for swap on the Mac/);
    // Past the window and steady at 3.9 GB (under 25 % of 24 GB): room.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await becomes({ swapUsedBytes: 3.9 * GB });
    expect(state(scheduler, a.id)).toBe('working');
    // Over 6 GB of swap but still, memory under the roomy level: the next one takes its turn,
    // told why, never held for good.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await becomes({ swapUsedBytes: 7 * GB, memFreePercent: 35 });
    const b = await create(scheduler, { name: 'B' });
    expect(b.state).toBe('queued');
    expect(b.queued?.resources).toMatchObject({ short: ['swap'], paced: true });
    expect(b.queued?.resources?.detail).toMatch(/swap steady at 7\.0 GB/);
    expect(b.queued?.resources?.detail).not.toMatch(/in use/);
    expect(queuedNote(b)).toMatch(/lets tasks in one at a time/);
    const pacedPush = pushes()
      .filter((p) => p.type === 'task-queued')
      .pop();
    expect(pacedPush?.body).toMatch(/let in one at a time/);
    // No «short of swap» rebuilt from the numbers by the service worker.
    expect(pacedPush?.data).not.toHaveProperty('waitingFor');
    for (let minute = 0; minute < 15; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await becomes({ swapUsedBytes: 7 * GB, memFreePercent: 35 });
    }
    expect(state(scheduler, b.id)).toBe('working');
    // The same swap with memory to spare (2026-11-11): old pages, not pressure. In at once.
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await becomes({ swapUsedBytes: 7 * GB, memFreePercent: 68 });
    const c = await create(scheduler, { name: 'C' });
    expect(c.state).toBe('working');
  });

  it('fair among projects: when room comes back one at a time, the project running fewer goes first; urgent goes before', async () => {
    limits.clear();
    const { scheduler, becomes } = await withRoom();
    // Bakery runs one already.
    const running = await create(scheduler, { name: 'R' });
    expect(running.state).toBe('working');
    await becomes({ memFreePercent: 10 });
    const b1 = await create(scheduler, { name: 'B1' });
    const b2 = await create(scheduler, { name: 'B2' });
    const o1 = await create(scheduler, { name: 'O1', workingDir: OTHER, repoPath: OTHER });
    expect([b1, b2, o1].map((task) => task.state)).toEqual(['queued', 'queued', 'queued']);
    // Room for one more over the floor (30 % free), once R's start is past its ramp window: one
    // start, and the next waits for the samples to show what that one takes.
    await vi.advanceTimersByTimeAsync(91_000);
    await becomes({ memFreePercent: 30 });
    expect(state(scheduler, o1.id)).toBe('working');
    expect(state(scheduler, b1.id)).toBe('queued');
    expect(state(scheduler, b2.id)).toBe('queued');
    expect(scheduler.get(b1.id)?.queued?.resources).toMatchObject({ short: [], settling: true });
    // B2 marked urgent while it waits: first of its line.
    scheduler.setPriority(b2.id, true);
    await vi.advanceTimersByTimeAsync(91_000);
    await becomes({ memFreePercent: 30 });
    expect(state(scheduler, b2.id)).toBe('working');
    expect(state(scheduler, b1.id)).toBe('queued');
    await vi.advanceTimersByTimeAsync(91_000);
    await becomes({ memFreePercent: 30 });
    expect(state(scheduler, b1.id)).toBe('working');
  });

  it('a task queued behind others while the project has free slots is not told the limit is reached', async () => {
    limits.set(REPO, 4);
    const { scheduler, becomes } = await withRoom();
    const running = await create(scheduler, { name: 'R' });
    expect(running.state).toBe('working');
    // Tight room: the next one waits for R to settle, quietly; the one after waits behind it.
    await becomes({ memFreePercent: 30 });
    const a = await create(scheduler, { name: 'A' });
    const b = await create(scheduler, { name: 'B' });
    expect([a.state, b.state]).toEqual(['queued', 'queued']);
    const told = pushes().find((p) => p.type === 'task-queued' && p.data?.taskId === b.id);
    expect(told?.body).toMatch(
      /1 of 4 tasks of the project run; it waits behind those queued before it/
    );
  });

  it('«Empezar ya» starts a task waiting for room at once; a roomy Mac starts tasks one after another, quietly', async () => {
    limits.clear();
    const { scheduler, becomes } = await withRoom();
    await becomes({ load: 40 });
    const a = await create(scheduler, { name: 'A' });
    expect(a.queued?.resources?.short).toEqual(['cpu']);
    expect(await scheduler.retry(a.id)).toMatchObject({ ok: false, code: 'limit' });
    expect((await scheduler.retry(a.id, { force: true })).ok).toBe(true);
    await scheduler.settled();
    expect(state(scheduler, a.id)).toBe('working');
    expect(pushes().find((p) => p.type === 'task-started')?.body).toMatch(/as asked/);
    // Idle Mac (2026-11-11, the ramp): they come in one at a time, settleSec apart, and nothing
    // is pushed about a line.
    await becomes({});
    notify.mockClear();
    const tasks = [];
    for (const name of ['B', 'C', 'D']) tasks.push(await create(scheduler, { name }));
    expect(tasks.map((task) => task.state)).toEqual(['working', 'queued', 'queued']);
    expect(scheduler.get(tasks[1].id)?.queued?.resources).toMatchObject({
      short: [],
      settling: true,
    });
    await vi.advanceTimersByTimeAsync(21_000);
    await becomes({});
    expect(tasks.map((task) => state(scheduler, task.id))).toEqual([
      'working',
      'working',
      'queued',
    ]);
    await vi.advanceTimersByTimeAsync(21_000);
    await becomes({});
    expect(tasks.map((task) => state(scheduler, task.id))).toEqual([
      'working',
      'working',
      'working',
    ]);
    expect(pushes().some((p) => p.type === 'task-queued' || p.type === 'task-started')).toBe(false);
  });

  it('the project limit still applies first; only a task its project has room for waits for the Mac', async () => {
    limits.set(REPO, 1);
    const { scheduler, becomes } = await withRoom();
    const a = await create(scheduler, { name: 'A' });
    await becomes({ memFreePercent: 5 });
    const b = await create(scheduler, { name: 'B' });
    // Its project is full: that is what it waits for (no word about memory).
    expect(b.queued).toMatchObject({ limit: 1 });
    expect(b.queued?.resources).toBeUndefined();
    expect(queuedNote(b)).toMatch(/maxActiveTasks/);
    // A ends: now its project has room, the Mac does not.
    await scheduler.markDone(a.sessionId as string, 'Hecho');
    await scheduler.settled();
    await becomes({ memFreePercent: 5 });
    expect(state(scheduler, b.id)).toBe('queued');
    expect(scheduler.get(b.id)?.queued?.resources?.short).toEqual(['memory']);
    await vi.advanceTimersByTimeAsync(21_000);
    await becomes({});
    expect(state(scheduler, b.id)).toBe('working');
  });

  it('fairest: urgent first, then fewer running, then longest waiting', () => {
    const entry = (repoPath: string, since: string, urgent = false) => [
      { queued: { repoPath, since, order: 1 }, urgent, createdAt: since } as TaskRecord,
    ];
    const old = entry('/a', '2026-11-01T10:00:00Z');
    const young = entry('/b', '2026-11-01T11:00:00Z');
    expect(fairest([old, young], () => 0)).toBe(old);
    expect(fairest([old, young], (repo) => (repo === '/a' ? 2 : 0))).toBe(young);
    const urgent = entry('/a', '2026-11-01T12:00:00Z', true);
    expect(fairest([young, urgent], (repo) => (repo === '/a' ? 5 : 0))).toBe(urgent);
  });

  it('fairest: one that waited ROOM_WAIT_FIRST_MS for room goes before projects running fewer (2026-11-11)', () => {
    const now = Date.parse('2026-11-11T02:00:00Z');
    const entry = (repoPath: string, since: string, roomSince?: string, urgent = false) => [
      {
        queued: {
          repoPath,
          since,
          order: 1,
          ...(roomSince
            ? { resources: { short: [], detail: '', at: since, since: roomSince } }
            : {}),
        },
        urgent,
        createdAt: since,
      } as TaskRecord,
    ];
    const running = (repo: string) => (repo === '/a' ? 2 : 0);
    const young = entry('/b', '2026-11-11T01:50:00Z', '2026-11-11T01:50:00Z');
    // 29 min for room: the project running fewer still goes first.
    const waiting = entry('/a', '2026-11-10T20:00:00Z', '2026-11-11T01:31:00Z');
    expect(fairest([waiting, young], running, now)).toBe(young);
    // In line for hours, but for its project's limit, not for room: the same.
    expect(fairest([entry('/a', '2026-11-10T20:00:00Z'), young], running, now)).toBe(young);
    const starved = entry('/a', '2026-11-10T20:00:00Z', '2026-11-11T01:30:00Z');
    expect(fairest([young, starved], running, now)).toBe(starved);
    // Two of them: the one waiting longest; an urgent one still before both.
    const longer = entry('/c', '2026-11-11T00:00:00Z', '2026-11-11T01:00:00Z');
    expect(fairest([starved, longer, young], running, now)).toBe(longer);
    const urgent = entry('/b', '2026-11-11T01:59:00Z', undefined, true);
    expect(fairest([starved, urgent], running, now)).toBe(urgent);
  });

  it('tasks let in one at a time: a project with tasks running is not passed over for good, also across a restart (2026-11-11)', async () => {
    // (Roomy: the worktree mock files every task under REPO once read back from disk.)
    limits.set(REPO, 5);
    const steady = { swapUsedBytes: 7 * GB, swapTotalBytes: 16 * GB, memFreePercent: 35 };
    let next = roomy();
    const stateFile = path.join(dir, 'admission-state.json');
    // A server: its monitor and its scheduler, both from what the last one left on disk.
    const server = async () => {
      const monitor = createResourceMonitor({
        sample: async () => ({ ...next, at: Date.now() }),
        stateFile,
      });
      const scheduler = make({
        admission: {
          check: (waitedMs) => monitor.admission({ waitedMs }),
          started: () => monitor.started(),
        },
      });
      await monitor.refresh();
      await scheduler.start(0);
      return { monitor, scheduler };
    };
    let { monitor, scheduler } = await server();
    const minutes = async (count: number) => {
      for (let minute = 0; minute < count; minute++) {
        await vi.advanceTimersByTimeAsync(60_000);
        await monitor.refresh();
        await scheduler.checkExited();
        await scheduler.settled();
      }
    };
    const a = await create(scheduler, { name: 'A' });
    await vi.advanceTimersByTimeAsync(30_000);
    const b = await create(scheduler, { name: 'B' });
    expect([a.state, b.state]).toEqual(['working', 'working']);
    // Swap high but steady, memory under the roomy level: one task every 15 min. The project running 2 has one waiting.
    next = roomy(steady);
    await minutes(1);
    const c = await create(scheduler, { name: 'C' });
    expect(c.state).toBe('queued');
    const roomSince = c.queued?.resources?.since;
    expect(roomSince).toBe(new Date().toISOString());
    const other = (name: string) => create(scheduler, { name, workingDir: OTHER, repoPath: OTHER });
    const d = await other('D');
    // (The jump to 7 GB reads as growth for the 10 min window; the turn comes after it.)
    await minutes(26);
    // The first turn goes to the project with nothing running.
    expect(state(scheduler, d.id)).toBe('working');
    expect(state(scheduler, c.id)).toBe('queued');
    const e = await other('E');
    // The server restarts in the middle of the wait: the wait for room is on disk, not begun again.
    scheduler.stop();
    ({ monitor, scheduler } = await server());
    await minutes(1);
    expect(scheduler.get(c.id)?.queued?.resources?.since).toBe(roomSince);
    await minutes(19);
    // C has waited over 30 min for room: this turn is its own, though E's project runs fewer.
    expect(state(scheduler, c.id)).toBe('working');
    expect(state(scheduler, e.id)).toBe('queued');
    await minutes(16);
    expect(state(scheduler, e.id)).toBe('working');
  });
});
