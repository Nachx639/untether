import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS } from '../../shared/projects.js';
import type { TaskResult } from '../../shared/task-result.js';
import {
  TASK_BASE_WAIT_MAX_MS,
  TASK_BASE_WAIT_NOTIFY_MS,
  TASK_LATE_GRACE_MS,
  TASK_SUMMARY_MAX,
  TASK_UNDO_MAX,
  type TaskRecord,
} from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { ClaudeStatus } from './claude-chat.js';
import { ClaudeStatusNotifier } from './claude-status-notifier.js';
import { createMergeQueue, mergeQueueKey } from './merge-queue.js';
import { mergeTrainsFor } from './merge-train.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { PipelineOptions, PipelineResult, PipelineTask } from './task-merge.js';
import {
  BASE_WAIT_POLL_MS,
  CODEX_IDLE_MS,
  FINISHED_SESSION_GRACE_MS,
  IDLE_HOLD_MS,
  type NewTask,
  RESTART_WINDOW_MS,
  STALE_REMIND_MS,
  TASK_RETRY_TEXT,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const T0 = new Date('2026-10-03T12:00:00Z').getTime();

function task(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Arregla los tests',
    prompt: 'Revisa los tests de {folder} y arregla los que fallen',
    workingDir: '/Users/me/Projects/app',
    command: ['claude', '--model', 'opus'],
    agent: 'claude',
    shielded: true,
    notify: true,
    ...overrides,
  };
}

describe('TaskScheduler', () => {
  let dir: string;
  let store: string;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let statuses: Map<string, string>;
  let schedulers: TaskScheduler[];

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: (id) => statuses.get(id),
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-tasks-'));
    store = path.join(dir, 'tasks.json');
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    notify = vi.fn();
    statuses = new Map();
    schedulers = [];
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('runs a task for now at once, with the filled prompt, shielded and its command', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    expect(created.state).toBe('working');
    expect(created.sessionId).toBe('s1');
    const [record, prompt] = launch.mock.calls[0];
    expect(prompt).toBe('Revisa los tests de app y arregla los que fallen');
    expect(record).toMatchObject({ shielded: true, command: ['claude', '--model', 'opus'] });
  });

  it('records its states in the event log, with why, never its prompt or name', async () => {
    const events: Array<Record<string, unknown>> = [];
    const scheduler = make({ recordEvent: (event) => events.push({ ...event }) });
    await scheduler.start(0);
    const created = await scheduler.create(task());
    expect(events.map((event) => [event.type, event.from, event.state])).toEqual([
      ['task.state', undefined, 'scheduled'],
      ['task.state', 'scheduled', 'working'],
    ]);
    // A plain task is working from before its session starts: the next events carry it.
    expect(events[1]).toMatchObject({
      taskId: created.id,
      dir: '/Users/me/Projects/app',
      agent: 'claude',
    });

    const text = JSON.stringify(events);
    expect(text).not.toContain('Revisa los tests');
    expect(text).not.toContain('Arregla los tests');
    scheduler.ask('s1', 'Which port should it use?');
    expect(events.at(-1)).toMatchObject({
      state: 'needs_you',
      from: 'working',
      reason: 'question',
      message: 'Which port should it use?',
    });
  });

  it('fires a scheduled task at its time, not before', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task({ runAt: new Date(T0 + 60_000) }));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(scheduler.list()[0].state).toBe('working');
  });

  it('persists scheduled tasks and re-arms them after a restart', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).tasks).toHaveLength(1);

    const second = make();
    await second.start(0);
    expect(second.list()[0].state).toBe('scheduled');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('runs on start a task less than 6 h late', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    vi.setSystemTime(T0 + 60_000 + 5 * 3600_000);
    const second = make();
    await second.start(0);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks a task more than 6 h late as missed and says so', async () => {
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    vi.setSystemTime(T0 + 60_000 + TASK_LATE_GRACE_MS + 1);
    const second = make();
    await second.start(0);
    expect(launch).not.toHaveBeenCalled();
    expect(second.list()[0].state).toBe('missed');
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task-missed', title: expect.stringContaining('Arregla') })
    );
  });

  it('cancels a scheduled task', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task({ runAt: new Date(T0 + 60_000) }));
    expect(scheduler.remove(created.id)).toBe('removed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(launch).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).tasks).toHaveLength(0);
  });

  it('edits the time of a scheduled task', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task({ runAt: new Date(T0 + 60_000) }));
    scheduler.update(created.id, { runAt: new Date(T0 + 600_000) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(480_000);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  const busy: ClaudeStatus = { status: 'busy' };
  const idle = (text = ''): ClaudeStatus => ({
    status: 'idle',
    ...(text ? { preview: { role: 'assistant' as const, text } } : {}),
  });

  it("a prompt of Claude's answered during a restart puts the task back to work (2026-10-20 review)", async () => {
    const first = make();
    await first.start(0);
    const created = await first.create(task());
    first.onClaudeTransition('s1', undefined, 'busy', busy);
    first.onClaudeTransition('s1', 'busy', 'waiting', {
      status: 'waiting',
      waitingFor: 'permission to run Bash',
    });
    expect(first.get(created.id)).toMatchObject({
      state: 'needs_you',
      blocker: { kind: 'permission', fromPrompt: true },
    });
    first.stop();
    // Answered on the Mac while the server restarted: the first look sees it at work.
    const restarted = make();
    await restarted.start(0);
    restarted.onClaudeTransition('s1', undefined, 'busy', busy);
    expect(restarted.get(created.id)?.state).toBe('working');
  });

  it('a young task whose agent finished during a restart is not left working forever (2026-10-20)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    statuses.set('s1', 'running');
    // First look after the restart: already idle, with its reply; too young for "ran a while".
    scheduler.onClaudeTransition('s1', undefined, 'idle', idle('Hecho: 3 tests nuevos'));
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS * 2);
    expect(scheduler.get(created.id)?.state).toBe('working');
    // Nothing else changes; the exit check sees it idle once it ran a while.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await scheduler.checkExited();
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS + 1000);
    expect(scheduler.get(created.id)?.state).toBe('ready');
  });

  it('finishes a task once Claude stays idle after working, with one "Task ready"', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    scheduler.onClaudeTransition('s1', undefined, 'idle', idle());
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS * 2);
    // Idle before its prompt was typed is not done.
    expect(scheduler.get(created.id)?.state).toBe('working');
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle('All 12 tests pass'));
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS - 1000);
    expect(scheduler.get(created.id)?.state).toBe('working');
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler.get(created.id)?.state).toBe('ready');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      type: 'task-ready',
      title: '✅ Task ready: Arregla los tests',
      body: 'All 12 tests pass',
      data: expect.objectContaining({ sessionId: 's1' }),
    });
    // A session that ends afterwards doesn't send it a second time.
    statuses.set('s1', 'exited');
    await scheduler.checkExited();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a quick new turn inside the hold keeps the task working', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle());
    await vi.advanceTimersByTimeAsync(5000);
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS * 2);
    expect(scheduler.get(created.id)?.state).toBe('working');
  });

  it('a waiting Claude makes the task need the user, and work again once answered', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'waiting', {
      status: 'waiting',
      waitingFor: 'Claude needs your permission to use Bash',
    });
    expect(scheduler.get(created.id)).toMatchObject({
      state: 'needs_you',
      blocker: { kind: 'permission', message: 'Claude needs your permission to use Bash' },
    });
    scheduler.onClaudeTransition('s1', 'waiting', 'busy', busy);
    const back = scheduler.get(created.id);
    expect(back?.state).toBe('working');
    expect(back?.blocker).toBeUndefined();
  });

  it('drops the plain "Claude finished" of an open task session, not of others', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task());
    const finished = (sessionId: string): NotificationPayload => ({
      type: 'claude-finished',
      title: 'x',
      body: 'y',
      data: { sessionId },
    });
    expect(scheduler.rewritePush(finished('s1'))).toBeNull();
    const other = finished('other');
    expect(scheduler.rewritePush(other)).toBe(other);
    const waiting = { ...finished('s1'), type: 'claude-waiting' };
    expect(scheduler.rewritePush(waiting)).toBe(waiting);
    // A Codex task's session too (2026-11-10): one push, the task's own.
    expect(scheduler.rewritePush({ ...finished('s1'), type: 'codex-finished' })).toBeNull();
    const codexElsewhere = { ...finished('other'), type: 'codex-finished' };
    expect(scheduler.rewritePush(codexElsewhere)).toBe(codexElsewhere);
    const codexWaiting = { ...finished('s1'), type: 'codex-waiting' };
    expect(scheduler.rewritePush(codexWaiting)).toBe(codexWaiting);
  });

  it('reports a task whose session ended before Claude finished, once, as cut off (2026-10-20)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    await scheduler.create(task());
    statuses.set('s1', 'running');
    await scheduler.checkExited();
    expect(notify).not.toHaveBeenCalled();
    statuses.set('s1', 'exited');
    await scheduler.checkExited();
    await scheduler.checkExited();
    expect(notify).toHaveBeenCalledTimes(1);
    // Never "ready": its agent may have been half way (a restart killed it).
    expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-failed' });
  });

  it('a task without a worktree cut off by a restart is resumed in its folder (2026-10-20)', async () => {
    const first = make();
    await first.start(0);
    const created = await first.create(task());
    expect(created.isolation).not.toBe('worktree');
    first.stop();
    statuses.set('s1', 'exited');
    const resume = vi.fn(async () => ({ sessionId: 'resumed-1' }));
    const restarted = make({
      resume,
      claudeConversation: (id) => (id === 's1' ? 'conv-1' : undefined),
    });
    await restarted.start(0);
    await restarted.checkExited();
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id }),
      'conv-1',
      expect.any(String)
    );
    expect(restarted.get(created.id)).toMatchObject({ state: 'working', sessionId: 'resumed-1' });
  });

  it('a task without a worktree keeps its last reply as its report, and is done (2026-10-20)', async () => {
    const scheduler = make({ finalReply: async () => 'atlas-guard manda X-Atlas-Turn' });
    await scheduler.start(0);
    const created = await scheduler.create(task());
    await scheduler.markDone(created.sessionId as string);
    expect(scheduler.get(created.id)).toMatchObject({
      state: 'done',
      summary: 'atlas-guard manda X-Atlas-Turn',
    });
  });

  describe('tasks without a worktree close as done (2026-10-24)', () => {
    const records = (scheduler: TaskScheduler) =>
      (scheduler as unknown as { tasks: TaskRecord[] }).tasks;

    it('done with its report: final, with a task-done push', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await scheduler.create(task());
      await scheduler.markDone('s1', 'Logs rotados');
      expect(scheduler.get(created.id)).toMatchObject({ state: 'done', summary: 'Logs rotados' });
      expect(scheduler.get(created.id)?.finishedAt).toBeDefined();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task-done', title: `✅ Task done: ${created.name}` })
      );
      // Nothing can send to it any more, nor discard it.
      expect((await scheduler.send(created.id, 'otra cosa', 'ui')).ok).toBe(false);
      expect((await scheduler.discard(created.id)).ok).toBe(false);
    });

    it('keeps a summary as long as the API takes, whole (2026-10-31)', async () => {
      // The API took 4000 characters but 2000 were kept: the measurements at the end were lost.
      const scheduler = make();
      await scheduler.start(0);
      const created = await scheduler.create(task());
      const summary = `${'a'.repeat(TASK_SUMMARY_MAX - 9)} Measured`;
      const undo = 'u'.repeat(TASK_UNDO_MAX);
      await scheduler.markDone('s1', summary, { undo });
      expect(scheduler.get(created.id)?.summary).toBe(summary);
      expect(scheduler.get(created.id)?.report?.undo).toBe(undo);
    });

    it('stays ready when it ended on a question or reported nothing', async () => {
      const asked = make({ finalReply: async () => '¿Borro también los antiguos?' });
      await asked.start(0);
      const created = await asked.create(task());
      asked.onClaudeTransition('s1', 'idle', 'busy', idle('¿Borro también los antiguos?'));
      await asked.markDone('s1');
      expect(asked.get(created.id)?.state).toBe('ready');

      const silent = make();
      await silent.start(0);
      const quiet = await silent.create(task());
      await silent.markDone(quiet.sessionId as string);
      expect(silent.get(quiet.id)?.state).toBe('ready');
      // `ut task merge` closes it: nothing to merge.
      const closed = silent.complete(quiet.id);
      expect(closed).toMatchObject({ ok: true, task: { state: 'done' } });
      expect(silent.complete(quiet.id)).toMatchObject({ ok: false, code: 'not-open' });
    });

    it('complete refuses a worktree task and one still at work', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const created = await scheduler.create(task());
      expect(scheduler.complete(created.id)).toMatchObject({ ok: false, code: 'busy' });
      records(scheduler)[0].isolation = 'worktree';
      records(scheduler)[0].state = 'ready';
      expect(scheduler.complete(created.id)).toMatchObject({ ok: false, code: 'not-open' });
      expect(scheduler.complete('nope')).toMatchObject({ ok: false, code: 'not-found' });
    });

    it('a failed one with the same prompt in the same folder closes when the newer is done', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const failed = await scheduler.create(task());
      const elsewhere = await scheduler.create(task({ workingDir: '/Users/me/Projects/otra' }));
      const other = await scheduler.create(task({ prompt: 'Otra cosa' }));
      for (const id of [failed.id, elsewhere.id, other.id]) {
        const record = records(scheduler).find((entry) => entry.id === id) as TaskRecord;
        record.state = 'failed';
        record.blocker = { kind: 'session-exit', message: 'The session ended' };
      }
      vi.setSystemTime(T0 + 60_000);
      const newer = await scheduler.create(task());
      await scheduler.markDone(newer.sessionId as string, 'Arreglados');
      expect(scheduler.get(newer.id)?.state).toBe('done');
      expect(scheduler.get(failed.id)).toMatchObject({ state: 'done', supersededBy: newer.id });
      expect(scheduler.get(elsewhere.id)?.state).toBe('failed');
      expect(scheduler.get(other.id)?.state).toBe('failed');
      // Only the newer one's push: the old one closes quietly.
      expect(notify.mock.calls.filter(([p]) => p.type === 'task-done')).toHaveLength(1);
    });

    it('at startup, ready ones over a day old whose session ended close as done', async () => {
      const first = make();
      await first.start(0);
      const old = await first.create(task());
      const running = await first.create(task({ prompt: 'Sigue' }));
      const recent = await first.create(task({ prompt: 'Reciente' }));
      const blocked = await first.create(task({ prompt: 'Bloqueada' }));
      const retried = await first.create(task({ prompt: 'Reintentada' }));
      for (const record of records(first)) {
        record.state = 'ready';
        record.stateSince = new Date(T0).toISOString();
      }
      const at = (id: string) => records(first).find((entry) => entry.id === id) as TaskRecord;
      at(recent.id).stateSince = new Date(T0 + 24 * 3600_000).toISOString();
      at(blocked.id).blocker = { kind: 'session-exit', message: 'ended with work' };
      at(retried.id).state = 'failed';
      // A newer try of the failed one, done since.
      const redo = await first.create(task({ prompt: 'Reintentada' }));
      at(redo.id).state = 'done';
      (first as unknown as { save(): void }).save();
      first.stop();

      vi.setSystemTime(T0 + 25 * 3600_000);
      statuses.set(running.sessionId as string, 'running');
      const second = make();
      await second.start(0);
      expect(second.get(old.id)?.state).toBe('done');
      expect(second.get(running.id)?.state).toBe('ready');
      expect(second.get(recent.id)?.state).toBe('ready');
      expect(second.get(blocked.id)?.state).toBe('ready');
      expect(second.get(retried.id)).toMatchObject({ state: 'done', supersededBy: redo.id });
      // Closed quietly: these are old news.
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe('finished tasks stop their session (2026-10-24)', () => {
    const records = (scheduler: TaskScheduler) =>
      (scheduler as unknown as { tasks: TaskRecord[] }).tasks;
    let stopSession: ReturnType<typeof vi.fn>;
    const makeStopping = (extra: Partial<TaskSchedulerDeps> = {}) =>
      make({
        stopSession: stopSession as unknown as (id: string) => Promise<void>,
        finishedSessionGraceMs: 1_000,
        ...extra,
      });

    beforeEach(() => {
      stopSession = vi.fn(async (id: string) => {
        statuses.set(id, 'exited');
      });
    });

    it('ut task done: the session is stopped after the grace, its report kept', async () => {
      const scheduler = makeStopping();
      await scheduler.start(0);
      const created = await scheduler.create(task());
      statuses.set('s1', 'running');
      await scheduler.markDone('s1', 'Logs rotados');
      expect(scheduler.get(created.id)?.state).toBe('done');
      // `ut task done` runs in it: not at once.
      expect(stopSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await scheduler.settled();
      expect(stopSession).toHaveBeenCalledWith('s1');
    });

    it('closed with ut task merge (complete) and superseded ones: every path stops it', async () => {
      const finalReply = vi.fn(async () => 'Lo que hice');
      const scheduler = makeStopping({ finalReply });
      await scheduler.start(0);
      const failed = await scheduler.create(task());
      const quiet = await scheduler.create(task({ prompt: 'Otra' }));
      records(scheduler)[0].state = 'failed';
      records(scheduler)[1].state = 'ready';
      statuses.set('s1', 'running');
      statuses.set('s2', 'running');
      expect(scheduler.complete(quiet.id)).toMatchObject({ ok: true });
      vi.setSystemTime(T0 + 60_000);
      const newer = await scheduler.create(task());
      statuses.set('s3', 'running');
      await scheduler.markDone('s3', 'Hecho');
      expect(scheduler.get(failed.id)?.state).toBe('done');
      await vi.advanceTimersByTimeAsync(1_000);
      await scheduler.settled();
      expect(stopSession.mock.calls.map(([id]) => id).sort()).toEqual(['s1', 's2', 's3']);
      // The one closed without a report got its agent's last reply before its session went.
      expect(scheduler.get(quiet.id)?.summary).toBe('Lo que hice');
      expect(scheduler.get(newer.id)?.summary).toBe('Hecho');
    });

    it('waits while its agent still works, up to a limit', async () => {
      const scheduler = makeStopping();
      await scheduler.start(0);
      await scheduler.create(task());
      statuses.set('s1', 'running');
      await scheduler.markDone('s1', 'Hecho');
      scheduler.onClaudeTransition('s1', 'idle', 'busy', idle());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stopSession).not.toHaveBeenCalled();
      scheduler.onClaudeTransition('s1', 'busy', 'idle', idle());
      await vi.advanceTimersByTimeAsync(1_000);
      await scheduler.settled();
      expect(stopSession).toHaveBeenCalledWith('s1');
    });

    it('never an orchestrator session, one reopened by hand, nor one an open task uses', async () => {
      const scheduler = makeStopping({ isOrchestratorSession: (id) => id === 's1' });
      await scheduler.start(0);
      const orch = await scheduler.create(task());
      const reopened = await scheduler.create(task({ prompt: 'Reabierta' }));
      const shared = await scheduler.create(task({ prompt: 'Compartida' }));
      for (const id of ['s1', 's2', 's3', 'resumed-2']) statuses.set(id, 'running');
      // Another open task reports to s3.
      const open = await scheduler.create(task({ prompt: 'Abierta' }));
      (
        records(scheduler).find((entry) => entry.id === open.id) as TaskRecord
      ).orchestratorSessionId = 's3';
      for (const record of records(scheduler).slice(0, 3)) record.state = 'ready';
      for (const created of [orch, reopened, shared]) scheduler.complete(created.id);
      // The user reopens s2's conversation by hand after it finished.
      scheduler.sessionReplaced('s2', 'resumed-2', { resumed: true });
      expect(scheduler.get(reopened.id)?.keepSessionId).toBe('resumed-2');
      // Its agent at work again, and done again: the session stays the user's.
      expect(scheduler.get(reopened.id)?.state).toBe('working');
      await scheduler.markDone('resumed-2', 'Otra vez');
      expect(scheduler.get(reopened.id)?.state).toBe('done');
      await vi.advanceTimersByTimeAsync(60_000);
      await scheduler.settled();
      expect(stopSession).not.toHaveBeenCalled();
      expect(scheduler.lingeringSessions(0)).toEqual([]);
    });

    it('lists finished tasks whose session outlived its stop, and stops them (the doctor)', async () => {
      const first = makeStopping();
      await first.start(0);
      const created = await first.create(task());
      await first.markDone('s1', 'Hecho');
      // The server went down before the grace ran out.
      first.stop();
      statuses.set('s1', 'running');
      vi.setSystemTime(T0 + 20 * 60_000);
      const second = makeStopping();
      await second.start(0);
      expect(second.lingeringSessions(30 * 60_000)).toEqual([]);
      expect(second.lingeringSessions(15 * 60_000).map((entry) => entry.id)).toEqual([created.id]);
      expect(await second.stopLingeringSession(created.id)).toBe('stopped');
      expect(stopSession).toHaveBeenCalledWith('s1');
      expect(second.lingeringSessions(15 * 60_000)).toEqual([]);
      // Gone meanwhile: nothing to do, not a failure (the doctor tells nothing).
      expect(await second.stopLingeringSession(created.id)).toBe('not-needed');
    });

    it('a restart arms the stop again for tasks finished before it', async () => {
      const first = makeStopping();
      await first.start(0);
      await first.create(task());
      await first.markDone('s1', 'Hecho');
      first.stop();
      statuses.set('s1', 'running');
      const second = makeStopping();
      await second.start(0);
      expect(stopSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await second.settled();
      expect(stopSession).toHaveBeenCalledWith('s1');
    });

    it('the mark keeps only the reopened session, whichever finished task names it', async () => {
      const scheduler = makeStopping();
      await scheduler.start(0);
      const kept = await scheduler.create(task());
      const sharing = await scheduler.create(task({ prompt: 'Otra' }));
      const later = await scheduler.create(task({ prompt: 'Luego' }));
      const at = (id: string) => records(scheduler).find((entry) => entry.id === id) as TaskRecord;
      for (const id of [kept.id, sharing.id, later.id]) at(id).state = 'done';
      // The user reopened `kept` by hand in s1; another finished task names s1 too.
      at(kept.id).keepSessionId = 's1';
      at(sharing.id).sessionId = 's1';
      // A task whose reopened session (s0) ended: its new one is stopped as usual.
      at(later.id).keepSessionId = 's0';
      statuses.set('s1', 'running');
      statuses.set('s3', 'running');
      vi.setSystemTime(T0 + 20 * 60_000);
      expect(scheduler.lingeringSessions(15 * 60_000).map((entry) => entry.id)).toEqual([later.id]);
      expect(await scheduler.stopLingeringSession(sharing.id)).toBe('not-needed');
      expect(await scheduler.stopLingeringSession(later.id)).toBe('stopped');
      expect(stopSession.mock.calls).toEqual([['s3']]);
    });

    it('a kept session reopened shielded (no resume) stays kept', async () => {
      const scheduler = makeStopping();
      await scheduler.start(0);
      const created = await scheduler.create(task());
      const record = records(scheduler)[0];
      record.state = 'done';
      record.keepSessionId = 's1';
      scheduler.sessionReplaced('s1', 's9');
      expect(scheduler.get(created.id)).toMatchObject({ sessionId: 's9', keepSessionId: 's9' });
    });
  });

  it('a session reopened shielded carries on its task (2026-10-18)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    statuses.set('s1', 'running');
    scheduler.sessionReplacing('s1');
    statuses.set('s1', 'exited');
    await scheduler.checkExited();
    expect(notify).not.toHaveBeenCalled();
    scheduler.sessionReplaced('s1', 'shielded-1');
    statuses.set('shielded-1', 'running');
    await scheduler.checkExited();
    expect(scheduler.get(created.id)).toMatchObject({ sessionId: 'shielded-1', state: 'working' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends no task push when the user turned it off', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task({ notify: false }));
    await scheduler.markDone('s1', 'done');
    expect(scheduler.get(created.id)?.state).toBe('done');
    expect(notify).not.toHaveBeenCalled();
  });

  it('marks a task failed when its session cannot start', async () => {
    launch.mockRejectedValueOnce(new Error('tmux missing'));
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    expect(created.state).toBe('failed');
    expect(created.error).toBe('tmux missing');
    expect(created.blocker).toMatchObject({ kind: 'setup', message: 'tmux missing' });
  });

  it('finishes a muted task session too: the notifier reports its transitions', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    let status: ClaudeStatus = { status: 'idle' };
    const sent: NotificationPayload[] = [];
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude (~/app)', pid: 7, status: 'running', muted: true }],
      (payload) => sent.push(payload),
      async () => new Map([[7, status]])
    );
    notifier.onTransition((id, previous, next, claude) =>
      scheduler.onClaudeTransition(id, previous, next, claude)
    );
    notifier.setPayloadRewriter((payload) => scheduler.rewritePush(payload));
    await notifier.tick();
    status = { status: 'busy' };
    await notifier.tick();
    status = { status: 'idle', preview: { role: 'assistant', text: 'Fixed 2 tests' } };
    await notifier.tick();
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    expect(sent).toEqual([]);
    expect(scheduler.get(created.id)?.state).toBe('ready');
    expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-ready', body: 'Fixed 2 tests' });
  });

  describe('2026-10-24: a task without a worktree leaves nothing of its own uncommitted', () => {
    let repo: string;
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
        cwd: repo,
        stdio: 'pipe',
      });
    const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);

    beforeEach(() => {
      // Real time: the git calls below are real.
      vi.useRealTimers();
      repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-sched-plain-')));
      git('init', '-q', '-b', 'main');
      write('a.txt', 'a\n');
      write('b.txt', 'b\n');
      git('add', '.');
      git('commit', '-qm', 'start');
      // Someone's work in progress before the task starts: never the task's to commit.
      write('b.txt', 'b changed by the user\n');
      write('notes.txt', "the user's notes\n");
    });

    afterEach(() => {
      fs.rmSync(repo, RM_TEST_DIR);
    });

    const started = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
      await scheduler.start(0);
      const created = await scheduler.create(
        task({ workingDir: repo, isolation: 'none', ...overrides })
      );
      await scheduler.settled();
      return scheduler.get(created.id) as TaskRecord;
    };

    it('counts only files the task changed, until they are committed', async () => {
      const scheduler = make();
      const created = await started(scheduler);
      expect(created.startDirty?.map((entry) => entry.file).sort()).toEqual(['b.txt', 'notes.txt']);
      const sessionId = created.sessionId as string;
      expect(await scheduler.uncommittedWork(sessionId)).toEqual([]);

      write('a.txt', 'a changed by the task\n');
      write('new.txt', 'made by the task\n');
      expect((await scheduler.uncommittedWork(sessionId)).sort()).toEqual(['a.txt', 'new.txt']);

      // A file that was already dirty and that the task changed again counts too.
      write('b.txt', 'b changed by the user, then by the task, a longer line\n');
      expect((await scheduler.uncommittedWork(sessionId)).sort()).toEqual([
        'a.txt',
        'b.txt',
        'new.txt',
      ]);

      git('add', 'a.txt', 'new.txt', 'b.txt');
      git('commit', '-qm', 'the task');
      expect(await scheduler.uncommittedWork(sessionId)).toEqual([]);
      // The user's notes stay where they were, uncommitted.
      expect(git('status', '--porcelain').toString()).toContain('notes.txt');
    });

    it('asks nothing of a project that waits for the user, unless autoApprove is on', async () => {
      let autoApprove = false;
      const scheduler = make({ autoApprove: () => autoApprove });
      const created = await started(scheduler, { mergePolicy: 'ask' });
      write('a.txt', 'a changed by the task\n');
      expect(await scheduler.uncommittedWork(created.sessionId as string)).toEqual([]);
      autoApprove = true;
      expect(await scheduler.uncommittedWork(created.sessionId as string)).toEqual(['a.txt']);
    });

    it('outside git, or with nothing known from its start, nothing is counted', async () => {
      const scheduler = make();
      const outside = await started(scheduler, { workingDir: os.tmpdir() });
      expect(outside.startDirty).toBeUndefined();
      expect(await scheduler.uncommittedWork(outside.sessionId as string)).toEqual([]);
    });
  });

  it('finishes a Codex task on `ut task done`, or after a quiet spell', async () => {
    let lastOutput = T0;
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      lastOutputAt: () => lastOutput,
      now: () => Date.now(),
    });
    schedulers.push(scheduler);
    await scheduler.start(0);
    const quiet = await scheduler.create(task({ agent: 'codex', command: ['codex'] }));
    const done = await scheduler.create(task({ agent: 'codex', command: ['codex'] }));
    expect((await scheduler.markDone('s2', 'Hecho'))?.summary).toBe('Hecho');
    expect(scheduler.get(done.id)?.state).toBe('done');

    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS / 2);
    lastOutput = Date.now();
    await scheduler.checkExited();
    expect(scheduler.get(quiet.id)?.state).toBe('working');
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS);
    await scheduler.checkExited();
    expect(scheduler.get(quiet.id)?.state).toBe('ready');
  });

  it('`ut task ask` stops the task for the user; going idle then does not finish it', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    expect(scheduler.ask('s1', '¿Uso OAuth o magic links?')?.state).toBe('needs_you');
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle());
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS * 2);
    expect(scheduler.get(created.id)).toMatchObject({
      state: 'needs_you',
      blocker: { kind: 'question', message: '¿Uso OAuth o magic links?' },
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'task-needs-you' }));
    expect(scheduler.ask('nobody', 'x')).toBeUndefined();
  });

  it('sends follow-ups to an open task and refuses settled or gone ones', async () => {
    const deliver = vi.fn(() => true);
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: (id) => statuses.get(id),
      deliver,
      now: () => Date.now(),
    });
    schedulers.push(scheduler);
    await scheduler.start(0);
    const created = await scheduler.create(task());
    statuses.set('s1', 'running');
    const sent = await scheduler.send(created.id, 'Añade también un test', 'route');
    expect(sent.ok && sent.task.followUps).toEqual([
      { at: new Date(T0).toISOString(), text: 'Añade también un test', via: 'route' },
    ]);
    expect(deliver).toHaveBeenCalledWith('s1', 'Añade también un test', 'claude');
    statuses.set('s1', 'exited');
    expect(await scheduler.send(created.id, 'x', 'ui')).toMatchObject({
      ok: false,
      code: 'session-gone',
    });
    expect(await scheduler.send('nope', 'x', 'ui')).toMatchObject({ ok: false, code: 'not-found' });
    await scheduler.discard(created.id);
    expect(await scheduler.send(created.id, 'x', 'ui')).toMatchObject({
      ok: false,
      code: 'not-open',
    });
  });

  it('drops saved tasks of another version and broken records', async () => {
    fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{ id: 'x', state: 'running' }] }));
    const old = make();
    await old.start(0);
    expect(old.list()).toEqual([]);
    old.stop();
    const first = make();
    await first.start(0);
    await first.create(task({ runAt: new Date(T0 + 60_000) }));
    first.stop();
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
    expect(saved.version).toBe(2);
    saved.tasks.push({ id: 'broken', state: 'nonsense' });
    fs.writeFileSync(store, JSON.stringify(saved));
    const second = make();
    await second.start(0);
    expect(second.list().map((t) => t.state)).toEqual(['scheduled']);
  });

  it('an unreadable tasks.json is kept aside before anything is saved over it (2026-10-20)', async () => {
    fs.writeFileSync(store, '{"version": 2, "tasks": [ {"id": "trunc');
    const scheduler = make();
    await scheduler.start(0);
    expect(scheduler.list()).toEqual([]);
    const aside = fs.readdirSync(dir).filter((name) => name.startsWith('tasks.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toContain('"trunc');
  });

  it('a tasks.json that could not be kept aside is never written over, pushes still go (2026-11-01)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const created = await scheduler.create(task());
    // As when the saved file could be neither read nor copied aside (putAside).
    (scheduler as unknown as { saveBlocked: boolean }).saveBlocked = true;
    fs.writeFileSync(store, 'unreadable');
    notify.mockClear();
    await scheduler.markDone(created.sessionId as string, 'hecho');
    await scheduler.settled();
    expect(notify.mock.calls.map(([p]) => p.type)).toEqual(['task-done']);
    expect(fs.readFileSync(store, 'utf8')).toBe('unreadable');
  });

  describe('worktree tasks', () => {
    let worktrees: TaskWorktrees & Record<string, ReturnType<typeof vi.fn>>;
    let pipeline: ReturnType<typeof vi.fn>;
    let deliver: ReturnType<typeof vi.fn>;
    let stopSession: ReturnType<typeof vi.fn>;
    let commits: number;
    let unmerged: boolean;

    const makeWithWorktrees = (extra: Partial<TaskSchedulerDeps> = {}) => {
      const scheduler = new TaskScheduler({
        storePath: store,
        launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
        notify: notify as unknown as (p: NotificationPayload) => void,
        sessionStatus: (id) => statuses.get(id) ?? 'running',
        stopSession: stopSession as unknown as (id: string) => Promise<void>,
        deliver: deliver as unknown as (id: string, text: string) => boolean,
        worktrees,
        pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
        logDir: path.join(dir, 'logs'),
        now: () => Date.now(),
        ...extra,
      });
      schedulers.push(scheduler);
      return scheduler;
    };

    /** Create a worktree task and wait for its background setup. */
    const createReady = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
      const created = await scheduler.create(task({ isolation: 'worktree', ...overrides }));
      await scheduler.settled();
      return scheduler.get(created.id) as TaskRecord;
    };

    beforeEach(() => {
      commits = 0;
      unmerged = false;
      deliver = vi.fn(() => true);
      stopSession = vi.fn(async () => {});
      pipeline = vi.fn(async () => ({ state: 'merged', mergedSha: 'def456', baseSha: 'abc999' }));
      let n = 0;
      worktrees = {
        create: vi.fn(async (t: TaskRecord) => {
          n++;
          return {
            repoPath: '/repo',
            baseBranch: 'main',
            baseSha: 'abc123',
            branch: `ut/arregla-los-tests${t.groupIndex !== undefined ? `-${'ab'[t.groupIndex]}` : ''}`,
            worktreePath: `/wt/${n}`,
            clonedDirs: [],
          };
        }),
        remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
        commitLeftovers: vi.fn(async () => false),
        changes: vi.fn(async () => ({
          files: commits ? ['src/a.ts'] : [],
          stats: { commits, files: commits ? 1 : 0, insertions: 3, deletions: 1 },
        })),
        hasUnmergedWork: vi.fn(async () => unmerged),
      };
    });

    it('hands each new worktree to worktreeMade (kept out of Time Machine)', async () => {
      const worktreeMade = vi.fn();
      const scheduler = makeWithWorktrees({ worktreeMade });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      expect(worktreeMade).toHaveBeenCalledWith(created.worktreePath);
      expect(worktreeMade).toHaveBeenCalledTimes(1);
    });

    it('resumes a task whose session died with the server instead of finishing it half done', async () => {
      const first = makeWithWorktrees();
      await first.start(0);
      const created = await createReady(first);
      const sessionId = created.sessionId as string;
      expect(created.state).toBe('working');
      first.stop();

      // The server restarts: the task's PTY went with the old one.
      statuses.set(sessionId, 'exited');
      const resume = vi.fn(async () => ({ sessionId: 'resumed-1' }));
      const restarted = makeWithWorktrees({
        resume,
        claudeConversation: (id) => (id === sessionId ? 'conv-1' : undefined),
      });
      await restarted.start(0);
      await restarted.checkExited();
      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({ id: created.id }),
        'conv-1',
        expect.any(String)
      );
      expect(restarted.get(created.id)).toMatchObject({
        state: 'working',
        sessionId: 'resumed-1',
        resumes: 1,
      });
      expect(pipeline).not.toHaveBeenCalled();

      // Later on, a session that ends is the task's end as before.
      vi.setSystemTime(Date.now() + RESTART_WINDOW_MS + 1);
      statuses.set('resumed-1', 'exited');
      await restarted.checkExited();
      expect(resume).toHaveBeenCalledTimes(1);
      expect(restarted.get(created.id)?.state).not.toBe('working');
    });

    it('starts again a task cut off by a restart before it changed anything, with no conversation to reopen', async () => {
      const first = makeWithWorktrees();
      await first.start(0);
      const created = await createReady(first);
      const sessionId = created.sessionId as string;
      first.stop();

      statuses.set(sessionId, 'exited');
      launch.mockClear();
      const restarted = makeWithWorktrees({ claudeConversation: () => undefined });
      await restarted.start(0);
      await restarted.checkExited();
      expect(launch).toHaveBeenCalledTimes(1);
      const [launched, prompt] = launch.mock.calls[0] as [TaskRecord, string];
      expect(launched).toMatchObject({ id: created.id, worktreePath: created.worktreePath });
      expect(prompt).toContain(created.branch as string);
      const again = restarted.get(created.id) as TaskRecord;
      expect(again).toMatchObject({ state: 'working', resumes: 1 });
      expect(again.sessionId).not.toBe(sessionId);
      expect(pipeline).not.toHaveBeenCalled();
    });

    it('shows its place in the merge queue, leaves it to be discarded, and the user’s merge goes first (2026-11-01)', async () => {
      commits = 1;
      const queue = createMergeQueue();
      const prioritize = vi.spyOn(queue, 'prioritize');
      const scheduler = makeWithWorktrees({ mergeQueue: queue });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      let seen: PipelineOptions | undefined;
      pipeline.mockImplementationOnce(
        (_task: PipelineTask, opts: PipelineOptions) =>
          new Promise<PipelineResult>((resolve) => {
            seen = opts;
            opts.onProgress?.({
              state: 'merge-queue',
              spot: { position: 2, of: 3, since: '2026-11-01T10:00:00.000Z' },
            });
            opts.signal?.addEventListener('abort', () => resolve({ state: 'ready' }));
          })
      );
      await scheduler.markDone(created.sessionId as string, 'Hecho');
      await vi.waitFor(() =>
        expect(scheduler.get(created.id)?.mergeQueue).toMatchObject({ position: 2, of: 3 })
      );
      expect(seen?.mergePriority?.()).toBeUndefined();
      // Fast lane: marked urgent while it waits, its place in line changes at once.
      expect(scheduler.setPriority(created.id, true).ok).toBe(true);
      expect(scheduler.get(created.id)?.urgent).toBe(true);
      expect(seen?.mergePriority?.()).toBe('urgent');
      expect(prioritize).toHaveBeenCalledWith(
        mergeQueueKey(created.repoPath as string, created.baseBranch as string),
        created.id,
        'urgent'
      );
      // Waiting behind others: discarding it does not answer "busy".
      unmerged = false;
      expect((await scheduler.discard(created.id)).ok).toBe(true);
      expect(scheduler.get(created.id)).toMatchObject({ state: 'discarded' });
      expect(scheduler.get(created.id)?.mergeQueue).toBeUndefined();

      // The user's own «Fusionar»: ahead of the unattended ones in the line.
      const other = await createReady(scheduler);
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await scheduler.markDone(other.sessionId as string, 'Hecho');
      await scheduler.settled();
      let asked: { mode?: string; priority?: string } = {};
      pipeline.mockImplementationOnce(async (_task: PipelineTask, opts: PipelineOptions) => {
        asked = { mode: opts.mode, priority: opts.mergePriority?.() };
        return { state: 'merged', mergedSha: 'm1' };
      });
      expect(scheduler.merge(other.id).ok).toBe(true);
      await scheduler.settled();
      expect(asked).toEqual({ mode: 'merge', priority: 'user' });
    });

    // 2026-11-11 (decision): a batch under check is not cut for a discard; the answer was a
    // bare "The task is busy", with no word on what it waited for or for how long.
    it('on a merge batch being checked, a discard says what it waits for and how long is left', async () => {
      commits = 1;
      const queue = createMergeQueue();
      const scheduler = makeWithWorktrees({ mergeQueue: queue });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      const key = mergeQueueKey(created.repoPath as string, created.baseBranch as string);
      const trains = mergeTrainsFor(queue);
      let checking = false;
      let endCheck: () => void = () => {};
      const checked = new Promise<void>((resolve) => {
        endCheck = resolve;
      });
      pipeline.mockImplementationOnce(async (task: PipelineTask, opts: PipelineOptions) => {
        opts.onProgress?.({ state: 'merge-queue' });
        const verdict = await trains.board(
          key,
          {
            id: task.id,
            head: 'car-1',
            onto: 'main-1',
            level: 'related',
            files: [],
            signal: opts.signal,
            fullCheck: async () => {
              checking = true;
              await checked;
              return { passed: true };
            },
            move: async () => ({ kind: 'merged' }),
          },
          'main-1'
        );
        return { state: verdict.kind === 'merged' ? 'merged' : 'ready' };
      });
      // The project's last whole check took 6 minutes.
      const record = (scheduler as unknown as { tasks: TaskRecord[] }).tasks.find(
        (entry) => entry.id === created.id
      ) as TaskRecord;
      const ended = Date.now() - 3_600_000;
      record.timings = [
        {
          phase: 'verify',
          level: 'full',
          round: 1,
          outcome: 'passed',
          startedAt: new Date(ended - 6 * 60_000).toISOString(),
          finishedAt: new Date(ended).toISOString(),
        },
      ];
      await scheduler.markDone(created.sessionId as string, 'Hecho');
      await vi.waitFor(() => expect(checking).toBe(true));
      expect(trains.boarding(key)).toEqual([]);

      const refused = await scheduler.discard(created.id);
      expect(refused).toMatchObject({ ok: false, code: 'busy' });
      const message = (refused as { message: string }).message;
      expect(message).toContain('merge batch is being checked');
      expect(message).toMatch(/\d+ min so far/);
      expect(message).toMatch(/last whole check took 6 min, so about \d+ min are left/);
      // The batch was not cut: it ends and the task merges.
      endCheck();
      await scheduler.settled();
      expect(scheduler.get(created.id)).toMatchObject({ state: 'merged' });
    });

    it('on board a merge batch that has not left, it leaves it to be discarded (2026-11-11)', async () => {
      commits = 1;
      const queue = createMergeQueue();
      const scheduler = makeWithWorktrees({ mergeQueue: queue });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      const key = mergeQueueKey(created.repoPath as string, created.baseBranch as string);
      // Another task waits its turn behind: the batch keeps boarding.
      const behind = queue.join(key, { id: 'behind', at: 0 });
      const trains = mergeTrainsFor(queue);
      pipeline.mockImplementationOnce(async (task: PipelineTask, opts: PipelineOptions) => {
        // As the pipeline boards: out of the line (no place shown), waiting for the verdict.
        opts.onProgress?.({ state: 'merge-queue' });
        const verdict = await trains.board(
          key,
          {
            id: task.id,
            head: 'car-1',
            onto: 'main-1',
            level: 'related',
            files: [],
            signal: opts.signal,
            fullCheck: async () => {
              throw new Error('the batch must not be checked');
            },
            move: async () => ({ kind: 'merged' }),
          },
          'main-1'
        );
        return { state: verdict.kind === 'merged' ? 'merged' : 'ready' };
      });
      await scheduler.markDone(created.sessionId as string, 'Hecho');
      await vi.waitFor(() => expect(trains.boarding(key)).toEqual([created.id]));
      expect(scheduler.get(created.id)?.mergeQueue).toBeUndefined();
      unmerged = false;
      expect(await scheduler.discard(created.id)).toMatchObject({ ok: true });
      expect(scheduler.get(created.id)).toMatchObject({ state: 'discarded' });
      expect(trains.cars(key)).toEqual([]);
      behind.leave();
    });

    it('a task cut off with work in its worktree is not started over', async () => {
      const first = makeWithWorktrees();
      await first.start(0);
      const created = await createReady(first);
      first.stop();

      statuses.set(created.sessionId as string, 'exited');
      unmerged = true;
      launch.mockClear();
      const restarted = makeWithWorktrees();
      await restarted.start(0);
      await restarted.checkExited();
      expect(launch).not.toHaveBeenCalled();
      expect(restarted.get(created.id)?.state).not.toBe('working');
    });

    it('a message to a task whose session ended reopens its conversation with it', async () => {
      const resume = vi.fn(async () => ({ sessionId: 'reopened-1' }));
      const scheduler = makeWithWorktrees({
        resume,
        claudeConversation: (id) => (id === 'gone' ? 'conv-9' : undefined),
      });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      // Files Untether does not commit left in its worktree: it stays ready (no-changes).
      unmerged = true;
      await scheduler.markDone(created.sessionId as string, 'done');
      await scheduler.settled();
      const ready = scheduler.get(created.id) as TaskRecord;
      expect(ready.state).toBe('ready');
      unmerged = false;
      // Its session is gone; the conversation it ran is conv-9.
      Object.assign(
        (scheduler as unknown as { tasks: TaskRecord[] }).tasks.find((t) => t.id === created.id) ??
          {},
        { sessionId: 'gone' }
      );
      statuses.set('gone', 'exited');
      const sent = await scheduler.send(created.id, 'Termina los tests', 'cli');
      // A reopen the user asked for is no restart: it does not use up MAX_TASK_RESUMES.
      expect(sent).toMatchObject({ ok: true, task: { state: 'working', reopens: 1 } });
      expect(sent.ok && sent.task.resumes).toBeFalsy();
      expect(resume).toHaveBeenCalledWith(
        expect.objectContaining({ id: created.id }),
        'conv-9',
        expect.any(String),
        'Termina los tests'
      );
      await scheduler.settled();
      expect(scheduler.get(created.id)?.sessionId).toBe('reopened-1');
      await scheduler.checkExited();
      expect(scheduler.get(created.id)?.state).toBe('working');
    });

    it("a dirty base that is a working task's branch says so: its work, not leftovers", async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const original = await createReady(scheduler);
      const fix = await createReady(scheduler);
      const internal = (scheduler as unknown as { tasks: TaskRecord[] }).tasks;
      const fixRecord = internal.find((t) => t.id === fix.id) as TaskRecord;
      fixRecord.baseBranch = original.branch;
      commits = 1;
      pipeline.mockResolvedValueOnce({
        state: 'needs_you',
        blocker: { kind: 'dirty-base', message: '/wt/1 has changes not committed on x' },
      });
      await scheduler.markDone(fix.sessionId as string, 'done');
      await scheduler.settled();
      expect(scheduler.get(fix.id)?.blocker?.message).toContain(
        `work in progress of task ${original.id.slice(0, 8)}`
      );
    });

    it('a check that passed on its rerun after failing under load hands its flaky tests over, once (2026-11-02)', async () => {
      const onFlakyUnderLoad = vi.fn();
      const scheduler = makeWithWorktrees({ onFlakyUnderLoad });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      commits = 1;
      const verify = {
        command: 'pnpm test',
        cwd: '/wt/1',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        firstRunLoad: 40,
        flakyFirstRun: ' Tests  1 failed',
        flakyUnderLoad: ['a.test.ts > b'],
      };
      pipeline.mockResolvedValueOnce({ state: 'ready', verify });
      await scheduler.markDone(created.sessionId as string, 'done');
      await scheduler.settled();
      expect(onFlakyUnderLoad).toHaveBeenCalledTimes(1);
      expect(onFlakyUnderLoad.mock.calls[0][0]).toMatchObject({ id: created.id });
      expect(onFlakyUnderLoad.mock.calls[0][1]).toMatchObject({
        flakyUnderLoad: ['a.test.ts > b'],
      });
      expect(scheduler.get(created.id)?.verify?.flakyUnderLoad).toEqual(['a.test.ts > b']);
      // The same check handed back again (a passed check of the same commit is kept): not twice.
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'def456', verify });
      scheduler.verify(created.id);
      await scheduler.settled();
      expect(pipeline).toHaveBeenCalledTimes(2);
      expect(scheduler.get(created.id)?.state).toBe('merged');
      expect(onFlakyUnderLoad).toHaveBeenCalledTimes(1);
    });

    it('a task blocked by a working task’s branch merges on its own once that task is done', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const original = await createReady(scheduler);
      const fix = await createReady(scheduler);
      const internal = (scheduler as unknown as { tasks: TaskRecord[] }).tasks;
      const fixRecord = internal.find((t) => t.id === fix.id) as TaskRecord;
      fixRecord.baseBranch = original.branch;
      commits = 1;
      pipeline.mockResolvedValueOnce({
        state: 'needs_you',
        blocker: { kind: 'dirty-base', message: 'changes not committed' },
      });
      await scheduler.markDone(fix.sessionId as string, 'done');
      await scheduler.settled();
      expect(scheduler.get(fix.id)).toMatchObject({
        state: 'ready',
        blocker: { kind: 'dirty-base' },
        baseWait: { run: { mode: 'auto' } },
      });
      // Its base is a working agent's branch: a clean tree there is no reason to merge into it.
      await vi.advanceTimersByTimeAsync(BASE_WAIT_POLL_MS * 2);
      expect(pipeline).toHaveBeenCalledTimes(1);

      // The original finishes and merges into main: the fix goes into main now, on its own.
      pipeline.mockClear();
      await scheduler.markDone(original.sessionId as string, 'done');
      await scheduler.settled();
      // The dependents start from a microtask once the original's pipeline is over.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await scheduler.settled();
      expect(pipeline.mock.calls.map((call) => (call[0] as TaskRecord).id)).toEqual([
        original.id,
        fix.id,
      ]);
      expect((pipeline.mock.calls[1][0] as TaskRecord).baseBranch).toBe('main');
      expect(scheduler.get(fix.id)?.state).toBe('merged');
    });

    describe('2026-10-24: a dirty base checkout', () => {
      const dirtyBase = {
        state: 'needs_you',
        blocker: {
          kind: 'dirty-base',
          message: '/repo has changes not committed on main',
          detail: ['src/b.ts'],
        },
      };

      /** A task stopped by a dirty main, with `isDirty` answering for the checkout. */
      const stoppedByDirtyBase = async (isDirty: () => boolean, extra = {}) => {
        const baseDirty = vi.fn(async () => isDirty());
        const scheduler = makeWithWorktrees({ baseDirty, ...extra });
        await scheduler.start(0);
        const created = await createReady(scheduler);
        commits = 1;
        pipeline.mockResolvedValueOnce(dirtyBase);
        await scheduler.markDone(created.sessionId as string, 'hecho');
        await scheduler.settled();
        return { scheduler, created, baseDirty };
      };

      it('waits ready asking nobody, and merges by itself once main is clean', async () => {
        let dirty = true;
        const { scheduler, created, baseDirty } = await stoppedByDirtyBase(() => dirty);
        expect(scheduler.get(created.id)).toMatchObject({
          state: 'ready',
          blocker: { kind: 'dirty-base' },
          baseWait: { run: { mode: 'auto' } },
        });
        // Nothing for the user to do: no push.
        expect(notify).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(BASE_WAIT_POLL_MS);
        expect(baseDirty).toHaveBeenCalledWith('/repo', 'main', expect.any(String));
        expect(pipeline).toHaveBeenCalledTimes(1);
        expect(scheduler.get(created.id)?.state).toBe('ready');

        dirty = false;
        await vi.advanceTimersByTimeAsync(BASE_WAIT_POLL_MS);
        await scheduler.settled();
        expect(pipeline).toHaveBeenCalledTimes(2);
        expect(pipeline.mock.calls[1][1]).toMatchObject({ mode: 'auto' });
        const after = scheduler.get(created.id) as TaskRecord;
        expect(after.state).toBe('merged');
        expect(after.baseWait).toBeUndefined();
        expect(notify.mock.calls.map((call) => call[0].type)).toEqual(['task-merged']);
      });

      it('does not spin its timer while the pipeline of the clean base runs (2026-11-10)', async () => {
        let dirty = true;
        const { scheduler, created } = await stoppedByDirtyBase(() => dirty);
        let release!: (result: { state: string }) => void;
        pipeline.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        dirty = false;
        await vi.advanceTimersByTimeAsync(BASE_WAIT_POLL_MS);
        expect(pipeline).toHaveBeenCalledTimes(2);
        // The pipeline takes its time (a merge queue, a check): the task still shows its past
        // look at the base, and the timer used to fire every millisecond until it ended.
        const fired = vi.spyOn(scheduler as unknown as { fireDue: () => Promise<void> }, 'fireDue');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fired.mock.calls.length).toBeLessThan(5);
        release({ state: 'merged' });
        await vi.advanceTimersByTimeAsync(0);
        await scheduler.settled();
        expect(scheduler.get(created.id)?.state).toBe('merged');
      });

      it('keeps waiting across a restart', async () => {
        let dirty = true;
        const { scheduler, created } = await stoppedByDirtyBase(() => dirty);
        scheduler.stop();
        const baseDirty = vi.fn(async () => dirty);
        const restarted = makeWithWorktrees({ baseDirty });
        await restarted.start(0);
        dirty = false;
        await vi.advanceTimersByTimeAsync(BASE_WAIT_POLL_MS);
        await restarted.settled();
        expect(baseDirty).toHaveBeenCalled();
        expect(restarted.get(created.id)?.state).toBe('merged');
      });

      it('tells the user once after 2 h that it still waits, and hands it over after a day', async () => {
        const poll = 10 * 60_000;
        const { scheduler, created } = await stoppedByDirtyBase(() => true, {
          baseWaitPollMs: poll,
        });
        await vi.advanceTimersByTimeAsync(TASK_BASE_WAIT_NOTIFY_MS + poll);
        expect(notify).toHaveBeenCalledTimes(1);
        const told = notify.mock.calls[0][0] as NotificationPayload;
        expect(told).toMatchObject({
          type: 'task-ready',
          title: `⏳ Waiting to merge: ${created.name}`,
          data: { blocker: 'dirty-base', base: 'main' },
        });
        expect(told.data?.baseWaitSince).toEqual(expect.any(String));
        expect(told.body).toContain('Nothing to do');
        expect(scheduler.get(created.id)?.state).toBe('ready');

        await vi.advanceTimersByTimeAsync(4 * 3_600_000);
        expect(notify).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(TASK_BASE_WAIT_MAX_MS);
        const after = scheduler.get(created.id) as TaskRecord;
        expect(after).toMatchObject({ state: 'needs_you', blocker: { kind: 'dirty-base' } });
        expect(after.blocker?.message).toContain('Untether waited 24 hours');
        expect(after.baseWait).toBeUndefined();
        expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'task-needs-you' });
        // The pipeline never ran again while the base stayed dirty.
        expect(pipeline).toHaveBeenCalledTimes(1);
      });

      it('an orchestrator hears once that there is nothing to do', async () => {
        const scheduler = makeWithWorktrees({ baseDirty: async () => true });
        await scheduler.start(0);
        const created = await createReady(scheduler, {
          origin: 'orchestrator',
          orchestratorSessionId: 'orch-1',
        });
        commits = 1;
        pipeline.mockResolvedValueOnce(dirtyBase);
        await scheduler.markDone(created.sessionId as string, 'hecho');
        await scheduler.settled();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({
          type: 'task-ready',
          data: { quiet: true, blocker: 'dirty-base' },
        });
        await vi.advanceTimersByTimeAsync(BASE_WAIT_POLL_MS * 3);
        expect(notify).toHaveBeenCalledTimes(1);
      });
    });

    it('a session that ends before done is checked, never merged on its own', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler);
      commits = 1;
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      vi.setSystemTime(Date.now() + RESTART_WINDOW_MS + 1);
      statuses.set(created.sessionId as string, 'exited');
      await scheduler.checkExited();
      await scheduler.settled();
      expect((pipeline.mock.calls.at(-1) as unknown[])[1]).toMatchObject({ mode: 'verify' });
      expect(scheduler.get(created.id)).toMatchObject({
        state: 'ready',
        blocker: { kind: 'session-exit' },
      });
    });

    it('Reintentar: a cut-off task reopens its conversation; a failed setup starts over', async () => {
      const resume = vi.fn(async () => ({ sessionId: 'again-1' }));
      const scheduler = makeWithWorktrees({
        resume,
        claudeConversation: (id) => (id === 'gone' ? 'conv-1' : undefined),
      });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      const internal = (scheduler as unknown as { tasks: TaskRecord[] }).tasks;
      const record = internal.find((t) => t.id === created.id) as TaskRecord;
      Object.assign(record, {
        state: 'failed',
        sessionId: 'gone',
        blocker: { kind: 'session-exit', message: 'ended' },
      });
      statuses.set('gone', 'exited');
      expect(await scheduler.retry(created.id)).toMatchObject({
        ok: true,
        task: { state: 'working' },
      });
      expect(resume).toHaveBeenCalledWith(
        expect.anything(),
        'conv-1',
        expect.any(String),
        TASK_RETRY_TEXT
      );

      // A setup that failed: a fresh worktree and session.
      const before = worktrees.create.mock.calls.length;
      Object.assign(record, {
        state: 'failed',
        sessionId: undefined,
        blocker: { kind: 'setup', message: 'pnpm failed' },
      });
      expect(await scheduler.retry(created.id)).toMatchObject({ ok: true });
      await scheduler.settled();
      expect(worktrees.create.mock.calls.length).toBe(before + 1);
      expect(scheduler.get(created.id)?.state).toBe('working');
      expect(await scheduler.retry(created.id)).toMatchObject({ ok: false, code: 'not-open' });
    });

    it('adoptTasks: the open worktree tasks a session started report to it as orchestrator', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const mine = await createReady(scheduler, { createdBySessionId: 'chat-1' });
      const other = await createReady(scheduler, { createdBySessionId: 'chat-2' });
      expect(mine.createdBySessionId).toBe('chat-1');
      expect(scheduler.adoptTasks('chat-1', '/elsewhere')).toBe(0);
      expect(scheduler.adoptTasks('chat-1', '/repo/')).toBe(1);
      expect(scheduler.get(mine.id)).toMatchObject({
        origin: 'orchestrator',
        orchestratorSessionId: 'chat-1',
      });
      expect(scheduler.get(other.id)?.origin).toBe('user');
      expect(scheduler.adoptTasks('chat-1', '/repo')).toBe(0);

      // Blindar reopens the orchestrator: its tasks follow it.
      scheduler.sessionReplaced('chat-1', 'shielded-1');
      expect(scheduler.get(mine.id)).toMatchObject({
        orchestratorSessionId: 'shielded-1',
        createdBySessionId: 'shielded-1',
      });
    });

    it('answers at once while preparing, then launches in the worktree with the instructions', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await scheduler.create(task({ isolation: 'worktree' }));
      expect(created.state).toBe('preparing');
      expect(created.sessionId).toBeUndefined();
      await scheduler.settled();
      expect(scheduler.get(created.id)).toMatchObject({
        state: 'working',
        isolation: 'worktree',
        branch: 'ut/arregla-los-tests',
        baseBranch: 'main',
        baseSha: 'abc123',
        worktreePath: '/wt/1',
        repoPath: '/repo',
        sessionId: 's1',
      });
      const [record, prompt] = launch.mock.calls[0];
      expect(record.worktreePath).toBe('/wt/1');
      expect(prompt).toContain('Revisa los tests de app');
      expect(prompt).toContain('`ut/arregla-los-tests`');
      expect(prompt).toContain('ut task done');
      expect(worktrees.create.mock.calls[0][1]).toEqual({
        logPath: path.join(dir, 'logs', created.id, 'setup.log'),
        onPlanned: expect.any(Function),
      });
    });

    it('uses the project settings to make the worktree', async () => {
      const settings = {
        get: vi.fn(() => ({
          ...DEFAULT_PROJECT_SETTINGS,
          baseBranch: 'develop',
          worktreeRoot: '/elsewhere',
          setupCommand: 'make deps',
          cloneDirs: ['vendor'],
        })),
      };
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-sched-repo-'));
      execFileSync('git', ['init', '-q', repo]);
      const scheduler = new TaskScheduler({
        storePath: store,
        launch: launch as unknown as (t: TaskRecord, p: string) => Promise<{ sessionId: string }>,
        notify: notify as unknown as (p: NotificationPayload) => void,
        sessionStatus: () => 'running',
        worktrees,
        settings,
        now: () => Date.now(),
      });
      schedulers.push(scheduler);
      await scheduler.start(0);
      await scheduler.create(task({ isolation: 'worktree', workingDir: repo }));
      await scheduler.settled();
      expect(settings.get).toHaveBeenCalledWith(fs.realpathSync(repo));
      expect(worktrees.create.mock.calls[0][0].baseBranch).toBe('develop');
      expect(worktrees.create.mock.calls[0][1]).toMatchObject({
        worktreeRoot: '/elsewhere',
        setupCommand: 'make deps',
        cloneDirs: ['vendor'],
      });
      fs.rmSync(repo, RM_TEST_DIR);
    });

    it('a failed setup fails the task with its reason', async () => {
      const { TaskWorktreeError } = await import('./task-worktree.js');
      worktrees.create.mockRejectedValueOnce(
        new TaskWorktreeError('Install failed: pnpm install', ['ERR_PNPM_X'])
      );
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler);
      expect(created).toMatchObject({
        state: 'failed',
        blocker: { kind: 'setup', message: 'Install failed: pnpm install', detail: ['ERR_PNPM_X'] },
      });
      expect(launch).not.toHaveBeenCalled();
    });

    it('discarded while preparing: the worktree goes as soon as it is made, nothing launches', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await scheduler.create(task({ isolation: 'worktree' }));
      expect((await scheduler.discard(created.id)).ok).toBe(true);
      await scheduler.settled();
      expect(launch).not.toHaveBeenCalled();
      expect(worktrees.remove).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/wt/1' }),
        { deleteUnmerged: true }
      );
      expect(scheduler.get(created.id)?.state).toBe('discarded');
    });

    it('done with commits → the merge pipeline → merged, session ended, one push', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler);
      commits = 2;
      pipeline.mockImplementationOnce(async (_t, options) => {
        options.onProgress({
          state: 'verifying',
          verify: { command: 'pnpm test', cwd: '/wt/1', startedAt: 'x', queued: true },
        });
        expect(scheduler.get(created.id)).toMatchObject({
          state: 'verifying',
          verify: { queued: true },
        });
        options.onProgress({ state: 'merging' });
        expect(scheduler.get(created.id)?.state).toBe('merging');
        await options.beforeCleanup();
        return { state: 'merged', mergedSha: 'def456', baseSha: 'abc999' };
      });
      await scheduler.markDone('s1', 'Arreglados 3 tests');
      await scheduler.settled();
      expect(worktrees.commitLeftovers).toHaveBeenCalled();
      expect(pipeline.mock.calls[0][1]).toMatchObject({ mode: 'auto' });
      expect(pipeline.mock.calls[0][1].logDir).toBe(path.join(dir, 'logs', created.id));
      expect(stopSession).toHaveBeenCalledWith('s1');
      expect(scheduler.get(created.id)).toMatchObject({
        state: 'merged',
        mergedSha: 'def456',
        baseSha: 'abc999',
        files: ['src/a.ts'],
        summary: 'Arreglados 3 tests',
      });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({
        type: 'task-merged',
        title: '✅ Task merged: Arregla los tests',
        data: { taskId: created.id, where: 'Arregla los tests', branch: 'main' },
      });
    });

    it('the pipeline stopping short leaves the task with its reason and the matching push', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const cases = [
        [{ state: 'ready' }, 'task-ready'],
        [
          { state: 'needs_you', blocker: { kind: 'conflict', message: 'Conflicts' } },
          'task-needs-you',
        ],
        [
          { state: 'failed', blocker: { kind: 'verify', message: 'The check failed' } },
          'task-failed',
        ],
      ] as const;
      commits = 1;
      for (const [result, type] of cases) {
        notify.mockClear();
        // Policy ask: no automatic fix, the user hears of each stop.
        const created = await createReady(scheduler, { mergePolicy: 'ask' });
        pipeline.mockResolvedValueOnce(result);
        await scheduler.markDone(created.sessionId as string);
        await scheduler.settled();
        expect(scheduler.get(created.id)).toMatchObject(result);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ type });
        if ('blocker' in result) {
          expect(notify.mock.calls[0][0].data.blocker).toBe(result.blocker.kind);
        }
      }
      expect(stopSession).not.toHaveBeenCalled();
    });

    it('the same outcome again with no new turn sends no second push', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      commits = 1;
      const created = await createReady(scheduler);
      notify.mockClear();
      pipeline.mockResolvedValue({ state: 'ready' });
      await scheduler.markDone(created.sessionId as string);
      await scheduler.settled();
      // A redraw read as busy then idle runs the pipeline again: same result, no news.
      await scheduler.markDone(created.sessionId as string);
      await scheduler.settled();
      expect(notify).toHaveBeenCalledTimes(1);
      pipeline.mockReset();
    });

    it('merge, verify and fix from the user', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler, { mergePolicy: 'ask' });
      commits = 1;
      pipeline.mockResolvedValueOnce({
        state: 'failed',
        blocker: { kind: 'verify', message: 'The check failed', detail: ['1 failed'] },
        verify: { command: 'pnpm test', cwd: '/wt/1', startedAt: 'x', exitCode: 1, tail: 'FAIL a' },
      });
      await scheduler.markDone('s1');
      await scheduler.settled();
      expect(scheduler.get(created.id)?.state).toBe('failed');

      // "Que lo arregle": the failure goes to the agent, the task is back at work.
      const fixed = await scheduler.fix(created.id);
      expect(fixed).toMatchObject({ ok: true, task: { state: 'working' } });
      const text = deliver.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain('pnpm test');
      expect(text).toContain('FAIL a');
      expect(text).toContain('ut task done');
      expect(await scheduler.fix(created.id)).toMatchObject({ ok: false, code: 'not-fixable' });

      // "Fusionar" with risk accepted: verifying at once, the pipeline in merge mode.
      await scheduler.markDone('s1');
      await scheduler.settled();
      expect(scheduler.get(created.id)?.state).toBe('merged');
      const other = await createReady(scheduler);
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await scheduler.markDone(other.sessionId as string);
      await scheduler.settled();
      let gate: () => void = () => {};
      pipeline.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            gate = () => resolve({ state: 'merged', mergedSha: 'x1' });
          })
      );
      expect(scheduler.merge(other.id, { acceptRisk: true })).toMatchObject({
        ok: true,
        task: { state: 'verifying' },
      });
      expect(scheduler.merge(other.id)).toMatchObject({ ok: false, code: 'busy' });
      expect(await scheduler.discard(other.id, { confirm: true })).toMatchObject({
        ok: false,
        code: 'busy',
      });
      gate();
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'merge', acceptRisk: true });
      expect(scheduler.get(other.id)?.state).toBe('merged');
      expect(scheduler.verify(other.id)).toMatchObject({ ok: false, code: 'not-open' });

      const third = await createReady(scheduler);
      expect(scheduler.verify(third.id)).toMatchObject({ ok: false, code: 'busy' });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await scheduler.markDone(third.sessionId as string);
      await scheduler.settled();
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      expect(scheduler.verify(third.id).ok).toBe(true);
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'verify' });
      expect(scheduler.logPath(third.id, 'verify')).toBe(
        path.join(dir, 'logs', third.id, 'verify.log')
      );
    });

    it('an AI review blocker: its push, the fix with its issues, merging anyway; unavailable is noted', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler, { mergePolicy: 'ask' });
      commits = 1;
      const review = {
        verdict: 'concerns' as const,
        summary: 'Divide entre n-1',
        issues: [{ file: 'src/a.ts', line: 3, severity: 'high' as const, what: 'Divide mal' }],
        at: 'x',
        model: 'sonnet',
        headSha: 'h1',
      };
      pipeline.mockImplementationOnce(async (_t, options) => {
        options.onProgress?.({ state: 'reviewing' });
        expect(scheduler.get(created.id)).toMatchObject({ state: 'verifying', reviewing: true });
        return {
          state: 'needs_you',
          blocker: {
            kind: 'review',
            message: 'Divide entre n-1',
            detail: ['high · src/a.ts:3 · Divide mal'],
          },
          review,
        };
      });
      notify.mockClear();
      await scheduler.markDone('s1');
      await scheduler.settled();
      const stopped = scheduler.get(created.id);
      expect(stopped).toMatchObject({ state: 'needs_you', blocker: { kind: 'review' }, review });
      expect(stopped?.reviewing).toBeUndefined();
      expect(notify.mock.calls[0][0]).toMatchObject({
        type: 'task-needs-you',
        title: '🔎 Review: Arregla los tests',
        body: 'Divide entre n-1',
        data: { blocker: 'review', detail: 'Divide entre n-1' },
      });

      // "Que lo arregle": the issues go to the agent.
      expect(await scheduler.fix(created.id)).toMatchObject({
        ok: true,
        task: { state: 'working' },
      });
      const text = deliver.mock.calls.at(-1)?.[1] as string;
      expect(text).toContain('AI review');
      expect(text).toContain('high · src/a.ts:3 · Divide mal');
      expect(text).toContain('ut task done');

      // Stopped again; the user merges anyway (the options reach the pipeline).
      pipeline.mockResolvedValueOnce({
        state: 'needs_you',
        blocker: { kind: 'review', message: 'Divide entre n-1' },
        review,
      });
      await scheduler.markDone('s1');
      await scheduler.settled();
      pipeline.mockResolvedValueOnce({ state: 'merged', mergedSha: 'm1', review });
      expect(scheduler.merge(created.id, { acceptReview: true }).ok).toBe(true);
      await scheduler.settled();
      expect(pipeline.mock.calls.at(-1)?.[1]).toMatchObject({ mode: 'merge', acceptReview: true });
      expect(scheduler.get(created.id)?.state).toBe('merged');

      // A review that could not run: merged, and the push says so.
      const other = await createReady(scheduler);
      pipeline.mockResolvedValueOnce({
        state: 'merged',
        mergedSha: 'm2',
        review: { ...review, verdict: 'unavailable', summary: '', issues: [], reason: 'timeout' },
      });
      notify.mockClear();
      await scheduler.markDone(other.sessionId as string, 'Hecho');
      await scheduler.settled();
      expect(scheduler.get(other.id)?.review).toMatchObject({ verdict: 'unavailable' });
      expect(notify.mock.calls[0][0]).toMatchObject({
        type: 'task-merged',
        body: 'Hecho · AI review unavailable',
        data: { review: 'unavailable' },
      });
    });

    it('no changes → ready (no-changes), or needs you when the agent ended on a question', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const plain = await createReady(scheduler);
      await scheduler.markDone('s1');
      expect(scheduler.get(plain.id)).toMatchObject({
        state: 'ready',
        blocker: { kind: 'no-changes' },
      });
      expect(pipeline).not.toHaveBeenCalled();
      const asking = await createReady(scheduler);
      scheduler.onClaudeTransition('s2', 'idle', 'busy', busy);
      scheduler.onClaudeTransition('s2', 'busy', 'idle', idle('¿Lo hago con OAuth?'));
      await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
      expect(scheduler.get(asking.id)).toMatchObject({
        state: 'needs_you',
        blocker: { kind: 'question', message: '¿Lo hago con OAuth?' },
      });
    });

    it('a Claude task that changed nothing closes as done with its whole reply; its worktree goes (2026-10-31)', async () => {
      const report = `Revisión: ${'hallazgo. '.repeat(50)}`.trim();
      const scheduler = makeWithWorktrees({ finalReply: async () => report });
      await scheduler.start(0);
      const created = await createReady(scheduler);
      notify.mockClear();
      // Its agent went idle without `ut task done`: Claude's status is reliable, so it closes.
      scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
      scheduler.onClaudeTransition('s1', 'busy', 'idle', idle('Revisado, nada que cambiar.'));
      await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
      await scheduler.settled();
      const closed = scheduler.get(created.id) as TaskRecord;
      expect(closed).toMatchObject({ state: 'done', summary: report });
      expect(closed.blocker).toBeUndefined();
      expect(pipeline).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-done' });
      // Its session is stopped first (`ut task done` gets its answer), then worktree and branch go.
      expect(worktrees.remove).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FINISHED_SESSION_GRACE_MS);
      await scheduler.settled();
      expect(stopSession).toHaveBeenCalledWith('s1');
      expect(worktrees.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: created.id, branch: 'ut/arregla-los-tests' }),
        { deleteUnmerged: true }
      );
      expect(scheduler.get(created.id)?.worktreePath).toBeUndefined();
    });

    it('a Codex task that changed nothing closes as done on `ut task done` (2026-10-31, bakery aab57353)', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler, { agent: 'codex', command: ['codex'] });
      notify.mockClear();
      await scheduler.markDone('s1', 'Kept the dependency: it is used. No files changed.', {
        verified: 'git status --short: clean',
      });
      await scheduler.settled();
      expect(scheduler.get(created.id)).toMatchObject({
        state: 'done',
        summary: 'Kept the dependency: it is used. No files changed.',
        stats: { commits: 0, files: 0 },
      });
      expect(pipeline).not.toHaveBeenCalled();
      expect(notify.mock.calls.map(([payload]) => payload.type)).toEqual(['task-done']);
      await vi.advanceTimersByTimeAsync(FINISHED_SESSION_GRACE_MS);
      await scheduler.settled();
      expect(worktrees.remove).toHaveBeenCalledTimes(1);
    });

    describe('its structured result decides, not its prose (2026-11-01)', () => {
      const base = {
        files: [] as Array<{ path: string; why: string }>,
        tests: [] as Array<{ command: string; result: 'passed' | 'failed' | 'skipped' }>,
        risks: [] as string[],
        followUps: [] as string[],
      };
      const done = (scheduler: TaskScheduler, result: TaskResult, summary = 'Resumen') =>
        scheduler.markDone('s1', summary, { result }).then(() => scheduler.settled());

      it('no-change with no commits closes as done, a question mark in its prose or not', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        await done(scheduler, { ...base, outcome: 'no-change' }, '¿Hacía falta? No: ya estaba.');
        expect(scheduler.get(created.id)).toMatchObject({ state: 'done' });
        expect(scheduler.get(created.id)?.resultMismatch).toBeUndefined();
        expect(pipeline).not.toHaveBeenCalled();
      });

      it('partial with no commits waits ready with what is left', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        await done(scheduler, {
          ...base,
          outcome: 'partial',
          followUps: ['falta medir en el iPad', 'falta la doc'],
        });
        expect(scheduler.get(created.id)).toMatchObject({
          state: 'ready',
          blocker: {
            kind: 'partial',
            message: 'The agent says the work is partial; left to do: falta medir en el iPad',
            detail: ['falta la doc'],
          },
        });
        expect(pipeline).not.toHaveBeenCalled();
      });

      it('blocked needs the user, even with commits (no pipeline)', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        commits = 1;
        await done(scheduler, { ...base, outcome: 'blocked', followUps: ['necesito la clave'] });
        expect(scheduler.get(created.id)).toMatchObject({
          state: 'needs_you',
          blocker: { kind: 'question', message: 'The agent is blocked: necesito la clave' },
        });
        expect(pipeline).not.toHaveBeenCalled();
      });

      it('done with files but no commits is a mismatch, not closed as done', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        await done(scheduler, {
          ...base,
          outcome: 'done',
          files: [{ path: 'src/a.ts', why: 'el arreglo' }],
          tests: [{ command: 'pnpm test', result: 'passed' }],
        });
        const after = scheduler.get(created.id) as TaskRecord;
        expect(after).toMatchObject({ state: 'ready', blocker: { kind: 'result-mismatch' } });
        expect(after.resultMismatch).toBe(
          "The agent's result lists changed files (src/a.ts), but its branch has no change"
        );
      });

      it('a result naming a renamed file by its old path agrees with the branch (2026-11-02)', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        commits = 1;
        worktrees.changes.mockImplementation(async () => ({
          files: ['src/new.ts'],
          stats: { commits: 1, files: 1, insertions: 0, deletions: 0 },
          renamed: [{ from: 'src/old.ts', to: 'src/new.ts' }],
        }));
        await done(scheduler, {
          ...base,
          outcome: 'done',
          files: [{ path: './src/old.ts', why: 'renombrado' }],
          tests: [{ command: 'pnpm test', result: 'passed' }],
        });
        expect(scheduler.get(created.id)?.resultMismatch).toBeUndefined();
        expect(pipeline).toHaveBeenCalled();
      });

      describe('its memory note (2026-11-03)', () => {
        const note = {
          name: 'flaky-check',
          description: 'checks flake under load',
          body: 'Wait for markers.',
        };
        const withNote = {
          ...base,
          outcome: 'done' as const,
          files: [{ path: 'src/a.ts', why: 'el arreglo' }],
          tests: [{ command: 'pnpm test', result: 'passed' as const }],
          memoryNote: note,
        };
        let home: string;
        beforeEach(() => {
          home = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-sched-memory-'));
          worktrees.changes.mockImplementation(async () => ({
            files: ['src/a.ts'],
            stats: { commits: 1, files: 1, insertions: 1, deletions: 0 },
          }));
        });
        afterEach(() => fs.rmSync(home, RM_TEST_DIR));
        const withMemoryDir = (memoryDir?: string) =>
          makeWithWorktrees({
            memoryHome: home,
            settings: {
              get: () => ({ ...DEFAULT_PROJECT_SETTINGS, ...(memoryDir ? { memoryDir } : {}) }),
            },
          });

        it('is saved in the memoryDir once the task merges', async () => {
          const memory = path.join(home, '.claude', 'projects', '-repo', 'memory');
          fs.mkdirSync(memory, { recursive: true });
          const scheduler = withMemoryDir('auto');
          await scheduler.start(0);
          const created = await createReady(scheduler);
          commits = 1;
          await done(scheduler, withNote);
          const merged = scheduler.get(created.id) as TaskRecord;
          expect(merged.state).toBe('merged');
          expect(merged.memoryNote).toEqual({
            saved: path.join(memory, 'flaky-check.md'),
            updated: false,
          });
          expect(fs.readFileSync(path.join(memory, 'flaky-check.md'), 'utf8')).toContain(
            'Wait for markers.'
          );
          expect(fs.readFileSync(path.join(memory, 'MEMORY.md'), 'utf8')).toBe(
            '- [Flaky check](flaky-check.md) — checks flake under load\n'
          );
        });

        it("off (Claude Code's folder there or not): nothing is written, the task says why", async () => {
          fs.mkdirSync(path.join(home, '.claude', 'projects', '-repo', 'memory'), {
            recursive: true,
          });
          const scheduler = withMemoryDir();
          await scheduler.start(0);
          const created = await createReady(scheduler);
          commits = 1;
          await done(scheduler, withNote);
          const merged = scheduler.get(created.id) as TaskRecord;
          expect(merged.state).toBe('merged');
          expect(merged.memoryNote).toEqual({ skipped: 'memoryDir is off for this project' });
          expect(fs.readdirSync(path.join(home, '.claude', 'projects', '-repo', 'memory'))).toEqual(
            []
          );
        });

        it('a task that does not merge saves nothing yet', async () => {
          pipeline.mockResolvedValueOnce({ state: 'ready' });
          const scheduler = withMemoryDir(home);
          await scheduler.start(0);
          const created = await createReady(scheduler);
          commits = 1;
          await done(scheduler, withNote);
          expect(scheduler.get(created.id)?.memoryNote).toBeUndefined();
          expect(fs.readdirSync(home)).toEqual([]);
        });
      });

      it('no-change with commits goes through the pipeline with its result and the mismatch', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        commits = 1;
        await done(scheduler, { ...base, outcome: 'no-change' });
        expect(pipeline).toHaveBeenCalledWith(
          expect.objectContaining({
            id: created.id,
            result: expect.objectContaining({ outcome: 'no-change' }),
            resultMismatch:
              "The agent's result says no-change, but its branch has changes (src/a.ts)",
          }),
          expect.anything()
        );
      });
    });

    it('a ready task nobody acts on reminds the user once per interval, spaced out (2026-10-31)', async () => {
      const projectNotice = vi.fn(() => true);
      const scheduler = makeWithWorktrees({ projectNotice });
      await scheduler.start(0);
      unmerged = true;
      const created = await createReady(scheduler);
      await scheduler.markDone('s1', 'Hecho');
      await scheduler.settled();
      expect(scheduler.get(created.id)?.state).toBe('ready');
      notify.mockClear();
      const reminders = () =>
        notify.mock.calls.filter(([payload]) => typeof payload.data?.reminder === 'string');

      await vi.advanceTimersByTimeAsync(STALE_REMIND_MS - 1000);
      await scheduler.checkExited();
      expect(reminders()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2000);
      await scheduler.checkExited();
      await scheduler.checkExited();
      expect(reminders()).toHaveLength(1);
      expect(reminders()[0][0]).toMatchObject({
        type: 'task-ready',
        body: expect.stringContaining('Still ready after 30 min'),
      });
      expect(reminders()[0][0].data?.quiet).toBeUndefined();
      // Not its orchestrator's task: the project's orchestrator, if any, hears too.
      expect(projectNotice).toHaveBeenCalledTimes(1);
      expect(projectNotice.mock.calls[0]).toEqual([
        '/repo',
        expect.stringContaining('not yours: the user started it'),
      ]);

      // The next one twice as long later (60 min), not before; a restart does not repeat it.
      await vi.advanceTimersByTimeAsync(STALE_REMIND_MS * 2 - 2000);
      await scheduler.checkExited();
      expect(reminders()).toHaveLength(1);
      scheduler.stop();
      const restarted = makeWithWorktrees({ projectNotice });
      await restarted.start(0);
      await restarted.checkExited();
      expect(reminders()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000);
      await restarted.checkExited();
      expect(reminders()).toHaveLength(2);
      expect(restarted.get(created.id)?.staleReminder?.count).toBe(2);
    });

    it("an orchestrator's stale task reminds its orchestrator (quiet), not the project notice", async () => {
      const projectNotice = vi.fn(() => true);
      const scheduler = makeWithWorktrees({ projectNotice });
      await scheduler.start(0);
      unmerged = true;
      const created = await createReady(scheduler, {
        origin: 'orchestrator',
        orchestratorSessionId: 'orch-1',
        notify: false,
      });
      await scheduler.markDone('s1', 'Hecho');
      await scheduler.settled();
      notify.mockClear();
      await vi.advanceTimersByTimeAsync(STALE_REMIND_MS + 1000);
      await scheduler.checkExited();
      await scheduler.checkExited();
      const sent = notify.mock.calls.map(([payload]) => payload);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'task-ready',
        data: { taskId: created.id, quiet: true, reminder: expect.stringContaining('Still ready') },
      });
      expect(projectNotice).not.toHaveBeenCalled();

      // Ready again with nothing pushed (a silent re-run, same commit): the new spell's first
      // reminder is no repeat of the last spell's (pushes dedupe on their key).
      const internal = (scheduler as unknown as { tasks: TaskRecord[] }).tasks;
      const record = internal.find((t) => t.id === created.id) as TaskRecord;
      record.stateSince = new Date(Date.now()).toISOString();
      await vi.advanceTimersByTimeAsync(STALE_REMIND_MS + 1000);
      await scheduler.checkExited();
      expect(notify).toHaveBeenCalledTimes(2);
    });

    it('no reminder while Untether still acts on it, or with reminders off', async () => {
      let remindMs = 0;
      const scheduler = makeWithWorktrees({ staleRemindMs: () => remindMs });
      await scheduler.start(0);
      unmerged = true;
      const off = await createReady(scheduler);
      await scheduler.markDone('s1', 'Hecho');
      await scheduler.settled();
      notify.mockClear();
      await vi.advanceTimersByTimeAsync(STALE_REMIND_MS * 4);
      await scheduler.checkExited();
      expect(notify).not.toHaveBeenCalled();
      // On again, but counting down to its merge: Untether merges it, nobody has to act.
      remindMs = STALE_REMIND_MS;
      const internal = (scheduler as unknown as { tasks: TaskRecord[] }).tasks;
      const record = internal.find((t) => t.id === off.id) as TaskRecord;
      record.autoMergeAt = new Date(Date.now() + 60_000).toISOString();
      await scheduler.checkExited();
      expect(notify).not.toHaveBeenCalled();
      delete record.autoMergeAt;
      await scheduler.checkExited();
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('a ready task that changed nothing closes as done once its orchestrator got the report', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      unmerged = true;
      const created = await createReady(scheduler);
      await scheduler.markDone('s1', 'Informe');
      await scheduler.settled();
      expect(await scheduler.closeReported(created.id)).toBe(false);
      unmerged = false;
      expect(await scheduler.closeReported(created.id)).toBe(true);
      expect(scheduler.get(created.id)).toMatchObject({ state: 'done', summary: 'Informe' });
      expect(await scheduler.closeReported(created.id)).toBe(false);
    });

    it('a pipeline that finds nothing left to merge closes a Claude task, never a Codex one', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      commits = 1;
      const claude = await createReady(scheduler);
      pipeline.mockResolvedValueOnce({
        state: 'ready',
        blocker: { kind: 'no-changes', message: 'The agent changed nothing' },
      });
      await scheduler.markDone('s1', 'Hecho');
      await scheduler.settled();
      expect(scheduler.get(claude.id)?.state).toBe('done');
      const codex = await createReady(scheduler, { agent: 'codex', command: ['codex'] });
      pipeline.mockResolvedValueOnce({
        state: 'ready',
        blocker: { kind: 'no-changes', message: 'The agent changed nothing' },
      });
      await scheduler.markDone('s2', 'Hecho');
      await scheduler.settled();
      expect(scheduler.get(codex.id)).toMatchObject({
        state: 'ready',
        blocker: { kind: 'no-changes' },
      });
    });

    it('a task that left work in its worktree is not closed (2026-10-31)', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      // Uncommitted changes Untether commits: they go through the pipeline as before.
      const leftovers = await createReady(scheduler);
      worktrees.commitLeftovers.mockImplementationOnce(async () => {
        commits = 1;
        return true;
      });
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      await scheduler.markDone('s1', 'Hecho');
      await scheduler.settled();
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(scheduler.get(leftovers.id)?.state).toBe('ready');
      // Files it may not commit (cloneDirs, node_modules) left behind: ready, never closed.
      commits = 0;
      unmerged = true;
      const kept = await createReady(scheduler);
      await scheduler.markDone('s2', 'Hecho');
      await scheduler.settled();
      expect(scheduler.get(kept.id)).toMatchObject({
        state: 'ready',
        blocker: { kind: 'no-changes' },
      });
      await vi.advanceTimersByTimeAsync(FINISHED_SESSION_GRACE_MS);
      expect(worktrees.remove).not.toHaveBeenCalled();
    });

    it('a session that ended without commits fails the task; with commits it goes on', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const empty = await createReady(scheduler);
      statuses.set('s1', 'exited');
      await scheduler.checkExited();
      expect(scheduler.get(empty.id)).toMatchObject({
        state: 'failed',
        blocker: { kind: 'session-exit' },
      });
      const withWork = await createReady(scheduler);
      commits = 1;
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      statuses.set('s2', 'exited');
      await scheduler.checkExited();
      await scheduler.settled();
      expect(scheduler.get(withWork.id)?.state).toBe('ready');
    });

    it('discard asks for confirmation when work would be lost, then removes it all', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler);
      unmerged = true;
      expect(await scheduler.discard(created.id)).toMatchObject({
        ok: false,
        code: 'needs-confirmation',
      });
      expect(worktrees.remove).not.toHaveBeenCalled();
      expect(scheduler.remove(created.id)).toBe('active');
      const result = await scheduler.discard(created.id, { confirm: true });
      expect(result).toMatchObject({ ok: true, task: { state: 'discarded' } });
      expect(worktrees.remove).toHaveBeenCalledWith(expect.objectContaining({ id: created.id }), {
        deleteUnmerged: true,
      });
      expect(await scheduler.discard(created.id)).toMatchObject({ ok: false, code: 'not-open' });
      expect(scheduler.remove(created.id)).toBe('removed');
    });

    it('a parallel group gets one worktree each, suffixed, and never merges on its own', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const group = await scheduler.createGroup(task({ mergePolicy: 'auto' }), 2);
      await scheduler.settled();
      const tasks = group.map((t) => scheduler.get(t.id) as TaskRecord);
      expect(tasks.map((t) => t.branch)).toEqual([
        'ut/arregla-los-tests-a',
        'ut/arregla-los-tests-b',
      ]);
      expect(new Set(tasks.map((t) => t.groupId)).size).toBe(1);
      expect(tasks.map((t) => [t.isolation, t.groupIndex, t.mergePolicy])).toEqual([
        ['worktree', 0, 'ask'],
        ['worktree', 1, 'ask'],
      ]);
    });

    it('drops the plain "Claude finished" of a task session in every state', async () => {
      const scheduler = makeWithWorktrees();
      await scheduler.start(0);
      const created = await createReady(scheduler);
      commits = 1;
      await scheduler.markDone('s1');
      await scheduler.settled();
      expect(scheduler.get(created.id)?.state).toBe('merged');
      const finished = {
        type: 'claude-finished',
        title: 'x',
        body: 'y',
        data: { sessionId: 's1' },
      };
      expect(scheduler.rewritePush(finished)).toBeNull();
      const other = { ...finished, data: { sessionId: 'other' } };
      expect(scheduler.rewritePush(other)).toBe(other);
    });

    describe('2026-10-20 audit', () => {
      const internal = (scheduler: TaskScheduler) =>
        (scheduler as unknown as { tasks: TaskRecord[] }).tasks;

      it('a restart resumes a pipeline the way it was asked: verify stays verify, the user merge keeps acceptRisk', async () => {
        const first = makeWithWorktrees();
        await first.start(0);
        const checked = await createReady(first);
        const merging = await createReady(first);
        commits = 1;
        // Both pipelines hang (the server stops under them).
        pipeline.mockImplementation(() => new Promise(() => {}));
        await first.markDone(checked.sessionId as string);
        statuses.set(checked.sessionId as string, 'running');
        expect(first.verify(checked.id)).toMatchObject({ ok: false, code: 'busy' });
        await first.markDone(merging.sessionId as string);
        first.stop();
        // The saved file as the stopped server left it, with the first one re-run as verify
        // and the second as the user's merge with risk accepted.
        const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
        const runOf = (t: TaskRecord) => t.effects?.find((e) => e.kind === 'pipeline');
        expect(saved.tasks.map((t: TaskRecord) => runOf(t)?.run.mode)).toEqual(['auto', 'auto']);
        runOf(saved.tasks[0]).run = {
          mode: 'verify',
          readyNote: { kind: 'session-exit', message: 'ended early' },
        };
        runOf(saved.tasks[1]).run = { mode: 'merge', acceptRisk: true };
        saved.tasks[1].state = 'merging';
        fs.writeFileSync(store, JSON.stringify(saved));
        pipeline.mockReset();
        pipeline.mockResolvedValue({ state: 'ready' });
        const second = makeWithWorktrees();
        await second.start(0);
        await second.settled();
        expect(pipeline.mock.calls.map(([t, o]) => [t.id, o.mode, !!o.acceptRisk])).toEqual([
          [checked.id, 'verify', false],
          [merging.id, 'merge', true],
        ]);
        expect(second.get(checked.id)).toMatchObject({
          state: 'ready',
          blocker: { kind: 'session-exit' },
        });
        expect(second.get(checked.id)?.effects).toBeUndefined();
      });

      it('a restart while it waits in the merge queue keeps its place: the saved since goes back to the pipeline (2026-11-01)', async () => {
        const first = makeWithWorktrees();
        await first.start(0);
        const created = await createReady(first);
        commits = 1;
        const since = '2026-11-01T09:00:00.000Z';
        // Waiting third in line when the server stops under it.
        pipeline.mockImplementation((_task: PipelineTask, opts: PipelineOptions) => {
          opts.onProgress?.({ state: 'merge-queue', spot: { position: 3, of: 3, since } });
          return new Promise(() => {});
        });
        await first.markDone(created.sessionId as string);
        await vi.waitFor(() => expect(first.get(created.id)?.mergeQueue?.since).toBe(since));
        first.stop();
        const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
        expect(saved.tasks[0].mergeQueue).toMatchObject({ position: 3, since });
        pipeline.mockReset();
        pipeline.mockResolvedValue({ state: 'ready' });
        const second = makeWithWorktrees();
        await second.start(0);
        await second.settled();
        expect(pipeline).toHaveBeenCalledTimes(1);
        expect((pipeline.mock.calls[0][0] as PipelineTask).mergeQueue?.since).toBe(since);
        // The run over, it is out of the line.
        expect(second.get(created.id)?.mergeQueue).toBeUndefined();
      });

      it('2026-10-31: a restart between moving the base and saving "merged" finishes the merge, not a new one (the move recorded first, 2026-11-01)', async () => {
        const first = makeWithWorktrees();
        await first.start(0);
        const created = await createReady(first);
        commits = 1;
        let moved: () => void = () => {};
        const baseMoved = new Promise<void>((resolve) => (moved = resolve));
        // The move is recorded, the base moves, then the server restarts (its own files
        // changed) before anything else.
        pipeline.mockImplementationOnce(async (_t, options) => {
          options.onProgress({ state: 'merging' });
          options.onMoveBase({ sha: 'e3c12c3', onto: 'd2493e3' });
          moved();
          return new Promise(() => {});
        });
        await first.markDone(created.sessionId as string);
        await baseMoved;
        first.stop();
        const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
        expect(saved.tasks[0]).toMatchObject({ state: 'merging' });
        expect(saved.tasks[0].effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'pipeline', run: { mode: 'auto' } }),
            expect.objectContaining({ kind: 'base', sha: 'e3c12c3', onto: 'd2493e3' }),
          ])
        );

        notify.mockClear();
        pipeline.mockReset();
        const finishMerge = vi.fn(async () => ({
          state: 'merged' as const,
          mergedSha: 'e3c12c3',
          baseSha: 'e3c12c3',
          mergedOnto: 'd2493e3',
        }));
        const second = makeWithWorktrees({ finishMerge });
        await second.start(0);
        await second.settled();
        expect(pipeline).not.toHaveBeenCalled();
        expect(finishMerge).toHaveBeenCalledTimes(1);
        expect(finishMerge.mock.calls[0][0].effects).toContainEqual(
          expect.objectContaining({ kind: 'base', sha: 'e3c12c3' })
        );
        const after = second.get(created.id) as TaskRecord;
        expect(after).toMatchObject({
          state: 'merged',
          mergedSha: 'e3c12c3',
          mergedOnto: 'd2493e3',
        });
        expect(after.effects).toBeUndefined();
        expect(after.blocker).toBeUndefined();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toMatchObject({ type: 'task-merged' });
      });

      it('2026-10-31: a moved base the restart no longer finds in the base runs the pipeline as asked', async () => {
        const first = makeWithWorktrees();
        await first.start(0);
        const created = await createReady(first);
        first.stop();
        const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
        Object.assign(saved.tasks[0], {
          state: 'merging',
          effects: [
            { kind: 'pipeline', key: 'pipeline', at: 'x', run: { mode: 'merge' } },
            { kind: 'base', key: 'e3c12c3', at: 'x', sha: 'e3c12c3', onto: 'd2493e3' },
          ],
        });
        fs.writeFileSync(store, JSON.stringify(saved));
        pipeline.mockReset();
        pipeline.mockResolvedValue({ state: 'merged', mergedSha: 'f00', baseSha: 'f00' });
        const finishMerge = vi.fn(async () => null);
        const second = makeWithWorktrees({ finishMerge });
        await second.start(0);
        await second.settled();
        expect(finishMerge).toHaveBeenCalledTimes(1);
        expect(pipeline.mock.calls.map(([t, o]) => [t.id, o.mode])).toEqual([
          [created.id, 'merge'],
        ]);
        expect(second.get(created.id)).toMatchObject({ state: 'merged', mergedSha: 'f00' });
        expect(second.get(created.id)?.effects).toBeUndefined();
      });

      it('2026-11-01: a failed task with no step recorded is left as it is at startup (no load-time repair)', async () => {
        // Every base move is recorded before it is made (task journal): a restart can no
        // longer leave a merged task failed, so nothing second-guesses failures at load.
        const first = makeWithWorktrees();
        await first.start(0);
        const created = await createReady(first);
        first.stop();
        const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
        Object.assign(saved.tasks[0], {
          state: 'failed',
          error: 'The task branch has no commit',
          headSha: 'e3c12c3',
          blocker: { kind: 'merge-error', message: 'The task branch has no commit' },
        });
        fs.writeFileSync(store, JSON.stringify(saved));
        notify.mockClear();
        pipeline.mockReset();
        const finishMerge = vi.fn(async () => null);
        const second = makeWithWorktrees({ finishMerge });
        await second.start(0);
        await second.settled();
        expect(finishMerge).not.toHaveBeenCalled();
        expect(pipeline).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(second.get(created.id)).toMatchObject({
          state: 'failed',
          blocker: { kind: 'merge-error' },
          stateSince: saved.tasks[0].stateSince,
        });
      });

      it('a discard while finish commits the leftovers waits (busy); finish never brings it back', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        let release: () => void = () => {};
        worktrees.commitLeftovers.mockImplementationOnce(
          () => new Promise<boolean>((resolve) => (release = () => resolve(false)))
        );
        commits = 1;
        const done = scheduler.markDone(created.sessionId as string);
        expect(await scheduler.discard(created.id, { confirm: true })).toMatchObject({
          ok: false,
          code: 'busy',
        });
        release();
        await done;
        await scheduler.settled();
        expect(scheduler.get(created.id)?.state).toBe('merged');
      });

      it('discarded while its session starts: the new session is stopped, the task stays discarded', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        let started: (value: { sessionId: string }) => void = () => {};
        launch.mockImplementationOnce(
          () => new Promise((resolve) => (started = resolve as typeof started))
        );
        const created = await scheduler.create(task({ isolation: 'worktree' }));
        // Let the worktree be made; the launch hangs.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(launch).toHaveBeenCalledTimes(1);
        expect((await scheduler.discard(created.id, { confirm: true })).ok).toBe(true);
        started({ sessionId: 'late-1' });
        await scheduler.settled();
        expect(scheduler.get(created.id)?.state).toBe('discarded');
        expect(stopSession).toHaveBeenCalledWith('late-1');
      });

      it('start() does not wait for overdue tasks: the exit check runs from the start', async () => {
        const first = makeWithWorktrees();
        await first.start(0);
        await first.create(task({ runAt: new Date(Date.now() + 60_000) }));
        first.stop();
        vi.setSystemTime(Date.now() + 120_000);
        launch.mockImplementationOnce(() => new Promise(() => {}));
        const second = makeWithWorktrees();
        // Before the fix this await never ended: the launch it waited for hangs.
        await second.start(0);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(second.list()[0].state).toBe('working');
      });

      it('Reintentar on a failed task whose session still runs tells that session, no second one', async () => {
        const resume = vi.fn(async () => ({ sessionId: 'second' }));
        const scheduler = makeWithWorktrees({ resume, claudeConversation: () => 'conv-1' });
        await scheduler.start(0);
        const created = await createReady(scheduler);
        Object.assign(internal(scheduler).find((t) => t.id === created.id) ?? {}, {
          state: 'failed',
          blocker: { kind: 'verify', message: 'The check failed' },
        });
        expect(await scheduler.retry(created.id)).toMatchObject({
          ok: true,
          task: { state: 'working', sessionId: created.sessionId },
        });
        expect(resume).not.toHaveBeenCalled();
        expect(deliver).toHaveBeenCalledWith(created.sessionId, TASK_RETRY_TEXT, 'claude', {
          trustFolder: true,
        });
      });

      it("the user's reopens never run out: fix after fix after fix reopens the conversation", async () => {
        let n = 0;
        const resume = vi.fn(async () => ({ sessionId: `again-${++n}` }));
        const scheduler = makeWithWorktrees({ resume, claudeConversation: () => 'conv-1' });
        await scheduler.start(0);
        const created = await createReady(scheduler);
        const record = internal(scheduler).find((t) => t.id === created.id) as TaskRecord;
        for (let i = 0; i < 4; i++) {
          Object.assign(record, {
            state: 'failed',
            blocker: { kind: 'verify', message: 'The check failed' },
          });
          statuses.set(record.sessionId as string, 'exited');
          expect(await scheduler.fix(created.id), `fix ${i}`).toMatchObject({ ok: true });
          await scheduler.settled();
        }
        expect(resume).toHaveBeenCalledTimes(4);
        expect(scheduler.get(created.id)).toMatchObject({ reopens: 4 });
      });

      it('a discarded task, or a pipeline that threw, frees the tasks waiting on its branch', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const original = await createReady(scheduler);
        const fix = await createReady(scheduler);
        const fixRecord = internal(scheduler).find((t) => t.id === fix.id) as TaskRecord;
        fixRecord.baseBranch = original.branch;
        commits = 1;
        pipeline.mockResolvedValueOnce({
          state: 'needs_you',
          blocker: { kind: 'dirty-base', message: 'changes not committed' },
        });
        await scheduler.markDone(fix.sessionId as string);
        await scheduler.settled();
        pipeline.mockClear();
        pipeline.mockResolvedValueOnce({
          state: 'failed',
          blocker: { kind: 'merge-error', message: 'The base branch is gone' },
        });
        expect((await scheduler.discard(original.id, { confirm: true })).ok).toBe(true);
        await scheduler.settled();
        expect(pipeline.mock.calls.map((call) => (call[0] as TaskRecord).id)).toEqual([fix.id]);
        expect(scheduler.get(fix.id)?.state).toBe('failed');
      });

      it('a commit hook that fails stops with its own reason, and the fix prompt says so', async () => {
        const { TaskWorktreeError } = await import('./task-worktree.js');
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler, { mergePolicy: 'ask' });
        worktrees.commitLeftovers.mockRejectedValueOnce(
          new TaskWorktreeError('Committing the changes failed', ['lint: 3 errors'])
        );
        await scheduler.markDone(created.sessionId as string);
        expect(scheduler.get(created.id)).toMatchObject({
          state: 'needs_you',
          blocker: { kind: 'merge-error', message: 'Committing what the agent left failed' },
        });
        expect((await scheduler.fix(created.id)).ok).toBe(true);
        const text = deliver.mock.calls.at(-1)?.[1] as string;
        expect(text).toContain('could not commit');
        expect(text).toContain('lint: 3 errors');
        expect(text).not.toContain('check failed');
      });

      it('a worktree half made when the server stopped is removed on start', async () => {
        const first = makeWithWorktrees();
        await first.start(0);
        worktrees.create.mockImplementationOnce(
          (_t: TaskRecord, setup: { onPlanned?: (plan: unknown) => void }) => {
            setup.onPlanned?.({ repoPath: '/repo', branch: 'ut/half', worktreePath: '/wt/half' });
            return new Promise(() => {});
          }
        );
        const created = await first.create(task({ isolation: 'worktree' }));
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(first.get(created.id)?.effects).toEqual([
          expect.objectContaining({ kind: 'worktree', branch: 'ut/half' }),
        ]);
        first.stop();
        const second = makeWithWorktrees();
        await second.start(0);
        await second.settled();
        expect(worktrees.remove).toHaveBeenCalledWith(
          expect.objectContaining({ branch: 'ut/half', worktreePath: '/wt/half' }),
          { deleteUnmerged: true }
        );
        // Nothing of it ran: it starts over by itself (2026-11-02), in a fresh worktree.
        expect(second.get(created.id)?.state).toBe('working');
        expect(second.get(created.id)?.startCuts).toBeUndefined();
        expect(second.get(created.id)?.worktreePath).not.toBe('/wt/half');
        expect(second.get(created.id)?.effects).toBeUndefined();
      });

      it('two exit checks at once resume a cut-off task once', async () => {
        const first = makeWithWorktrees();
        await first.start(0);
        const created = await createReady(first);
        first.stop();
        statuses.set(created.sessionId as string, 'exited');
        let resolveResume: (value: { sessionId: string }) => void = () => {};
        const resume = vi.fn(
          () => new Promise<{ sessionId: string }>((resolve) => (resolveResume = resolve))
        );
        const second = makeWithWorktrees({ resume, claudeConversation: () => 'conv-1' });
        await second.start(0);
        const one = second.checkExited();
        const two = second.checkExited();
        resolveResume({ sessionId: 'resumed-1' });
        await Promise.all([one, two]);
        expect(resume).toHaveBeenCalledTimes(1);
        expect(second.get(created.id)).toMatchObject({ sessionId: 'resumed-1', resumes: 1 });
      });

      it('keeps the commit the base got when the pipeline stops short after it', async () => {
        const scheduler = makeWithWorktrees();
        await scheduler.start(0);
        const created = await createReady(scheduler);
        commits = 1;
        pipeline.mockResolvedValueOnce({
          state: 'needs_you',
          blocker: { kind: 'merge-error', message: 'kept' },
          mergedSha: 'm1',
        });
        await scheduler.markDone(created.sessionId as string);
        await scheduler.settled();
        expect(scheduler.get(created.id)).toMatchObject({ state: 'needs_you', mergedSha: 'm1' });
      });
    });

    it('after a restart: preparing starts over; verifying (checked only) and merging run the pipeline again', async () => {
      const first = makeWithWorktrees();
      await first.start(0);
      const a = await createReady(first);
      const b = await createReady(first);
      const c = await createReady(first);
      first.stop();
      const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
      // Cut after its worktree, before its session (none recorded on it yet).
      saved.tasks[0].state = 'preparing';
      delete saved.tasks[0].sessionId;
      // (The mock names every branch alike: a branch another task uses is never removed.)
      saved.tasks[0].branch = 'ut/cut';
      saved.tasks[1].state = 'verifying';
      saved.tasks[2].state = 'merging';
      fs.writeFileSync(store, JSON.stringify(saved));
      pipeline.mockResolvedValueOnce({ state: 'ready' });
      const second = makeWithWorktrees();
      await second.start(0);
      await second.settled();
      // Its unused worktree went and it started over in a new one, with a new session.
      expect(worktrees.remove).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: a.worktreePath }),
        { deleteUnmerged: true }
      );
      expect(second.get(a.id)?.state).toBe('working');
      expect(second.get(a.id)?.worktreePath).not.toBe(a.worktreePath);
      // No record of how they were asked: checking is checked again, never merged on its own.
      expect(pipeline.mock.calls.map(([t, o]) => [t.id, o.mode])).toEqual([
        [b.id, 'verify'],
        [c.id, 'merge'],
      ]);
      expect(second.get(b.id)?.state).toBe('ready');
      expect(second.get(c.id)?.state).toBe('merged');
    });
  });
});
