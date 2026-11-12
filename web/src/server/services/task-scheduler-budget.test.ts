/**
 * Task budgets (2026-11-01, shared/task-budget.ts): bakery tasks ran 2 to 5 hours with no
 * limit but the automatic fixes per reason. A task warns once at its warning level, is cut at
 * its limit (its agent stopped, its work kept, needs_you · budget), goes on with more budget,
 * and the time it waits (a usage-limit pause, here) is not counted.
 */
import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  budgetOver,
  parseBudgetExtension,
  parseBudgetSpec,
  resolveBudget,
  TASK_BUDGET_DEFAULTS,
} from '../../shared/task-budget.js';
import { emptyUsage } from '../../shared/task-metrics.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { NotificationPayload } from './push-notification-service.js';
import {
  BUDGET_CONTINUE_TEXT,
  CODEX_IDLE_MS,
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const MIN = 60_000;
const T0 = new Date(2026, 10, 1, 10, 0).getTime();

const screen = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__/agent-halt', name), 'utf8');

function newTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Espacios de trabajo aislados',
    prompt: 'Aísla los espacios de trabajo por tarea',
    workingDir: '/Users/me/Projects/bakery',
    command: ['codex'],
    agent: 'codex',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  };
}

describe('task budget specs', () => {
  it('a dollar limit under $1 stays what was asked, and +50% adds cents (2026-11-10)', () => {
    const resolved = resolveBudget(undefined, { limits: { usd: 0.5 } }, undefined);
    expect(resolved.limits.usd).toBe(0.5);
    expect(parseBudgetExtension('', resolved.limits, ['usd'])).toEqual({ usd: 0.25 });
  });

  it('reads a spec, the project over the defaults and the task over the project', () => {
    expect(parseBudgetSpec('wall=2h,agent=90m rounds=4 tokens=50M warn=80')).toEqual({
      limits: { wall: 2 * 60 * MIN, agent: 90 * MIN, rounds: 4, tokens: 50_000_000 },
      warnPct: 80,
    });
    expect(() => parseBudgetSpec('wall=soon')).toThrow(/not a value for wall/);
    expect(() => parseBudgetSpec('speed=2')).toThrow(/not a budget item/);
    const resolved = resolveBudget('rounds=3,tokens=off', { limits: { rounds: 5 } }, { rounds: 2 });
    expect(resolved.limits).toEqual({ ...TASK_BUDGET_DEFAULTS, rounds: 7, tokens: 0 });
    expect(resolved.warnPct).toBe(75);
  });

  it('reads more budget: time, rounds, tokens, a share, or +50% of what was reached', () => {
    const limits = { wall: 60 * MIN, agent: 60 * MIN, rounds: 4, tokens: 10_000_000 };
    expect(parseBudgetExtension('+30m', limits)).toEqual({ wall: 30 * MIN, agent: 30 * MIN });
    expect(parseBudgetExtension('+2 +5M', limits)).toEqual({ rounds: 2, tokens: 5_000_000 });
    expect(parseBudgetExtension('wall=2h', limits)).toEqual({ wall: 60 * MIN });
    expect(parseBudgetExtension('', limits, ['agent'])).toEqual({ agent: 30 * MIN });
    expect(parseBudgetExtension('+50%', limits)).toEqual({
      wall: 30 * MIN,
      agent: 30 * MIN,
      rounds: 2,
      tokens: 5_000_000,
    });
    expect(() => parseBudgetExtension('lots', limits)).toThrow();
    // Rounds: the cut is the round past the limit.
    expect(budgetOver({ limits, spent: { wall: 0, agent: 0, rounds: 4, tokens: 0 } })).toEqual([]);
    expect(budgetOver({ limits, spent: { wall: 0, agent: 0, rounds: 5, tokens: 0 } })).toEqual([
      'rounds',
    ]);
  });
});

describe('TaskScheduler: budgets', () => {
  let dir: string;
  let store: string;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let interrupt: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let worktrees: TaskWorktrees & Record<string, ReturnType<typeof vi.fn>>;
  let screens: Map<string, string>;
  let lastOutput: number;
  let schedulers: TaskScheduler[];

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      interrupt: interrupt as unknown as TaskSchedulerDeps['interrupt'],
      worktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      screenText: async (sessionId) => screens.get(sessionId),
      lastOutputAt: () => lastOutput,
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 10,
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const created = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
    const task = await scheduler.create(newTask(overrides));
    await scheduler.settled();
    return scheduler.get(task.id) as TaskRecord;
  };

  /** Its agent keeps printing for `ms`, looked at every minute as the server does. */
  const work = async (scheduler: TaskScheduler, ms: number) => {
    for (let spent = 0; spent < ms; spent += MIN) {
      lastOutput = Date.now();
      await vi.advanceTimersByTimeAsync(MIN);
      await scheduler.checkExited();
      await scheduler.settled();
    }
  };

  const pushes = () => notify.mock.calls.map(([payload]) => payload as NotificationPayload);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-budget-'));
    store = path.join(dir, 'tasks.json');
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    notify = vi.fn();
    deliver = vi.fn(() => true);
    interrupt = vi.fn();
    pipeline = vi.fn(async () => ({ state: 'merged', mergedSha: 'def456', baseSha: 'abc999' }));
    screens = new Map();
    lastOutput = T0;
    schedulers = [];
    let w = 0;
    worktrees = {
      create: vi.fn(async () => {
        w++;
        return {
          repoPath: '/repo',
          baseBranch: 'main',
          baseSha: 'abc123',
          branch: `ut/espacios-${w}`,
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

  it('warns once at 75 %, then cuts at the limit: needs_you · budget, its agent stopped, its work kept', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler, { budget: { limits: { agent: 60 * MIN } } });
    expect(task.budget?.limits).toMatchObject({ agent: 60 * MIN, wall: TASK_BUDGET_DEFAULTS.wall });

    await work(scheduler, 44 * MIN);
    expect(pushes().filter((p) => p.type === 'task-budget')).toHaveLength(0);
    await work(scheduler, 2 * MIN);
    const warnings = pushes().filter((p) => p.type === 'task-budget');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].data).toMatchObject({ budgetKeys: ['agent'], budgetPct: 75 });
    expect(warnings[0].data?.detail).toMatch(/Budget at 75%: agent 45m of 1h.*Spent: agent 45m/);
    expect(warnings[0].data?.detail).toMatch(/Suggestion: big for one task: split it/);
    expect(scheduler.get(task.id)?.state).toBe('working');

    // Once: the next minutes say nothing more.
    await work(scheduler, 10 * MIN);
    expect(pushes().filter((p) => p.type === 'task-budget')).toHaveLength(1);

    await work(scheduler, 6 * MIN);
    const cut = scheduler.get(task.id) as TaskRecord;
    expect(cut.state).toBe('needs_you');
    expect(cut.blocker?.kind).toBe('budget');
    expect(cut.blocker?.message).toMatch(/Budget reached \(agent 1h of 1h\).*ut task budget/);
    expect(cut.budget?.cut).toMatchObject({ keys: ['agent'], working: true });
    expect(cut.budget?.spent.agent).toBe(60 * MIN);
    expect(interrupt).toHaveBeenCalledWith('s1');
    // Its work stays: worktree, branch and session.
    expect(worktrees.remove).not.toHaveBeenCalled();
    expect(cut.worktreePath).toBe('/wt/1');
    expect(cut.sessionId).toBe('s1');
    expect(pipeline).not.toHaveBeenCalled();
    const needs = pushes().filter((p) => p.type === 'task-needs-you');
    expect(needs).toHaveLength(1);
    expect(needs[0].data?.blocker).toBe('budget');

    // Waiting for the user counts nothing and tells nothing again.
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
    await scheduler.checkExited();
    expect(scheduler.get(task.id)?.budget?.spent.agent).toBe(60 * MIN);
    // (The usual reminder that it still waits on someone aside.)
    expect(pushes().filter((p) => !p.data?.reminder)).toHaveLength(2);
    expect(interrupt).toHaveBeenCalledTimes(1);

    // Kept across a restart.
    scheduler.stop();
    const again = make();
    await again.start(0);
    expect(again.get(task.id)).toMatchObject({
      state: 'needs_you',
      blocker: { kind: 'budget' },
      budget: { cut: { keys: ['agent'] }, warned: ['agent'] },
    });
  });

  it('more budget sends it on in the same session; too little leaves it stopped', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler, { budget: { limits: { agent: 30 * MIN } } });
    await work(scheduler, 31 * MIN);
    expect(scheduler.get(task.id)?.state).toBe('needs_you');
    deliver.mockClear();

    const short = await scheduler.extendBudget(task.id, 'rounds=+1');
    expect(short).toMatchObject({ ok: false, code: 'over-budget' });
    expect(scheduler.get(task.id)?.state).toBe('needs_you');
    expect(deliver).not.toHaveBeenCalled();
    const bad = await scheduler.extendBudget(task.id, 'mucho');
    expect(bad).toMatchObject({ ok: false, code: 'bad-budget' });

    const more = await scheduler.extendBudget(task.id, '+30m');
    expect(more.ok).toBe(true);
    const going = scheduler.get(task.id) as TaskRecord;
    expect(going.state).toBe('working');
    expect(going.budget?.cut).toBeUndefined();
    expect(going.budget?.limits.agent).toBe(60 * MIN);
    // Going on after more budget is not a new round.
    expect(going.budget?.spent.rounds).toBe(0);
    expect(deliver).toHaveBeenCalledWith('s1', BUDGET_CONTINUE_TEXT, 'codex', expect.anything());
    expect(launch).toHaveBeenCalledTimes(1);
    // The raised limit warns again at its new level (75 % of 60 min), then cuts again.
    expect(going.budget?.warned).toEqual([]);
    await work(scheduler, 15 * MIN);
    expect(pushes().filter((p) => p.type === 'task-budget')).toHaveLength(2);
    await work(scheduler, 15 * MIN);
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'needs_you',
      blocker: { kind: 'budget' },
    });
  });

  it('a round past the limit is held, not handed back; more rounds hand it back', async () => {
    const failed = {
      state: 'failed',
      blocker: { kind: 'verify', message: 'The check failed' },
      verify: { command: 'pnpm test', cwd: '/wt/1', startedAt: 'x', exitCode: 1, tail: 'FAIL' },
    };
    pipeline.mockImplementation(async () => failed);
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler, { budget: { limits: { rounds: 1 } } });
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    // Round 1: handed back as always.
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'working',
      autoFix: { reason: 'verify', attempts: 1 },
      budget: { spent: { rounds: 1 } },
    });
    expect(deliver).toHaveBeenCalledTimes(1);

    await scheduler.markDone('s1', 'Arreglado');
    await scheduler.settled();
    const held = scheduler.get(task.id) as TaskRecord;
    expect(held.state).toBe('needs_you');
    expect(held.blocker?.kind).toBe('budget');
    expect(held.budget?.cut).toMatchObject({
      keys: ['rounds'],
      handBack: { reason: 'verify', blocker: { kind: 'verify' } },
    });
    expect(held.autoFix).toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();

    const more = await scheduler.extendBudget(task.id, '+2');
    expect(more.ok).toBe(true);
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'working',
      autoFix: { reason: 'verify', attempts: 2 },
      budget: { spent: { rounds: 2 }, limits: { rounds: 3 } },
    });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('time paused by a usage limit is not counted', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    await work(scheduler, 20 * MIN);
    const before = scheduler.get(task.id)?.budget?.spent as { agent: number; wall: number };
    expect(before.agent).toBe(20 * MIN);
    expect(before.wall).toBe(20 * MIN);

    // Its agent hits its usage limit (a quiet spell on that screen): paused for hours.
    screens.set('s1', screen('codex-usage-limit.txt'));
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS + 1000);
    await scheduler.checkExited();
    // The idle finish is not one of the scheduler's tracked jobs: a few turns for it.
    await vi.advanceTimersByTimeAsync(100);
    await scheduler.settled();
    expect(scheduler.get(task.id)?.state).toBe('paused');
    const pausedAt = scheduler.get(task.id)?.budget?.spent.agent as number;
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(MIN);
      await scheduler.checkExited();
      if (scheduler.get(task.id)?.state !== 'paused') break;
    }
    const after = scheduler.get(task.id)?.budget?.spent as { agent: number; wall: number };
    // Only the quiet spell before the pause was seen (the agent was still "working" then).
    expect(after.agent).toBe(pausedAt);
    expect(after.agent).toBeLessThanOrEqual(23 * MIN);
    expect(after.wall).toBe(after.agent);
  });

  it("reads its agent's tokens and cuts at the token limit", async () => {
    let tokens = 0;
    const agentUsage = vi.fn(async () => ({
      '/claude/projects/x/conv.jsonl': { ...emptyUsage(), cacheRead: tokens },
    }));
    const scheduler = make({ agentUsage, budgetTokensEveryMs: 0 });
    await scheduler.start(0);
    const task = await created(scheduler, { budget: { limits: { tokens: 1_000_000 } } });
    tokens = 800_000;
    await work(scheduler, MIN);
    expect(scheduler.get(task.id)?.budget?.spent.tokens).toBe(800_000);
    expect(pushes().filter((p) => p.type === 'task-budget')[0]?.data?.detail).toMatch(
      /tokens 800k of 1.0M.*try claude/
    );
    tokens = 1_200_000;
    await work(scheduler, MIN);
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'needs_you',
      blocker: { kind: 'budget' },
      budget: { cut: { keys: ['tokens'] }, spent: { tokens: 1_200_000 } },
    });
    expect(agentUsage).toHaveBeenLastCalledWith(expect.objectContaining({ id: task.id }), [
      '/claude/projects/x/conv.jsonl',
    ]);
  });

  it("a task without a worktree (a session in the user's folder) has no budget and is never cut", async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler, { isolation: 'none' });
    expect(task.budget).toBeUndefined();
    await work(scheduler, 3 * 60 * MIN);
    expect(scheduler.get(task.id)).toMatchObject({ state: 'working' });
    expect(scheduler.get(task.id)?.budget).toBeUndefined();
    expect(interrupt).not.toHaveBeenCalled();
    expect(await scheduler.extendBudget(task.id, '+1h')).toMatchObject({ ok: false });
  });

  it("the project's taskBudget sets its tasks' limits", async () => {
    const settings = {
      get: () => ({
        mergePolicy: 'auto' as const,
        allowMergeWithoutCheck: false,
        verifyTimeoutSec: 900,
        aiReview: false,
        taskBudget: 'agent=10m,warn=50',
      }),
    };
    const scheduler = make({ settings });
    await scheduler.start(0);
    const task = await created(scheduler);
    expect(task.budget).toMatchObject({ limits: { agent: 10 * MIN }, warnPct: 50 });
    await work(scheduler, 5 * MIN);
    expect(pushes().filter((p) => p.type === 'task-budget')).toHaveLength(1);
    await work(scheduler, 5 * MIN);
    expect(scheduler.get(task.id)?.blocker?.kind).toBe('budget');
  });
});
