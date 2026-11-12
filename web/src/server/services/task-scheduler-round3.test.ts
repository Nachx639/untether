/**
 * Round 3 (2026-10-20): redraws never reopen a settled task, pushes dedupe on outcome, review
 * retries survive a verify and keep who asked, "fixing itself" clears on another blocker, the
 * circuit breaker's code/count and re-enable time, one budget of automatic fixes per task,
 * undelivered messages back off (menus told once, given up when the session is gone) and a
 * task with no session gets an agent in its worktree.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import type { TaskRecord, TaskReview } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { ClaudeStatus } from './claude-chat.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { PipelineResult } from './task-merge.js';
import {
  INPUT_GIVE_UP_MS,
  INPUT_RETRY_MAX_MS,
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
  withSendingTime,
} from './task-scheduler.js';

const T0 = new Date('2026-10-20T10:00:00Z').getTime();

const task = (overrides: Partial<NewTask> = {}): NewTask => ({
  name: 'Arregla el login',
  prompt: 'Arregla el login',
  workingDir: '/repo',
  command: ['claude'],
  agent: 'claude',
  shielded: false,
  notify: true,
  isolation: 'worktree',
  ...overrides,
});

const unavailable: TaskReview = {
  verdict: 'unavailable',
  summary: '',
  issues: [],
  reason: 'timeout',
  at: 'x',
  model: 'sonnet',
  headSha: 'h1',
};

const claude = (preview?: ClaudeStatus['preview'], waitingFor?: string): ClaudeStatus =>
  ({
    status: 'x',
    ...(preview ? { preview } : {}),
    ...(waitingFor ? { waitingFor } : {}),
  }) as ClaudeStatus;

describe('TaskScheduler round 3 (2026-10-20)', () => {
  let dir: string;
  let store: string;
  let notify: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let launch: ReturnType<typeof vi.fn>;
  let statuses: Map<string, string>;
  let settings: ProjectSettings;
  let worktrees: TaskWorktrees & {
    changes: ReturnType<typeof vi.fn>;
    hasUnmergedWork: ReturnType<typeof vi.fn>;
  };
  let schedulers: TaskScheduler[];
  let logs: string[];

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
      reviewRetryDelaysMs: [1000],
      now: () => Date.now(),
      onError: (message) => logs.push(message),
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-round3-'));
    store = path.join(dir, 'tasks.json');
    notify = vi.fn();
    deliver = vi.fn(async () => true);
    statuses = new Map();
    settings = { ...DEFAULT_PROJECT_SETTINGS };
    schedulers = [];
    logs = [];
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    pipeline = vi.fn(async (): Promise<PipelineResult> => ({ state: 'merged', mergedSha: 'm1' }));
    let w = 0;
    worktrees = {
      create: vi.fn(async () => {
        w++;
        const worktreePath = path.join(dir, `wt${w}`);
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          repoPath: '/repo',
          baseBranch: 'main',
          baseSha: 'b0',
          branch: `ut/t${w}`,
          worktreePath,
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

  const failedCheck = (headSha = 'h1'): PipelineResult => ({
    state: 'failed',
    headSha,
    blocker: { kind: 'verify', message: 'The check failed', detail: ['1 failed'] },
    verify: { command: 'pnpm test', cwd: '/wt', startedAt: 'x', exitCode: 1, tail: 'FAIL' },
  });

  it('a reopen that fails fails the task with its cause and tells it, not only a log line (2026-10-20)', async () => {
    const scheduler = make({
      resume: async () => {
        throw new Error('Folder not found: /wt/x');
      },
      claudeConversation: () => 'conv-1',
    });
    await scheduler.start(0);
    const created = await ready(scheduler, { mergePolicy: 'ask' });
    statuses.set(created.sessionId as string, 'exited');
    notify.mockClear();
    expect(await scheduler.send(created.id, 'sigue con el logout', 'cli')).toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.get(created.id)).toMatchObject({
      state: 'failed',
      blocker: { kind: 'setup', message: 'Its conversation could not be reopened' },
    });
    expect(notify).toHaveBeenCalled();
  });

  it('while a discard runs, a merge, a fix or a send is refused and no finish starts (2026-10-20)', async () => {
    let stopped: () => void = () => {};
    const scheduler = make({
      stopSession: () =>
        new Promise<void>((resolve) => {
          stopped = resolve;
        }),
    });
    await scheduler.start(0);
    const created = await ready(scheduler);
    const discarding = scheduler.discard(created.id, { confirm: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.merge(created.id)).toMatchObject({ ok: false, code: 'busy' });
    expect(await scheduler.send(created.id, 'x', 'cli')).toMatchObject({ ok: false, code: 'busy' });
    await scheduler.checkExited();
    stopped();
    expect(await discarding).toMatchObject({ ok: true, task: { state: 'discarded' } });
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('a first prompt the agent was never ready for waits to be typed, not dropped (2026-10-20)', async () => {
    let n = 0;
    launch.mockImplementation(async (_task: TaskRecord, prompt: string) => ({
      sessionId: `s${++n}`,
      typed: Promise.resolve(false),
      text: prompt,
    }));
    const scheduler = make();
    await scheduler.start(0);
    deliver.mockResolvedValue(false);
    const created = await ready(scheduler);
    await vi.advanceTimersByTimeAsync(0);
    const record = scheduler.get(created.id) as TaskRecord;
    expect(record.state).toBe('working');
    expect(record.pendingInput?.[0].text).toContain(created.name);
    expect(deliver).toHaveBeenCalledWith(
      record.sessionId,
      record.pendingInput?.[0].text,
      'claude',
      { trustFolder: true }
    );
    deliver.mockResolvedValue(true);
  });

  it('a task never finishes with a message still waiting to be typed; idle types it now (2026-10-20)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await ready(scheduler);
    const sid = created.sessionId as string;
    scheduler.onClaudeTransition(sid, 'idle', 'busy', claude());
    // Claude is busy: the follow-up waits.
    deliver.mockResolvedValueOnce(false);
    await scheduler.send(created.id, 'arregla también el test de X', 'cli');
    await scheduler.settled();
    expect(scheduler.get(created.id)?.pendingInput).toHaveLength(1);
    // The turn ends: it is tried at once (still not taken here), and while it waits the idle
    // hold never finishes the task on the old commit.
    deliver.mockClear();
    deliver.mockResolvedValue(false);
    scheduler.onClaudeTransition(sid, 'busy', 'idle', claude({ role: 'assistant', text: 'listo' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledWith(sid, 'arregla también el test de X', 'claude', {
      trustFolder: true,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scheduler.get(created.id)?.state).toBe('working');
    expect(scheduler.get(created.id)?.pendingInput).toHaveLength(1);
    expect(pipeline).not.toHaveBeenCalled();
    deliver.mockResolvedValue(true);
  });

  describe('a settled task and its terminal (M3)', () => {
    it('a redraw (busy then idle) neither reopens it nor runs the pipeline again', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValue({ state: 'ready', headSha: 'h1' });
      const sid = created.sessionId as string;
      scheduler.onClaudeTransition(
        sid,
        'busy',
        'idle',
        claude({ role: 'assistant', text: 'Hecho' })
      );
      const settled = await finish(scheduler, created);
      expect(settled.state).toBe('ready');
      expect(notify).toHaveBeenCalledTimes(1);
      const runs = pipeline.mock.calls.length;

      scheduler.onClaudeTransition(
        sid,
        'idle',
        'busy',
        claude({ role: 'assistant', text: 'Hecho' })
      );
      expect(scheduler.get(created.id)?.state).toBe('ready');
      scheduler.onClaudeTransition(
        sid,
        'busy',
        'idle',
        claude({ role: 'assistant', text: 'Hecho' })
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await scheduler.settled();
      expect(scheduler.get(created.id)?.state).toBe('ready');
      expect(pipeline.mock.calls.length).toBe(runs);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('the user typing in its session (the conversation moved on) reopens it', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValue({ state: 'ready', headSha: 'h1' });
      const sid = created.sessionId as string;
      scheduler.onClaudeTransition(
        sid,
        'busy',
        'idle',
        claude({ role: 'assistant', text: 'Hecho' })
      );
      await finish(scheduler, created);
      scheduler.onClaudeTransition(
        sid,
        'idle',
        'busy',
        claude({ role: 'user', text: 'y añade X' })
      );
      expect(scheduler.get(created.id)?.state).toBe('working');
    });

    it('a follow-up sent since it settled reopens it', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValue({ state: 'ready', headSha: 'h1' });
      await finish(scheduler, created);
      vi.advanceTimersByTime(1000);
      await scheduler.send(created.id, 'añade X', 'ui');
      scheduler.onClaudeTransition(created.sessionId as string, 'idle', 'busy', claude());
      expect(scheduler.get(created.id)?.state).toBe('working');
    });

    it('a follow-up sent since it settled still reopens it after a restart (2026-10-20)', async () => {
      const first = make();
      await first.start(0);
      const created = await ready(first, { mergePolicy: 'ask' });
      pipeline.mockResolvedValue({ state: 'ready', headSha: 'h1' });
      await finish(first, created);
      vi.advanceTimersByTime(1000);
      await first.send(created.id, 'quita el skip', 'cli');
      first.stop();

      // The server restarts before the agent picks it up: only the task file remembers it.
      const restarted = make();
      await restarted.start(0);
      restarted.onClaudeTransition(created.sessionId as string, undefined, 'busy', claude());
      expect(restarted.get(created.id)?.state).toBe('working');
    });

    it('new commits seen after a busy/idle spell reopen it and it finishes again', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValue({ state: 'ready', headSha: 'h1' });
      const sid = created.sessionId as string;
      await finish(scheduler, created);
      worktrees.changes.mockResolvedValue({
        files: ['src/a.ts'],
        stats: { commits: 2, files: 1, insertions: 2, deletions: 0 },
      });
      scheduler.onClaudeTransition(sid, 'idle', 'busy', claude());
      scheduler.onClaudeTransition(sid, 'busy', 'idle', claude());
      await scheduler.settled();
      expect(scheduler.get(created.id)?.state).toBe('working');
      await vi.advanceTimersByTimeAsync(16_000);
      await scheduler.settled();
      expect(pipeline).toHaveBeenCalledTimes(2);
    });

    it('the same outcome of the same commit is pushed once, however it is worded', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValueOnce({
        state: 'ready',
        headSha: 'h1',
        blocker: { kind: 'no-check', message: 'one wording' },
      });
      await finish(scheduler, created);
      pipeline.mockResolvedValueOnce({
        state: 'ready',
        headSha: 'h1',
        blocker: { kind: 'no-check', message: 'another wording' },
      });
      scheduler.verify(created.id);
      await scheduler.settled();
      expect(notify).toHaveBeenCalledTimes(1);
      pipeline.mockResolvedValueOnce({
        state: 'ready',
        headSha: 'h2',
        blocker: { kind: 'no-check', message: 'new commit' },
      });
      scheduler.verify(created.id);
      await scheduler.settled();
      expect(notify).toHaveBeenCalledTimes(2);
    });
  });

  describe('review retries (M5, L4)', () => {
    it('a verify run keeps retrying an unavailable review, in auto mode', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await finish(scheduler, created);
      pipeline.mockResolvedValueOnce({
        state: 'ready',
        review: unavailable,
        blocker: { kind: 'review-unavailable', message: 'no review' },
      });
      scheduler.verify(created.id);
      await scheduler.settled();
      const after = scheduler.get(created.id) as TaskRecord;
      expect(after.reviewRetryAt).toBeDefined();
      expect(after.reviewRetry).toMatchObject({ mode: 'auto', attempts: 0 });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await vi.advanceTimersByTimeAsync(1500);
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'auto' });
    });

    it("an orchestrator's merge stays byAgent across a review retry", async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await finish(scheduler, created);
      pipeline.mockResolvedValueOnce({
        state: 'ready',
        review: unavailable,
        blocker: { kind: 'review-unavailable', message: 'no review' },
      });
      scheduler.merge(created.id, { byAgent: true });
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'merge', byAgent: true });
      expect(scheduler.get(created.id)?.reviewRetry).toMatchObject({
        mode: 'merge',
        byAgent: true,
      });
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b0' });
      await vi.advanceTimersByTimeAsync(1500);
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'merge', byAgent: true });
      expect(scheduler.get(created.id)).toMatchObject({ state: 'merged', autoMerged: true });
    });
  });

  describe("errors of Untether's own (2026-10-23)", () => {
    const internal = (error = 'os is not defined'): PipelineResult => ({
      state: 'needs_you',
      blocker: {
        kind: 'merge-error',
        internal: true,
        message: 'Merging stopped on an error of Untether',
        detail: [error],
      },
    });

    const askReady = async (scheduler: TaskScheduler) => {
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      return await finish(scheduler, created);
    };

    it('runs the pipeline again by itself, the same way, and merges without asking', async () => {
      const scheduler = make({ internalRetryDelaysMs: [1000, 5000] });
      const created = await askReady(scheduler);
      notify.mockClear();
      pipeline.mockResolvedValueOnce(internal());
      scheduler.merge(created.id, { acceptRisk: true, acceptReview: true, byAgent: true });
      await scheduler.settled();
      const waiting = scheduler.get(created.id) as TaskRecord;
      expect(waiting.state).toBe('verifying');
      expect(waiting.internalRetryAt).toBeDefined();
      expect(waiting.blocker).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      expect(logs.some((line) => line.includes("error of Untether's own"))).toBe(true);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b0' });
      await vi.advanceTimersByTimeAsync(1500);
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({
        mode: 'merge',
        acceptRisk: true,
        acceptReview: true,
        byAgent: true,
      });
      const after = scheduler.get(created.id) as TaskRecord;
      expect(after).toMatchObject({ state: 'merged', autoMerged: true });
      expect(after.internalRetry).toBeUndefined();
      expect(after.internalRetryAt).toBeUndefined();
    });

    it('still failing after a retry at 1 and at 5: needs_you, saying it is Untether', async () => {
      const scheduler = make({ internalRetryDelaysMs: [1000, 5000] });
      const created = await askReady(scheduler);
      const calls = pipeline.mock.calls.length;
      notify.mockClear();
      pipeline.mockResolvedValueOnce(internal());
      // The scheduler's own catch counts the same.
      pipeline.mockRejectedValueOnce(new TypeError('x is not a function'));
      pipeline.mockResolvedValueOnce(internal());
      scheduler.merge(created.id);
      await scheduler.settled();
      await vi.advanceTimersByTimeAsync(1500);
      await scheduler.settled();
      expect(pipeline.mock.calls.length).toBe(calls + 2);
      expect(scheduler.get(created.id)?.state).toBe('verifying');
      expect(notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4000);
      await scheduler.settled();
      expect(pipeline.mock.calls.length).toBe(calls + 2);
      await vi.advanceTimersByTimeAsync(1500);
      await scheduler.settled();
      expect(pipeline.mock.calls.length).toBe(calls + 3);
      const after = scheduler.get(created.id) as TaskRecord;
      expect(after).toMatchObject({
        state: 'needs_you',
        blocker: { kind: 'merge-error', internal: true },
      });
      expect(after.blocker?.message).toContain('inside Untether (not in the task)');
      expect(after.blocker?.message).toContain('os is not defined');
      expect(after.autoFix).toBeUndefined();
      expect(notify).toHaveBeenCalledTimes(1);
      expect((await scheduler.fix(created.id)).ok).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pipeline.mock.calls.length).toBe(calls + 3);
    });

    it("a git merge-error is the user's at once, as before", async () => {
      const scheduler = make({ internalRetryDelaysMs: [1000, 5000] });
      const created = await askReady(scheduler);
      const calls = pipeline.mock.calls.length;
      pipeline.mockResolvedValueOnce({
        state: 'needs_you',
        blocker: { kind: 'merge-error', message: 'Could not move main' },
      });
      scheduler.merge(created.id);
      await scheduler.settled();
      expect(scheduler.get(created.id)).toMatchObject({
        state: 'needs_you',
        blocker: { kind: 'merge-error', message: 'Could not move main' },
      });
      expect(scheduler.get(created.id)?.internalRetryAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pipeline.mock.calls.length).toBe(calls + 1);
    });
  });

  describe('automatic fixes (C1, L7)', () => {
    it('"fixing itself" is cleared when the task moves to a permission prompt', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce(failedCheck());
      const fixing = await finish(scheduler, created);
      expect(fixing.autoFix).toBeDefined();
      scheduler.onClaudeTransition(
        fixing.sessionId as string,
        'busy',
        'waiting',
        claude(undefined, 'Bash permission')
      );
      const now = scheduler.get(created.id) as TaskRecord;
      expect(now).toMatchObject({ state: 'needs_you', blocker: { kind: 'permission' } });
      expect(now.autoFix).toBeUndefined();
    });

    it('at most 3 automatic rounds per task across reasons, then the user hears once', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      const conflict: PipelineResult = {
        state: 'needs_you',
        headSha: 'h9',
        blocker: { kind: 'conflict', message: 'Conflicts with main in 1 file', detail: ['a'] },
      };
      // The first time a conflict shows up it is new (the base moved on), not a failed fix:
      // only the same conflict again takes one of the 3 rounds (2026-11-01).
      pipeline
        .mockResolvedValueOnce(failedCheck('h1'))
        .mockResolvedValueOnce(conflict)
        .mockResolvedValueOnce(conflict)
        .mockResolvedValueOnce(failedCheck('h2'))
        .mockResolvedValueOnce(conflict);
      for (let i = 0; i < 4; i++) await finish(scheduler, created);
      expect(scheduler.get(created.id)?.autoFixes).toEqual({ verify: 2, conflict: 1 });
      expect(deliver).toHaveBeenCalledTimes(4);
      expect(deliver.mock.calls.at(-1)?.[1]).toContain('Step back and rethink');
      const end = await finish(scheduler, created);
      expect(deliver).toHaveBeenCalledTimes(4);
      expect(end).toMatchObject({ state: 'needs_you', blocker: { kind: 'conflict' } });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0].body).toContain(
        'Untether had its agent fix it 3 times and it still does not merge'
      );
    });
  });

  describe('circuit breaker (C2, L7)', () => {
    const revertTwo = async (scheduler: TaskScheduler) => {
      for (let i = 0; i < 2; i++) {
        const created = await ready(scheduler);
        pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: `m${i}`, mergedOnto: 'b' });
        await finish(scheduler, created);
        pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: `r${i}` });
        await scheduler.revert(created.id);
        await scheduler.settled();
      }
    };

    it('pauses with a code and a count, also in the push', async () => {
      const scheduler = make({ revertCommits: async () => ({ ok: true, commits: 1 }) });
      await scheduler.start(0);
      await revertTwo(scheduler);
      expect(settings).toMatchObject({ autoMergePausedCode: 'reverts', autoMergePausedCount: 2 });
      const push = notify.mock.calls.find((call) => call[0].type === 'project-paused')?.[0];
      expect(push.data).toMatchObject({ code: 'reverts', count: 2 });
    });

    it('does not count a task whose fixes ran out but that merged in the end (2026-11-02)', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const gaveUp = async (mergedAfter: boolean) => {
        const created = await ready(scheduler);
        pipeline
          .mockResolvedValueOnce(failedCheck('h1'))
          .mockResolvedValueOnce(failedCheck('h2'))
          .mockResolvedValueOnce(failedCheck('h3'));
        for (let i = 0; i < 3; i++) await finish(scheduler, created);
        expect(scheduler.get(created.id)?.autoFixGaveUpAt).toBeDefined();
        if (mergedAfter) {
          pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm', mergedOnto: 'b' });
          await finish(scheduler, created);
          expect(scheduler.get(created.id)?.state).toBe('merged');
        }
      };
      await gaveUp(true);
      await gaveUp(true);
      await gaveUp(false);
      // Two of three merged: one failure, no pause.
      expect(settings.autoMergePausedCode).toBeUndefined();
    });

    it('ends a failures pause on its own once those tasks merged (2026-11-02)', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const ids: string[] = [];
      for (let n = 0; n < 3; n++) {
        const created = await ready(scheduler);
        ids.push(created.id);
        pipeline
          .mockResolvedValueOnce(failedCheck('h1'))
          .mockResolvedValueOnce(failedCheck('h2'))
          .mockResolvedValueOnce(failedCheck('h3'));
        for (let i = 0; i < 3; i++) await finish(scheduler, created);
      }
      expect(settings.autoMergePausedCode).toBe('failures');
      // Two of them merge (the user or an orchestrator merged them by hand).
      for (const id of ids.slice(0, 2)) {
        pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm', mergedOnto: 'b' });
        await finish(scheduler, scheduler.get(id) as TaskRecord);
      }
      // The next run sees one failure left: the pause has no cause and ends.
      expect(settings.autoMergePausedCode ?? undefined).toBeUndefined();
      expect(settings.autoMergePausedUntil ?? undefined).toBeUndefined();
    });

    it('ignores what happened before the user turned auto-merge back on', async () => {
      const scheduler = make({ revertCommits: async () => ({ ok: true, commits: 1 }) });
      await scheduler.start(0);
      await revertTwo(scheduler);
      // The user turns it back on (task-commands sets autoMergeResumedAt).
      vi.advanceTimersByTime(60_000);
      for (const key of [
        'autoMergePausedUntil',
        'autoMergePausedReason',
        'autoMergePausedCode',
        'autoMergePausedCount',
      ]) {
        delete (settings as unknown as Record<string, unknown>)[key];
      }
      settings.autoMergeResumedAt = new Date(Date.now()).toISOString();
      vi.advanceTimersByTime(1000);
      const created = await ready(scheduler);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm9', mergedOnto: 'b' });
      await finish(scheduler, created);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'r9' });
      await scheduler.revert(created.id);
      await scheduler.settled();
      expect(settings.autoMergePausedUntil).toBeUndefined();
    });
  });

  describe('messages that cannot be typed (L3, L8)', () => {
    it('back off up to 5 minutes and log once per reason', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask' });
      deliver.mockResolvedValue(false);
      await scheduler.send(created.id, 'hola', 'ui');
      await scheduler.settled();
      const tries = () => deliver.mock.calls.length;
      expect(tries()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(tries()).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(tries()).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(tries()).toBe(3);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      // 1, 2, 4, … s, then every 5 min at most.
      expect(tries()).toBeLessThan(25);
      expect(tries()).toBeGreaterThan(10);
      expect(INPUT_RETRY_MAX_MS).toBe(5 * 60_000);
      expect(logs.filter((line) => line.includes('was not typed yet'))).toHaveLength(1);
      // Its agent never back at its prompt: the user is told once, after 15 min (2026-10-20).
      const told = notify.mock.calls.filter(([payload]) =>
        String((payload as { body?: string }).body).includes('Claude has not been ready to take it')
      );
      expect(told).toHaveLength(1);
    });

    it('behind a menu of Claude its own, the user is told once that a choice on screen is needed', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      const sid = created.sessionId as string;
      scheduler.onClaudeTransition(sid, 'busy', 'waiting', claude(undefined, '¿A o B?'));
      deliver.mockResolvedValue(false);
      await scheduler.send(created.id, 'A', 'ui');
      await scheduler.settled();
      await vi.advanceTimersByTimeAsync(10_000);
      const menus = notify.mock.calls.filter((call) =>
        String(call[0].body).includes('waiting for a choice')
      );
      expect(menus).toHaveLength(1);
      expect(scheduler.get(created.id)?.blocker).toMatchObject({
        kind: 'question',
        onScreen: true,
      });
      // Off the menu: typed at once.
      deliver.mockResolvedValue(true);
      const before = deliver.mock.calls.length;
      scheduler.onClaudeTransition(sid, 'waiting', 'idle', claude());
      await scheduler.settled();
      expect(deliver.mock.calls.length).toBe(before + 1);
      expect(scheduler.get(created.id)?.pendingInput).toBeUndefined();
    });

    it('a follow-up to a working Claude is typed at once, as sent (2026-10-23)', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      const sid = created.sessionId as string;
      scheduler.onClaudeTransition(sid, 'idle', 'busy', claude());
      deliver.mockClear();
      deliver.mockResolvedValue(true);
      await scheduler.send(created.id, 'el dato: usa 48 kHz', 'cli');
      await scheduler.settled();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledWith(sid, 'el dato: usa 48 kHz', 'claude', {
        trustFolder: true,
      });
      expect(scheduler.get(created.id)).toMatchObject({ state: 'working' });
      expect(scheduler.get(created.id)?.pendingInput).toBeUndefined();
      expect(scheduler.get(created.id)?.pendingWhy).toBeUndefined();
    });

    it('a message held behind a menu says so, and typed 30 min late carries its sending time (2026-10-23)', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler);
      const sid = created.sessionId as string;
      scheduler.onClaudeTransition(sid, 'busy', 'waiting', claude(undefined, '¿A o B?'));
      deliver.mockClear();
      deliver.mockResolvedValue(false);
      const sentAt = Date.now();
      await scheduler.send(created.id, 'A', 'ui');
      await scheduler.settled();
      // Held: Untether never types into a menu of Claude's own.
      expect(scheduler.get(created.id)).toMatchObject({
        pendingInput: [{ text: 'A' }],
        pendingWhy: 'menu',
      });
      expect(deliver.mock.calls.every((call) => call[1] === 'A')).toBe(true);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      deliver.mockClear();
      deliver.mockResolvedValue(true);
      scheduler.onClaudeTransition(sid, 'waiting', 'idle', claude());
      await scheduler.settled();
      const typed = deliver.mock.calls.at(-1)?.[1] as string;
      expect(typed).toBe(
        withSendingTime({ text: 'A', at: new Date(sentAt).toISOString() }, Date.now())
      );
      expect(typed).toMatch(/^\(sent at \d{2}:\d{2}, 30 min ago\) A$/);
      expect(scheduler.get(created.id)?.pendingInput).toBeUndefined();
      expect(scheduler.get(created.id)?.pendingWhy).toBeUndefined();
    });

    it('withSendingTime: as sent up to 2 min, then with its time (and its day once it is not today)', () => {
      const at = '2026-10-20T10:00:00.000Z';
      const sent = new Date(at);
      const clock = `${String(sent.getHours()).padStart(2, '0')}:${String(sent.getMinutes()).padStart(2, '0')}`;
      expect(withSendingTime({ text: 'hola', at }, T0 + 2 * 60_000)).toBe('hola');
      expect(withSendingTime({ text: 'hola', at }, T0 + 2 * 60_000 + 1)).toBe(
        `(sent at ${clock}, 2 min ago) hola`
      );
      expect(withSendingTime({ text: 'hola', at }, T0 + 3 * 60 * 60_000)).toMatch(
        new RegExp(`^\\(sent (on 2026-10-\\d{2} )?at ${clock}, 3 h ago\\) hola$`)
      );
      expect(withSendingTime({ text: 'hola', at }, T0 + 3 * 24 * 60 * 60_000)).toMatch(
        new RegExp(`^\\(sent on 2026-10-\\d{2} at ${clock}, 3 days ago\\) hola$`)
      );
      expect(withSendingTime({ text: 'hola', at: 'x' }, T0)).toBe('hola');
    });

    it('with its session gone and nothing to reopen, it is given up after an hour, once', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await ready(scheduler, { mergePolicy: 'ask', agent: 'codex' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await finish(scheduler, created);
      deliver.mockResolvedValue(false);
      await scheduler.send(created.id, 'hola', 'ui');
      statuses.set(created.sessionId as string, 'exited');
      notify.mockClear();
      await vi.advanceTimersByTimeAsync(INPUT_GIVE_UP_MS + 10 * 60_000);
      await scheduler.settled();
      expect(scheduler.get(created.id)?.pendingInput).toBeUndefined();
      const dropped = notify.mock.calls.filter((call) =>
        String(call[0].body).includes('could not be typed')
      );
      expect(dropped).toHaveLength(1);
    });
  });

  describe('clocks and notices across a server restart (2026-11-02)', () => {
    /** The server goes (its timers with it) and a new one starts on the same tasks.json. */
    const restart = async (old: TaskScheduler, extra: Partial<TaskSchedulerDeps> = {}) => {
      old.stop();
      const next = make(extra);
      await next.start(0);
      return next;
    };
    const told = (text: string) =>
      notify.mock.calls.filter(([payload]) =>
        String((payload as { body?: string }).body).includes(text)
      ).length;

    it('a message not typed for 15 min is told once, the clock kept across a restart', async () => {
      const first = make();
      await first.start(0);
      const created = await ready(first, { mergePolicy: 'ask' });
      deliver.mockResolvedValue(false);
      await first.send(created.id, 'hola', 'ui');
      await first.settled();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(first.get(created.id)?.pendingSince).toBeDefined();
      const second = await restart(first);
      // Retries back off again from 1 s (up to 5 min): told at the first one past 15 min of
      // waiting, well before 15 min after the restart (25 min) as it was.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(told('Claude has not been ready to take it')).toBe(1);
      const third = await restart(second);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(told('Claude has not been ready to take it')).toBe(1);
      // Typed at last: its clock and notice go with it.
      deliver.mockResolvedValue(true);
      third.onClaudeTransition(created.sessionId as string, 'busy', 'idle', claude());
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await third.settled();
      const after = third.get(created.id) as TaskRecord;
      expect(after.pendingInput).toBeUndefined();
      expect(after.pendingSince).toBeUndefined();
      expect(after.pendingNoticed).toBeUndefined();
    });

    it('a session gone: given up an hour after it stalled, restarts or not', async () => {
      const first = make();
      await first.start(0);
      const created = await ready(first, { mergePolicy: 'ask', agent: 'codex' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await finish(first, created);
      deliver.mockResolvedValue(false);
      await first.send(created.id, 'hola', 'ui');
      statuses.set(created.sessionId as string, 'exited');
      await vi.advanceTimersByTimeAsync(40 * 60_000);
      const second = await restart(first);
      await vi.advanceTimersByTimeAsync(INPUT_GIVE_UP_MS - 40 * 60_000 + 10 * 60_000);
      await second.settled();
      expect(second.get(created.id)?.pendingInput).toBeUndefined();
      expect(told('could not be typed')).toBe(1);
    });

    it("an agent's choice on screen is told once per session, not again after a restart", async () => {
      const first = make();
      await first.start(0);
      const created = await ready(first, { agent: 'codex' });
      const sid = created.sessionId as string;
      first.agentChoiceOnScreen(sid);
      first.agentChoiceOnScreen(sid);
      expect(told('waiting for a choice on its screen')).toBe(1);
      const second = await restart(first);
      second.agentChoiceOnScreen(sid);
      expect(told('waiting for a choice on its screen')).toBe(1);
    });

    it('an internal retry waits out its backoff after a restart instead of running at once', async () => {
      const internal: PipelineResult = {
        state: 'needs_you',
        blocker: { kind: 'merge-error', internal: true, message: 'x', detail: ['boom'] },
      };
      const first = make({ internalRetryDelaysMs: [60_000, 300_000] });
      await first.start(0);
      const created = await ready(first, { mergePolicy: 'ask' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await finish(first, created);
      pipeline.mockResolvedValueOnce(internal);
      first.merge(created.id);
      await first.settled();
      expect(first.get(created.id)?.internalRetryAt).toBeDefined();
      const calls = pipeline.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      const second = await restart(first, { internalRetryDelaysMs: [60_000, 300_000] });
      await second.settled();
      expect(pipeline.mock.calls.length).toBe(calls);
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b0' });
      await vi.advanceTimersByTimeAsync(39_000);
      expect(pipeline.mock.calls.length).toBe(calls);
      await vi.advanceTimersByTimeAsync(2_000);
      await second.settled();
      expect(pipeline.mock.calls.length).toBe(calls + 1);
      expect(second.get(created.id)?.state).toBe('merged');
    });

    it('a failed setup is still retried by itself when a restart came before its retry', async () => {
      worktrees.create = vi
        .fn()
        .mockRejectedValueOnce(new Error('index.lock exists'))
        .mockImplementation(async () => {
          const worktreePath = path.join(dir, 'wt-retry');
          fs.mkdirSync(worktreePath, { recursive: true });
          return {
            repoPath: '/repo',
            baseBranch: 'main',
            baseSha: 'b0',
            branch: 'ut/retry',
            worktreePath,
            clonedDirs: [],
          };
        });
      const first = make({ setupRetryMs: 30_000 });
      await first.start(0);
      const created = await first.create(task());
      await first.settled();
      const failed = first.get(created.id) as TaskRecord;
      expect(failed).toMatchObject({ state: 'failed', blocker: { kind: 'setup' } });
      expect(failed.setupRetryAt).toBeDefined();
      await vi.advanceTimersByTimeAsync(10_000);
      const second = await restart(first, { setupRetryMs: 30_000 });
      await vi.advanceTimersByTimeAsync(19_000);
      expect(worktrees.create).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await second.settled();
      expect(worktrees.create).toHaveBeenCalledTimes(2);
      const after = second.get(created.id) as TaskRecord;
      expect(after.state).toBe('working');
      expect(after.setupRetryAt).toBeUndefined();
    });

    it('"the check waits for disk" is told once per episode, across reruns and restarts', async () => {
      const verify = { command: 'pnpm test', cwd: '/wt', startedAt: 'x', headSha: 'h1' };
      const low = { path: '/Users/n', freeBytes: 1024 ** 3 };
      const waitsForDisk = async (
        _task: unknown,
        options: Parameters<NonNullable<TaskSchedulerDeps['pipeline']>>[1]
      ): Promise<PipelineResult> => {
        options.onProgress?.({ state: 'verifying', verify: { ...verify, queued: true } });
        options.onProgress?.({
          state: 'verifying',
          verify: { ...verify, queued: true, waitingDisk: low },
        });
        return {
          state: 'needs_you',
          blocker: { kind: 'merge-error', internal: true, message: 'x', detail: ['stopped'] },
          verify: { ...verify, queued: true, waitingDisk: low },
        };
      };
      const first = make({ internalRetryDelaysMs: [1000, 5000] });
      await first.start(0);
      const created = await ready(first, { mergePolicy: 'ask' });
      pipeline.mockImplementation(waitsForDisk);
      notify.mockClear();
      await finish(first, created);
      expect(told('waits for disk space')).toBe(1);
      const second = await restart(first, { internalRetryDelaysMs: [1000, 5000] });
      await vi.advanceTimersByTimeAsync(1500);
      await second.settled();
      expect(pipeline.mock.calls.length).toBeGreaterThan(1);
      expect(told('waits for disk space')).toBe(1);
      // A check that runs with room ends the episode: the next wait is told.
      pipeline.mockImplementation(async (_task, options) => {
        options.onProgress?.({ state: 'verifying', verify: { ...verify } });
        options.onProgress?.({
          state: 'verifying',
          verify: { ...verify, queued: true, waitingDisk: low },
        });
        return { state: 'ready' };
      });
      await vi.advanceTimersByTimeAsync(6000);
      await second.settled();
      expect(told('waits for disk space')).toBe(2);
    });
  });

  it('a task with no session gets an agent in its worktree (M7)', async () => {
    const scheduler = make({ revertCommits: async () => ({ ok: true, commits: 1 }) });
    await scheduler.start(0);
    const created = await ready(scheduler);
    pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', mergedOnto: 'b0' });
    await finish(scheduler, created);
    launch.mockClear();
    // The undo (git alone, no session) fails its check: its automatic fix needs an agent.
    pipeline.mockResolvedValueOnce(failedCheck());
    const undo = await scheduler.revert(created.id);
    await scheduler.settled();
    const id = undo.ok ? undo.task.id : '';
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][1]).toContain('You take over the task "Undo: Arregla el login"');
    expect(launch.mock.calls[0][1]).toContain('Automatic fix 1 of 2');
    expect(scheduler.get(id)).toMatchObject({ state: 'working', sessionId: 's2' });
  });

  it('retry of a failed task with work and no conversation starts an agent in its worktree (M7)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await ready(scheduler, { mergePolicy: 'ask', agent: 'codex' });
    pipeline.mockResolvedValueOnce(failedCheck());
    await finish(scheduler, created);
    statuses.set(created.sessionId as string, 'exited');
    worktrees.hasUnmergedWork.mockResolvedValue(true);
    launch.mockClear();
    const retried = await scheduler.retry(created.id);
    expect(retried.ok).toBe(true);
    await scheduler.settled();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][1]).toContain("The project's check failed");
    expect(scheduler.get(created.id)).toMatchObject({ state: 'working', sessionId: 's2' });
  });
  it('a check failed on a low disk: the orchestrator and the phone hear the cause once, and no fix goes to the agent (2026-11-01)', async () => {
    const verify = { command: 'pnpm test', cwd: '/wt', startedAt: 'x', headSha: 'h1' };
    pipeline.mockImplementation(async (_task, options): Promise<PipelineResult> => {
      const low = { path: '/Users/n', freeBytes: 1024 ** 3 };
      options.onProgress?.({
        state: 'verifying',
        verify: { ...verify, queued: true, waitingDisk: low },
      });
      options.onProgress?.({
        state: 'verifying',
        verify: { ...verify, queued: true, waitingDisk: low, diskLow: low },
      });
      options.onProgress?.({ state: 'verifying', verify: { ...verify, diskLow: low } });
      return {
        state: 'needs_you',
        headSha: 'h1',
        blocker: {
          kind: 'merge-error',
          internal: true,
          message:
            "The check failed while the disk was low (1.0 GB free on /Users/n): not the task's",
        },
        verify: { ...verify, exitCode: 1, diskLow: { ...low, again: true } },
      };
    });
    const scheduler = make();
    await scheduler.start(0);
    const created = await ready(scheduler);
    notify.mockClear();
    deliver.mockClear();
    await finish(scheduler, created);
    const told = notify.mock.calls
      .map(([payload]) => payload as NotificationPayload)
      .filter((payload) => payload.type === 'task-paused');
    expect(told.map((payload) => payload.body)).toEqual([
      'The check waits for disk space (1.0 GB free on /Users/n): it starts by itself once there is room; free disk space to speed it up.',
      "The check failed while the disk was low (1.0 GB free on /Users/n): not the task's fault. It runs again by itself once there is room; free disk space to speed it up.",
    ]);
    const after = scheduler.get(created.id) as TaskRecord;
    // Untether's own stop, run again by itself: not a fix round of the agent.
    expect(after.autoFixes).toBeUndefined();
    expect(after.autoFix).toBeUndefined();
    expect(after.internalRetryAt).toBeDefined();
    expect(deliver).not.toHaveBeenCalled();
  });
});
