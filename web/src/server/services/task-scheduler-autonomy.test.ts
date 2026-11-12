/**
 * Phase 2 (2026-10-20, THE PRINCIPLE: the human in the loop as little as possible): the
 * auto-fix loop, unavailable reviews retried by themselves, messages kept until typed, setup
 * retried once, orchestrator routing of quiet events, revert tasks, the circuit breaker and
 * tasks following moved projects.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import {
  TASK_AUTO_FIX_MAX,
  TASK_CONFLICT_FRESH_MAX,
  type TaskPhaseTiming,
  type TaskRecord,
  type TaskReview,
} from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { NotificationPayload } from './push-notification-service.js';
import { type PipelineOptions, type PipelineResult, risksNotAccepted } from './task-merge.js';
import {
  fixPrompt,
  type NewTask,
  REVIEW_RETRY_DELAYS_MS,
  REVIEW_UNAVAILABLE_NOTIFY_MS,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const T0 = new Date('2026-10-20T10:00:00Z').getTime();

function task(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Arregla el login',
    prompt: 'Arregla el login',
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude',
    shielded: false,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  };
}

const unavailable: TaskReview = {
  verdict: 'unavailable',
  summary: '',
  issues: [],
  reason: 'timeout',
  at: 'x',
  model: 'sonnet',
  headSha: 'h1',
};

describe('TaskScheduler autonomy (2026-10-20)', () => {
  let dir: string;
  let store: string;
  let notify: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let launch: ReturnType<typeof vi.fn>;
  let statuses: Map<string, string>;
  let settings: ProjectSettings;
  let updates: Array<Record<string, unknown>>;
  let worktrees: TaskWorktrees & { create: ReturnType<typeof vi.fn> };
  let schedulers: TaskScheduler[];

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: (id) => statuses.get(id) ?? 'running',
      stopSession: async () => {},
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      worktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      settings: {
        get: () => settings,
        update: (_repo, patch) => {
          updates.push(patch);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete (settings as unknown as Record<string, unknown>)[key];
            else (settings as unknown as Record<string, unknown>)[key] = value;
          }
          return settings;
        },
      },
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 0,
      inputRetryMs: 1000,
      setupRetryMs: 1000,
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const ready = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
    const created = await scheduler.create(task(overrides));
    await scheduler.settled();
    return scheduler.get(created.id) as TaskRecord;
  };

  const finish = async (scheduler: TaskScheduler, record: TaskRecord) => {
    await scheduler.markDone(scheduler.get(record.id)?.sessionId as string, 'hecho');
    await scheduler.settled();
    return scheduler.get(record.id) as TaskRecord;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-autonomy-'));
    store = path.join(dir, 'tasks.json');
    notify = vi.fn();
    deliver = vi.fn(async () => true);
    statuses = new Map();
    settings = { ...DEFAULT_PROJECT_SETTINGS };
    updates = [];
    schedulers = [];
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    pipeline = vi.fn(async (): Promise<PipelineResult> => ({ state: 'merged', mergedSha: 'm1' }));
    let w = 0;
    worktrees = {
      create: vi.fn(async () => {
        w++;
        return {
          repoPath: '/repo',
          baseBranch: 'main',
          baseSha: 'b0',
          branch: `ut/t${w}`,
          worktreePath: `/wt/${w}`,
          clonedDirs: [],
        };
      }),
      remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
      commitLeftovers: vi.fn(async () => false),
      changes: vi.fn(async () => ({
        files: ['src/a.ts'],
        stats: { commits: 1, files: 1, insertions: 1, deletions: 0 },
      })),
      hasUnmergedWork: vi.fn(async () => false),
    };
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  // 2026-10-31: bakery's 2b3c5cca took 40 min across 4 rounds and nothing said where.
  describe('phase timings and the review run alongside the check', () => {
    const stamp = (phase: TaskPhaseTiming['phase'], ms: number, round = 1): TaskPhaseTiming => ({
      phase,
      startedAt: new Date(Date.now() - ms).toISOString(),
      finishedAt: new Date(Date.now()).toISOString(),
      round,
    });
    const concerns = (headSha: string): TaskReview => ({
      verdict: 'concerns',
      summary: 'Divide entre n-1',
      issues: [{ file: 'split.ts', line: 1, severity: 'high', what: 'Divide entre n-1' }],
      at: 'x',
      model: 'sonnet',
      headSha,
    });

    it("keeps each run's phases with its round, and the agent's fix between them", async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockImplementationOnce(async (_task, options: PipelineOptions) => ({
        state: 'failed',
        blocker: { kind: 'verify', message: 'The check failed' },
        verify: { command: 'pnpm test', cwd: '/wt/1', startedAt: 'x', exitCode: 1, tail: 'FAIL' },
        timings: [stamp('verify', 270_000, options.round)],
      }));
      const first = await finish(scheduler, created);
      expect(pipeline.mock.calls[0][1]).toMatchObject({ round: 1 });
      expect(first.timings).toEqual([
        expect.objectContaining({ phase: 'verify', round: 1 }),
        expect.objectContaining({ phase: 'fix', round: 1, outcome: 'verify' }),
      ]);
      expect(first.timings?.[1].finishedAt).toBeUndefined();

      vi.advanceTimersByTime(6 * 60_000);
      pipeline.mockImplementationOnce(async (_task, options: PipelineOptions) => ({
        state: 'merged',
        mergedSha: 'm2',
        timings: [stamp('verify', 280_000, options.round), stamp('merge', 1_000, options.round)],
      }));
      const done = await finish(scheduler, created);
      expect(pipeline.mock.calls[1][1]).toMatchObject({ round: 2 });
      expect(done.timings?.map((t) => `${t.phase}:${t.round}`)).toEqual([
        'verify:1',
        'fix:1',
        'verify:2',
        'merge:2',
      ]);
      const fix = done.timings?.[1] as TaskPhaseTiming;
      expect(Date.parse(fix.finishedAt as string) - Date.parse(fix.startedAt)).toBe(6 * 60_000);
    });

    it('a conflict handed back counts as conflict time', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce({
        state: 'needs_you',
        blocker: { kind: 'conflict', message: 'Conflicts with main in 1 file', detail: ['a.ts'] },
      });
      const first = await finish(scheduler, created);
      expect(first.timings).toEqual([expect.objectContaining({ phase: 'conflict', round: 1 })]);
    });

    // 2026-11-01 (171d25b2): four tasks merging in parallel gave one a new conflict after
    // each resolution; it ran out of fixes three times and spent 5 of its 6 rounds.
    describe('conflicts brought by the base moving on', () => {
      const conflict = (base: string, files = ['src/server/services/task-scheduler.ts']) => ({
        state: 'needs_you' as const,
        blocker: {
          kind: 'conflict' as const,
          message: `Conflicts with main in ${files.length} file`,
          detail: files,
          base,
        },
      });

      it('three new conflicts in a row, each on another base, do not use up the fixes', async () => {
        const scheduler = make();
        await scheduler.start(0);
        const created = await ready(scheduler);
        for (const [i, base] of ['b1', 'b2', 'b3', 'b4'].entries()) {
          pipeline.mockResolvedValueOnce(conflict(base));
          const handed = await finish(scheduler, created);
          expect(handed).toMatchObject({
            state: 'working',
            autoFix: { reason: 'conflict', attempts: 1 },
            autoFixes: { conflict: 0 },
            lastConflict: { base },
            freshConflicts: i + 1,
          });
          expect(handed.autoFixGaveUpAt).toBeUndefined();
          expect(deliver.mock.calls.at(-1)?.[1]).toContain(
            'a new conflict to resolve, not a failed fix'
          );
          expect(deliver.mock.calls.at(-1)?.[1]).not.toContain('last automatic attempt');
        }
        expect(deliver).toHaveBeenCalledTimes(4);
        expect(notify).not.toHaveBeenCalled();
        // Resolved at last: merged.
        pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1' });
        expect((await finish(scheduler, created)).state).toBe('merged');
      });

      it('the same conflict again (same base, same files) uses up the fixes', async () => {
        const scheduler = make();
        await scheduler.start(0);
        const created = await ready(scheduler);
        pipeline.mockResolvedValue(conflict('b1'));
        const first = await finish(scheduler, created);
        expect(first).toMatchObject({
          state: 'working',
          autoFix: { attempts: 1, baseMoved: true },
          autoFixes: { conflict: 0 },
        });
        // Back the same: a failed fix, counted (TASK_AUTO_FIX_MAX of them).
        const second = await finish(scheduler, created);
        expect(second).toMatchObject({
          autoFix: { reason: 'conflict', attempts: 1 },
          autoFixes: { conflict: 1 },
        });
        expect(second.autoFix?.baseMoved).toBeUndefined();
        expect(deliver.mock.calls.at(-1)?.[1]).toContain('Automatic fix 1 of 2');
        const third = await finish(scheduler, created);
        expect(third.autoFix).toMatchObject({ reason: 'conflict', attempts: 2 });
        expect(deliver.mock.calls.at(-1)?.[1]).toContain('last automatic attempt');
        const fourth = await finish(scheduler, created);
        expect(fourth).toMatchObject({ state: 'needs_you', blocker: { kind: 'conflict' } });
        expect(fourth.autoFix).toBeUndefined();
        expect(fourth.autoFixGaveUpAt).toBeDefined();
        expect(deliver).toHaveBeenCalledTimes(3);
        expect(notify).toHaveBeenCalledTimes(1);
      });

      it('a new conflict takes nothing from the fixes of all reasons together', async () => {
        const failedCheck = (): PipelineResult => ({
          state: 'failed',
          blocker: { kind: 'verify', message: 'The check failed' },
          verify: { command: 'pnpm test', cwd: '/wt/1', startedAt: 'x', exitCode: 1, tail: 'FAIL' },
        });
        const scheduler = make();
        await scheduler.start(0);
        const created = await ready(scheduler);
        pipeline.mockResolvedValueOnce(failedCheck());
        await finish(scheduler, created);
        pipeline.mockResolvedValueOnce(failedCheck());
        await finish(scheduler, created);
        pipeline.mockResolvedValueOnce(conflict('b1'));
        expect((await finish(scheduler, created)).autoFix).toMatchObject({ baseMoved: true });
        // Two check fixes and a new conflict: a review still gets its first fix (3 in all).
        pipeline.mockResolvedValueOnce({
          state: 'needs_you',
          blocker: { kind: 'review', message: 'The AI review found problems' },
        });
        const review = await finish(scheduler, created);
        expect(review).toMatchObject({
          state: 'working',
          autoFix: { reason: 'review', attempts: 1 },
          autoFixes: { verify: 2, conflict: 0, review: 1 },
        });
        expect(review.autoFixGaveUpAt).toBeUndefined();
      });

      it('a base that never stops moving runs out after TASK_CONFLICT_FRESH_MAX new conflicts', async () => {
        const scheduler = make();
        await scheduler.start(0);
        const created = await ready(scheduler);
        let n = 0;
        pipeline.mockImplementation(async () => conflict(`b${++n}`));
        let last = created;
        for (let i = 0; i < TASK_CONFLICT_FRESH_MAX + TASK_AUTO_FIX_MAX + 1; i++) {
          last = await finish(scheduler, created);
          if (last.state !== 'working') break;
        }
        expect(last).toMatchObject({ state: 'needs_you', blocker: { kind: 'conflict' } });
        expect(last.autoFixGaveUpAt).toBeDefined();
        expect(last.freshConflicts).toBe(TASK_CONFLICT_FRESH_MAX);
        // The cap reached, the next ones count as fixes (TASK_AUTO_FIX_MAX of them).
        expect(deliver).toHaveBeenCalledTimes(TASK_CONFLICT_FRESH_MAX + TASK_AUTO_FIX_MAX);
      });

      it('rounds of conflict from the base moving do not spend budget rounds; the same one again does', async () => {
        const scheduler = make();
        await scheduler.start(0);
        const created = await ready(scheduler, { budget: { limits: { rounds: 1 } } });
        for (const base of ['b1', 'b2', 'b3']) {
          pipeline.mockResolvedValueOnce(conflict(base));
          const handed = await finish(scheduler, created);
          expect(handed.state).toBe('working');
          expect(handed.budget?.spent.rounds).toBe(0);
        }
        // The same conflict again is the agent's own round.
        pipeline.mockResolvedValueOnce(conflict('b3'));
        const again = await finish(scheduler, created);
        expect(again).toMatchObject({ state: 'working', budget: { spent: { rounds: 1 } } });
        // Its rounds spent (1 of 1), a new conflict still goes back: it needs no round.
        pipeline.mockResolvedValueOnce(conflict('b4'));
        const fresh = await finish(scheduler, created);
        expect(fresh).toMatchObject({
          state: 'working',
          autoFix: { baseMoved: true },
          budget: { spent: { rounds: 1 } },
        });
        expect(fresh.budget?.cut).toBeUndefined();
        // The same one again needs a round it does not have: held for more budget.
        pipeline.mockResolvedValueOnce(conflict('b4'));
        const held = await finish(scheduler, created);
        expect(held).toMatchObject({
          state: 'needs_you',
          blocker: { kind: 'budget' },
          budget: { cut: { keys: ['rounds'], handBack: { reason: 'conflict' } } },
        });
      });

      it('new conflicts still stop at the wall-time budget: the hard cap on a base that keeps moving', async () => {
        const MIN = 60_000;
        const scheduler = make();
        await scheduler.start(0);
        const created = await ready(scheduler, { budget: { limits: { wall: 30 * MIN } } });
        let n = 0;
        pipeline.mockImplementation(async () => conflict(`b${++n}`));
        let last = created;
        for (let i = 0; i < TASK_CONFLICT_FRESH_MAX; i++) {
          // Each resolution takes the agent 10 minutes, the clock looked at every minute.
          for (let m = 0; m < 10 && scheduler.get(created.id)?.state === 'working'; m++) {
            await vi.advanceTimersByTimeAsync(MIN);
            await scheduler.checkExited();
            await scheduler.settled();
          }
          last = scheduler.get(created.id) as TaskRecord;
          if (last.state !== 'working') break;
          last = await finish(scheduler, created);
          if (last.state !== 'working') break;
          expect(last.autoFix).toMatchObject({ baseMoved: true });
        }
        expect(last).toMatchObject({ state: 'needs_you', blocker: { kind: 'budget' } });
        expect(last.budget?.cut?.keys).toContain('wall');
        expect(last.freshConflicts ?? 0).toBeLessThan(TASK_CONFLICT_FRESH_MAX);
        // Cut: nothing more goes to the agent until the user gives it more budget.
        const sent = deliver.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10 * MIN);
        await scheduler.checkExited();
        await scheduler.settled();
        expect(deliver.mock.calls.length).toBe(sent);
        expect(scheduler.get(created.id)?.state).toBe('needs_you');
      });
    });

    it('a review that ends after its check failed is kept and sent to the agent fixing that commit', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      let late: PipelineOptions['onLateReview'];
      pipeline.mockImplementationOnce(async (_task, options: PipelineOptions) => {
        late = options.onLateReview;
        return {
          state: 'failed',
          blocker: { kind: 'verify', message: 'The check failed' },
          headSha: 'h1',
          verify: {
            command: 'pnpm test',
            cwd: '/wt/1',
            startedAt: 'x',
            exitCode: 1,
            tail: 'FAIL',
            headSha: 'h1',
          },
        };
      });
      const first = await finish(scheduler, created);
      expect(first).toMatchObject({ state: 'working', autoFix: { reason: 'verify' } });
      const handBack = deliver.mock.calls.length;
      late?.(concerns('h1'), stamp('review', 40_000));
      await scheduler.settled();
      const after = scheduler.get(created.id) as TaskRecord;
      expect(after.review).toMatchObject({ verdict: 'concerns', headSha: 'h1' });
      expect(after.timings?.some((t) => t.phase === 'review')).toBe(true);
      await vi.waitFor(() => expect(deliver.mock.calls.length).toBe(handBack + 1));
      expect(deliver.mock.calls.at(-1)?.[1]).toContain('also found problems');
      expect(deliver.mock.calls.at(-1)?.[1]).toContain('Divide entre n-1');
      // One of an older commit is only timed.
      late?.(concerns('h0'), stamp('review', 40_000));
      expect((scheduler.get(created.id) as TaskRecord).review?.headSha).toBe('h1');
    });

    it('the hand-back of a failed check carries the review of the same commit; a stopped check is named', () => {
      const record = {
        baseBranch: 'main',
        verify: {
          command: 'pnpm test',
          cwd: '/w',
          startedAt: 'x',
          exitCode: 1,
          tail: 'FAIL',
          headSha: 'h1',
        },
        review: concerns('h1'),
      } as unknown as TaskRecord;
      const verifyText = fixPrompt(record, { kind: 'verify', message: 'The check failed' });
      expect(verifyText).toContain('also found problems');
      expect(verifyText).toContain('Divide entre n-1');
      // Of another commit: not.
      record.review = concerns('h0');
      expect(fixPrompt(record, { kind: 'verify', message: 'x' })).not.toContain('also found');
      record.review = concerns('h1');
      record.verify = {
        command: 'pnpm test',
        cwd: '/w',
        startedAt: 'x',
        cancelled: true,
        headSha: 'h1',
      };
      expect(fixPrompt(record, { kind: 'review', message: 'x' })).toContain(
        'was stopped before it finished'
      );
    });
  });

  describe('the auto-fix loop', () => {
    const failedCheck = (): PipelineResult => ({
      state: 'failed',
      blocker: { kind: 'verify', message: 'The check failed', detail: ['1 failed'] },
      verify: { command: 'pnpm test', cwd: '/wt/1', startedAt: 'x', exitCode: 1, tail: 'FAIL' },
    });

    it('hands a failed check back to the agent twice, quietly, then tells the user once', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValue(failedCheck());

      const first = await finish(scheduler, created);
      expect(first).toMatchObject({
        state: 'working',
        autoFix: { attempts: 1, max: 2, reason: 'verify' },
        autoFixes: { verify: 1 },
      });
      expect(deliver.mock.calls.at(-1)?.[1]).toContain('Automatic fix 1 of 2');
      expect(deliver.mock.calls.at(-1)?.[1]).toContain('FAIL');
      expect(notify).not.toHaveBeenCalled();

      const second = await finish(scheduler, created);
      expect(second.autoFix).toMatchObject({ attempts: 2 });
      const text = deliver.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain('Step back and rethink the approach');
      expect(notify).not.toHaveBeenCalled();

      const third = await finish(scheduler, created);
      expect(third).toMatchObject({ state: 'failed', blocker: { kind: 'verify' } });
      expect(third.autoFix).toBeUndefined();
      expect(third.autoFixGaveUpAt).toBeDefined();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({
        type: 'task-failed',
        body: expect.stringContaining('fix it 2 times and it still does not merge'),
      });
      expect(deliver).toHaveBeenCalledTimes(2);
    });

    it('a fix that works ends merged with a single push', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce(failedCheck());
      await finish(scheduler, created);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm2', mergedOnto: 'b1' });
      const done = await finish(scheduler, created);
      expect(done).toMatchObject({ state: 'merged', autoMerged: true, mergedOnto: 'b1' });
      expect(done.autoFix).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-merged' });
    });

    describe("the user's merge OK through the automatic rounds (2026-10-23, task e6f1e24b)", () => {
      const secret = { rule: 'secret-file', file: '.env' };
      // The pipeline's risk gate (risksNotAccepted, as in task-merge.ts), then a check whose
      // outcome the test sets.
      let findings: Array<{ rule: string; file: string }>;
      let checkFails: boolean;
      const gate = async (_t: TaskRecord, options: PipelineOptions): Promise<PipelineResult> => {
        const fresh = options.acceptRisk ? risksNotAccepted(findings, options.acceptedRisk) : [];
        if (findings.length && (!options.acceptRisk || fresh.length)) {
          return {
            state: 'needs_you',
            blocker: {
              kind: 'risk',
              message: fresh.length
                ? `A new risky change since your OK: ${fresh[0].rule} in ${fresh[0].file}`
                : 'A risky change',
            },
            risk: findings,
          };
        }
        if (checkFails) return failedCheck();
        return { state: 'merged', mergedSha: 'm1' };
      };

      const okThenFailedCheck = async (scheduler: TaskScheduler) => {
        await scheduler.start(0);
        const created = await ready(scheduler);
        findings = [secret];
        checkFails = false;
        pipeline.mockImplementation(gate);
        expect((await finish(scheduler, created)).blocker?.kind).toBe('risk');
        notify.mockClear();
        // "Fusionar con sus cambios delicados"; the check fails under load.
        checkFails = true;
        expect(scheduler.merge(created.id, { acceptRisk: true }).ok).toBe(true);
        await scheduler.settled();
        const fixing = scheduler.get(created.id) as TaskRecord;
        expect(fixing).toMatchObject({
          state: 'working',
          autoFix: { reason: 'verify' },
          mergeOk: { risk: [secret] },
        });
        return created;
      };

      it('a failed check fixed by the agent (no code change) merges without asking again', async () => {
        const scheduler = make();
        const created = await okThenFailedCheck(scheduler);
        checkFails = false;
        const done = await finish(scheduler, created);
        expect(done.state).toBe('merged');
        expect(done.autoMerged).toBeUndefined();
        expect(done.mergeOk).toBeUndefined();
        expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({
          mode: 'merge',
          acceptRisk: true,
          acceptedRisk: [secret],
        });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-merged' });
      });

      it('a round that adds a new risk asks again, naming what is new; the OK is not widened', async () => {
        const scheduler = make();
        const created = await okThenFailedCheck(scheduler);
        checkFails = false;
        findings = [secret, { rule: 'migration', file: 'db/001.sql' }];
        const asked = await finish(scheduler, created);
        expect(asked).toMatchObject({
          state: 'needs_you',
          blocker: {
            kind: 'risk',
            message: 'A new risky change since your OK: migration in db/001.sql',
          },
          mergeOk: { risk: [secret] },
        });
        expect(asked.autoFix).toBeUndefined();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-needs-you' });

        // The user's new OK covers both.
        expect(scheduler.merge(created.id, { acceptRisk: true }).ok).toBe(true);
        await scheduler.settled();
        expect(scheduler.get(created.id)?.state).toBe('merged');
      });

      it('a follow-up from the user drops the OK: new work, new decision', async () => {
        const scheduler = make();
        const created = await okThenFailedCheck(scheduler);
        await scheduler.send(created.id, 'añade también el logout', 'ui');
        checkFails = false;
        const after = await finish(scheduler, created);
        expect(after).toMatchObject({ state: 'needs_you', blocker: { kind: 'risk' } });
        expect(after.mergeOk).toBeUndefined();
      });
    });

    it('never auto-fixes risk, questions, no-check or a task whose policy is ask', async () => {
      const scheduler = make();
      await scheduler.start(0);
      for (const result of [
        { state: 'needs_you', blocker: { kind: 'risk', message: 'secrets' } },
        { state: 'ready', blocker: { kind: 'no-check', message: 'no check' } },
        { state: 'needs_you', blocker: { kind: 'dirty-base', message: 'dirty' } },
      ] as PipelineResult[]) {
        const created = await ready(scheduler);
        pipeline.mockResolvedValueOnce(result);
        const after = await finish(scheduler, created);
        // A dirty base waits ready, merged by Untether once clean (2026-10-24): no push.
        expect(after.state).toBe(result.blocker?.kind === 'dirty-base' ? 'ready' : result.state);
        expect(after.autoFix).toBeUndefined();
      }
      const ask = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValueOnce(failedCheck());
      expect((await finish(scheduler, ask)).state).toBe('failed');
      expect(deliver).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(3);
    });

    it("an orchestrator's task: the orchestrator hears it is being fixed (quiet), the phone does not", async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, {
        origin: 'orchestrator',
        orchestratorSessionId: 'orch-1',
      });
      pipeline.mockResolvedValue(failedCheck());
      await finish(scheduler, created);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({
        type: 'task-failed',
        data: { quiet: true, autoFix: { attempts: 1, max: 2, reason: 'verify' } },
      });
    });

    it('a task with pushes off still reaches its orchestrator, quietly', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, {
        notify: false,
        origin: 'orchestrator',
        orchestratorSessionId: 'orch-1',
        mergePolicy: 'ask',
      });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await finish(scheduler, created);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-ready', data: { quiet: true } });
      // A plain task with pushes off stays silent.
      const plain = await ready(scheduler, { notify: false, mergePolicy: 'ask' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await finish(scheduler, plain);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('three tasks giving up within a day pause the project (circuit breaker), told once', async () => {
      const scheduler = make();
      await scheduler.start(0);
      pipeline.mockResolvedValue(failedCheck());
      for (let i = 0; i < 3; i++) {
        const created = await ready(scheduler);
        for (let round = 0; round < 3; round++) await finish(scheduler, created);
      }
      expect(updates).toContainEqual(
        expect.objectContaining({
          autoMergePausedReason: expect.stringContaining('3 of its tasks'),
        })
      );
      const paused = notify.mock.calls.filter((call) => call[0].type === 'project-paused');
      expect(paused).toHaveLength(1);
      expect(settings.autoMergePausedUntil).toBeDefined();
      // Over after 24 h: cleared on the next pipeline run.
      vi.setSystemTime(T0 + 25 * 3600_000);
      const next = await ready(scheduler);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm9' });
      await finish(scheduler, next);
      expect(settings.autoMergePausedUntil).toBeUndefined();
    });
  });

  describe('an unavailable AI review', () => {
    const stillUnavailable = (): PipelineResult => ({
      state: 'ready',
      blocker: { kind: 'review-unavailable', message: 'The AI review could not run' },
      review: unavailable,
    });

    it('waits ready, retries by itself with backoff, quietly, and tells the user once after 3 h', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValue(stillUnavailable());
      const waiting = await finish(scheduler, created);
      expect(waiting).toMatchObject({
        state: 'ready',
        blocker: { kind: 'review-unavailable' },
        reviewRetryAt: new Date(T0 + REVIEW_RETRY_DELAYS_MS[0]).toISOString(),
        reviewRetry: { attempts: 0, mode: 'auto' },
      });
      expect(notify).not.toHaveBeenCalled();
      expect(pipeline).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(REVIEW_RETRY_DELAYS_MS[0]);
      await scheduler.settled();
      expect(pipeline).toHaveBeenCalledTimes(2);
      expect(pipeline.mock.calls[1][1]).toMatchObject({ mode: 'auto' });
      expect(scheduler.get(created.id)?.reviewRetry?.attempts).toBe(1);
      expect(notify).not.toHaveBeenCalled();

      // Keep retrying until past three hours: one push, then quiet again.
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        await scheduler.settled();
      }
      const pushes = notify.mock.calls.map((call) => call[0]);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({
        type: 'task-ready',
        body: expect.stringContaining('has not been able to run'),
      });
      expect(Date.now() - T0).toBeGreaterThan(REVIEW_UNAVAILABLE_NOTIFY_MS);

      // The user's "merge anyway" goes through and clears the retry.
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', review: unavailable });
      expect(scheduler.merge(created.id, { acceptReview: true }).ok).toBe(true);
      await scheduler.settled();
      const merged = scheduler.get(created.id) as TaskRecord;
      expect(merged.state).toBe('merged');
      expect(merged.reviewRetryAt).toBeUndefined();
      expect(merged.autoMerged).toBeUndefined();
    });

    it('a review that comes back merges on the retry', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce(stillUnavailable());
      await finish(scheduler, created);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1' });
      await vi.advanceTimersByTimeAsync(REVIEW_RETRY_DELAYS_MS[0]);
      await scheduler.settled();
      expect(scheduler.get(created.id)).toMatchObject({ state: 'merged', autoMerged: true });
      expect(notify).toHaveBeenCalledTimes(1);
    });
  });

  describe('messages kept until typed', () => {
    it('a message the agent could not take waits, is retried, and goes in later', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      deliver.mockResolvedValueOnce(false);
      const sent = await scheduler.send(created.id, 'Añade un test', 'cli');
      expect(sent.ok).toBe(true);
      await Promise.resolve();
      expect(scheduler.get(created.id)?.pendingInput).toEqual([
        { text: 'Añade un test', at: new Date(T0).toISOString() },
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      await scheduler.settled();
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(scheduler.get(created.id)?.pendingInput).toBeUndefined();
    });

    it('a message still waiting when the task ends is reported undelivered (2026-11-10)', async () => {
      const messageDropped = vi.fn();
      const scheduler = make({ messageDropped });
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      deliver.mockResolvedValue(false);
      await scheduler.send(created.id, 'Añade un test', 'cli', {
        id: 'msg-1',
        header: 'from another agent',
      });
      await Promise.resolve();
      expect(scheduler.get(created.id)?.pendingInput).toHaveLength(1);
      await scheduler.discard(created.id);
      await scheduler.settled();
      expect(messageDropped).toHaveBeenCalledWith('msg-1', expect.stringContaining('the task is'));
      expect(scheduler.get(created.id)?.pendingInput).toBeUndefined();
      deliver.mockReset();
    });

    it('messages still waiting after a restart are typed then', async () => {
      const first = make();
      await first.start(0);
      const created = await ready(first, { mergePolicy: 'ask' });
      deliver.mockResolvedValueOnce(false);
      await first.send(created.id, 'uno', 'cli');
      await Promise.resolve();
      first.stop();
      deliver.mockClear();
      const second = make();
      await second.start(0);
      await second.settled();
      expect(deliver).toHaveBeenCalledWith(created.sessionId, 'uno', 'claude', {
        trustFolder: true,
      });
      expect(second.get(created.id)?.pendingInput).toBeUndefined();
    });
  });

  it('a failed setup is retried once by itself; the second failure is pushed', async () => {
    const scheduler = make();
    await scheduler.start(0);
    worktrees.create.mockRejectedValueOnce(new Error('lock held'));
    worktrees.create.mockRejectedValueOnce(new Error('lock held again'));
    const created = await ready(scheduler);
    expect(created).toMatchObject({ state: 'failed', setupRetries: 1 });
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await scheduler.settled();
    expect(scheduler.get(created.id)?.state).toBe('failed');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-failed' });
    expect(worktrees.create).toHaveBeenCalledTimes(2);
  });

  describe('revert ("Deshacer")', () => {
    it('makes a task that reverts the merged commits with git and merges it through the pipeline', async () => {
      const revertCommits = vi.fn(async () => ({ ok: true as const, commits: 2 }));
      const scheduler = make({ revertCommits });
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b5' });
      await finish(scheduler, created);
      launch.mockClear();
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'r1', mergedOnto: 'm1' });
      const result = await scheduler.revert(created.id);
      expect(result.ok).toBe(true);
      const undo = result.ok ? result.task : (undefined as never);
      expect(undo).toMatchObject({
        name: 'Undo: Arregla el login',
        revertOf: { taskId: created.id, from: 'b5', to: 'm1' },
        mergePolicy: 'auto',
      });
      await scheduler.settled();
      expect(revertCommits).toHaveBeenCalledWith(
        '/wt/2',
        { from: 'b5', to: 'm1' },
        expect.any(String)
      );
      expect(launch).not.toHaveBeenCalled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'merge', acceptRisk: true });
      expect(scheduler.get(undo.id)?.state).toBe('merged');
      expect(scheduler.get(created.id)).toMatchObject({ revertedBy: undo.id });
      // Undone again: the same revert task.
      const again = await scheduler.revert(created.id);
      expect(again.ok && again.task.id).toBe(undo.id);
    });

    it('a double tap on «Deshacer» makes one revert task, not two (2026-11-11)', async () => {
      const revertCommits = vi.fn(async () => ({ ok: true as const, commits: 1 }));
      const scheduler = make({ revertCommits });
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b5' });
      await finish(scheduler, created);
      pipeline.mockResolvedValue({ state: 'merged', mergedSha: 'r1', mergedOnto: 'm1' });
      const [first, second] = await Promise.all([
        scheduler.revert(created.id),
        scheduler.revert(created.id),
      ]);
      expect(first.ok && second.ok).toBe(true);
      expect(first.ok && second.ok && second.task.id).toBe(first.ok && first.task.id);
      await scheduler.settled();
      expect(scheduler.list().filter((task) => task.revertOf?.taskId === created.id)).toHaveLength(
        1
      );
    });

    it('a revert that conflicts goes to an agent with the conflicting files', async () => {
      const revertCommits = vi.fn(async () => ({
        ok: false as const,
        conflict: true,
        message: 'conflicts',
        files: ['src/a.ts'],
      }));
      const scheduler = make({ revertCommits });
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b5' });
      await finish(scheduler, created);
      launch.mockClear();
      const result = await scheduler.revert(created.id);
      await scheduler.settled();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1]).toContain('- src/a.ts');
      // 2026-10-20: the exact change the merge made, reversed (merge commits included).
      expect(launch.mock.calls[0][1]).toContain(
        'git diff --binary --full-index b5 m1 | git apply --3way --index -R'
      );
      expect(launch.mock.calls[0][1]).toContain('`Undo: Arregla el login`');
      expect(result.ok && scheduler.get(result.task.id)?.state).toBe('working');
    });

    it('only a merged task with a recorded range can be undone', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      expect(await scheduler.revert(created.id)).toMatchObject({ ok: false, code: 'not-open' });
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1' });
      await finish(scheduler, created);
      expect(await scheduler.revert(created.id)).toMatchObject({ ok: false, code: 'not-fixable' });
    });

    it('two auto-merged tasks undone within a day pause the project', async () => {
      const scheduler = make({ revertCommits: async () => ({ ok: true, commits: 1 }) });
      await scheduler.start(0);
      for (let i = 0; i < 2; i++) {
        const created = await ready(scheduler);
        pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: `m${i}`, mergedOnto: 'b' });
        await finish(scheduler, created);
        pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: `r${i}` });
        await scheduler.revert(created.id);
        await scheduler.settled();
      }
      expect(settings.autoMergePausedReason).toContain('2 of its tasks that merged on their own');
      expect(notify.mock.calls.filter((call) => call[0].type === 'project-paused')).toHaveLength(1);
    });
  });

  it('a finished task follows its project folder too, with no worktree to repair (2026-11-10)', async () => {
    const repairWorktree = vi.fn(async () => {});
    const scheduler = make({ repairWorktree });
    await scheduler.start(0);
    const created = await ready(scheduler);
    pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b' });
    const merged = await finish(scheduler, created);
    expect(merged.state).toBe('merged');
    const from = merged.repoPath as string;
    await scheduler.projectsMoved([{ from, to: `${from}-renamed` }]);
    // "Deshacer" makes its worktree from this folder: the old one is gone.
    expect(scheduler.get(created.id)?.repoPath).toBe(`${from}-renamed`);
    expect(repairWorktree).not.toHaveBeenCalled();
  });

  it('open tasks follow a project folder that moved, and git is told', async () => {
    const repairWorktree = vi.fn(async () => {});
    const scheduler = make({ repairWorktree });
    await scheduler.start(0);
    worktrees.create.mockResolvedValueOnce({
      repoPath: path.join(dir, 'skylark'),
      baseBranch: 'main',
      baseSha: 'b0',
      branch: 'ut/x',
      worktreePath: dir,
      clonedDirs: [],
    });
    const created = await ready(scheduler, { workingDir: path.join(dir, 'skylark', 'web') });
    const moved = await scheduler.projectsMoved([
      { from: path.join(dir, 'skylark'), to: path.join(dir, 'inkwell') },
    ]);
    expect(moved).toBe(1);
    expect(scheduler.get(created.id)).toMatchObject({
      repoPath: path.join(dir, 'inkwell'),
      workingDir: path.join(dir, 'inkwell', 'web'),
      worktreePath: dir,
    });
    expect(repairWorktree).toHaveBeenCalledWith(path.join(dir, 'inkwell'), dir);
  });

  it('`ut task done` keeps how the agent verified it and how to undo it', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await ready(scheduler, { mergePolicy: 'ask' });
    pipeline.mockResolvedValueOnce({ state: 'ready' });
    await scheduler.markDone(created.sessionId as string, 'Cambié X', {
      verified: 'pnpm test: 12 passed',
      undo: 'git revert abc',
    });
    await scheduler.settled();
    expect(scheduler.get(created.id)).toMatchObject({
      summary: 'Cambié X',
      report: { verified: 'pnpm test: 12 passed', undo: 'git revert abc' },
    });
  });
});
