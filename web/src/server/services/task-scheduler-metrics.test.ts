/**
 * Task metrics in the scheduler (2026-11-03): a task's usage from its agent's files, its
 * quality signals, the saving features it ran with (or holdout), its project's ledger, the
 * comparison of `ut project stats` and the guard that turns a feature off.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import { formatSavingsReport } from '../../shared/saving-features.js';
import type { emptyUsage, TaskQuality, TaskSavings } from '../../shared/task-metrics.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { formatTaskDetail } from '../task-cli/format-task-detail.js';
import type { NotificationPayload } from './push-notification-service.js';
import { TaskMetricsLedger } from './task-metrics-ledger.js';
import {
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const MIN = 60_000;
const T0 = new Date(2026, 10, 3, 10, 0).getTime();
const REPO = '/repo';

function newTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Rotar logs',
    prompt: 'Rota los logs',
    workingDir: REPO,
    repoPath: REPO,
    command: ['claude'],
    agent: 'claude',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  };
}

describe('TaskScheduler: metrics and saving features', () => {
  let dir: string;
  let settings: ProjectSettings;
  let update: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let projectNotice: ReturnType<typeof vi.fn>;
  let usage: Record<string, ReturnType<typeof emptyUsage>>;
  let random: number;
  let ledger: TaskMetricsLedger;
  let schedulers: TaskScheduler[];

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    let n = 0;
    let w = 0;
    const worktrees: TaskWorktrees = {
      create: vi.fn(async () => {
        w++;
        return {
          repoPath: REPO,
          baseBranch: 'main',
          baseSha: 'abc123',
          branch: `ut/rotar-${w}`,
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
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: vi.fn(async () => ({ sessionId: `s${++n}` })),
      notify: vi.fn() as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      deliver: vi.fn(() => true),
      worktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      lastOutputAt: () => Date.now(),
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 10,
      mainRepo: async () => REPO,
      settings: {
        get: () => settings,
        update: update as unknown as NonNullable<TaskSchedulerDeps['settings']>['update'],
      },
      projectNotice: projectNotice as unknown as TaskSchedulerDeps['projectNotice'],
      agentUsage: async () => ({ ...usage }),
      budgetTokensEveryMs: 0,
      metricsLedger: ledger,
      random: () => random,
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

  const tick = async (scheduler: TaskScheduler) => {
    await vi.advanceTimersByTimeAsync(MIN);
    await scheduler.checkExited();
    await scheduler.settled();
  };

  const passedPipeline = {
    state: 'merged',
    mergedSha: 'def456',
    baseSha: 'abc999',
    verify: {
      command: 'pnpm test',
      cwd: '/wt/1',
      startedAt: 'x',
      finishedAt: 'y',
      exitCode: 0,
    },
    review: { verdict: 'ok', summary: 'Bien', issues: [], at: 'x', model: 'sonnet' },
  };

  /** A finished task of the project as the ledger keeps it. */
  const entry = (
    i: number,
    on: boolean,
    passed: boolean,
    {
      ok = true,
      features = { 'loop-nudge': 1 },
    }: { ok?: boolean; features?: TaskSavings['on'] } = {}
  ) => {
    const quality: TaskQuality = {
      autoFixRounds: passed ? 0 : 1,
      riskRules: [],
      firstCheck: { passed, at: 'x' },
      firstReview: { verdict: ok ? 'ok' : 'concerns', at: 'x' },
    };
    return {
      taskId: `old-${on ? 'with' : 'without'}-${i}`,
      name: 'old',
      agent: 'claude' as const,
      state: 'merged' as const,
      finishedAt: new Date(T0 - (100 - i) * MIN).toISOString(),
      savings: (on ? { on: features } : { on: {}, holdout: true }) as TaskSavings,
      quality,
      cost: on ? 500 : 1000,
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-metrics-'));
    settings = { ...DEFAULT_PROJECT_SETTINGS };
    update = vi.fn((_repo: string, patch: Partial<ProjectSettings>) => {
      settings = { ...settings, ...patch };
      return settings;
    });
    pipeline = vi.fn(async () => passedPipeline);
    projectNotice = vi.fn(() => true);
    usage = {};
    random = 0.5;
    ledger = new TaskMetricsLedger(path.join(dir, 'task-metrics.json'));
    schedulers = [];
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('records usage, cost and quality, shows them in status and keeps them in the ledger', async () => {
    const failedFirst = {
      state: 'failed',
      blocker: { kind: 'verify', message: 'The check failed' },
      verify: { command: 'pnpm test', cwd: '/wt/1', startedAt: 'x', finishedAt: 'y', exitCode: 1 },
    };
    pipeline.mockImplementationOnce(async () => failedFirst);
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    expect(task.metrics?.savings).toEqual({ on: { 'loop-nudge': 1 } });
    expect(task.metrics?.project).toBe(REPO);

    usage = {
      '/claude/projects/wt-1/c1.jsonl': {
        input: 2000,
        cacheWrite: 4000,
        cacheRead: 100_000,
        output: 1000,
        turns: 12,
        maxContext: 60_000,
        compactions: 1,
      },
    };
    await tick(scheduler);
    const working = scheduler.get(task.id) as TaskRecord;
    // 2000 + 5000 + 10000 + 5000
    expect(working.metrics?.cost).toBe(22_000);
    expect(working.budget?.spent.tokens).toBe(107_000);

    // Its first check fails, the fix goes back to it, the second one passes and it merges.
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    expect(scheduler.get(task.id)?.state).toBe('working');
    await scheduler.markDone('s1', 'Arreglado');
    await scheduler.settled();
    const merged = scheduler.get(task.id) as TaskRecord;
    expect(merged.state).toBe('merged');
    expect(merged.metrics?.quality).toMatchObject({
      firstCheck: { passed: false },
      firstReview: { verdict: 'ok' },
      autoFixRounds: 1,
      riskRules: [],
    });

    const detail = formatTaskDetail(merged, { now: Date.now() });
    expect(detail).toMatch(
      /usage: {4}in 2\.0k · cache write 4\.0k · cache read 100k · out 1\.0k · weighted cost 22k · 12 turns · max context 60k · 1 compaction/
    );
    expect(detail).toMatch(
      /quality: {2}first check failed · 1 auto-fix round · first review ok · no risk flags/
    );
    expect(detail).toMatch(/savings: {2}loop-nudge v1/);

    const [kept] = new TaskMetricsLedger(path.join(dir, 'task-metrics.json')).list(REPO);
    expect(kept).toMatchObject({
      taskId: task.id,
      state: 'merged',
      cost: 22_000,
      savings: { on: { 'loop-nudge': 1 } },
      quality: { firstCheck: { passed: false }, autoFixRounds: 1 },
    });
  });

  it('a holdout share runs without the features', async () => {
    settings = { ...settings, summarizeOutput: true };
    const scheduler = make();
    await scheduler.start(0);
    random = 0.05;
    expect((await created(scheduler)).metrics?.savings).toEqual({ on: {}, holdout: true });
    random = 0.5;
    expect((await created(scheduler)).metrics?.savings).toEqual({
      on: { 'test-summary': 1, 'loop-nudge': 1 },
    });
    // Codex gets no summaries (no PreToolUse rewrite).
    expect(
      (await created(scheduler, { agent: 'codex', command: ['codex'] })).metrics?.savings
    ).toEqual({
      on: { 'loop-nudge': 1 },
    });
    settings = { ...settings, savingHoldoutPct: 60 };
    expect((await created(scheduler)).metrics?.savings.holdout).toBe(true);
  });

  it("counts a task's check runs: made, by its agent, reused with the time saved, failed by load (2026-11-11)", async () => {
    const start = new Date(T0).toISOString();
    const end = new Date(T0 + 5 * MIN).toISOString();
    pipeline.mockImplementation(async () => ({
      ...passedPipeline,
      timings: [
        { phase: 'verify', startedAt: start, finishedAt: end, round: 1, outcome: 'failed (load)' },
        { phase: 'verify', startedAt: start, finishedAt: end, round: 1, outcome: 'passed' },
      ],
      // Two runs (one failed by load), and one not made: the same tree had passed.
      checks: { runs: 2, runMs: 10 * MIN, reused: 1, savedMs: 5 * MIN, loadFailed: 1 },
    }));
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    // Its agent ran the whole check once itself, and asked for it again on the same files.
    scheduler.noteAgentCheck(task.id, { ms: 4 * MIN });
    scheduler.noteAgentCheck(task.id, { ms: 0, reusedMs: 4 * MIN });
    scheduler.noteAgentCheck('no-such-task', { ms: 1 });
    expect(scheduler.get(task.id)?.metrics?.checks).toEqual({
      runs: 1,
      runMs: 4 * MIN,
      agentRuns: 1,
      reused: 1,
      savedMs: 4 * MIN,
      loadFailed: 0,
    });
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    const merged = scheduler.get(task.id) as TaskRecord;
    expect(merged.state).toBe('merged');
    expect(merged.metrics?.checks).toEqual({
      runs: 3,
      runMs: 14 * MIN,
      agentRuns: 1,
      reused: 2,
      savedMs: 9 * MIN,
      loadFailed: 1,
    });
    // `ut task status`, line time:.
    expect(formatTaskDetail(merged, { now: Date.now() })).toMatch(
      /time: .* in all; 3 check runs \(1 by its agent, 14m\), 2 reused \(saved 9m\), 1 failed by load/
    );
    // `ut project stats`: every finished task of the project together.
    const [kept] = ledger.list(REPO);
    expect(kept.checks).toEqual(merged.metrics?.checks);
    const report = scheduler.savingsReport(REPO);
    expect(report.checks).toEqual({ tasks: 1, checks: merged.metrics?.checks });
    expect(formatSavingsReport(report)).toMatch(
      /checks: {3}3 check runs \(1 by its agent, 14m\), 2 reused \(saved 9m\), 1 failed by load over 1 task\(s\); 40% of the checks asked for were not run again/
    );
  });

  it('turns a feature off for the project when its tasks are clearly worse, and tells the orchestrator the numbers', async () => {
    // 29 earlier tasks with it, 12 of them passed first; 12 without, all passed.
    for (let i = 0; i < 29; i++) ledger.upsert(REPO, entry(i, true, i < 12));
    for (let i = 0; i < 12; i++) ledger.upsert(REPO, entry(i, false, true));
    pipeline.mockImplementation(async () => ({
      ...passedPipeline,
      verify: { ...passedPipeline.verify, exitCode: 1 },
      state: 'merged',
    }));
    const scheduler = make();
    await scheduler.start(0);
    const before = scheduler.savingsReport(REPO);
    expect(before.features.find((f) => f.id === 'loop-nudge')).toMatchObject({
      state: 'on',
      comparison: { with: { tasks: 29 }, without: { tasks: 12, small: true }, small: true },
    });
    expect(update).not.toHaveBeenCalled();

    // The 30th task with it: 12 of 30 (40 %) against 12 of 12 (100 %).
    const task = await created(scheduler);
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    expect(scheduler.get(task.id)?.state).toBe('merged');
    expect(update).toHaveBeenCalledTimes(1);
    expect(settings.savingAutoOff).toEqual([
      expect.objectContaining({
        feature: 'loop-nudge',
        version: 1,
        rule: 2,
        // The numbers with their uncertainty; the size of the new task's change is known.
        reason: expect.stringMatching(
          /first-try check pass rate 40% with it \(12\/30\) vs 100% without \(12\/12\): −60 points, 99% interval −\d+ to −\d+; −\d+ within changes of a like size \(size known for 1 of 42\) \(last 42 tasks; median cost 500 with it vs 1\.0k without\)/
        ),
      }),
    ]);
    expect(projectNotice).toHaveBeenCalledWith(
      REPO,
      expect.stringMatching(
        /Saving feature loop-nudge v1 turned off for this project.*40%.*100%.*99% interval/
      )
    );
    expect(ledger.list(REPO).find((row) => row.taskId === task.id)?.quality.lines).toBe(4);

    // New tasks run without it; the report says why; nothing is turned off twice.
    const next = await created(scheduler);
    expect(next.metrics?.savings).toEqual({ on: {} });
    const report = scheduler.savingsReport(REPO);
    expect(report.features.find((f) => f.id === 'loop-nudge')).toMatchObject({
      state: 'auto-off',
      autoOff: { version: 1 },
      comparison: { with: { tasks: 30, firstCheckPassRate: 12 / 30 }, without: { tasks: 12 } },
    });
    expect(report).toMatchObject({ tasks: 42, holdout: 12 });
    await scheduler.markDone('s2', 'Hecho');
    await scheduler.settled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('the real case (2026-11-11): loop-nudge turned off on 61 % of 87 against 80 % of 5 is on again under the present rule', async () => {
    for (let i = 0; i < 87; i++) ledger.upsert(REPO, entry(i, true, true, { ok: i < 53 }));
    for (let i = 0; i < 5; i++) ledger.upsert(REPO, entry(i, false, true, { ok: i < 4 }));
    // As the first rule wrote it: no rule number.
    settings = {
      ...settings,
      savingAutoOff: [
        {
          feature: 'loop-nudge',
          version: 1,
          at: '2026-11-11T02:45:00.000Z',
          reason:
            'first-review approval rate 61% with it (87 tasks) vs 80% without (5 tasks) (last 92 tasks)',
        },
      ],
    };
    const scheduler = make();
    await scheduler.start(0);
    // Off: a task made now runs without it.
    const task = await created(scheduler);
    expect(task.metrics?.savings).toEqual({ on: {} });
    expect(scheduler.savingsReport(REPO).features.find((f) => f.id === 'loop-nudge')?.state).toBe(
      'auto-off'
    );
    // The guard looks when a task finishes: judged again, not enough data, on again.
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(settings.savingAutoOff).toEqual([]);
    expect(projectNotice).toHaveBeenCalledWith(
      REPO,
      expect.stringMatching(
        /Saving feature loop-nudge v1 is on again for this project: the guard turned it off on 2026-11-11T02:45:00\.000Z under an earlier rule, and under the present one there is not enough data yet to judge it\. .*first-review approval rate: not enough data yet \(87 task\(s\) with it, 6 without; the guard needs 10 in each\)/
      )
    );
    const report = scheduler.savingsReport(REPO);
    expect(report.features.find((f) => f.id === 'loop-nudge')?.state).toBe('on');
    expect(formatSavingsReport(report)).toMatch(
      /loop-nudge v1 \(failure-loop nudges\): on \(failureLoopNudge\)\n.*\n.*\n.*\n.*\n {4}guard: {3}first-review approval rate: not enough data yet/
    );
    expect((await created(scheduler)).metrics?.savings).toEqual({ on: { 'loop-nudge': 1 } });
    await scheduler.markDone('s2', 'Hecho');
    await scheduler.settled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('the real case (2026-11-11): tool-pruning and test-summary, 31 % of 26 against 74 % of 66, stay off under the present rule, judged once', async () => {
    const features = { 'tool-pruning': 1, 'test-summary': 1 };
    for (let i = 0; i < 26; i++) {
      ledger.upsert(REPO, entry(i, true, true, { ok: i < 8, features }));
    }
    for (let i = 0; i < 65; i++) ledger.upsert(REPO, entry(i, false, true, { ok: i < 48 }));
    const at = '2026-11-10T20:00:00.000Z';
    settings = {
      ...settings,
      toolPruning: true,
      summarizeOutput: true,
      // The nudges are not what this test is about.
      failureLoopNudge: false,
      savingAutoOff: [
        { feature: 'tool-pruning', version: 1, at, reason: 'old numbers' },
        { feature: 'test-summary', version: 1, at, reason: 'old numbers' },
      ],
    };
    const scheduler = make();
    await scheduler.start(0);
    // The 66th task without them, approved first: 49 of 66.
    await created(scheduler);
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    expect(update).toHaveBeenCalledTimes(1);
    const reason = (other: string) =>
      expect.stringMatching(
        new RegExp(
          `^first-review approval rate 31% with it \\(8/26\\) vs 74% without \\(49/66\\): −43 points, 99% interval −\\d+ to −\\d+.*it ran together with ${other} in nearly all of those tasks: the numbers cannot tell them apart\\)$`
        )
      );
    // Still off, since when they were, with the numbers and the rule they now stand on.
    expect(settings.savingAutoOff).toEqual([
      { feature: 'tool-pruning', version: 1, at, rule: 2, reason: reason('test-summary') },
      { feature: 'test-summary', version: 1, at, rule: 2, reason: reason('tool-pruning') },
    ]);
    expect(projectNotice).toHaveBeenCalledTimes(2);
    expect(projectNotice).toHaveBeenCalledWith(
      REPO,
      expect.stringMatching(
        /Saving feature tool-pruning v1 stays off for this project: judged again/
      )
    );
    // Judged under the present rule: not judged again, whatever the next tasks show.
    await created(scheduler);
    await scheduler.markDone('s2', 'Hecho');
    await scheduler.settled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(projectNotice).toHaveBeenCalledTimes(2);
  });

  it('as good with it: nothing is turned off; a discarded task counts in the ledger', async () => {
    for (let i = 0; i < 20; i++) ledger.upsert(REPO, entry(i, true, i < 18));
    for (let i = 0; i < 6; i++) ledger.upsert(REPO, entry(i, false, i < 5));
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    expect(update).not.toHaveBeenCalled();
    const other = await created(scheduler);
    expect((await scheduler.discard(other.id, { confirm: true })).ok).toBe(true);
    await scheduler.settled();
    const rows = ledger.list(REPO);
    expect(rows.find((r) => r.taskId === task.id)?.state).toBe('merged');
    expect(rows.find((r) => r.taskId === other.id)).toMatchObject({
      state: 'discarded',
      quality: { discarded: true },
    });
  });

  it('the ledger follows a moved project', () => {
    ledger.upsert(REPO, entry(1, true, true));
    expect(ledger.projectsMoved([{ from: REPO, to: '/moved' }])).toBe(1);
    expect(ledger.list(REPO)).toEqual([]);
    expect(new TaskMetricsLedger(path.join(dir, 'task-metrics.json')).list('/moved')).toHaveLength(
      1
    );
  });
});
