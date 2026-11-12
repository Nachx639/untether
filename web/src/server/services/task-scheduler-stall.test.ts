/**
 * Progress and stalls of working agents (2026-11-02, task-scheduler-stall.ts): task 87df7078
 * sat 1h40m on a Monitor whose notice never came while `ut task status` said "busy, last
 * activity 0m ago" (the screen's spinner). Last activity is real progress now; a wait without
 * progress is told once and nudged once; a long run that progresses is left alone.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  type AgentEvent,
  AgentStateTracker,
  CodexRolloutReader,
  claudeHookEvent,
} from './agent-events.js';
import { BACKGROUND } from './claude-status-notifier.js';
import type { NotificationPayload } from './push-notification-service.js';
import {
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';
import { BACKGROUND_WAIT, STALL_MINUTES_DEFAULT } from './task-scheduler-stall.js';

const MIN = 60_000;
const T0 = new Date(2026, 10, 2, 15, 30).getTime();

describe('agent events: real progress and what the agent waits on', () => {
  it('a tool call or result is progress; a prompt typed to it is not; the oldest open call is the wait', () => {
    const tracker = new AgentStateTracker();
    tracker.apply('s', { at: 1000, source: 'claude-hook', kind: 'turn-start' });
    expect(tracker.get('s')?.lastProgressAt).toBeUndefined();
    const monitor = claudeHookEvent(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Monitor',
        tool_use_id: 'm1',
        tool_input: { command: 'tail -f /tmp/test.log', description: 'test suite' },
      },
      2000
    ) as AgentEvent;
    expect(monitor.detail).toBe('tail -f /tmp/test.log');
    tracker.apply('s', monitor);
    tracker.apply('s', {
      at: 3000,
      source: 'claude-hook',
      kind: 'tool-start',
      tool: 'Bash',
      callId: 'b1',
    });
    expect(tracker.get('s')).toMatchObject({
      lastProgressAt: 3000,
      waitingOn: { tool: 'Monitor', detail: 'tail -f /tmp/test.log', since: 2000 },
    });
    tracker.apply('s', { at: 4000, source: 'claude-hook', kind: 'tool-end', callId: 'b1' });
    expect(tracker.get('s')?.lastProgressAt).toBe(4000);
    tracker.apply('s', { at: 5000, source: 'claude-hook', kind: 'tool-end', callId: 'm1' });
    expect(tracker.get('s')?.waitingOn).toBeUndefined();
    // Someone types to it again: no progress of its own.
    tracker.apply('s', { at: 6000, source: 'claude-hook', kind: 'turn-start' });
    expect(tracker.get('s')?.lastProgressAt).toBe(5000);
  });

  it('Codex: its messages and calls are progress, the user’s message is not; a call’s command is its detail', () => {
    const reader = new CodexRolloutReader();
    const line = (at: string, payload: Record<string, unknown>) =>
      reader.line(JSON.stringify({ timestamp: at, type: 'response_item', payload }));
    const user = line('2026-11-02T15:00:00Z', { type: 'message', role: 'user' });
    const call = line('2026-11-02T15:01:00Z', {
      type: 'function_call',
      name: 'shell',
      call_id: 'c1',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'sleep 600; cat out.log'] }),
    });
    expect(call).toMatchObject({ kind: 'tool-start', detail: 'bash -lc sleep 600; cat out.log' });
    const tracker = new AgentStateTracker();
    tracker.apply('s', user as AgentEvent);
    expect(tracker.get('s')?.lastProgressAt).toBeUndefined();
    tracker.apply('s', call as AgentEvent);
    expect(tracker.get('s')).toMatchObject({
      lastProgressAt: Date.parse('2026-11-02T15:01:00Z'),
      waitingOn: { tool: 'shell', since: Date.parse('2026-11-02T15:01:00Z') },
    });
  });
});

describe('TaskScheduler: a working agent’s progress and stalls', () => {
  let dir: string;
  let deliver: ReturnType<typeof vi.fn>;
  let pushes: NotificationPayload[];
  let tracker: AgentStateTracker;
  let screenOutput: number;
  let folder: { at: number; by: 'files' | 'commit' } | undefined;
  let schedulers: TaskScheduler[];

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    let n = 0;
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: vi.fn(async () => ({
        sessionId: `s${++n}`,
      })) as unknown as TaskSchedulerDeps['launch'],
      notify: (payload) => pushes.push(payload),
      sessionStatus: () => 'running',
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      worktrees: {
        create: vi.fn(async () => ({
          repoPath: '/repo',
          baseBranch: 'main',
          baseSha: 'abc123',
          branch: 'ut/t-1',
          worktreePath: '/wt/1',
          clonedDirs: [],
        })),
        remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
        commitLeftovers: vi.fn(async () => false),
        changes: vi.fn(async () => ({
          files: [],
          stats: { commits: 0, files: 0, insertions: 0, deletions: 0 },
        })),
        hasUnmergedWork: vi.fn(async () => false),
      } as unknown as TaskWorktrees,
      pipeline: vi.fn(async () => ({
        state: 'merged',
      })) as unknown as TaskSchedulerDeps['pipeline'],
      // The screen prints all the time (a spinner): never progress.
      lastOutputAt: () => screenOutput,
      agentState: (sessionId) => tracker.get(sessionId),
      worktreeActivity: async () => folder,
      agentCommand: () => ['claude'],
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 10,
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const newTask = (overrides: Partial<NewTask> = {}): NewTask => ({
    name: 'Tests',
    prompt: 'Run the suite',
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  });

  const feed = (event: Omit<AgentEvent, 'at' | 'source'>) =>
    tracker.apply('s1', { at: Date.now(), source: 'claude-hook', ...event });

  /** `minutes` of the scheduler's checks, one a minute; the screen prints throughout. */
  const run = async (
    scheduler: TaskScheduler,
    minutes: number,
    each?: (minute: number) => void
  ) => {
    for (let minute = 1; minute <= minutes; minute++) {
      await vi.advanceTimersByTimeAsync(MIN);
      screenOutput = Date.now();
      each?.(minute);
      await scheduler.checkExited();
      await scheduler.settled();
    }
  };

  const stalledPushes = () => pushes.filter((payload) => payload.type === 'task-stalled');
  const nudges = () =>
    deliver.mock.calls.filter(([, text]) => String(text).startsWith('[untether] No progress'));

  const started = async (scheduler: TaskScheduler) => {
    await scheduler.start(0);
    const task = await scheduler.create(newTask());
    await scheduler.settled();
    feed({ kind: 'turn-start' });
    feed({ kind: 'tool-start', tool: 'Edit', callId: 'e1' });
    feed({ kind: 'tool-end', callId: 'e1' });
    expect(scheduler.get(task.id)?.state).toBe('working');
    return task;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-stall-'));
    deliver = vi.fn(() => true);
    pushes = [];
    tracker = new AgentStateTracker();
    screenOutput = T0;
    folder = undefined;
    schedulers = [];
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('last activity is real progress: a tool result, then a commit; never the screen printing', async () => {
    const scheduler = make();
    const task = await started(scheduler);
    const toolEndAt = Date.now();
    feed({ kind: 'tool-start', tool: 'Monitor', callId: 'm1', detail: 'pnpm run test' });
    await run(scheduler, 5);
    let live = scheduler.liveState(task.id);
    // The Monitor call itself is model output (it chose to wait): progress then, not since.
    expect(Date.parse(live?.progress?.at ?? '')).toBe(toolEndAt);
    expect(live?.progress).toMatchObject({
      by: 'agent',
      waitingOn: { what: 'Monitor "pnpm run test"', since: new Date(toolEndAt).toISOString() },
    });
    // A commit in its folder, looked at while the agent is quiet: that is progress.
    folder = { at: Date.now(), by: 'commit' };
    const commitAt = folder.at;
    await run(scheduler, 2);
    live = scheduler.liveState(task.id);
    expect(live?.progress).toMatchObject({ at: new Date(commitAt).toISOString(), by: 'commit' });
    expect(scheduler.get(task.id)?.progress?.by).toBe('commit');
  });

  it('a wait with no progress: one note to whoever it reports to and one nudge; told once more past the deadline, its agent time stops counting', async () => {
    const scheduler = make();
    const task = await started(scheduler);
    const lastProgress = Date.now();
    feed({ kind: 'tool-start', tool: 'Monitor', callId: 'm1', detail: 'pnpm run test' });
    await run(scheduler, STALL_MINUTES_DEFAULT + 1);
    expect(stalledPushes()).toHaveLength(1);
    expect(nudges()).toHaveLength(1);
    const note = String(stalledPushes()[0].data?.detail);
    expect(note).toContain('No progress for');
    expect(note).toContain('Monitor "pnpm run test"');
    expect(stalledPushes()[0].data).toMatchObject({
      lastProgressAt: new Date(lastProgress).toISOString(),
      waitingOn: 'Monitor "pnpm run test"',
    });
    expect(String(nudges()[0][1])).toContain('Check that job');
    expect(scheduler.get(task.id)?.stall).toMatchObject({ waitingOn: 'Monitor "pnpm run test"' });

    // The deadline (10 min) passes with nothing: told once more, never nudged again.
    await run(scheduler, 11);
    expect(stalledPushes()).toHaveLength(2);
    expect(stalledPushes()[1].data).toMatchObject({ escalated: true });
    expect(nudges()).toHaveLength(1);
    const agentAt = scheduler.get(task.id)?.budget?.spent.agent ?? 0;
    await run(scheduler, 30);
    expect(stalledPushes()).toHaveLength(2);
    expect(nudges()).toHaveLength(1);
    expect(scheduler.get(task.id)?.budget?.spent.agent).toBe(agentAt);

    // It moves again: the stall is over and its time counts again.
    feed({ kind: 'tool-end', callId: 'm1' });
    await run(scheduler, 2);
    expect(scheduler.get(task.id)?.stall).toBeUndefined();
    expect(scheduler.get(task.id)?.budget?.spent.agent).toBeGreaterThan(agentAt);
  });

  it('waiting for a check slot is neither a stall nor agent time; both count again from when its turn came (2026-11-10)', async () => {
    let slot: { waiting: boolean; endedAt?: number } = { waiting: true };
    const scheduler = make({ checkSlotWait: () => slot });
    const task = await started(scheduler);
    feed({ kind: 'tool-start', tool: 'Bash', callId: 'b1', detail: 'pnpm run test' });
    await run(scheduler, 1);
    const agentAt = scheduler.get(task.id)?.budget?.spent.agent ?? 0;
    // 45 minutes in line for a slot, the call open all along: nobody is told, nothing typed.
    await run(scheduler, 45);
    expect(stalledPushes()).toHaveLength(0);
    expect(nudges()).toHaveLength(0);
    expect(scheduler.get(task.id)?.stall).toBeUndefined();
    expect(scheduler.get(task.id)?.budget?.spent.agent).toBe(agentAt);

    // Its turn comes and the check runs: agent time again, and no stall for the wait behind it.
    slot = { waiting: false, endedAt: Date.now() };
    await run(scheduler, STALL_MINUTES_DEFAULT - 2);
    expect(stalledPushes()).toHaveLength(0);
    expect(scheduler.get(task.id)?.budget?.spent.agent).toBeGreaterThan(agentAt);
    // Still nothing well after its turn came: that is a stall like any other.
    await run(scheduler, 4);
    expect(stalledPushes()).toHaveLength(1);
  });

  it('Claude’s reply over with background work running (busy:background) is a wait too', async () => {
    const scheduler = make();
    const task = await started(scheduler);
    feed({ kind: 'turn-end', message: 'Waiting for the test suite to finish.' });
    scheduler.onClaudeTransition('s1', 'busy', BACKGROUND, {
      status: 'busy',
      waitingForBackground: true,
    });
    await run(scheduler, STALL_MINUTES_DEFAULT + 1);
    expect(scheduler.get(task.id)?.state).toBe('working');
    expect(stalledPushes()).toHaveLength(1);
    expect(stalledPushes()[0].data?.waitingOn).toBe(BACKGROUND_WAIT);
    expect(nudges()).toHaveLength(1);
  });

  it('a long run that keeps progressing is left alone (two hours, a command open, a tool result every 5 min)', async () => {
    const scheduler = make();
    const task = await started(scheduler);
    feed({ kind: 'tool-start', tool: 'Task', callId: 'agent-1', detail: 'subagent' });
    let call = 0;
    await run(scheduler, 110, (minute) => {
      if (minute % 5 !== 0) return;
      call++;
      feed({ kind: 'tool-start', tool: 'Bash', callId: `b${call}` });
      feed({ kind: 'tool-end', callId: `b${call}` });
    });
    expect(stalledPushes()).toHaveLength(0);
    expect(nudges()).toHaveLength(0);
    expect(scheduler.get(task.id)?.stall).toBeUndefined();
    expect(scheduler.liveState(task.id)?.progress?.waitingOn?.what).toBe('Task "subagent"');
  });

  it('stallMinutes=0 turns it off', async () => {
    const scheduler = make({ settings: { get: () => ({ stallMinutes: 0 }) as never } });
    const task = await started(scheduler);
    feed({ kind: 'tool-start', tool: 'Monitor', callId: 'm1' });
    await run(scheduler, 45);
    expect(stalledPushes()).toHaveLength(0);
    expect(nudges()).toHaveLength(0);
    expect(scheduler.get(task.id)?.state).toBe('working');
  });
});
