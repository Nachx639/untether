import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import type { TaskPhaseTiming, TaskReview } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { KeyedMutex } from '../utils/repo-mutex.js';
import { createMergeQueue, type MergeQueue } from './merge-queue.js';
import {
  type PipelineOptions,
  type PipelineResult,
  type PipelineTask,
  runTaskPipeline,
} from './task-merge.js';
import type { ReviewRequest, TaskReviewer } from './task-review.js';
import { createLimiter, createLoadGate, type RunCheckResult } from './task-verify.js';

/**
 * 2026-11-01, bakery: 5 tasks ready at once, every check passed, yet 751b4753 took 2h 25m
 * (4 checks, 49 min queued, «merge 0s (moved)» four times): each merge of another task moved
 * main, its passed check no longer counted and it went back for another whole check. This is
 * that case, simulated: N tasks finish together in one repository, each check takes CHECK_MS.
 */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

function commitFile(cwd: string, file: string, text: string, message = `edit ${file}`): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * One simulated check: CHECK_MS of wall time stands for ~10 minutes of a loaded Mac. A bigger
 * MERGE_QUEUE_SIM_CHECK_MS makes git's own time negligible next to it, for measuring.
 */
const CHECK_MS = Number(process.env.MERGE_QUEUE_SIM_CHECK_MS) || 150;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits behind real git work: a deadline, not vi.waitFor's 1 s (load 40-50, 2026-11-01). */
const UNDER_LOAD = { timeout: 20_000, interval: 5 };

interface SimTask {
  task: PipelineTask;
  head: string;
}

describe('merge queue (2026-11-01: checks thrown away when main moved)', () => {
  let tmp: string;
  let repo: string;
  let settings: ProjectSettings;

  beforeEach(() => {
    for (const [key, value] of Object.entries(GIT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-merge-queue-')));
    repo = path.join(tmp, 'bakery');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    settings = { ...DEFAULT_PROJECT_SETTINGS, checkCommand: 'pnpm test', aiReview: false };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  /** A task with a worktree of its own and one commit touching only `file`. */
  const makeTask = (id: string, file = `${id}.ts`, text = `export const ${id} = 1;\n`): SimTask => {
    const baseSha = git(repo, 'rev-parse', 'main');
    const wt = path.join(tmp, 'wt', id);
    git(repo, 'worktree', 'add', '-q', '-b', `ut/${id}`, wt, baseSha);
    const head = commitFile(wt, file, text);
    return {
      head,
      task: {
        id,
        name: id,
        repoPath: repo,
        baseBranch: 'main',
        baseSha,
        branch: `ut/${id}`,
        worktreePath: wt,
      },
    };
  };

  interface Shared {
    limiter: ReturnType<typeof createLimiter>;
    mutex: KeyedMutex;
    queue: MergeQueue;
    checks: { id: string; head: string }[];
    runCheck: PipelineOptions['runCheck'];
  }

  const shared = (fail: (cwd: string) => boolean = () => false): Shared => {
    const checks: Shared['checks'] = [];
    return {
      limiter: createLimiter(2),
      mutex: new KeyedMutex(),
      queue: createMergeQueue(),
      checks,
      runCheck: async (opts) => {
        checks.push({ id: path.basename(opts.cwd), head: git(opts.cwd, 'rev-parse', 'HEAD') });
        await sleep(CHECK_MS);
        return fail(opts.cwd)
          ? { exitCode: 1, tail: 'FAIL a test', timedOut: false }
          : ({ exitCode: 0, tail: 'all good', timedOut: false } satisfies RunCheckResult);
      },
    };
  };

  const optionsFor = (
    sim: SimTask,
    s: Shared,
    round = 1,
    extra: Partial<PipelineOptions> = {}
  ): PipelineOptions => ({
    mode: 'auto',
    settings,
    logDir: path.join(tmp, 'logs', sim.task.id),
    limiter: s.limiter,
    // A quiet simulated Mac, never the real one's load (a failure under it would wait to rerun).
    loadGate: createLoadGate({ loadavg: () => 1, cores: () => 8 }),
    mutex: s.mutex,
    mergeQueue: s.queue,
    runCheck: s.runCheck,
    round,
    ...extra,
  });

  /**
   * Every task's pipeline at once, as the scheduler starts them when their agents finish; a
   * run that gave up because main kept moving is run again (the scheduler's next round).
   */
  const runAll = async (
    sims: SimTask[],
    s: Shared,
    extra: (sim: SimTask) => Partial<PipelineOptions> = () => ({})
  ) => {
    const started = Date.now();
    const timings = new Map<string, TaskPhaseTiming[]>();
    const results = await Promise.all(
      sims.map(async (sim, index) => {
        // They finish a moment apart, in this order: the first is at its check when the
        // others are ready (else which one is first to take its turn is a race of git calls).
        if (index > 0) {
          await vi.waitFor(() => expect(s.checks.length).toBeGreaterThan(0), {
            timeout: 20_000,
            interval: 5,
          });
          await sleep(index * 5);
        }
        // Its place in line is when it became ready, said outright (what a run taken up after
        // a restart carries). 2026-11-11: the place came from the millisecond each pipeline
        // happened to start in, 5 ms apart: under load t3 started before t2 and merged first.
        sim.task.mergeQueue ??= {
          position: index + 1,
          of: sims.length,
          since: new Date(started + index).toISOString(),
        };
        let result: PipelineResult;
        let round = 1;
        for (;;) {
          result = await runTaskPipeline(sim.task, optionsFor(sim, s, round, extra(sim)));
          timings.set(sim.task.id, [
            ...(timings.get(sim.task.id) ?? []),
            ...(result.timings ?? []),
          ]);
          if (!/kept moving/.test(result.blocker?.message ?? '') || round > 5) break;
          round++;
        }
        return { id: sim.task.id, result, rounds: round, wallMs: Date.now() - started };
      })
    );
    return { results, timings, wallMs: Date.now() - started };
  };

  /** "check 3 (36m), moved 2, wall 1h 12m" in simulated minutes (CHECK_MS = 10 min). */
  const report = (run: Awaited<ReturnType<typeof runAll>>, s: Shared) => {
    const minutes = (ms: number) => Math.round((ms / CHECK_MS) * 10);
    const lines = run.results.map(({ id, result, wallMs }) => {
      const timings = run.timings.get(id) ?? [];
      const sum = (phase: string) =>
        timings
          .filter((t) => t.phase === phase)
          .reduce((ms, t) => ms + (Date.parse(t.finishedAt ?? '') - Date.parse(t.startedAt)), 0);
      const moved = timings.filter((t) => t.phase === 'merge' && t.outcome === 'moved').length;
      const checks = s.checks.filter((c) => c.id === id).length;
      return `${id}: ${result.state}, ${checks} checks (${minutes(sum('verify'))} min), queued ${minutes(sum('queue') + sum('merge-queue'))} min, moved ${moved}, done after ${minutes(wallMs)} min`;
    });
    return [
      ...lines,
      `all: ${s.checks.length} checks for ${run.results.length} tasks, ${minutes(run.wallMs)} min`,
    ].join('\n');
  };

  /** Every check ran on the very commit that then merged: none was thrown away. */
  const checkedWhatMerged = (run: Awaited<ReturnType<typeof runAll>>, s: Shared) => {
    for (const { id, result } of run.results) {
      if (result.state !== 'merged') continue;
      expect(s.checks.filter((c) => c.id === id).map((c) => c.head)).toEqual([result.mergedSha]);
    }
  };

  it('five tasks ready at once: one whole check each, none thrown away, all merged', async () => {
    const sims = ['t1', 't2', 't3', 't4', 't5'].map((id) => makeTask(id));
    const s = shared();
    const order: string[] = [];
    const run = await runAll(sims, s, (sim) => ({ onMoveBase: () => order.push(sim.task.id) }));
    console.log(`[merge-queue sim]\n${report(run, s)}`);
    expect(run.results.map((r) => r.result.state)).toEqual(Array(5).fill('merged'));
    expect(s.checks).toHaveLength(5);
    checkedWhatMerged(run, s);
    // Merged in the order they were ready, each on top of the one before.
    expect(order).toEqual(['t1', 't2', 't3', 't4', 't5']);
    const merged = git(repo, 'ls-tree', '--name-only', 'main').split('\n');
    expect(merged).toEqual(expect.arrayContaining(['t1.ts', 't2.ts', 't3.ts', 't4.ts', 't5.ts']));
    // None saw the base move under it.
    for (const timings of run.timings.values()) {
      expect(timings.filter((t) => t.outcome === 'moved')).toEqual([]);
    }
  }, 60_000);

  it('three ready at once: each checked once, on what merges; the wait shows as merge-queue', async () => {
    const sims = ['t1', 't2', 't3'].map((id) => makeTask(id));
    const s = shared();
    const spots = new Map<string, string[]>();
    const run = await runAll(sims, s, (sim) => ({
      onProgress: (p) => {
        if (p.state !== 'merge-queue') return;
        const seen = spots.get(sim.task.id) ?? [];
        seen.push(p.spot ? `${p.spot.position}/${p.spot.of}` : 'out');
        spots.set(sim.task.id, seen);
      },
    }));
    expect(run.results.map((r) => r.result.state)).toEqual(['merged', 'merged', 'merged']);
    expect(s.checks).toHaveLength(3);
    checkedWhatMerged(run, s);
    // The last one was third, then second, then had its turn.
    expect(spots.get('t3')).toEqual(expect.arrayContaining(['3/3', '2/2', '1/1', 'out']));
    const t3 = run.timings.get('t3') ?? [];
    expect(t3.filter((t) => t.phase === 'merge-queue').map((t) => t.outcome)).toEqual(['its turn']);
    expect(s.queue.line(keyOf())).toEqual([]);
  }, 60_000);

  it('one whose check fails does not hold up the others', async () => {
    const sims = ['t1', 't2', 't3'].map((id) => makeTask(id));
    const s = shared((cwd) => path.basename(cwd) === 't1');
    const run = await runAll(sims, s);
    expect(run.results.map((r) => r.result.state)).toEqual(['failed', 'merged', 'merged']);
    // t1 ran its check once (a quiet Mac's failure counts at once); the others one each.
    expect(s.checks.filter((c) => c.id === 't1')).toHaveLength(1);
    checkedWhatMerged(run, s);
    expect(git(repo, 'ls-tree', '--name-only', 'main').split('\n')).not.toContain('t1.ts');
  }, 60_000);

  it('a conflict with what merged ahead of it: the usual conflict, no check spent, the rest merge', async () => {
    const t1 = makeTask('t1', 'a.txt', 'one\nfirst\nthree\n');
    const t2 = makeTask('t2', 'a.txt', 'one\nsecond\nthree\n');
    const t3 = makeTask('t3');
    const s = shared();
    const run = await runAll([t1, t2, t3], s);
    const [r1, r2, r3] = run.results.map((r) => r.result);
    expect(r1.state).toBe('merged');
    expect(r2).toMatchObject({
      state: 'needs_you',
      blocker: { kind: 'conflict', detail: ['a.txt'] },
    });
    expect(r3.state).toBe('merged');
    expect(s.checks.filter((c) => c.id === 't2')).toEqual([]);
    // Its worktree is as it was: the merge was aborted.
    expect(git(t2.task.worktreePath as string, 'status', '--porcelain')).toBe('');
    expect(git(t2.task.worktreePath as string, 'rev-parse', 'HEAD')).toBe(t2.head);
  }, 60_000);

  it("the user's own merge goes ahead of the unattended ones still waiting, never of the one at its turn", async () => {
    const sims = ['t1', 't2', 't3', 'mine'].map((id) => makeTask(id));
    const s = shared();
    const order: string[] = [];
    const run = await runAll(sims, s, (sim) => ({
      ...(sim.task.id === 'mine'
        ? { mode: 'merge' as const, mergePriority: () => 'user' as const }
        : {}),
      onMoveBase: () => order.push(sim.task.id),
    }));
    expect(run.results.map((r) => r.result.state)).toEqual(Array(4).fill('merged'));
    expect(order).toEqual(['t1', 'mine', 't2', 't3']);
    checkedWhatMerged(run, s);
  }, 60_000);

  it('fast lane: marked urgent while it waits, it goes next, ahead of the user’s merge too, and still passes its whole check (2026-11-01)', async () => {
    const sims = ['t1', 't2', 'mine', 'hot'].map((id) => makeTask(id));
    const s = shared();
    const order: string[] = [];
    const urgent = new Set<string>();
    const run = runAll(sims, s, (sim) => ({
      ...(sim.task.id === 'mine' ? { mode: 'merge' as const } : {}),
      mergePriority: () =>
        urgent.has(sim.task.id) ? 'urgent' : sim.task.id === 'mine' ? 'user' : undefined,
      onMoveBase: () => order.push(sim.task.id),
    }));
    // All four in line, t1 at its turn: 'hot' is marked urgent (ut task priority hot urgent).
    await vi.waitFor(() => expect(s.queue.line(`${repo}\0main`)).toHaveLength(4), {
      timeout: 20_000,
    });
    expect(s.queue.line(`${repo}\0main`)).toEqual(['t1', 'mine', 't2', 'hot']);
    urgent.add('hot');
    expect(s.queue.prioritize(`${repo}\0main`, 'hot', 'urgent')).toBe(true);
    expect(s.queue.line(`${repo}\0main`)).toEqual(['t1', 'hot', 'mine', 't2']);
    const done = await run;
    expect(done.results.map((r) => r.result.state)).toEqual(Array(4).fill('merged'));
    expect(order).toEqual(['t1', 'hot', 'mine', 't2']);
    // Only the order changed: one whole check each, on exactly what merged.
    expect(s.checks.map((c) => c.id).sort()).toEqual(['hot', 'mine', 't1', 't2']);
    checkedWhatMerged(done, s);
  }, 60_000);

  it('a task that waits for its turn is reviewed once, though main moved twice meanwhile', async () => {
    settings = { ...settings, aiReview: true };
    const reviewer = vi.fn(
      async (request: ReviewRequest): Promise<TaskReview> => ({
        verdict: 'ok',
        summary: 'Bien',
        issues: [],
        at: '2026-11-01T00:00:00.000Z',
        model: 'sonnet',
        headSha: request.headSha,
      })
    );
    const sims = ['t1', 't2', 't3'].map((id) => makeTask(id));
    const s = shared();
    const run = await runAll(sims, s, () => ({
      reviewer: reviewer as unknown as TaskReviewer,
    }));
    expect(run.results.map((r) => r.result.state)).toEqual(['merged', 'merged', 'merged']);
    expect(reviewer).toHaveBeenCalledTimes(3);
    const t3 = run.results[2].result;
    expect(t3.review?.carriedFrom).toBe(sims[2].head);
    expect(s.checks).toHaveLength(3);
  }, 60_000);

  it('leaves the line when the task is discarded while it waits: no check, nothing merged', async () => {
    const [t1, t2] = ['t1', 't2'].map((id) => makeTask(id));
    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const s = shared();
    const quick = s.runCheck;
    s.runCheck = async (opts) => {
      await held;
      return (quick as NonNullable<PipelineOptions['runCheck']>)(opts);
    };
    const leave = new AbortController();
    const first = runTaskPipeline(t1.task, optionsFor(t1, s));
    await vi.waitFor(() => expect(s.queue.line(keyOf())).toEqual(['t1']), UNDER_LOAD);
    const second = runTaskPipeline(t2.task, optionsFor(t2, s, 1, { signal: leave.signal }));
    await vi.waitFor(() => expect(s.queue.line(keyOf())).toEqual(['t1', 't2']), UNDER_LOAD);
    leave.abort();
    const left = await second;
    expect(left.state).toBe('ready');
    expect(left.timings?.find((t) => t.phase === 'merge-queue')?.outcome).toBe('left');
    expect(s.queue.line(keyOf())).toEqual(['t1']);
    finish();
    expect((await first).state).toBe('merged');
    expect(s.checks.map((c) => c.id)).toEqual(['t1']);
  }, 60_000);

  const keyOf = () => `${repo}\0main`;
});

describe('createMergeQueue', () => {
  it("first come, first served; the user's merges ahead of waiting ones, never of a turn taken", async () => {
    const queue = createMergeQueue();
    const a = queue.join('k', { id: 'a', at: 1 });
    expect(a.tryTurn()).toBe(true);
    const b = queue.join('k', { id: 'b', at: 2 });
    const c = queue.join('k', { id: 'c', at: 3 });
    expect(b.tryTurn()).toBe(false);
    const u = queue.join('k', { id: 'u', at: 4, priority: 'user' });
    expect(queue.line('k')).toEqual(['a', 'u', 'b', 'c']);
    expect(c.spot()).toEqual({ position: 4, of: 4 });
    let bTurn = false;
    void b.turn().then(() => (bTurn = true));
    const uTurn = u.turn();
    a.leave();
    await uTurn;
    expect(bTurn).toBe(false);
    expect(queue.line('k')).toEqual(['u', 'b', 'c']);
    // A later priority one never goes ahead of a turn already taken.
    const v = queue.join('k', { id: 'v', at: 5, priority: 'user' });
    expect(queue.line('k')).toEqual(['u', 'v', 'b', 'c']);
    u.leave();
    v.leave();
    await vi.waitFor(() => expect(bTurn).toBe(true));
    expect(b.spot()).toEqual({ position: 1, of: 2 });
    b.leave();
    c.leave();
    expect(queue.line('k')).toEqual([]);
  });

  it('urgent goes ahead of the user’s merges and of unattended ones; unmarked it goes back to its place', () => {
    const queue = createMergeQueue();
    const a = queue.join('k', { id: 'a', at: 1 });
    a.tryTurn();
    queue.join('k', { id: 'b', at: 2 });
    queue.join('k', { id: 'u', at: 3, priority: 'user' });
    const c = queue.join('k', { id: 'c', at: 4 });
    expect(queue.line('k')).toEqual(['a', 'u', 'b', 'c']);
    expect(queue.prioritize('k', 'c', 'urgent')).toBe(true);
    expect(queue.line('k')).toEqual(['a', 'c', 'u', 'b']);
    expect(c.spot()).toEqual({ position: 2, of: 4, priority: 'urgent' });
    // The one holding its turn keeps it, urgent or not.
    expect(queue.prioritize('k', 'a', undefined)).toBe(true);
    expect(queue.line('k')[0]).toBe('a');
    queue.prioritize('k', 'c', undefined);
    expect(queue.line('k')).toEqual(['a', 'u', 'b', 'c']);
    expect(queue.prioritize('k', 'nobody', 'urgent')).toBe(false);
  });

  it('marked urgent while first in line waiting, it takes its turn', async () => {
    const queue = createMergeQueue();
    const a = queue.join('k', { id: 'a', at: 1 });
    const b = queue.join('k', { id: 'b', at: 2 });
    // Neither took its turn yet (a is still at its cheap steps): b waits for it.
    let bTurn = false;
    void b.turn().then(() => (bTurn = true));
    queue.prioritize('k', 'b', 'urgent');
    await vi.waitFor(() => expect(bTurn).toBe(true));
    expect(a.tryTurn()).toBe(false);
    b.leave();
    expect(a.tryTurn()).toBe(true);
  });

  it('a wait aborted leaves the line; other keys are other lines', async () => {
    const queue = createMergeQueue();
    const a = queue.join('k', { id: 'a', at: 1 });
    a.tryTurn();
    const other = queue.join('other', { id: 'x', at: 2 });
    expect(other.tryTurn()).toBe(true);
    const b = queue.join('k', { id: 'b', at: 2 });
    const controller = new AbortController();
    const waiting = b.turn(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow('Left the merge queue');
    expect(queue.line('k')).toEqual(['a']);
    expect(b.spot()).toBeUndefined();
  });

  it('tells who changed', () => {
    const queue = createMergeQueue();
    const changes: string[] = [];
    const stop = queue.onChange((key) => changes.push(key));
    const a = queue.join('k', { id: 'a', at: 1 });
    a.tryTurn();
    a.leave();
    stop();
    queue.join('k', { id: 'b', at: 2 });
    expect(changes).toEqual(['k', 'k', 'k']);
  });
});
