/**
 * Failure loops of task agents (2026-11-03, agent-failure-loop.ts and task-scheduler-loops.ts):
 * the same command failing with the same error 3 times in one turn gets the agent one note;
 * different errors get none; 3 more identical failures after the note tell its orchestrator
 * once; progress after the note (the command works, or fails another way) tells nobody.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUrgentEvent, nextAction } from '../../shared/orchestrator-prompt.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { formatTaskDetail } from '../task-cli/format-task-detail.js';
import {
  type AgentEvent,
  AgentStateTracker,
  CodexRolloutReader,
  claudeHookEvent,
} from './agent-events.js';
import {
  errorLineOf,
  FailureLoops,
  failureSignature,
  loopingRun,
  normaliseCommand,
} from './agent-failure-loop.js';
import type { NotificationPayload } from './push-notification-service.js';
import {
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const T0 = new Date(2026, 10, 3, 10, 0).getTime();
const TEST_FAILURE = `Exit code 1
 FAIL  src/a.test.ts > adds
AssertionError: expected 3 to be 4
 Test Files  1 failed (1)
   Duration  2.31s`;

describe('failure signatures', () => {
  it('a command is the same without its cd prefix, whitespace or output plumbing', () => {
    expect(normaliseCommand('cd /repo/web &&  pnpm  test 2>&1 | tail -n 40')).toBe('pnpm test');
    expect(normaliseCommand('pnpm test')).toBe('pnpm test');
    expect(normaliseCommand('pnpm test src/a.test.ts')).not.toBe('pnpm test');
  });

  it('the error line is the one that says what went wrong, not "Exit code 1" or a timer', () => {
    expect(errorLineOf(TEST_FAILURE)).toBe('FAIL src/a.test.ts > adds');
    expect(errorLineOf('Exit code 2\nsomething odd')).toBe('something odd');
    // Durations and temp paths differ between runs: the same failure still.
    expect(
      failureSignature('Bash', 'pnpm test', 'Error: timed out after 5012ms in /tmp/x-81a/run')
    ).toBe(failureSignature('Bash', 'pnpm test', 'Error: timed out after 4988ms in /tmp/y-11/run'));
  });

  it('runs: counted per turn, cleared when the command works or fails another way', () => {
    const loops = new FailureLoops();
    const fail = (at: number, failure = TEST_FAILURE, turn = 1) =>
      loops.toolEnded({ tool: 'Bash', command: 'pnpm test', failure, at }, turn);
    fail(1);
    // An edit in between (the edit/test cycle) does not break the run.
    loops.toolEnded({ tool: 'Edit', command: 'src/a.ts', at: 2 }, 1);
    fail(3);
    fail(4);
    expect(loopingRun(loops.list(), 1)).toMatchObject({ turnCount: 3, count: 3 });
    // Another turn: its own count starts over, the session's goes on.
    fail(5, TEST_FAILURE, 2);
    expect(loopingRun(loops.list(), 2)).toBeUndefined();
    expect(loops.list()[0]).toMatchObject({ count: 4, turnCount: 1 });
    // It fails another way: moved on.
    fail(6, 'Exit code 1\nTypeError: x is not a function', 2);
    expect(loops.list()).toHaveLength(1);
    expect(loops.list()[0]).toMatchObject({
      count: 1,
      errorLine: 'TypeError: x is not a function',
    });
    // It works.
    loops.toolEnded({ tool: 'Bash', command: 'cd web && pnpm test', at: 7 }, 2);
    expect(loops.list()).toHaveLength(0);
  });

  it('failure runs survive a server restart (dump, then restore)', () => {
    const before = new AgentStateTracker();
    before.apply('s', { at: 1, source: 'claude-hook', kind: 'turn-start' });
    for (let i = 0; i < 2; i++) {
      before.apply('s', {
        at: 2 + i,
        source: 'claude-hook',
        kind: 'tool-end',
        tool: 'Bash',
        detail: 'pnpm test',
        failure: TEST_FAILURE,
      });
    }
    const written = JSON.parse(JSON.stringify(before.dump('s')));
    const after = new AgentStateTracker();
    expect(after.restore('s', written)).toBe(true);
    after.apply('s', {
      at: 9,
      source: 'claude-hook',
      kind: 'tool-end',
      tool: 'Bash',
      detail: 'pnpm test',
      failure: TEST_FAILURE,
    });
    expect(after.get('s')?.failures?.[0]).toMatchObject({ count: 3, turnCount: 3, firstAt: 2 });
    // Garbage on disk restores no runs, not a crash.
    const broken = new AgentStateTracker();
    expect(broken.restore('x', { ...written, failures: [{ signature: 1 }] })).toBe(true);
    expect(broken.get('x')?.failures).toBeUndefined();
  });

  it('Claude: PostToolUseFailure carries its error and command; Codex: a non-zero exit code', () => {
    const claude = claudeHookEvent(
      {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: 't1',
        tool_input: { command: 'pnpm test' },
        error: TEST_FAILURE,
      },
      1000
    );
    expect(claude).toMatchObject({ kind: 'tool-end', detail: 'pnpm test', failure: TEST_FAILURE });
    const ok = claudeHookEvent(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      1000
    );
    expect(ok?.failure).toBeUndefined();

    const reader = new CodexRolloutReader();
    const line = (payload: Record<string, unknown>) =>
      reader.line(
        JSON.stringify({ timestamp: '2026-11-03T10:00:00Z', type: 'response_item', payload })
      );
    expect(
      line({
        type: 'function_call_output',
        call_id: 'c1',
        output: JSON.stringify({ output: 'error: x', metadata: { exit_code: 1 } }),
      })
    ).toMatchObject({ kind: 'tool-end', failure: 'error: x' });
    expect(
      line({
        type: 'function_call_output',
        call_id: 'c2',
        output: 'Exit code: 0\nWall time: 1s\nOutput:\nfine',
      })?.failure
    ).toBeUndefined();
    // The tracker pairs a Codex output with its call's command.
    const tracker = new AgentStateTracker();
    tracker.apply('s', { at: 1, source: 'codex-rollout', kind: 'turn-start' });
    for (let i = 0; i < 3; i++) {
      tracker.apply('s', {
        at: 2 + i,
        source: 'codex-rollout',
        kind: 'tool-start',
        tool: 'shell',
        callId: `c${i}`,
        detail: 'bash -lc cargo test',
      });
      tracker.apply('s', {
        at: 2 + i,
        source: 'codex-rollout',
        kind: 'tool-end',
        callId: `c${i}`,
        failure: 'error[E0308]: mismatched types',
      });
    }
    expect(tracker.get('s')?.failures?.[0]).toMatchObject({
      tool: 'shell',
      command: 'bash -lc cargo test',
      turnCount: 3,
    });
  });
});

describe('TaskScheduler: failure loops', () => {
  let dir: string;
  let deliver: ReturnType<typeof vi.fn>;
  let pushes: NotificationPayload[];
  let tracker: AgentStateTracker;
  let schedulers: TaskScheduler[];
  let call: number;

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    let n = 0;
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      // Never a holdout task (saving-features.ts), unless a test says so.
      random: () => 1,
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
      lastOutputAt: () => Date.now(),
      agentState: (sessionId) => tracker.get(sessionId),
      worktreeActivity: async () => undefined,
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
    name: 'Fix the adder',
    prompt: 'Make the test pass',
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  });

  /** One Bash call through Claude's real hook inputs: failed with `error`, or worked. */
  const bash = (command: string, error?: string) => {
    const id = `t${++call}`;
    const at = Date.now();
    const start = claudeHookEvent(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: id,
        tool_input: { command },
      },
      at
    ) as AgentEvent;
    const end = claudeHookEvent(
      {
        hook_event_name: error === undefined ? 'PostToolUse' : 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: id,
        tool_input: { command },
        ...(error === undefined ? { tool_response: { stdout: 'ok' } } : { error }),
      },
      at
    ) as AgentEvent;
    tracker.apply('s1', start);
    tracker.apply('s1', end);
  };
  const edit = () => {
    const id = `e${++call}`;
    tracker.apply('s1', {
      at: Date.now(),
      source: 'claude-hook',
      kind: 'tool-start',
      tool: 'Edit',
      callId: id,
      detail: 'src/a.ts',
    });
    tracker.apply('s1', {
      at: Date.now(),
      source: 'claude-hook',
      kind: 'tool-end',
      tool: 'Edit',
      callId: id,
      detail: 'src/a.ts',
    });
  };

  const check = async (scheduler: TaskScheduler) => {
    await vi.advanceTimersByTimeAsync(5_000);
    await scheduler.checkExited();
    await scheduler.settled();
  };

  const loopNudges = () =>
    deliver.mock.calls.filter(([, text]) =>
      String(text).includes('stuck repeating the same failure')
    );
  const loopPushes = () => pushes.filter((payload) => payload.type === 'task-looping');

  const started = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
    await scheduler.start(0);
    const task = await scheduler.create(newTask(overrides));
    await scheduler.settled();
    tracker.apply('s1', { at: Date.now(), source: 'claude-hook', kind: 'turn-start' });
    edit();
    expect(scheduler.get(task.id)?.state).toBe('working');
    return task;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-loops-'));
    deliver = vi.fn(() => true);
    pushes = [];
    tracker = new AgentStateTracker();
    schedulers = [];
    call = 0;
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('3 identical failures (an edit/test cycle) → one nudge quoting the error, recorded on the task', async () => {
    const scheduler = make();
    const task = await started(scheduler);
    bash('pnpm test 2>&1 | tail -30', TEST_FAILURE);
    edit();
    bash('pnpm test', TEST_FAILURE);
    await check(scheduler);
    expect(loopNudges()).toHaveLength(0);
    edit();
    bash('cd /wt/1 && pnpm test', TEST_FAILURE);
    await check(scheduler);
    expect(loopNudges()).toHaveLength(1);
    const text = String(loopNudges()[0][1]);
    expect(text).toContain('failed 3 times');
    expect(text).toContain('«FAIL src/a.test.ts > adds»');
    expect(text).toContain('try a different approach');
    expect(scheduler.get(task.id)?.state).toBe('working');
    // Once per turn: a fourth identical failure, another loop in the same turn: no new note.
    bash('pnpm test', TEST_FAILURE);
    for (let i = 0; i < 3; i++) bash('pnpm lint', 'error  no-unused-vars');
    await check(scheduler);
    expect(loopNudges()).toHaveLength(1);
    expect(scheduler.get(task.id)?.failureNudges).toEqual([
      expect.objectContaining({
        tool: 'Bash',
        errorLine: 'FAIL src/a.test.ts > adds',
        repeats: 3,
        after: 1,
      }),
    ]);
    expect(loopPushes()).toHaveLength(0);
    // ut task status shows it.
    const detail = formatTaskDetail(scheduler.get(task.id)!, { now: Date.now() });
    expect(detail).toContain('loops:    1 nudge(s) for a repeated failure: 1 still open');
  });

  it('different errors each time → no nudge', async () => {
    const scheduler = make();
    await started(scheduler);
    bash('pnpm test', 'Exit code 1\nTypeError: a is not a function');
    edit();
    bash('pnpm test', 'Exit code 1\nReferenceError: b is not defined');
    edit();
    bash('pnpm test', 'Exit code 1\nAssertionError: expected 1 to be 2');
    edit();
    bash('pnpm build', 'Exit code 1\nAssertionError: expected 1 to be 2');
    await check(scheduler);
    expect(loopNudges()).toHaveLength(0);
  });

  it('progress after the nudge (the command passes) → recovered, no escalation', async () => {
    const scheduler = make();
    const task = await started(scheduler);
    for (let i = 0; i < 3; i++) bash('pnpm test', TEST_FAILURE);
    await check(scheduler);
    expect(loopNudges()).toHaveLength(1);
    // The note arrives as a new turn; the agent changes approach and the test passes.
    tracker.apply('s1', { at: Date.now(), source: 'claude-hook', kind: 'turn-start' });
    edit();
    bash('pnpm test');
    await check(scheduler);
    // Then fails twice more the old way: a new run, below the bar.
    bash('pnpm test', TEST_FAILURE);
    bash('pnpm test', TEST_FAILURE);
    await check(scheduler);
    expect(loopPushes()).toHaveLength(0);
    expect(loopNudges()).toHaveLength(1);
    expect(scheduler.get(task.id)?.failureNudges?.[0]).toMatchObject({ outcome: 'recovered' });
  });

  it('a different error after the nudge is progress too', async () => {
    const scheduler = make();
    const task = await started(scheduler);
    for (let i = 0; i < 3; i++) bash('pnpm test', TEST_FAILURE);
    await check(scheduler);
    bash('pnpm test', 'Exit code 1\nTypeError: x is not a function');
    await check(scheduler);
    expect(scheduler.get(task.id)?.failureNudges?.[0].outcome).toBe('recovered');
    expect(loopPushes()).toHaveLength(0);
  });

  it('the same failure 3 more times after the nudge → its orchestrator told once, urgent, with the evidence; never stopped', async () => {
    const scheduler = make();
    const task = await started(scheduler, {
      notify: false,
      origin: 'orchestrator',
      orchestratorSessionId: 'orch-1',
    });
    for (let i = 0; i < 3; i++) bash('pnpm test', TEST_FAILURE);
    await check(scheduler);
    tracker.apply('s1', { at: Date.now(), source: 'claude-hook', kind: 'turn-start' });
    for (let i = 0; i < 3; i++) {
      edit();
      bash('pnpm test', TEST_FAILURE);
    }
    await check(scheduler);
    expect(loopPushes()).toHaveLength(1);
    const push = loopPushes()[0];
    expect(String(push.data?.detail)).toContain('failed 6 times with «FAIL src/a.test.ts > adds»');
    expect(push.data).toMatchObject({
      escalated: true,
      failure: { tool: 'Bash', command: 'pnpm test', count: 6 },
    });
    // Not nudged again for it, not told again, still working.
    for (let i = 0; i < 4; i++) bash('pnpm test', TEST_FAILURE);
    await check(scheduler);
    expect(loopPushes()).toHaveLength(1);
    expect(loopNudges()).toHaveLength(1);
    expect(scheduler.get(task.id)?.state).toBe('working');
    expect(scheduler.get(task.id)?.failureNudges?.[0]).toMatchObject({
      outcome: 'escalated',
      after: 3,
    });
    // For its orchestrator: urgent, with what to do.
    expect(isUrgentEvent({ kind: 'looping' })).toBe(true);
    expect(nextAction({ kind: 'looping', taskId: task.id })).toContain(
      `ut task send ${task.id.slice(0, 8)}`
    );
  });

  it('failureLoopNudge=false turns it off', async () => {
    const scheduler = make({ settings: { get: () => ({ failureLoopNudge: false }) as never } });
    const task = await started(scheduler);
    for (let i = 0; i < 6; i++) bash('pnpm test', TEST_FAILURE);
    await check(scheduler);
    expect(loopNudges()).toHaveLength(0);
    expect(scheduler.get(task.id)?.failureNudges).toBeUndefined();
  });

  it('a holdout task runs without nudges (2026-11-03)', async () => {
    const holdout = make({ random: () => 0 });
    const task = await started(holdout);
    expect(task.metrics?.savings).toEqual({ on: {}, holdout: true });
    for (let i = 0; i < 6; i++) bash('pnpm test', TEST_FAILURE);
    await check(holdout);
    expect(loopNudges()).toHaveLength(0);
  });

  it('a task made after the quality guard turned it off is never nudged (2026-11-03)', async () => {
    const autoOff = [
      { feature: 'loop-nudge', version: 1, at: '2026-11-03T00:00:00.000Z', reason: 'worse' },
    ];
    const guarded = make({ settings: { get: () => ({ savingAutoOff: autoOff }) as never } });
    const other = await started(guarded);
    expect(other.metrics?.savings).toEqual({ on: {} });
    for (let i = 0; i < 6; i++) bash('pnpm test', TEST_FAILURE);
    await check(guarded);
    expect(loopNudges()).toHaveLength(0);
  });
});
