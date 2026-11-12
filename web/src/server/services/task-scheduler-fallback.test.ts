/**
 * Model by difficulty and another agent at a usage limit (2026-11-01): a project with
 * modelRouting picks its tasks' model level from the prompt (capable when unsure), `--model`
 * forces it; a task whose agent hits its usage limit goes on with another configured agent in
 * the same worktree and branch (agentFallback auto), is offered it (offer, the default), or
 * pauses as before when there is none.
 */
import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AgentFallbackMode,
  DEFAULT_PROJECT_SETTINGS,
  type ProjectSettings,
} from '../../shared/projects.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { type AgentEvent, AgentStateTracker, CodexRolloutReader } from './agent-events.js';
import type { ClaudeStatus } from './claude-chat.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { TaskProgress } from './task-handoff.js';
import type { TierOpinion } from './task-router-llm.js';
import {
  CODEX_IDLE_MS,
  HALT_LIMIT_GUESS_MS,
  HALT_LOOK_EVERY_MS,
  HALT_LOOK_QUIET_MS,
  IDLE_HOLD_MS,
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';
import { STALL_MINUTES_DEFAULT } from './task-scheduler-stall.js';

const screen = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__/agent-halt', name), 'utf8');

const REPO = '/Users/me/Projects/bakery';
/** 01-nov 00:53 local; the Codex limit resets at 4:25 AM. */
const T0 = new Date(2026, 10, 1, 0, 53).getTime();
const RESET = new Date(2026, 10, 1, 4, 25).getTime();

const RUNNERS = [
  { name: 'claude', agent: 'claude' as const, command: ['claude'] },
  { name: 'codex', agent: 'codex' as const, command: ['codex'] },
];

function newTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Revisión de seguridad',
    prompt: 'Revisa y corrige la llave',
    workingDir: REPO,
    repoPath: REPO,
    command: ['codex'],
    agent: 'codex',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  };
}

describe('TaskScheduler: model by difficulty and fallback agents', () => {
  let dir: string;
  let store: string;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let stopSession: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let classify: ReturnType<typeof vi.fn>;
  let worktrees: TaskWorktrees & Record<string, ReturnType<typeof vi.fn>>;
  let screens: Map<string, string>;
  let settings: Partial<ProjectSettings>;
  let lastOutput: number;
  let commits: number;
  let schedulers: TaskScheduler[];

  const progress: TaskProgress = {
    commits: ['a1b2c3d fix(auth): rotate the key'],
    status: [' M src/key.ts'],
    diff: 'diff --git a/src/key.ts b/src/key.ts\n-old\n+new',
  };

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      stopSession: stopSession as unknown as TaskSchedulerDeps['stopSession'],
      worktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      screenText: async (sessionId) => screens.get(sessionId),
      lastOutputAt: () => lastOutput,
      agentCommand: (agent) => [agent],
      mainRepo: async () => REPO,
      settings: { get: () => ({ ...DEFAULT_PROJECT_SETTINGS, ...settings }) },
      classifyTier: classify as unknown as TaskSchedulerDeps['classifyTier'],
      modelFor: (agent, tier) =>
        tier === 'fast' ? (agent === 'claude' ? 'sonnet' : 'o4-mini') : undefined,
      runners: () => RUNNERS,
      progressOf: async () => progress,
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

  /** A Codex task's quiet spell is over: it is looked at as if finished. */
  const quietSpell = async (scheduler: TaskScheduler) => {
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS + 1000);
    await scheduler.checkExited();
    await scheduler.settled();
  };

  const pushes = () => notify.mock.calls.map(([payload]) => payload as NotificationPayload);
  const launched = (index: number) => launch.mock.calls[index] as [TaskRecord, string];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-fallback-'));
    store = path.join(dir, 'tasks.json');
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    notify = vi.fn();
    deliver = vi.fn(() => true);
    stopSession = vi.fn(async () => undefined);
    pipeline = vi.fn(async () => ({ state: 'merged', mergedSha: 'def456', baseSha: 'abc999' }));
    classify = vi.fn(async (): Promise<TierOpinion | null> => null);
    screens = new Map();
    settings = {};
    lastOutput = T0;
    commits = 0;
    schedulers = [];
    let w = 0;
    worktrees = {
      create: vi.fn(async () => {
        w++;
        return {
          repoPath: REPO,
          baseBranch: 'main',
          baseSha: 'abc123',
          branch: `ut/revision-${w}`,
          worktreePath: `/wt/${w}`,
          clonedDirs: [],
        };
      }),
      remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
      commitLeftovers: vi.fn(async () => false),
      changes: vi.fn(async () => ({
        files: commits ? ['src/key.ts'] : [],
        stats: { commits, files: commits ? 1 : 0, insertions: 3, deletions: 1 },
      })),
      hasUnmergedWork: vi.fn(async () => false),
    };
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  describe('model by difficulty', () => {
    it('routing off: nothing is classified, the agent runs with its own default', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler, { agent: 'claude', command: ['claude'] });
      expect(classify).not.toHaveBeenCalled();
      expect(task.model).toBeUndefined();
      expect(task.modelChoice).toBeUndefined();
      expect(launched(0)[0].model).toBeUndefined();
    });

    it('routing on: a confident "fast" runs the fast model; the choice and why are on the task', async () => {
      settings = { modelRouting: true };
      classify.mockResolvedValue({ tier: 'fast', confident: true, reason: 'a rename' });
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler, {
        agent: 'claude',
        command: ['claude'],
        prompt: 'Renombra getUser a fetchUser',
      });
      expect(classify).toHaveBeenCalledWith('Renombra getUser a fetchUser');
      expect(task.model).toBe('sonnet');
      expect(task.modelChoice).toEqual({ tier: 'fast', by: 'router', reason: 'a rename' });
      // Launched with it: taskCommand adds `--model sonnet` from task.model.
      expect(launched(0)[0].model).toBe('sonnet');
    });

    it('routing on but unsure, or no answer: the capable one (the agent default here)', async () => {
      settings = { modelRouting: true };
      classify.mockResolvedValueOnce({ tier: 'fast', confident: false, reason: 'maybe' });
      const scheduler = make();
      await scheduler.start(0);
      const unsure = await created(scheduler, { agent: 'claude', command: ['claude'] });
      expect(unsure.modelChoice).toMatchObject({ tier: 'capable', by: 'default' });
      expect(unsure.model).toBeUndefined();
      classify.mockRejectedValueOnce(new Error('claude crashed'));
      const failed = await created(scheduler, { agent: 'claude', command: ['claude'] });
      expect(failed.modelChoice).toMatchObject({ tier: 'capable', by: 'default' });
    });

    it('--model forces it: never classified, a level maps to the installation model', async () => {
      settings = { modelRouting: true };
      classify.mockResolvedValue({ tier: 'capable', confident: true, reason: 'design' });
      const scheduler = make();
      await scheduler.start(0);
      const fast = await created(scheduler, {
        agent: 'claude',
        command: ['claude'],
        modelTier: 'fast',
      });
      expect(fast.model).toBe('sonnet');
      expect(fast.modelChoice).toEqual({ tier: 'fast', by: 'user', reason: 'asked for fast' });
      const named = await created(scheduler, {
        agent: 'claude',
        command: ['claude'],
        model: 'opus',
      });
      expect(named.model).toBe('opus');
      expect(named.modelChoice).toMatchObject({ by: 'user' });
      expect(classify).not.toHaveBeenCalled();
      expect(launched(1)[0].model).toBe('opus');
    });
  });

  describe('another agent at a usage limit', () => {
    it('auto: Codex at its limit hands over to Claude in the same worktree and branch, without starting over', async () => {
      settings = { agentFallback: 'auto' };
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler);
      expect(task.sessionId).toBe('s1');
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);

      const moved = scheduler.get(task.id) as TaskRecord;
      // Never paused, never finished: working again, on Claude, in a new session.
      expect(moved.state).toBe('working');
      expect(moved.halt).toBeUndefined();
      expect(moved.agent).toBe('claude');
      expect(moved.command).toEqual(['claude']);
      expect(moved.sessionId).toBe('s2');
      expect(pipeline).not.toHaveBeenCalled();
      // The same worktree and branch: none made again.
      expect(worktrees.create).toHaveBeenCalledTimes(1);
      const [started, prompt] = launched(1);
      expect(started).toMatchObject({
        agent: 'claude',
        worktreePath: '/wt/1',
        branch: 'ut/revision-1',
      });
      // The bounded handoff: the task, what was done, the diff, the old screen's last rows.
      expect(prompt).toMatch(/take over a task another agent \(Codex\)/);
      expect(prompt).toContain('Revisa y corrige la llave');
      expect(prompt).toContain('ut/revision-1');
      expect(prompt).toContain('a1b2c3d fix(auth): rotate the key');
      expect(prompt).toContain(' M src/key.ts');
      expect(prompt).toContain('+new');
      expect(prompt).toContain('hit your usage limit. Upgrade to Pro');
      // The old session is stopped once the new one runs.
      expect(stopSession).toHaveBeenCalledWith('s1');
      expect(moved.agentChanges).toEqual([
        expect.objectContaining({
          from: { agent: 'codex', runner: 'codex' },
          to: { agent: 'claude', runner: 'claude' },
          by: 'auto',
          fromUntil: new Date(RESET).toISOString(),
        }),
      ]);
      // Its reporter hears the change, not a pause.
      expect(pushes().map((p) => p.type)).toEqual(['task-agent-changed']);
      expect(pushes()[0].data).toMatchObject({ fromAgent: 'codex', toAgent: 'claude' });
      expect(pushes()[0].body).toMatch(/Codex hit its usage limit: it goes on with Claude/);

      // A new Codex task waits for Codex's limit (it is known from the change).
      const next = await created(scheduler);
      expect(next.state).toBe('scheduled');
      expect(next.heldFor?.until).toBe(new Date(RESET).toISOString());

      // Claude finishes it: through the pipeline as always.
      commits = 1;
      await scheduler.markDone('s2', 'Arreglado');
      await scheduler.settled();
      expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it('auto keeps the level: a fast task goes on with the other agent at its fast model', async () => {
      settings = { agentFallback: 'auto', modelRouting: true };
      classify.mockResolvedValue({ tier: 'fast', confident: true, reason: 'a typo' });
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler);
      expect(task.model).toBe('o4-mini');
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);
      const moved = scheduler.get(task.id) as TaskRecord;
      expect(moved).toMatchObject({ agent: 'claude', model: 'sonnet' });
      expect(moved.agentChanges?.[0]).toMatchObject({
        from: { agent: 'codex', model: 'o4-mini' },
        to: { agent: 'claude', model: 'sonnet' },
      });
      expect(launched(1)[0].model).toBe('sonnet');
    });

    it('offer (the default): it pauses as before with the other agent offered; retry --agent takes it', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler);
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);

      const paused = scheduler.get(task.id) as TaskRecord;
      expect(paused.state).toBe('paused');
      expect(paused.agent).toBe('codex');
      expect(paused.halt?.offer).toEqual({ agent: 'claude', runner: 'claude' });
      expect(paused.blocker?.message).toContain(
        `ut task retry ${task.id.slice(0, 8)} --agent claude\` goes on now with Claude in the same worktree`
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(pushes().map((p) => p.type)).toEqual(['task-paused']);

      const result = await scheduler.retry(task.id, { agent: 'claude' });
      expect(result.ok).toBe(true);
      const moved = scheduler.get(task.id) as TaskRecord;
      expect(moved).toMatchObject({ state: 'working', agent: 'claude', sessionId: 's2' });
      expect(moved.agentChanges?.[0]).toMatchObject({ by: 'user' });
      expect(launched(1)[0].worktreePath).toBe('/wt/1');
      expect(launched(1)[1]).toContain('Revisa y corrige la llave');
      expect(stopSession).toHaveBeenCalledWith('s1');
    });

    it('retry --agent asked twice at once hands the task off once (2026-11-11)', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler);
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);
      expect(scheduler.get(task.id)?.state).toBe('paused');
      expect(launch).toHaveBeenCalledTimes(1);

      const results = await Promise.all([
        scheduler.retry(task.id, { agent: 'claude' }),
        scheduler.retry(task.id, { agent: 'claude' }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: 'busy' });
      expect(launch).toHaveBeenCalledTimes(2);
      expect(scheduler.get(task.id)).toMatchObject({ agent: 'claude', sessionId: 's2' });
    });

    it.each<[string, Partial<TaskSchedulerDeps>, AgentFallbackMode | undefined]>([
      ['no fallback configured', { runners: () => [RUNNERS[1]] }, 'auto'],
      ['the project said off', {}, 'off'],
      ['no runners at all', { runners: undefined }, 'auto'],
    ])('%s: it pauses as today, nothing offered', async (_name, extra, mode) => {
      settings = mode ? { agentFallback: mode } : {};
      const scheduler = make(extra);
      await scheduler.start(0);
      const task = await created(scheduler);
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);
      const paused = scheduler.get(task.id) as TaskRecord;
      expect(paused.state).toBe('paused');
      expect(paused.agent).toBe('codex');
      expect(paused.halt?.offer).toBeUndefined();
      expect(paused.halt?.nextTryAt).toBeDefined();
      expect(paused.blocker?.message).not.toContain('--agent');
      expect(launch).toHaveBeenCalledTimes(1);
      expect(stopSession).not.toHaveBeenCalled();
    });

    it('an API error is the service, not the account: it pauses, no other agent', async () => {
      settings = { agentFallback: 'auto' };
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler);
      screens.set('s1', screen('codex-stream-error.txt'));
      await quietSpell(scheduler);
      expect(scheduler.get(task.id)).toMatchObject({ state: 'paused', agent: 'codex' });
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('the other agent at its limit too: none taken back before its limit, it pauses', async () => {
      settings = { agentFallback: 'auto' };
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler);
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);
      expect(scheduler.get(task.id)?.agent).toBe('claude');
      // Claude hits its own limit an hour later: Codex is still at its own.
      await vi.advanceTimersByTimeAsync(3600_000);
      screens.set('s2', screen('claude-usage-limit.txt'));
      scheduler.onClaudeTransition('s2', undefined, 'busy', { status: 'busy' });
      scheduler.onClaudeTransition('s2', 'busy', 'idle', { status: 'idle' });
      await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS + 1000);
      await scheduler.settled();
      const paused = scheduler.get(task.id) as TaskRecord;
      expect(paused).toMatchObject({ state: 'paused', agent: 'claude' });
      expect(paused.halt?.offer).toBeUndefined();
      expect(launch).toHaveBeenCalledTimes(2);
      expect(HALT_LIMIT_GUESS_MS).toBeGreaterThan(0);
    });

    it('a task past its budget is never handed to another agent: the budget decides (task budgets)', async () => {
      const first = make();
      await first.start(0);
      const task = await created(first);
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(first);
      expect(first.get(task.id)?.halt?.offer).toEqual({ agent: 'claude', runner: 'claude' });
      first.stop();
      // Its tokens were over its limit by then (read late): as the store has it after a restart.
      const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
      const record = saved.tasks.find((entry: TaskRecord) => entry.id === task.id);
      record.budget.spent.tokens = record.budget.limits.tokens + 1;
      fs.writeFileSync(store, JSON.stringify(saved));
      const second = make();
      await second.start(0);
      const result = await second.retry(task.id, { agent: 'claude' });
      expect(result).toMatchObject({
        ok: false,
        code: 'not-fixable',
        message: expect.stringMatching(/budget/),
      });
      expect(second.get(task.id)).toMatchObject({ state: 'paused', agent: 'codex' });
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it('a held task started on the other agent drops a --model named for its old agent; a level maps anew (review 2026-11-01)', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const first = await created(scheduler);
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);
      expect(scheduler.get(first.id)?.state).toBe('paused');
      // Codex is at its limit: new Codex tasks wait for it.
      const named = await created(scheduler, { model: 'o4' });
      const leveled = await created(scheduler, { modelTier: 'fast' });
      expect(named).toMatchObject({ state: 'scheduled', model: 'o4' });
      expect(leveled).toMatchObject({ state: 'scheduled', model: 'o4-mini' });
      expect((await scheduler.retry(named.id, { agent: 'claude' })).ok).toBe(true);
      expect((await scheduler.retry(leveled.id, { agent: 'claude' })).ok).toBe(true);
      await scheduler.settled();
      const onClaude = scheduler.get(named.id) as TaskRecord;
      expect(onClaude.agent).toBe('claude');
      // Codex's o4 would make Claude fail to start: the agent's own default instead.
      expect(onClaude.model).toBeUndefined();
      expect(launch.mock.calls.find(([t]) => t.id === named.id)?.[0].model).toBeUndefined();
      // A level is the user's choice for any agent: Claude's fast model.
      expect(scheduler.get(leveled.id)).toMatchObject({ agent: 'claude', model: 'sonnet' });
    });

    it('a new session that will not start leaves the task as it was, paused', async () => {
      settings = { agentFallback: 'auto' };
      const scheduler = make();
      await scheduler.start(0);
      const task = await created(scheduler);
      launch.mockRejectedValueOnce(new Error('claude not found'));
      screens.set('s1', screen('codex-usage-limit.txt'));
      await quietSpell(scheduler);
      const paused = scheduler.get(task.id) as TaskRecord;
      expect(paused).toMatchObject({ state: 'paused', agent: 'codex', sessionId: 's1' });
      expect(paused.command).toEqual(['codex']);
      expect(paused.agentChanges).toBeUndefined();
      expect(stopSession).not.toHaveBeenCalled();
    });
  });

  /**
   * 2026-11-09, task f3719fe5 (Codex gpt-6-astra): `ut task done` 26 min in, the review handed
   * back 10 s later and typed into the turn still open; 7 min on Codex printed its usage limit.
   * The end of that turn was taken for an older one's (it had started before the fix was
   * typed), so the task sat "working" 54 min until someone typed "continua". The rollout and
   * the screen are the real ones (texts of the work cut out).
   */
  describe('a halt nobody read (f3719fe5)', () => {
    const at = (iso: string) => Date.parse(iso);
    const REVIEW = {
      state: 'needs_you' as const,
      blocker: {
        kind: 'review' as const,
        message: 'The AI review found problems',
        detail: [`medium · web/src/client/styles.css:6352 · ${'regla sin capa '.repeat(60)}FIN`],
      },
    };
    const LIMIT_RESET = new Date(2026, 10, 11, 18, 48).getTime();

    let tracker: AgentStateTracker;
    let pending: AgentEvent[];

    const rollout = (): AgentEvent[] => {
      const reader = new CodexRolloutReader();
      return readFileSync(
        path.join(__dirname, '__fixtures__/agent-events/codex-rollout-fix-round-usage-limit.jsonl'),
        'utf8'
      )
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => reader.line(line))
        .filter((event): event is AgentEvent => event !== null);
    };

    /** The clock moves to `iso`; what the rollout holds by then is read. */
    const goTo = async (scheduler: TaskScheduler, iso: string) => {
      await vi.advanceTimersByTimeAsync(at(iso) - Date.now());
      while (pending.length && pending[0].at <= Date.now()) {
        tracker.apply('s1', pending.shift() as AgentEvent);
      }
      await scheduler.checkExited();
      await scheduler.settled();
    };

    const tick = async (scheduler: TaskScheduler, ms = 5000) => {
      await vi.advanceTimersByTimeAsync(ms);
      await scheduler.checkExited();
      await scheduler.settled();
    };

    const withEvents = { agentState: (sessionId: string) => tracker.get(sessionId) };

    /** The real run up to the automatic fix typed into the turn still open. */
    const intoFixRound = async (scheduler: TaskScheduler) => {
      vi.setSystemTime(at('2026-11-09T21:13:35.000Z'));
      await scheduler.start(0);
      const task = await created(scheduler);
      await goTo(scheduler, '2026-11-09T21:39:57.000Z');
      expect(scheduler.get(task.id)?.state).toBe('working');
      commits = 1;
      pipeline.mockResolvedValueOnce(REVIEW);
      await vi.advanceTimersByTimeAsync(at('2026-11-09T21:40:05.000Z') - Date.now());
      await scheduler.markDone('s1', 'hecho');
      await scheduler.settled();
      expect(scheduler.get(task.id)).toMatchObject({
        state: 'working',
        autoFix: { reason: 'review', attempts: 1 },
      });
      expect(deliver.mock.calls.at(-1)?.[1]).toContain('Automatic fix 1 of 2');
      return task;
    };

    beforeEach(() => {
      tracker = new AgentStateTracker();
      pending = rollout();
    });

    it('auto: the usage limit that ends the turn the fix was typed into hands the task on at once, with the fix whole', async () => {
      settings = { agentFallback: 'auto' };
      const scheduler = make(withEvents);
      const task = await intoFixRound(scheduler);
      // At work on the fix, a command open: nothing moves.
      await goTo(scheduler, '2026-11-09T21:46:50.000Z');
      expect(scheduler.get(task.id)?.state).toBe('working');
      expect(launch).toHaveBeenCalledTimes(1);

      // 21:46:52 task_complete with usage_limit_exceeded; no task_started since 21:13.
      await goTo(scheduler, '2026-11-09T21:46:57.000Z');
      const moved = scheduler.get(task.id) as TaskRecord;
      expect(moved).toMatchObject({ state: 'working', agent: 'claude', sessionId: 's2' });
      expect(moved.agentChanges).toEqual([
        expect.objectContaining({
          from: { agent: 'codex', runner: 'codex' },
          to: { agent: 'claude', runner: 'claude' },
          by: 'auto',
          fromUntil: new Date(LIMIT_RESET).toISOString(),
        }),
      ]);
      expect(moved.agentChanges?.[0].reason).toContain('purchase more credits');
      expect(stopSession).toHaveBeenCalledWith('s1');
      expect(pushes().map((p) => p.type)).toEqual(['task-agent-changed']);
      // The relief goes on, it does not start over: what is there first, then the fix round's
      // request whole (it was cut at 600 characters).
      const [started, prompt] = launched(1);
      expect(started).toMatchObject({ agent: 'claude', worktreePath: '/wt/1' });
      expect(prompt).toContain('Do not start over');
      expect(prompt).toContain('git status, git log');
      expect(prompt).toContain('carry this on now');
      expect(prompt).toContain('Automatic fix 1 of 2');
      expect(prompt).toContain('FIN');
      expect(prompt).toContain('a1b2c3d fix(auth): rotate the key');
      // The pipeline ran once, for the first `ut task done`: the halt finished nothing.
      expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it('offer (the default): it pauses at once with the other agent offered, and retry --agent takes it', async () => {
      const scheduler = make(withEvents);
      const task = await intoFixRound(scheduler);
      await goTo(scheduler, '2026-11-09T21:46:57.000Z');
      const paused = scheduler.get(task.id) as TaskRecord;
      expect(paused.state).toBe('paused');
      expect(paused.halt).toMatchObject({
        kind: 'usage-limit',
        resumeAt: new Date(LIMIT_RESET).toISOString(),
        offer: { agent: 'claude', runner: 'claude' },
      });
      expect(paused.halt?.message).toContain('You’ve hit your usage limit');
      expect(pushes().map((p) => p.type)).toEqual(['task-paused']);
      expect(pushes()[0].body).toMatch(/ut task retry \w{8} --agent claude/);
      expect((await scheduler.retry(task.id, { agent: 'claude' })).ok).toBe(true);
      await scheduler.settled();
      expect(scheduler.get(task.id)).toMatchObject({ state: 'working', agent: 'claude' });
    });

    it('a text typed into a turn going on: that turn ending well finishes the task; an older turn over before a queued text does not', async () => {
      const scheduler = make(withEvents);
      await scheduler.start(0);
      const task = await created(scheduler);
      const event = (kind: AgentEvent['kind'], extra: Partial<AgentEvent> = {}): AgentEvent => ({
        at: Date.now(),
        source: 'codex-rollout',
        kind,
        ...extra,
      });
      await vi.advanceTimersByTimeAsync(1000);
      tracker.apply('s1', event('turn-start'));
      await tick(scheduler, 60_000);
      // Queued: Codex keeps it for its next turn; the turn going on ends without taking it.
      await scheduler.send(task.id, 'y además el README', 'cli');
      await vi.advanceTimersByTimeAsync(10_000);
      tracker.apply('s1', event('turn-end'));
      await tick(scheduler, 1000);
      expect(scheduler.get(task.id)?.state).toBe('working');
      expect(pipeline).not.toHaveBeenCalled();
      tracker.apply('s1', event('turn-start'));
      tracker.apply('s1', event('activity', { byUser: true }));
      await tick(scheduler, 60_000);
      // Taken into the turn going on: no turn starts for it, and its end is the task's.
      await scheduler.send(task.id, 'y los tests', 'cli');
      await vi.advanceTimersByTimeAsync(1000);
      tracker.apply('s1', event('activity', { byUser: true }));
      await vi.advanceTimersByTimeAsync(30_000);
      commits = 1;
      tracker.apply('s1', event('turn-end', { message: 'Hecho' }));
      await tick(scheduler, 1000);
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(scheduler.get(task.id)?.state).toBe('merged');
    });

    describe('the look at quiet working tasks (no event tells)', () => {
      const SCREEN = 'codex-usage-limit-fix-round.txt';
      /** A fix round on a Codex without a rollout whose screen keeps printing (redraws). */
      const fixRoundBlind = async (scheduler: TaskScheduler) => {
        await scheduler.start(0);
        const task = await created(scheduler);
        commits = 1;
        pipeline.mockResolvedValueOnce(REVIEW);
        await scheduler.markDone('s1', 'hecho');
        await scheduler.settled();
        expect(scheduler.get(task.id)).toMatchObject({ state: 'working', autoFix: {} });
        return task;
      };
      const printing = { lastOutputAt: () => Date.now() };

      it('the exact screen (typographic apostrophe, "purchase more credits") in a fix round: read twice, handed on (auto) long before the stall notice', async () => {
        vi.setSystemTime(new Date(2026, 10, 9, 22, 40));
        settings = { agentFallback: 'auto' };
        const scheduler = make(printing);
        const task = await fixRoundBlind(scheduler);
        const typedAt = Date.now();
        screens.set('s1', screen(SCREEN));
        // Quiet for less than HALT_LOOK_QUIET_MS: not looked at.
        await tick(scheduler, HALT_LOOK_QUIET_MS - 10_000);
        expect(scheduler.get(task.id)?.agent).toBe('codex');
        // One look is not enough (an error about to be retried looks the same).
        await tick(scheduler, 15_000);
        expect(scheduler.get(task.id)).toMatchObject({ state: 'working', agent: 'codex' });
        await tick(scheduler, HALT_LOOK_EVERY_MS);
        const moved = scheduler.get(task.id) as TaskRecord;
        expect(moved).toMatchObject({ state: 'working', agent: 'claude', sessionId: 's2' });
        expect(moved.agentChanges?.[0]).toMatchObject({
          by: 'auto',
          fromUntil: new Date(LIMIT_RESET).toISOString(),
        });
        expect(Date.now() - typedAt).toBeLessThan(5 * 60_000);
        expect(Date.now() - typedAt).toBeLessThan(STALL_MINUTES_DEFAULT * 60_000);
        const [, prompt] = launched(1);
        expect(prompt).toContain('Do not start over');
        expect(prompt).toContain('Automatic fix 1 of 2');
        expect(prompt).toContain('to purchase more credits or try again at Nov 11th, 2026 6:48 PM');
        expect(stopSession).toHaveBeenCalledWith('s1');
      });

      it('offer: the same screen pauses the task with the other agent offered, told once', async () => {
        vi.setSystemTime(new Date(2026, 10, 9, 22, 40));
        const scheduler = make(printing);
        const task = await fixRoundBlind(scheduler);
        screens.set('s1', screen(SCREEN));
        for (let i = 0; i < 60; i++) await tick(scheduler);
        const paused = scheduler.get(task.id) as TaskRecord;
        expect(paused.state).toBe('paused');
        expect(paused.halt).toMatchObject({
          kind: 'usage-limit',
          resumeAt: new Date(LIMIT_RESET).toISOString(),
          offer: { agent: 'claude', runner: 'claude' },
        });
        expect(pushes().map((p) => p.type)).toEqual(['task-paused']);
        expect(launch).toHaveBeenCalledTimes(1);
      });

      it('a limit the agent got past, or an error seen once and gone, never stops a working task', async () => {
        settings = { agentFallback: 'auto' };
        const scheduler = make(printing);
        const task = await fixRoundBlind(scheduler);
        screens.set('s1', screen('codex-limit-then-worked.txt'));
        for (let i = 0; i < 60; i++) await tick(scheduler);
        expect(scheduler.get(task.id)).toMatchObject({ state: 'working', agent: 'codex' });
        // Seen at one look, under new output at the next.
        screens.set('s1', screen(SCREEN));
        await tick(scheduler, HALT_LOOK_EVERY_MS);
        screens.set('s1', screen('codex-limit-then-worked.txt'));
        for (let i = 0; i < 60; i++) await tick(scheduler);
        expect(scheduler.get(task.id)).toMatchObject({ state: 'working', agent: 'codex' });
        expect(launch).toHaveBeenCalledTimes(1);
        expect(pushes()).toHaveLength(0);
      });

      it('first work, Claude: a limit on its screen while its status stays busy is found too', async () => {
        settings = { agentFallback: 'auto' };
        const scheduler = make(printing);
        await scheduler.start(0);
        const task = await created(scheduler, { agent: 'claude', command: ['claude'] });
        const busy: ClaudeStatus = { status: 'busy' };
        scheduler.onClaudeTransition('s1', undefined, 'busy', busy);
        screens.set('s1', screen('claude-usage-limit.txt'));
        for (let i = 0; i < 45; i++) await tick(scheduler);
        expect(scheduler.get(task.id)).toMatchObject({
          state: 'working',
          agent: 'codex',
          sessionId: 's2',
        });
        expect(stopSession).toHaveBeenCalledWith('s1');
      });

      it('an agent whose events still come is at work: its screen is not read', async () => {
        settings = { agentFallback: 'auto' };
        const read = vi.fn(async () => screen(SCREEN));
        const scheduler = make({ ...withEvents, screenText: read });
        await scheduler.start(0);
        const task = await created(scheduler);
        tracker.apply('s1', { at: Date.now(), source: 'codex-rollout', kind: 'turn-start' });
        for (let i = 0; i < 60; i++) {
          tracker.apply('s1', { at: Date.now(), source: 'codex-rollout', kind: 'activity' });
          await tick(scheduler);
        }
        expect(read).not.toHaveBeenCalled();
        expect(scheduler.get(task.id)).toMatchObject({ state: 'working', agent: 'codex' });
      });
    });
  });
});
