/**
 * Tasks started in series (2026-11-11, shared/task-serial.ts): `--after` waits queued for the
 * named tasks to merge or close and asks for a decision when one stops; a zone keeps two tasks
 * of a project from working at once; `ut task new` says when its prompt names files an open
 * task already changes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextAction } from '../../shared/orchestrator-prompt.js';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { formatTaskLine, queuedNote } from '../task-cli/format-task-line.js';
import type { NotificationPayload } from './push-notification-service.js';
import {
  type NewTask,
  SETUP_RETRY_MS,
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

describe('TaskScheduler: tasks started in series (--after, zones)', () => {
  let dir: string;
  let store: string;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let worktrees: TaskWorktrees & Record<string, ReturnType<typeof vi.fn>>;
  let limits: Map<string, number | undefined>;
  let zoneRules: Map<string, string[]>;
  let pipelineState: 'merged' | 'ready';
  let merged: string[];
  let schedulers: TaskScheduler[];

  const settingsOf = (repoPath: string): ProjectSettings => ({
    ...DEFAULT_PROJECT_SETTINGS,
    ...(limits.get(repoPath) !== undefined ? { maxActiveTasks: limits.get(repoPath) } : {}),
    ...(zoneRules.has(repoPath) ? { zones: zoneRules.get(repoPath) } : {}),
  });

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      stopSession: (async () => undefined) as unknown as TaskSchedulerDeps['stopSession'],
      deliver: () => true,
      worktrees,
      pipeline: (async (task: TaskRecord) => {
        if (pipelineState === 'merged') merged.push(task.name);
        return pipelineState === 'merged'
          ? { state: 'merged', mergedSha: 'def456', baseSha: 'abc999' }
          : { state: 'ready' };
      }) as unknown as TaskSchedulerDeps['pipeline'],
      settings: {
        get: settingsOf,
        list: () =>
          [...new Set([...limits.keys(), ...zoneRules.keys()])].map((repoPath) => ({
            repoPath,
            settings: settingsOf(repoPath),
          })),
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
    // Each a moment after the last: «older first» is told by when they were made.
    vi.setSystemTime(Date.now() + 1000);
    const task = await scheduler.create(newTask(overrides));
    await scheduler.settled();
    return scheduler.get(task.id) as TaskRecord;
  };
  const finish = async (scheduler: TaskScheduler, task: TaskRecord) => {
    await scheduler.markDone(scheduler.get(task.id)?.sessionId as string, 'Hecho');
    await scheduler.settled();
  };
  const get = (scheduler: TaskScheduler, task: TaskRecord) => scheduler.get(task.id) as TaskRecord;
  const state = (scheduler: TaskScheduler, task: TaskRecord) => get(scheduler, task).state;
  const pushes = (type: string, task: TaskRecord) =>
    notify.mock.calls
      .map(([payload]) => payload as NotificationPayload)
      .filter((payload) => payload.type === type && payload.data?.taskId === task.id);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 10, 0));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-serial-'));
    store = path.join(dir, 'tasks.json');
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    notify = vi.fn();
    limits = new Map();
    zoneRules = new Map();
    pipelineState = 'merged';
    merged = [];
    schedulers = [];
    let w = 0;
    worktrees = {
      create: vi.fn(async (task: TaskRecord) => {
        w++;
        return {
          repoPath: task.repoPath ?? REPO,
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
        files: ['web/src/client/styles/list.css'],
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

  it('--after: it waits queued, without worktree or session, and starts by itself once the other merged', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const b = await create(scheduler, { name: 'B', after: [a.id] });
    expect(a.state).toBe('working');
    expect(b.state).toBe('queued');
    expect(b.sessionId).toBeUndefined();
    expect(b.worktreePath).toBeUndefined();
    expect(b.after).toEqual([a.id]);
    expect(b.queued?.waitsFor).toEqual([
      { taskId: a.id, name: 'A', why: 'after', state: 'working' },
    ]);
    expect(worktrees.create).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    // `ut task list` and `ut task status` say what it waits for.
    expect(formatTaskLine(b)).toContain(`waits for ${a.id.slice(0, 8)}`);
    expect(queuedNote(b)).toContain(`Waits for ${a.id.slice(0, 8)} «A» (working)`);
    // Whoever it reports to hears it once, with the ids for the phone.
    const told = pushes('task-queued', b);
    expect(told).toHaveLength(1);
    expect(told[0].body).toMatch(/^Waits for .*«A».*it starts by itself once it merges or closes/);
    expect(told[0].data).toMatchObject({ waitsOn: [a.id.slice(0, 8)] });
    expect(told[0].data?.waitStopped).toBeUndefined();

    // A merges: B starts by itself, its worktree made only now (from a base with A's work).
    await finish(scheduler, a);
    expect(state(scheduler, a)).toBe('merged');
    expect(merged).toEqual(['A']);
    expect(state(scheduler, b)).toBe('working');
    expect(worktrees.create).toHaveBeenCalledTimes(2);
    expect(pushes('task-started', b)[0].body).toMatch(
      /Started: the tasks it waited for are merged or closed/
    );
    expect(pushes('task-queued', b)).toHaveLength(1);
  });

  it('--after several: it waits for all of them, and a ready one is not merged yet', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const b = await create(scheduler, { name: 'B' });
    const c = await create(scheduler, { name: 'C', after: [a.id, b.id] });
    expect(c.queued?.waitsFor?.map((wait) => wait.taskId)).toEqual([a.id, b.id]);
    await finish(scheduler, a);
    expect(get(scheduler, c).queued?.waitsFor?.map((wait) => wait.taskId)).toEqual([b.id]);
    // B finishes but waits for the user's merge: its work is not in the base.
    pipelineState = 'ready';
    await finish(scheduler, b);
    expect(state(scheduler, b)).toBe('ready');
    expect(state(scheduler, c)).toBe('queued');
    expect(get(scheduler, c).queued?.waitsFor).toMatchObject([{ taskId: b.id, state: 'ready' }]);
    pipelineState = 'merged';
    await scheduler.merge(b.id);
    await scheduler.settled();
    expect(state(scheduler, b)).toBe('merged');
    expect(state(scheduler, c)).toBe('working');
  });

  it('a waiting task keeps its place in the line and holds no slot: the ones behind it go past', async () => {
    limits.set(REPO, 2);
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const b = await create(scheduler, { name: 'B', after: [a.id] });
    // With one slot left, C starts: B neither holds a slot nor keeps C behind it.
    const c = await create(scheduler, { name: 'C' });
    expect(b.state).toBe('queued');
    expect(c.state).toBe('working');
    // The project is full now: D waits for a slot, behind B in the line.
    const d = await create(scheduler, { name: 'D' });
    expect(d.state).toBe('queued');
    expect(get(scheduler, b).queued).toMatchObject({ position: 1, of: 2 });
    expect(d.queued).toMatchObject({ position: 2, of: 2, active: 2 });
    expect(d.queued?.waitsFor).toBeUndefined();
    // C ends: D takes its slot (B still waits for A, which works).
    await finish(scheduler, c);
    expect(state(scheduler, d)).toBe('working');
    expect(state(scheduler, b)).toBe('queued');
    // A ends: the slot is B's.
    await finish(scheduler, a);
    expect(state(scheduler, b)).toBe('working');
  });

  it('the task it waits for is discarded: it says so once, does not start by itself, and waits for a decision', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    const b = await create(scheduler, {
      name: 'B',
      after: [a.id],
      origin: 'orchestrator',
      orchestratorSessionId: 'orc',
    });
    await scheduler.discard(a.id, { confirm: true });
    await scheduler.settled();
    expect(state(scheduler, a)).toBe('discarded');
    const waiting = get(scheduler, b);
    expect(waiting.state).toBe('queued');
    expect(waiting.queued?.waitsFor).toEqual([
      { taskId: a.id, name: 'A', why: 'after', state: 'discarded', stopped: true },
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
    const told = pushes('task-queued', b);
    expect(told).toHaveLength(2);
    expect(told[1].data).toMatchObject({ waitsOn: [a.id.slice(0, 8)], waitStopped: true });
    expect(String(told[1].data?.detail)).toMatch(
      /«A» \(discarded\), which will not merge by itself: it does not start on its own\. Decide:/
    );
    expect(formatTaskLine(waiting)).toContain('(stopped: decide)');
    // Its orchestrator is asked for a decision, not handed a digest line.
    expect(nextAction({ kind: 'queued', taskId: b.id, escalated: true })).toMatch(
      /does not start by itself.*retry .* --force.*discard/
    );
    // Looked at again and again, it is told once.
    await scheduler.retry(b.id);
    await scheduler.settled();
    expect(pushes('task-queued', b)).toHaveLength(2);
    // A plain retry starts nothing; --force is the decision to go without that work.
    const refused = await scheduler.retry(b.id);
    expect(refused).toMatchObject({ ok: false, code: 'limit' });
    expect(refused.ok ? '' : refused.message).toMatch(/will not merge by itself/);
    expect(state(scheduler, b)).toBe('queued');
    expect((await scheduler.retry(b.id, { force: true })).ok).toBe(true);
    await scheduler.settled();
    expect(state(scheduler, b)).toBe('working');
  });

  it('the task it waits for fails: it waits for a decision, and starts by itself if that one is tried again and merges', async () => {
    const scheduler = make();
    await scheduler.start(0);
    worktrees.create.mockRejectedValueOnce(new Error('no disk'));
    const a = await create(scheduler, { name: 'A' });
    expect(a.state).toBe('failed');
    const b = await create(scheduler, { name: 'B', after: [a.id] });
    expect(b.state).toBe('queued');
    expect(b.queued?.waitsFor).toMatchObject([{ taskId: a.id, state: 'failed', stopped: true }]);
    expect(pushes('task-queued', b)[0].data).toMatchObject({ waitStopped: true });
    expect(queuedNote(b)).toContain(
      `ut task retry ${a.id.slice(0, 8)}\` tries the failed one again`
    );
    // A's setup is tried again (Untether's own retry) and works: B waits for it as before.
    await vi.advanceTimersByTimeAsync(SETUP_RETRY_MS + 1000);
    await scheduler.settled();
    expect(state(scheduler, a)).toBe('working');
    expect(get(scheduler, b).queued?.waitsFor).toEqual([
      { taskId: a.id, name: 'A', why: 'after', state: 'working' },
    ]);
    await finish(scheduler, a);
    expect(state(scheduler, b)).toBe('working');
  });

  it('only tasks that are still to merge are waited for: unknown ids and merged ones are left out', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A' });
    await finish(scheduler, a);
    const b = await create(scheduler, { name: 'B', after: [a.id, 'no-such-task'] });
    expect(b.after).toBeUndefined();
    expect(b.state).toBe('working');
  });

  it('a queued task waiting for another survives a restart, still waiting', async () => {
    const first = make();
    await first.start(0);
    const a = await create(first, { name: 'A' });
    const b = await create(first, { name: 'B', after: [a.id] });
    first.stop();
    const second = make();
    await second.start(0);
    await second.settled();
    expect(state(second, b)).toBe('queued');
    expect(get(second, b).queued?.waitsFor).toMatchObject([{ taskId: a.id }]);
    await second.discard(a.id, { confirm: true });
    await second.settled();
    expect(state(second, b)).toBe('queued');
    expect(get(second, b).queued?.waitsFor).toMatchObject([{ taskId: a.id, stopped: true }]);
  });

  it('--zone: two tasks of a project with the same zone never work at once', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, { name: 'A', zones: ['core'] });
    const b = await create(scheduler, { name: 'B', zones: ['core'] });
    const other = await create(scheduler, { name: 'C', zones: ['docs'] });
    const none = await create(scheduler, { name: 'D' });
    const elsewhere = await create(scheduler, {
      name: 'E',
      zones: ['core'],
      workingDir: OTHER,
      repoPath: OTHER,
    });
    expect(a.state).toBe('working');
    expect(b.state).toBe('queued');
    expect(b.queued?.waitsFor).toEqual([
      { taskId: a.id, name: 'A', why: 'zone', zone: 'core', state: 'working' },
    ]);
    expect(queuedNote(b)).toContain('zone core');
    // Another zone, no zone, and the same zone's name in another project are not held.
    expect(other.state).toBe('working');
    expect(none.state).toBe('working');
    expect(elsewhere.state).toBe('working');
    // A third of the zone waits for both, and only the older one starts when A merges.
    const c = await create(scheduler, { name: 'F', zones: ['core', 'docs'] });
    expect(c.queued?.waitsFor?.map((wait) => wait.name).sort()).toEqual(['A', 'B', 'C']);
    await finish(scheduler, a);
    expect(state(scheduler, b)).toBe('working');
    expect(state(scheduler, c)).toBe('queued');
    // A zone is held until the work is in the base: ready is not enough.
    pipelineState = 'ready';
    await finish(scheduler, b);
    expect(state(scheduler, b)).toBe('ready');
    expect(state(scheduler, c)).toBe('queued');
    pipelineState = 'merged';
    await scheduler.merge(b.id);
    await finish(scheduler, other);
    await scheduler.settled();
    expect(state(scheduler, c)).toBe('working');
  });

  it('zones never make two tasks wait for each other: a failed older one tried again does not wait for the newer', async () => {
    const scheduler = make();
    await scheduler.start(0);
    worktrees.create.mockRejectedValueOnce(new Error('no disk'));
    const a = await create(scheduler, { name: 'A', zones: ['core'] });
    expect(a.state).toBe('failed');
    const b = await create(scheduler, { name: 'B', zones: ['core'] });
    expect(b.state).toBe('queued');
    expect(b.queued?.waitsFor).toMatchObject([{ taskId: a.id, why: 'zone', stopped: true }]);
    // A is tried again: it starts (B, newer and queued, is not in its way), B goes on waiting.
    await vi.advanceTimersByTimeAsync(SETUP_RETRY_MS + 1000);
    await scheduler.settled();
    expect(state(scheduler, a)).toBe('working');
    expect(state(scheduler, b)).toBe('queued');
    await finish(scheduler, a);
    expect(state(scheduler, b)).toBe('working');
  });

  it('two tasks of a zone due at the same moment: one starts, the other waits', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const [a, b] = await Promise.all([
      scheduler.create(newTask({ name: 'A', zones: ['core'] })),
      scheduler.create(newTask({ name: 'B', zones: ['core'] })),
    ]);
    await scheduler.settled();
    const states = [state(scheduler, a), state(scheduler, b)].sort();
    expect(states).toEqual(['queued', 'working']);
  });

  it("the project's zones: a prompt that names a path under a rule is in its zone; nothing is guessed", async () => {
    zoneRules.set(REPO, ['web/src/client/**=client', 'mac=mac']);
    const scheduler = make();
    await scheduler.start(0);
    const a = await create(scheduler, {
      name: 'A',
      prompt: 'Arregla el foco en web/src/client/components/task-row.ts',
    });
    const b = await create(scheduler, {
      name: 'B',
      prompt: 'Cambia los colores de `web/src/client/styles/list.css`.',
    });
    const mac = await create(scheduler, { name: 'C', prompt: 'Revisa mac/Untether/App.swift' });
    // It talks about the client but names no path: no zone, it starts.
    const vague = await create(scheduler, { name: 'D', prompt: 'Mejora el cliente web' });
    // Another project has no such rules.
    const elsewhere = await create(scheduler, {
      name: 'E',
      prompt: 'Toca web/src/client/app.ts',
      workingDir: OTHER,
      repoPath: OTHER,
    });
    expect(a.zones).toEqual(['client']);
    expect(b.zones).toEqual(['client']);
    expect(mac.zones).toEqual(['mac']);
    expect(vague.zones).toBeUndefined();
    expect(elsewhere.zones).toBeUndefined();
    expect(a.state).toBe('working');
    expect(b.state).toBe('queued');
    expect(b.queued?.waitsFor).toMatchObject([{ taskId: a.id, why: 'zone', zone: 'client' }]);
    expect(mac.state).toBe('working');
    expect(vague.state).toBe('working');
  });

  it('ut task new: a prompt naming files an open task already changes is told, and nothing is held', async () => {
    const scheduler = make();
    await scheduler.start(0);
    // A finished and waits for its merge: its files are known (web/src/client/styles/list.css).
    pipelineState = 'ready';
    const a = await create(scheduler, { name: 'A' });
    await finish(scheduler, a);
    expect(get(scheduler, a).files).toEqual(['web/src/client/styles/list.css']);
    const byFile = await create(scheduler, { name: 'B', prompt: 'Ajusta list.css y poco más' });
    const byFolder = await create(scheduler, { name: 'C', prompt: 'Limpia web/src/client/styles' });
    const apart = await create(scheduler, { name: 'D', prompt: 'Cambia web/src/server/app.ts' });
    const after = await create(scheduler, {
      name: 'E',
      prompt: 'Ajusta list.css',
      after: [a.id],
    });
    const touch = [
      { taskId: a.id, name: 'A', files: ['web/src/client/styles/list.css'], count: 1 },
    ];
    expect(await scheduler.touchedByOthers(byFile.id)).toEqual(touch);
    expect(await scheduler.touchedByOthers(byFolder.id)).toEqual(touch);
    expect(await scheduler.touchedByOthers(apart.id)).toEqual([]);
    // Already started after it: nothing to say.
    expect(await scheduler.touchedByOthers(after.id)).toEqual([]);
    // Not blocked: they work.
    expect(byFile.state).toBe('working');
    expect(byFolder.state).toBe('working');
    expect(after.state).toBe('queued');
  });
});
