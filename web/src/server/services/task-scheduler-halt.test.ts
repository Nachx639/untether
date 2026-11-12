/**
 * An agent cut short by its usage limit, an API error or a lost login (2026-11-01, bakery
 * 0cbedf19 and ce86f31b): the task pauses instead of finishing, resumes by itself in the same
 * session, and new tasks of that agent wait for the limit. Screens are the real ones in
 * __fixtures__/agent-halt.
 */

import { readFileSync } from 'node:fs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS } from '../../shared/projects.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { haltContinuePrompt } from './agent-halt.js';
import type { ClaudeStatus } from './claude-chat.js';
import type { NotificationPayload } from './push-notification-service.js';
import {
  CODEX_IDLE_MS,
  HALT_MAX_TRIES,
  HALT_RESUME_MARGIN_MS,
  HALT_RETRY_DELAYS_MS,
  HALT_SLOT_RETRY_MS,
  HALT_STREAK_MS,
  IDLE_HOLD_MS,
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const screen = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__/agent-halt', name), 'utf8');

/** 01-nov 00:53 local, when bakery's Codex tasks hit their limit (reset at 4:25 AM). */
const T0 = new Date(2026, 10, 1, 0, 53).getTime();
const RESET = new Date(2026, 10, 1, 4, 25).getTime();

const busy: ClaudeStatus = { status: 'busy' };
const idle = (text = ''): ClaudeStatus => ({
  status: 'idle',
  ...(text ? { preview: { role: 'assistant' as const, text } } : {}),
});

function newTask(overrides: Partial<NewTask> = {}): NewTask {
  return {
    name: 'Revisión de seguridad',
    prompt: 'Revisa y corrige la llave',
    workingDir: '/Users/me/Projects/bakery',
    command: ['codex'],
    agent: 'codex',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  };
}

describe('TaskScheduler: agents cut short', () => {
  let dir: string;
  let store: string;
  let launch: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let worktrees: TaskWorktrees & Record<string, ReturnType<typeof vi.fn>>;
  let screens: Map<string, string>;
  let lastOutput: number;
  let commits: number;
  let schedulers: TaskScheduler[];

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    const scheduler = new TaskScheduler({
      storePath: store,
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      worktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      screenText: async (sessionId) => screens.get(sessionId),
      lastOutputAt: () => lastOutput,
      agentCommand: (agent) => (agent === 'claude' ? ['claude', '--model', 'opus'] : ['codex']),
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-halt-'));
    store = path.join(dir, 'tasks.json');
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    notify = vi.fn();
    deliver = vi.fn(() => true);
    pipeline = vi.fn(async () => ({ state: 'merged', mergedSha: 'def456', baseSha: 'abc999' }));
    screens = new Map();
    lastOutput = T0;
    commits = 0;
    schedulers = [];
    let w = 0;
    worktrees = {
      create: vi.fn(async () => {
        w++;
        return {
          repoPath: '/repo',
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
        files: commits ? ['src/a.ts'] : [],
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

  it('a Codex task at its usage limit pauses, never ready, and resumes alone at the reset (bakery 0cbedf19)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    screens.set('s1', screen('codex-usage-limit.txt'));
    await quietSpell(scheduler);

    const paused = scheduler.get(task.id) as TaskRecord;
    expect(paused.state).toBe('paused');
    expect(paused.blocker?.kind).toBe('halted');
    expect(paused.halt).toMatchObject({
      kind: 'usage-limit',
      attempts: 0,
      resumeAt: new Date(RESET).toISOString(),
      nextTryAt: new Date(RESET + HALT_RESUME_MARGIN_MS).toISOString(),
    });
    expect(paused.halt?.message).toContain('try again at 4:25 AM');
    // Not finished: no pipeline, no fix round, not closed as "changed nothing".
    expect(pipeline).not.toHaveBeenCalled();
    expect(paused.autoFixes).toBeUndefined();
    expect(scheduler.liveState(task.id)?.status).toBe('paused');
    // Its reporter hears it once, with the time it goes on.
    expect(pushes().map((p) => p.type)).toEqual(['task-paused']);
    expect(pushes()[0].body).toMatch(/Codex hit its usage limit.*sends it on by itself at 04:27/);
    expect(pushes()[0].data?.resumeAt).toBe(new Date(RESET + HALT_RESUME_MARGIN_MS).toISOString());

    // Its quiet goes on: still paused, nothing new told, nothing typed.
    await quietSpell(scheduler);
    expect(scheduler.get(task.id)?.state).toBe('paused');
    expect(pushes()).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();

    // At the reset (plus the margin) the same session is told to go on.
    await vi.advanceTimersByTimeAsync(RESET + HALT_RESUME_MARGIN_MS + 1000 - Date.now());
    await scheduler.settled();
    expect(deliver).toHaveBeenCalledWith(
      's1',
      haltContinuePrompt('usage-limit'),
      'codex',
      expect.anything()
    );
    expect(launch).toHaveBeenCalledTimes(1);
    const resumed = scheduler.get(task.id) as TaskRecord;
    expect(resumed.state).toBe('working');
    expect(resumed.halt?.attempts).toBe(1);

    // This time it finishes for real: through the pipeline as always, the halt forgotten.
    lastOutput = Date.now();
    screens.set('s1', screen('codex-limit-then-worked.txt'));
    commits = 1;
    await scheduler.markDone('s1', 'Arreglado');
    await scheduler.settled();
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(scheduler.get(task.id)?.halt).toBeUndefined();
  });

  it('paused tasks go back to work only while their project has a slot: never past maxActiveTasks at the reset (bakery 2026-11-10, 5 at work with a limit of 3)', async () => {
    const REPO = '/Users/me/Projects/bakery';
    const settings = { ...DEFAULT_PROJECT_SETTINGS, maxActiveTasks: 2 };
    const scheduler = make({
      settings: {
        get: () => settings,
        list: () => [{ repoPath: REPO, settings }],
      } as unknown as TaskSchedulerDeps['settings'],
      mainRepo: async () => REPO,
    });
    await scheduler.start(0);
    const a = await created(scheduler, { name: 'A' });
    const b = await created(scheduler, { name: 'B' });
    // Both Codex tasks hit the usage limit: paused, their slots free.
    screens.set('s1', screen('codex-usage-limit.txt'));
    screens.set('s2', screen('codex-usage-limit.txt'));
    await quietSpell(scheduler);
    expect([a, b].map((task) => scheduler.get(task.id)?.state)).toEqual(['paused', 'paused']);
    // Two Claude tasks take the free slots meanwhile.
    const c = await created(scheduler, { name: 'C', agent: 'claude', command: ['claude'] });
    const d = await created(scheduler, { name: 'D', agent: 'claude', command: ['claude'] });
    expect([c.state, d.state]).toEqual(['working', 'working']);
    const working = () =>
      [a, b, c, d].filter((task) => scheduler.get(task.id)?.state === 'working').length;

    // The reset comes with the project full: neither goes on, each waits for a slot.
    deliver.mockClear();
    await vi.advanceTimersByTimeAsync(RESET + HALT_RESUME_MARGIN_MS + 1000 - Date.now());
    await scheduler.settled();
    expect(working()).toBe(2);
    expect(deliver).not.toHaveBeenCalled();
    expect(scheduler.get(a.id)?.halt?.slotWait).toBeTruthy();
    expect(scheduler.get(a.id)?.blocker?.message).toMatch(
      /can go on.*when one of its project's 2 tasks at work ends/
    );
    // Asked to go on by hand without --force: refused, and told how.
    expect(await scheduler.retry(b.id)).toMatchObject({ ok: false, code: 'limit' });
    expect(await scheduler.retry(a.id)).toMatchObject({ ok: false, code: 'limit' });
    // A new task waits behind them: they were there first.
    const e = await created(scheduler, { name: 'E', agent: 'claude', command: ['claude'] });
    expect(e.state).toBe('queued');

    // One slot frees up: one paused task goes on, the other and the new one still wait.
    await scheduler.discard(c.id);
    await vi.advanceTimersByTimeAsync(HALT_SLOT_RETRY_MS + 1000);
    await scheduler.settled();
    expect(working()).toBe(2);
    // They became due at the same moment: either one goes first, never both.
    const [on, still] = scheduler.get(a.id)?.state === 'working' ? [a, b] : [b, a];
    expect(scheduler.get(on.id)?.state).toBe('working');
    expect(scheduler.get(on.id)?.halt?.slotWait).toBeUndefined();
    expect(scheduler.get(still.id)?.state).toBe('paused');
    expect(scheduler.get(e.id)?.state).toBe('queued');
    expect(deliver).toHaveBeenCalledTimes(1);

    // --force sends the other on past the limit, as asked.
    expect((await scheduler.retry(still.id, { force: true })).ok).toBe(true);
    await scheduler.settled();
    expect(scheduler.get(still.id)?.state).toBe('working');
    expect(working()).toBe(3);
  });

  it('a limit hit again on the way back pauses again without telling again; tries are capped', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    // An outage without a time: spaced tries.
    screens.set('s1', screen('codex-stream-error.txt'));
    await quietSpell(scheduler);
    expect(scheduler.get(task.id)?.halt?.nextTryAt).toBe(
      new Date(Date.now() + HALT_RETRY_DELAYS_MS[0]).toISOString()
    );
    for (let attempt = 1; attempt <= HALT_MAX_TRIES; attempt++) {
      const next = Date.parse(scheduler.get(task.id)?.halt?.nextTryAt as string);
      await vi.advanceTimersByTimeAsync(next + 10 - Date.now());
      await scheduler.settled();
      expect(scheduler.get(task.id)?.state).toBe('working');
      lastOutput = Date.now();
      await quietSpell(scheduler);
      expect(scheduler.get(task.id)).toMatchObject({
        state: 'paused',
        halt: { attempts: attempt },
      });
    }
    expect(deliver).toHaveBeenCalledTimes(HALT_MAX_TRIES);
    // Out of tries: no next try, the user decides, told a second (last) time.
    expect(scheduler.get(task.id)?.halt?.nextTryAt).toBeUndefined();
    expect(pushes().map((p) => p.type)).toEqual(['task-paused', 'task-paused']);
    expect(pushes()[1].body).toMatch(/automatic tries ran out/);
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(deliver).toHaveBeenCalledTimes(HALT_MAX_TRIES);
    expect(pipeline).not.toHaveBeenCalled();

    // The user sends it on by hand (retry): typed at once, the count starts over.
    const retried = await scheduler.retry(task.id);
    expect(retried.ok && retried.task.state).toBe('working');
    expect(deliver).toHaveBeenCalledTimes(HALT_MAX_TRIES + 1);
    expect(scheduler.get(task.id)?.halt?.attempts).toBe(0);
  });

  it('a cut long after the task was sent on is a new one: its tries start over and it is told again', async () => {
    const scheduler = make();
    await scheduler.start(0);
    // Two hours of work: as long as the default agent budget, which is not what this is about.
    const task = await created(scheduler, { budget: { limits: { agent: 0 } } });
    screens.set('s1', screen('codex-stream-error.txt'));
    await quietSpell(scheduler);
    await vi.advanceTimersByTimeAsync(HALT_RETRY_DELAYS_MS[0] + 1000);
    await scheduler.settled();
    expect(scheduler.get(task.id)).toMatchObject({ state: 'working', halt: { attempts: 1 } });
    // Hours of real work, then another cut.
    screens.set('s1', screen('codex-limit-then-worked.txt'));
    for (let spent = 0; spent < HALT_STREAK_MS * 4; spent += CODEX_IDLE_MS / 2) {
      lastOutput = Date.now();
      await vi.advanceTimersByTimeAsync(CODEX_IDLE_MS / 2);
      await scheduler.checkExited();
    }
    expect(scheduler.get(task.id)?.state).toBe('working');
    screens.set('s1', screen('codex-stream-error.txt'));
    await quietSpell(scheduler);
    expect(scheduler.get(task.id)).toMatchObject({ state: 'paused', halt: { attempts: 0 } });
    expect(pushes().map((p) => p.type)).toEqual(['task-paused', 'task-paused']);
  });

  it('a Claude task cut by an API error pauses instead of closing; Claude going on by itself counts as work', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler, {
      agent: 'claude',
      command: ['claude'],
      isolation: 'none',
    });
    screens.set('s1', screen('claude-api-error.txt'));
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle('Voy a cambiar el test'));
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    await scheduler.settled();
    expect(scheduler.get(task.id)).toMatchObject({
      state: 'paused',
      halt: { kind: 'api-error', message: expect.stringMatching(/^API Error: Can't reach/) },
    });
    expect(pushes().map((p) => p.type)).toEqual(['task-paused']);

    // Its conversation moves on (Claude retried by itself): working again, nothing typed.
    scheduler.onClaudeTransition('s1', 'idle', 'busy', {
      status: 'busy',
      preview: { role: 'assistant', text: 'Sigo con el test' },
    });
    expect(scheduler.get(task.id)?.state).toBe('working');
    screens.set('s1', screen('claude-finished.txt'));
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle('Hecho: el test pasa.'));
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    await scheduler.settled();
    // A task that really ended is unchanged: ready (no report given), no halt.
    const ended = scheduler.get(task.id) as TaskRecord;
    expect(ended.state).toBe('ready');
    expect(ended.halt).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a Claude task that lost its login pauses until the user (or the next try) sends it on', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler, { agent: 'claude', command: ['claude'] });
    screens.set('s1', screen('claude-auth.txt'));
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle());
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    await scheduler.settled();
    expect(scheduler.get(task.id)).toMatchObject({ state: 'paused', halt: { kind: 'auth' } });
    expect(pushes()[0].body).toMatch(/Claude lost its login/);
    expect((await scheduler.retry(task.id)).ok).toBe(true);
    expect(deliver).toHaveBeenCalledWith(
      's1',
      haltContinuePrompt('auth'),
      'claude',
      expect.anything()
    );
  });

  it('a task that finishes for real is unchanged (Codex quiet spell, nothing on screen)', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    screens.set('s1', screen('codex-heads-up.txt').replace(/• Working.*\n/, ''));
    await quietSpell(scheduler);
    await vi.waitFor(() =>
      expect(scheduler.get(task.id)).toMatchObject({
        state: 'ready',
        blocker: { kind: 'no-changes' },
      })
    );
    expect(scheduler.get(task.id)?.halt).toBeUndefined();
  });

  it("new tasks of an agent at its limit wait for it, the other agent offered; the other agent's run at once", async () => {
    const scheduler = make();
    await scheduler.start(0);
    const first = await created(scheduler);
    screens.set('s1', screen('codex-usage-limit.txt'));
    await quietSpell(scheduler);
    expect(scheduler.get(first.id)?.state).toBe('paused');
    notify.mockClear();

    const held = await created(scheduler, { name: 'Segunda' });
    const other = await created(scheduler, { name: 'Tercera' });
    expect(launch).toHaveBeenCalledTimes(1);
    const until = new Date(RESET + HALT_RESUME_MARGIN_MS).toISOString();
    expect(scheduler.get(held.id)).toMatchObject({
      state: 'scheduled',
      runAt: until,
      heldFor: { agent: 'codex', until, told: true },
    });
    expect(pushes().map((p) => p.type)).toEqual(['task-paused', 'task-paused']);
    expect(pushes()[0].body).toContain(`ut task retry ${held.id.slice(0, 8)} --agent claude`);
    // Claude is not at a limit: its task starts at once.
    const claude = await created(scheduler, { agent: 'claude', command: ['claude'] });
    expect(scheduler.get(claude.id)?.state).toBe('working');
    expect(launch).toHaveBeenCalledTimes(2);

    // The user moves one to Claude: it starts now with the user's Claude command.
    const moved = await scheduler.retry(other.id, { agent: 'claude' });
    expect(moved.ok).toBe(true);
    await scheduler.settled();
    expect(scheduler.get(other.id)).toMatchObject({
      state: 'working',
      agent: 'claude',
      command: ['claude', '--model', 'opus'],
    });
    expect(scheduler.get(other.id)?.heldFor).toBeUndefined();

    // A running task cannot change agent.
    expect(await scheduler.retry(claude.id, { agent: 'codex' })).toMatchObject({ ok: false });

    // At the reset the held one starts by itself, and the paused one goes on.
    await vi.advanceTimersByTimeAsync(RESET + HALT_RESUME_MARGIN_MS + 1000 - Date.now());
    await scheduler.settled();
    expect(scheduler.get(held.id)?.state).toBe('working');
    expect(scheduler.get(held.id)?.heldFor).toBeUndefined();
    expect(scheduler.get(first.id)?.state).toBe('working');
  });

  it("a provider task's halt holds only that provider's tasks, never the user's own Claude (review 2026-11-08)", async () => {
    const scheduler = make();
    await scheduler.start(0);
    const provider = { agent: 'claude' as const, command: ['claude'], isolation: 'none' as const };
    const first = await created(scheduler, { ...provider, modelProvider: 'abl', model: 'glm-4.6' });
    // The provider refused its key (or ran out of balance): the task pauses.
    screens.set('s1', screen('claude-auth.txt'));
    scheduler.onClaudeTransition('s1', 'idle', 'busy', busy);
    scheduler.onClaudeTransition('s1', 'busy', 'idle', idle());
    await vi.advanceTimersByTimeAsync(IDLE_HOLD_MS);
    await scheduler.settled();
    expect(scheduler.get(first.id)).toMatchObject({ state: 'paused', halt: { kind: 'auth' } });

    // The user's own Claude is not at any limit: its task starts at once.
    const own = await created(scheduler, provider);
    expect(scheduler.get(own.id)?.state).toBe('working');
    expect(scheduler.get(own.id)?.heldFor).toBeUndefined();
    // Another task on the same provider waits for it; one on another provider does not.
    const same = await created(scheduler, { ...provider, modelProvider: 'abl', model: 'glm-4.6' });
    expect(scheduler.get(same.id)).toMatchObject({ state: 'scheduled', heldFor: { told: true } });
    const other = await created(scheduler, { ...provider, modelProvider: 'zen', model: 'k2' });
    expect(scheduler.get(other.id)?.state).toBe('working');
  });

  it('a paused task survives a restart and goes on at its time', async () => {
    const first = make();
    await first.start(0);
    const task = await created(first);
    screens.set('s1', screen('codex-usage-limit.txt'));
    await quietSpell(first);
    first.stop();

    const second = make();
    await second.start(0);
    expect(second.get(task.id)?.state).toBe('paused');
    await vi.advanceTimersByTimeAsync(RESET + HALT_RESUME_MARGIN_MS + 1000 - Date.now());
    await second.settled();
    expect(second.get(task.id)?.state).toBe('working');
    expect(deliver).toHaveBeenCalledWith(
      's1',
      haltContinuePrompt('usage-limit'),
      'codex',
      expect.anything()
    );
  });

  it('a paused task can be discarded', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const task = await created(scheduler);
    screens.set('s1', screen('codex-usage-limit.txt'));
    await quietSpell(scheduler);
    expect((await scheduler.discard(task.id, { confirm: true })).ok).toBe(true);
    expect(scheduler.get(task.id)?.state).toBe('discarded');
    await vi.advanceTimersByTimeAsync(RESET + HALT_RESUME_MARGIN_MS + 1000 - Date.now());
    expect(deliver).not.toHaveBeenCalled();
  });
});
