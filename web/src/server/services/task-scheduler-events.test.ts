/**
 * The scheduler decides from the agents' own events first (agent-events.ts), the screen last
 * (2026-11-01). Events are the recorded ones in __fixtures__/agent-events, moved to the test's
 * clock; screens the recorded ones in __fixtures__/agent-halt.
 *
 * The last test measures it: the same runs decided without events (as before) and with them,
 * counting the decisions taken from the screen or the terminal's output time.
 */
import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  type AgentEvent,
  AgentStateTracker,
  CodexRolloutReader,
  claudeHookEvent,
  SignalLedger,
} from './agent-events.js';
import { parseResumeAt } from './agent-halt.js';
import type { ClaudeStatus } from './claude-chat.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { PipelineOptions } from './task-merge.js';
import {
  CODEX_IDLE_MS,
  IDLE_HOLD_MS,
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const fixture = (dir: string, name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__', dir, name), 'utf8');
const fixtureLines = (name: string) =>
  fixture('agent-events', name)
    .split('\n')
    .filter((line) => line.trim());

function codexEvents(name: string): AgentEvent[] {
  const reader = new CodexRolloutReader();
  return fixtureLines(name)
    .map((line) => reader.line(line))
    .filter((event): event is AgentEvent => event !== null);
}

function claudeEvents(name: string): AgentEvent[] {
  return fixtureLines(name)
    .map(
      (line) => JSON.parse(line) as { at: number; event: string; input: Record<string, unknown> }
    )
    .map(({ at, event, input }) => claudeHookEvent({ ...input, hook_event_name: event }, at))
    .filter((event): event is AgentEvent => event !== null);
}

/**
 * The events up to (and with) the first one of `kind`, moved to start at `start`. A limit's
 * reset is a time of day in its message: read again at the moved time.
 */
function shifted(events: AgentEvent[], start: number, until?: AgentEvent['kind']): AgentEvent[] {
  const end = until ? events.findIndex((event) => event.kind === until) : events.length - 1;
  const delta = start - events[0].at;
  return events.slice(0, end + 1).map((event) => {
    const at = event.at + delta;
    if (event.halt?.resumeAt === undefined) return { ...event, at };
    const { resumeAt: _old, ...halt } = event.halt;
    const resumeAt = parseResumeAt(halt.message, at);
    return { ...event, at, halt: { ...halt, ...(resumeAt !== undefined ? { resumeAt } : {}) } };
  });
}

/** 01-nov 00:53 local, when bakery's Codex tasks hit their limit. */
const T0 = new Date(2026, 10, 1, 0, 53).getTime();

const busy: ClaudeStatus = { status: 'busy' };
const idle = (text = ''): ClaudeStatus => ({
  status: 'idle',
  ...(text ? { preview: { role: 'assistant' as const, text } } : {}),
});

function newTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Revisión',
    prompt: 'Revisa la llave',
    workingDir: '/Users/me/Projects/bakery',
    command: ['codex'],
    agent: 'codex',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  };
}

describe('TaskScheduler: decided from the agents’ events', () => {
  let dir: string;
  let launch: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let screenText: ReturnType<typeof vi.fn>;
  let worktrees: TaskWorktrees;
  let screens: Map<string, string>;
  let lastOutput: number;
  let commits: number;
  let tracker: AgentStateTracker;
  let schedulers: TaskScheduler[];

  const make = (options: { events: boolean; signals?: SignalLedger }) => {
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, `tasks-${schedulers.length}.json`),
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: vi.fn() as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      worktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      screenText: screenText as unknown as TaskSchedulerDeps['screenText'],
      lastOutputAt: () => lastOutput,
      ...(options.events ? { agentState: (sessionId: string) => tracker.get(sessionId) } : {}),
      ...(options.signals ? { signals: options.signals } : {}),
      agentCommand: (agent) => (agent === 'claude' ? ['claude'] : ['codex']),
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 10,
      now: () => Date.now(),
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const created = async (scheduler: TaskScheduler, overrides: Partial<NewTask> = {}) => {
    const task = await scheduler.create(newTask(overrides));
    await scheduler.settled();
    return scheduler.get(task.id) as TaskRecord;
  };

  const feed = (sessionId: string, events: AgentEvent[]) => {
    for (const event of events) tracker.apply(sessionId, event);
  };

  const tick = async (scheduler: TaskScheduler, ms = 5000) => {
    await vi.advanceTimersByTimeAsync(ms);
    await scheduler.checkExited();
    await scheduler.settled();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-events-'));
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    deliver = vi.fn(() => true);
    pipeline = vi.fn(async () => ({ state: 'merged', mergedSha: 'def456', baseSha: 'abc999' }));
    screens = new Map();
    screenText = vi.fn(async (sessionId: string) => screens.get(sessionId));
    lastOutput = T0;
    commits = 0;
    tracker = new AgentStateTracker();
    schedulers = [];
    let w = 0;
    worktrees = {
      create: vi.fn(async () => {
        w++;
        return {
          repoPath: '/repo',
          baseBranch: 'main',
          baseSha: 'abc123',
          branch: `ut/t-${w}`,
          worktreePath: `/wt/${w}`,
          clonedDirs: [],
        };
      }),
      remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
      commitLeftovers: vi.fn(async () => false),
      changes: vi.fn(async () => ({
        files: commits ? ['src/a.ts'] : [],
        stats: { commits, files: commits ? 1 : 0, insertions: 3, deletions: 1 },
      })),
      hasUnmergedWork: vi.fn(async () => false),
    } as unknown as TaskWorktrees;
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('Codex cut by its usage limit (the recorded rollout): paused at once with its reset, no quiet spell, no screen', async () => {
    const scheduler = make({ events: true });
    await scheduler.start(0);
    const task = await created(scheduler);
    feed('s1', shifted(codexEvents('codex-rollout-usage-limit.jsonl'), Date.now() + 1000, 'halt'));
    // Its screen would say "working" for minutes: never read.
    lastOutput = Date.now() + 2000;
    await tick(scheduler);
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'paused',
      halt: {
        kind: 'usage-limit',
        resumeAt: new Date(new Date(2026, 10, 1, 4, 25).getTime()).toISOString(),
      },
    });
    expect(screenText).not.toHaveBeenCalled();
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('Codex in a long command with a quiet screen is still working; its task_complete finishes it', async () => {
    const scheduler = make({ events: true });
    await scheduler.start(0);
    const task = await created(scheduler);
    const turn = shifted(codexEvents('codex-rollout-turn.jsonl'), Date.now() + 1000);
    const firstTool = turn.findIndex((event) => event.kind === 'tool-start');
    feed('s1', turn.slice(0, firstTool + 1));
    // Twice the old quiet spell without output: before, this was "done".
    await tick(scheduler, CODEX_IDLE_MS * 2);
    expect(scheduler.get(task.id)?.state).toBe('working');
    // So long without an event, its screen was looked at for a halt nobody told (watchHalts,
    // 2026-11-09): it showed none and decided nothing.
    const looks = screenText.mock.calls.length;
    feed('s1', turn.slice(firstTool + 1));
    await tick(scheduler);
    // Its last message is its report: with nothing changed it closes as done, like Claude's
    // (before, a Codex task only closed on its own `ut task done`).
    await vi.waitFor(() =>
      expect(scheduler.get(task.id)).toMatchObject({
        state: 'done',
        summary: 'Done: the change is committed.',
      })
    );
    // The end of its turn came from its events: the screen was not read for it.
    expect(screenText).toHaveBeenCalledTimes(looks);
  });

  it('a Codex task settled, then a new turn in its rollout: followed again; a redraw (output, no turn) is not', async () => {
    const scheduler = make({ events: true });
    await scheduler.start(0);
    const task = await created(scheduler);
    // A turn that ends on a question: the task waits for the user.
    const turn = codexEvents('codex-rollout-turn.jsonl').map((event) =>
      event.kind === 'turn-end' ? { ...event, message: '¿Sigo con la parte B?' } : event
    );
    feed('s1', shifted(turn, Date.now() + 1000));
    await tick(scheduler);
    await vi.waitFor(() =>
      expect(scheduler.get(task.id)).toMatchObject({
        state: 'needs_you',
        blocker: { kind: 'question' },
      })
    );
    // The phone redraws its screen: output, no turn.
    lastOutput = Date.now() + 1000;
    await tick(scheduler);
    expect(scheduler.get(task.id)?.state).toBe('needs_you');
    // The user types into it: a turn starts.
    feed('s1', shifted(turn, Date.now() + 1000).slice(0, 3));
    await tick(scheduler);
    expect(scheduler.get(task.id)?.state).toBe('working');
  });

  it('Claude cut by a lost login (the recorded StopFailure) pauses without the screen', async () => {
    const scheduler = make({ events: true });
    await scheduler.start(0);
    const cut = await created(scheduler, {
      agent: 'claude',
      command: ['claude'],
      isolation: 'none',
    });
    feed('s1', shifted(claudeEvents('claude-hooks-auth-failure.jsonl'), Date.now() + 1000, 'halt'));
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle('Invalid API key'));
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    await scheduler.settled();
    expect(scheduler.get(cut.id)).toMatchObject({ state: 'paused', halt: { kind: 'auth' } });
    expect(screenText).not.toHaveBeenCalled();
  });

  it('a clean Stop never pauses a Claude task, whatever its screen still shows', async () => {
    const scheduler = make({ events: true });
    await scheduler.start(0);
    const fine = await created(scheduler, {
      agent: 'claude',
      command: ['claude'],
      isolation: 'none',
    });
    feed('s1', shifted(claudeEvents('claude-hooks-turn.jsonl'), Date.now() + 1000, 'turn-end'));
    // A limit message on its screen (the one before was the last word there).
    screens.set('s1', fixture('agent-halt', 'claude-usage-limit.txt'));
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle('done'));
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    await scheduler.settled();
    // Its Stop's last message is its report: closed as done, never paused.
    expect(scheduler.get(fine.id)).toMatchObject({ state: 'done', summary: 'done' });
    expect(scheduler.get(fine.id)?.halt).toBeUndefined();
    expect(screenText).not.toHaveBeenCalled();
  });

  it("Claude without hooks: its transcript's API error decides, not the screen", async () => {
    const claudeTurnError = vi.fn(async () => ({
      error: 'rate_limit',
      text: "You've hit your session limit · resets 4:25am",
      at: Date.now(),
    }));
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks-transcript.json'),
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: vi.fn() as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      worktrees,
      screenText: screenText as unknown as TaskSchedulerDeps['screenText'],
      claudeTurnError,
      logDir: path.join(dir, 'logs'),
      now: () => Date.now(),
    });
    schedulers.push(scheduler);
    await scheduler.start(0);
    const task = await created(scheduler, {
      agent: 'claude',
      command: ['claude'],
      isolation: 'none',
    });
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle());
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    await scheduler.settled();
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'paused',
      halt: { kind: 'usage-limit', resumeAt: new Date(2026, 10, 1, 4, 25).toISOString() },
    });
    expect(claudeTurnError).toHaveBeenCalledWith('s1');
    expect(screenText).not.toHaveBeenCalled();
  });

  it("files changed during a check are the agent's only if its events say it acted then (94aef32c: a redraw is no edit)", async () => {
    const scheduler = make({ events: true });
    await scheduler.start(0);
    const task = await created(scheduler, { agent: 'claude', command: ['claude'] });
    const turn = shifted(claudeEvents('claude-hooks-turn.jsonl'), Date.now() + 1000, 'turn-end');
    feed('s1', turn);
    commits = 1;
    let options: PipelineOptions | undefined;
    pipeline.mockImplementation(async (_task: unknown, opts: PipelineOptions) => {
      options = opts;
      return { state: 'merged', mergedSha: 'def456', baseSha: 'abc999' };
    });
    await scheduler.markDone('s1', 'Hecho');
    await scheduler.settled();
    expect(task.id).toBeTruthy();
    expect(options?.agentActiveSince).toBeTypeOf('function');
    const afterTurn = turn[turn.length - 1].at + 1;
    // The phone redraws its terminal meanwhile: output, but no event.
    lastOutput = afterTurn + 5000;
    expect(options?.agentActiveSince?.(afterTurn)).toBe(false);
    // It takes a follow-up and runs a command while the check runs.
    tracker.apply('s1', { at: afterTurn + 6000, source: 'claude-hook', kind: 'turn-start' });
    tracker.apply('s1', {
      at: afterTurn + 7000,
      source: 'claude-hook',
      kind: 'tool-start',
      callId: 'b1',
    });
    expect(options?.agentActiveSince?.(afterTurn + 8000)).toBe(true);
  });

  it('measured: the same runs decided from the screen before, from the events now', async () => {
    const run = async (events: boolean) => {
      const signals = new SignalLedger();
      const scheduler = make({ events, signals });
      await scheduler.start(0);
      const start = Date.now();
      // 1. Codex cut by its usage limit (bakery 0cbedf19).
      const limited = await created(scheduler);
      screens.set(limited.sessionId as string, fixture('agent-halt', 'codex-usage-limit.txt'));
      if (events) {
        feed(
          limited.sessionId as string,
          shifted(codexEvents('codex-rollout-usage-limit.jsonl'), Date.now() + 1000, 'halt')
        );
      }
      // 2. Codex that finished for real.
      const codexDone = await created(scheduler);
      screens.set(
        codexDone.sessionId as string,
        fixture('agent-halt', 'codex-heads-up.txt').replace(/• Working.*\n/, '')
      );
      if (events)
        feed(
          codexDone.sessionId as string,
          shifted(codexEvents('codex-rollout-turn.jsonl'), Date.now() + 1000)
        );
      await tick(scheduler, CODEX_IDLE_MS + 1000);
      // 3. Claude that lost its login. 4. Claude that finished, with a change to check.
      const lost = await created(scheduler, {
        agent: 'claude',
        command: ['claude'],
        isolation: 'none',
      });
      screens.set(lost.sessionId as string, fixture('agent-halt', 'claude-auth.txt'));
      if (events)
        feed(
          lost.sessionId as string,
          shifted(claudeEvents('claude-hooks-auth-failure.jsonl'), Date.now() + 1000, 'halt')
        );
      const done = await created(scheduler, { agent: 'claude', command: ['claude'] });
      screens.set(done.sessionId as string, fixture('agent-halt', 'claude-finished.txt'));
      if (events)
        feed(
          done.sessionId as string,
          shifted(claudeEvents('claude-hooks-turn.jsonl'), Date.now() + 1000, 'turn-end')
        );
      let options: PipelineOptions | undefined;
      pipeline.mockImplementation(async (_task: unknown, opts: PipelineOptions) => {
        options = opts;
        return { state: 'merged', mergedSha: 'def456', baseSha: 'abc999' };
      });
      for (const task of [lost, done]) {
        const sessionId = task.sessionId as string;
        scheduler.onClaudeTransition(sessionId, 'idle', 'busy', busy);
        scheduler.onClaudeTransition(sessionId, 'busy', 'idle', idle('done'));
      }
      commits = 1;
      await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
      await scheduler.settled();
      commits = 0;
      // 5. The check asks whether the agent edited while it ran.
      options?.agentActiveSince?.(Date.now());
      const states = [limited, codexDone, lost, done].map((task) => scheduler.get(task.id)?.state);
      scheduler.stop();
      vi.setSystemTime(start + 3600_000);
      return { states, counts: signals.snapshot(), share: signals.screenShare() };
    };

    const before = await run(false);
    const after = await run(true);
    // The same outcome both ways: the change is where it comes from.
    // The same outcome both ways, but for the Codex task that finished: its rollout's last
    // message is its report, so it closes as done instead of waiting "ready" for a word.
    expect(before.states).toEqual(['paused', 'ready', 'paused', 'merged']);
    expect(after.states).toEqual(['paused', 'done', 'paused', 'merged']);
    // Before: 7 of the 8 decisions read the screen or the output time, the 8th the last
    // character of a 160-character preview ("ends with ?").
    expect(before.counts).toEqual({
      halt: { screen: 4 },
      'turn-ended': { output: 2 },
      'agent-active': { output: 1 },
      question: { text: 1 },
    });
    expect(before.share).toEqual({ screen: 7, total: 8 });
    // Now: all 8 from the agents' own events.
    expect(after.counts).toEqual({
      halt: { events: 4 },
      'turn-ended': { events: 2 },
      'agent-active': { events: 1 },
      question: { events: 1 },
    });
    expect(after.share).toEqual({ screen: 0, total: 8 });
    console.info(
      `[agent-state] decisions from the screen or output time: before ${before.share.screen}/${before.share.total}, after ${after.share.screen}/${after.share.total}`
    );
  });
});
