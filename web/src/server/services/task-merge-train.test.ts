import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import type { TaskBlocker, TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { KeyedMutex } from '../utils/repo-mutex.js';
import { createMergeQueue, type MergeQueue, mergeQueueKey } from './merge-queue.js';
import { mergeTrainsFor } from './merge-train.js';
import {
  type PipelineOptions,
  type PipelineResult,
  type PipelineTask,
  runTaskPipeline,
} from './task-merge.js';
import { fixPrompt } from './task-scheduler-prompts.js';
import { createLimiter, createLoadGate, type RunCheckOptions } from './task-verify.js';

/**
 * Two-level checks through the real pipeline (2026-11-02): each task runs its fast check and
 * related tests; the merge batch runs the whole check once on the combined result before main
 * moves, and a task whose related tests passed but broke something else is sent back.
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
const CHECK_MS = 120;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

function commitFile(cwd: string, file: string, text: string): string {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

const read = (cwd: string, file: string) => {
  try {
    return fs.readFileSync(path.join(cwd, file), 'utf8');
  } catch {
    return null;
  }
};

interface Ran {
  id: string;
  level: 'related' | 'full';
  head: string;
  command: string;
}

describe('two-level checks and the merge batch (2026-11-02)', () => {
  let tmp: string;
  let repo: string;
  let settings: ProjectSettings;
  let queue: MergeQueue;
  let mutex: KeyedMutex;
  let ran: Ran[];

  beforeEach(() => {
    for (const [key, value] of Object.entries(GIT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-merge-train-')));
    repo = path.join(tmp, 'untether');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'lib.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"p"}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      aiReview: false,
      checkCommand: 'whole-check',
      fastCheckCommand: 'fast-check',
      relatedTestCommand: 'related-tests {files}',
    };
    queue = createMergeQueue();
    mutex = new KeyedMutex();
    ran = [];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  const makeTask = (id: string, file: string, text: string): PipelineTask => {
    const baseSha = git(repo, 'rev-parse', 'main');
    const wt = path.join(tmp, 'wt', id);
    git(repo, 'worktree', 'add', '-q', '-b', `ut/${id}`, wt, baseSha);
    commitFile(wt, file, text);
    return {
      id,
      name: id,
      repoPath: repo,
      baseBranch: 'main',
      baseSha,
      branch: `ut/${id}`,
      worktreePath: wt,
    };
  };

  /**
   * The simulated project: the related tests only see each task's own files and always pass;
   * the whole check fails when `broken(worktree)` says the combined code is broken.
   */
  const runCheck = (broken: (cwd: string) => boolean) => async (opts: RunCheckOptions) => {
    const level = opts.command.includes('related-tests') ? 'related' : 'full';
    ran.push({
      id: path.basename(opts.cwd),
      level,
      head: git(opts.cwd, 'rev-parse', 'HEAD'),
      command: opts.command,
    });
    await sleep(CHECK_MS);
    const fails = level === 'full' && broken(opts.cwd);
    return { exitCode: fails ? 1 : 0, tail: fails ? 'FAIL use.test.ts' : 'ok', timedOut: false };
  };

  const optionsFor = (
    task: PipelineTask,
    broken: (cwd: string) => boolean,
    limiter = createLimiter(4)
  ): PipelineOptions => ({
    mode: 'auto',
    settings,
    logDir: path.join(tmp, 'logs', task.id),
    limiter,
    loadGate: createLoadGate({ loadavg: () => 1, cores: () => 8 }),
    mutex,
    mergeQueue: queue,
    runCheck: runCheck(broken),
  });

  /**
   * A first, B once A's check started; A's first check ends only once B waits behind it in the
   * merge queue (else A's batch could leave alone first: a race of git calls).
   */
  const runBoth = async (
    a: PipelineTask,
    b: PipelineTask,
    broken: (cwd: string) => boolean
  ): Promise<[PipelineResult, PipelineResult]> => {
    const limiter = createLimiter(4);
    const optionsA = optionsFor(a, broken, limiter);
    const check = optionsA.runCheck as NonNullable<PipelineOptions['runCheck']>;
    let held = false;
    optionsA.runCheck = async (opts) => {
      if (!held) {
        held = true;
        await vi.waitFor(() => expect(queue.line(mergeQueueKey(repo, 'main'))).toContain('b'), {
          timeout: 20_000,
          interval: 5,
        });
      }
      return check(opts);
    };
    const first = runTaskPipeline(a, optionsA);
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 20_000, interval: 5 });
    const second = runTaskPipeline(b, optionsFor(b, broken, limiter));
    return [await first, await second];
  };

  it('a lone task runs its related tests, then the whole check once, then merges', async () => {
    const a = makeTask('a', 'feature.ts', 'export const f = 1;\n');
    const result = await runTaskPipeline(
      a,
      optionsFor(a, () => false)
    );
    expect(result.state).toBe('merged');
    expect(ran.map((r) => r.level)).toEqual(['related', 'full']);
    expect(ran[0].command).toBe(
      `(fast-check) && (related-tests ${path.join(a.worktreePath as string, 'feature.ts')})`
    );
    expect(ran[1].command).toBe('whole-check');
    expect(result.verify).toMatchObject({ level: 'related', relatedFiles: 1, exitCode: 0 });
    // Timings say which level ran and how long.
    const verifies = (result.timings ?? []).filter((t) => t.phase === 'verify');
    expect(verifies.map((t) => t.level)).toEqual(['related', 'batch']);
    expect(git(repo, 'rev-parse', 'main')).toBe(result.mergedSha);
  }, 30_000);

  it('a change the related set cannot judge (package.json) runs the whole check, and no batch check after it', async () => {
    const a = makeTask('a', 'package.json', '{"name":"p","version":"2"}\n');
    const result = await runTaskPipeline(
      a,
      optionsFor(a, () => false)
    );
    expect(result.state).toBe('merged');
    expect(ran.map((r) => [r.level, r.command])).toEqual([['full', 'whole-check']]);
    expect(result.verify).toMatchObject({ level: 'full' });
    expect(result.verify?.fullReason).toContain('package.json');
  }, 30_000);

  it('the batch catches a cross-file break: the task before merges, the one that broke it is sent back', async () => {
    // A changes lib.ts; B adds use.ts, which needs lib's x to be 1. Each one's related tests
    // pass; only the two together fail.
    const a = makeTask('a', 'lib.ts', 'export const x = 2;\n');
    const b = makeTask('b', 'use.ts', "import { x } from './lib';\nif (x !== 1) throw 1;\n");
    const broken = (cwd: string) =>
      read(cwd, 'use.ts') !== null && read(cwd, 'lib.ts') === 'export const x = 2;\n';
    const [ra, rb] = await runBoth(a, b, broken);
    expect(ra.state).toBe('merged');
    expect(rb.state).toBe('failed');
    expect(rb.blocker).toMatchObject({ kind: 'verify' });
    expect(rb.blocker?.message).toContain('merge batch');
    expect(rb.verify).toMatchObject({ level: 'batch', exitCode: 1 });
    // One whole check of the batch (in B's worktree, on A+B), one of A alone to bisect it.
    const full = ran.filter((r) => r.level === 'full').map((r) => r.id);
    expect(full).toEqual(['b', 'a']);
    // Main moved once, to A; B's work never reached it.
    expect(git(repo, 'rev-parse', 'main')).toBe(ra.mergedSha);
    expect(read(repo, 'use.ts')).toBeNull();
    // B's branch is back to its own work (A's is in main anyway).
    expect(git(b.worktreePath as string, 'rev-parse', 'HEAD')).toBe(
      git(repo, 'rev-parse', 'refs/heads/ut/b')
    );
    expect(git(repo, 'for-each-ref', 'refs/untether/')).toBe('');
  }, 60_000);

  it('the first car broke it: it is sent back, the one built on it builds again without it and merges', async () => {
    const a = makeTask('a', 'broken.ts', 'export const broken = true;\n');
    const b = makeTask('b', 'ok.ts', 'export const ok = 1;\n');
    const broken = (cwd: string) => read(cwd, 'broken.ts') !== null;
    const [ra, rb] = await runBoth(a, b, broken);
    expect(ra.state).toBe('failed');
    expect(ra.verify).toMatchObject({ level: 'batch' });
    expect(rb.state).toBe('merged');
    expect(read(repo, 'broken.ts')).toBeNull();
    expect(read(repo, 'ok.ts')).toBe('export const ok = 1;\n');
    // B's merged commit holds none of A's work.
    const aOwn = git(repo, 'rev-parse', 'refs/heads/ut/a');
    expect(() => git(repo, 'merge-base', '--is-ancestor', aOwn, 'main')).toThrow();
  }, 60_000);

  // 2026-11-11: a conflict with the batch's tip was told as "Conflicts with main"; the agent
  // ran `git merge main`, saw no conflict and had nothing to fix.
  it('a conflict with the car ahead names the batch tip, and the agent is told to merge that commit', async () => {
    const a = makeTask('a', 'same.ts', 'export const who = "a";\n');
    const b = makeTask('b', 'same.ts', 'export const who = "b";\n');
    const [ra, rb] = await runBoth(a, b, () => false);
    expect(ra.state).toBe('merged');
    expect(rb.state).toBe('needs_you');
    expect(rb.blocker).toMatchObject({ kind: 'conflict', detail: ['same.ts'], batchTip: true });
    const tip = rb.blocker?.base as string;
    expect(tip).toMatch(/^[0-9a-f]{40}$/);
    expect(rb.blocker?.message).not.toContain('Conflicts with main');
    expect(rb.blocker?.message).toContain(`the merge batch ahead of it (${tip.slice(0, 12)}`);
    const told = fixPrompt({ ...b, baseBranch: 'main' } as TaskRecord, rb.blocker as TaskBlocker);
    expect(told).toContain(`Run \`git merge ${tip}\``);
    expect(told).not.toContain('git merge main');
    // The commit named is one the agent has: merging it shows the conflict it was told of.
    expect(() => git(b.worktreePath as string, 'merge', '--no-edit', tip)).toThrow();
    expect(git(b.worktreePath as string, 'diff', '--name-only', '--diff-filter=U')).toBe('same.ts');
  }, 60_000);

  it('both fine: one whole check for the batch, main moves once to the combined commit', async () => {
    const a = makeTask('a', 'one.ts', 'export const one = 1;\n');
    const b = makeTask('b', 'two.ts', 'export const two = 2;\n');
    const [ra, rb] = await runBoth(a, b, () => false);
    expect([ra.state, rb.state]).toEqual(['merged', 'merged']);
    expect(ran.filter((r) => r.level === 'full')).toHaveLength(1);
    expect(git(repo, 'rev-parse', 'main')).toBe(rb.mergedSha);
    // B's change starts at A's commit: undoing B never undoes A.
    expect(rb.mergedOnto).toBe(ra.mergedSha);
  }, 60_000);
  it('a restart in the middle of a batch: the branch goes back to its own work, no other car reaches main', async () => {
    const a = makeTask('a', 'mine.ts', 'export const mine = 1;\n');
    const wt = a.worktreePath as string;
    const own = git(wt, 'rev-parse', 'HEAD');
    // What boarding left: the batch's tip (another car's unmerged work) merged into the branch.
    const car = commitFile(wt, 'other-car.ts', 'export const notMerged = 1;\n');
    git(repo, 'update-ref', 'refs/untether/train/a/own', own);
    git(repo, 'update-ref', 'refs/untether/train/a/car', car);
    const result = await runTaskPipeline(
      a,
      optionsFor(a, () => false)
    );
    expect(result.state).toBe('merged');
    expect(read(repo, 'mine.ts')).toBe('export const mine = 1;\n');
    expect(read(repo, 'other-car.ts')).toBeNull();
    expect(git(repo, 'for-each-ref', 'refs/untether/')).toBe('');
  }, 30_000);
  it('a task that built on the batch and stopped before boarding goes back to its own work (2026-11-10)', async () => {
    // A boards; B takes its turn on top of A's commit and its own related tests fail: it never
    // boards. A then breaks the whole check and is sent back. B's branch kept A's commit, and
    // B's next pass took it to main (or was blamed for A's break).
    const a = makeTask('a', 'broken.ts', 'export const broken = true;\n');
    const b = makeTask('b', 'ok.ts', 'export const ok = 1;\n');
    const bOwn = git(b.worktreePath as string, 'rev-parse', 'HEAD');
    const aOwn = git(repo, 'rev-parse', 'refs/heads/ut/a');
    const broken = (cwd: string) => read(cwd, 'broken.ts') !== null;
    const limiter = createLimiter(4);
    const optionsA = optionsFor(a, broken, limiter);
    const check = optionsA.runCheck as NonNullable<PipelineOptions['runCheck']>;
    let held = false;
    optionsA.runCheck = async (opts) => {
      if (!held) {
        held = true;
        await vi.waitFor(() => expect(queue.line(mergeQueueKey(repo, 'main'))).toContain('b'), {
          timeout: 20_000,
          interval: 5,
        });
      }
      return check(opts);
    };
    const optionsB = optionsFor(b, broken, limiter);
    let bRelatedFails = true;
    let bCheckedOn = '';
    optionsB.runCheck = async (opts) => {
      if (opts.command.includes('related-tests') && bRelatedFails) {
        bCheckedOn = git(opts.cwd, 'rev-parse', 'HEAD');
        return { exitCode: 1, tail: 'FAIL ok.test.ts', timedOut: false };
      }
      return check(opts);
    };
    const first = runTaskPipeline(a, optionsA);
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 20_000, interval: 5 });
    const rb = await runTaskPipeline(b, optionsB);
    const ra = await first;
    expect(ra.state).toBe('failed');
    expect(rb.state).toBe('failed');
    expect(rb.blocker).toMatchObject({ kind: 'verify', message: 'The check failed' });
    // It was checked on top of A's commit (the batch's tip)…
    expect(git(repo, 'merge-base', '--is-ancestor', aOwn, bCheckedOn)).toBe('');
    // …and is back on its own work, with nothing of A's.
    expect(git(repo, 'rev-parse', 'refs/heads/ut/b')).toBe(bOwn);
    expect(read(b.worktreePath as string, 'broken.ts')).toBeNull();
    expect(git(repo, 'for-each-ref', 'refs/untether/')).toBe('');

    // Its agent fixed its tests: it merges, alone.
    bRelatedFails = false;
    const again = await runTaskPipeline(b, optionsFor(b, broken, limiter));
    expect(again.state).toBe('merged');
    expect(read(repo, 'ok.ts')).toBe('export const ok = 1;\n');
    expect(read(repo, 'broken.ts')).toBeNull();
    expect(() => git(repo, 'merge-base', '--is-ancestor', aOwn, 'main')).toThrow();
  }, 60_000);

  it('commits made on top of a batch that did not merge are kept, and the task says so (2026-11-10)', async () => {
    const a = makeTask('a', 'broken.ts', 'export const broken = true;\n');
    const b = makeTask('b', 'ok.ts', 'export const ok = 1;\n');
    const wt = b.worktreePath as string;
    const broken = (cwd: string) => read(cwd, 'broken.ts') !== null;
    const limiter = createLimiter(4);
    const optionsA = optionsFor(a, broken, limiter);
    const check = optionsA.runCheck as NonNullable<PipelineOptions['runCheck']>;
    let held = false;
    optionsA.runCheck = async (opts) => {
      if (!held) {
        held = true;
        await vi.waitFor(() => expect(queue.line(mergeQueueKey(repo, 'main'))).toContain('b'), {
          timeout: 20_000,
          interval: 5,
        });
      }
      return check(opts);
    };
    const optionsB = optionsFor(b, broken, limiter);
    let extra = '';
    optionsB.runCheck = async () => {
      // The agent commits while its check runs, and the check fails on something else.
      if (!extra) extra = commitFile(wt, 'more.ts', 'export const more = 1;\n');
      return { exitCode: 1, tail: 'FAIL ok.test.ts', timedOut: false };
    };
    const first = runTaskPipeline(a, optionsA);
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 20_000, interval: 5 });
    const rb = await runTaskPipeline(b, optionsB);
    await first;
    expect(rb.state).not.toBe('merged');
    // Nothing lost: the commit is still on the branch, and the refs say what to undo.
    expect(git(repo, 'merge-base', '--is-ancestor', extra, 'refs/heads/ut/b')).toBe('');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/untether/')).toContain(
      'refs/untether/train/b/own'
    );
    // The next pass does not merge A's work through it: it says why.
    const again = await runTaskPipeline(b, optionsFor(b, broken, limiter));
    expect(again.state).toBe('needs_you');
    expect(again.blocker?.message).toContain('on top of a merge batch that did not merge');
    expect(read(repo, 'broken.ts')).toBeNull();
    expect(read(wt, 'more.ts')).toBe('export const more = 1;\n');
  }, 60_000);

  it('a task no check covers does not build on the batch: it merges on the base (2026-11-10)', async () => {
    // No project check: a package's own one is detected for A; nothing covers B's root doc.
    settings = { ...settings, checkCommand: undefined };
    commitFile(repo, 'pkg/package.json', '{"name":"pkg","scripts":{"test":"vitest run"}}\n');
    const a = makeTask('a', 'pkg/feature.ts', 'export const f = 1;\n');
    const b = makeTask('b', 'NOTES.md', 'notes\n');
    const bOwn = git(b.worktreePath as string, 'rev-parse', 'HEAD');
    const [ra, rb] = await runBoth(a, b, () => false);
    expect(rb.state).toBe('merged');
    expect(ra.state).toBe('merged');
    expect(read(repo, 'NOTES.md')).toBe('notes\n');
    expect(read(repo, 'pkg/feature.ts')).toBe('export const f = 1;\n');
    // B's merged commit is its own work on main: A's batch commit never came through it.
    expect(rb.mergedSha).toBe(bOwn);
    expect(git(repo, 'for-each-ref', 'refs/untether/')).toBe('');
  }, 60_000);

  it('a restart in the middle of a batch with files edited since: they are kept, and the task says so (2026-11-10)', async () => {
    const a = makeTask('a', 'mine.ts', 'export const mine = 1;\n');
    const wt = a.worktreePath as string;
    const own = git(wt, 'rev-parse', 'HEAD');
    const car = commitFile(wt, 'other-car.ts', 'export const notMerged = 1;\n');
    git(repo, 'update-ref', 'refs/untether/train/a/own', own);
    git(repo, 'update-ref', 'refs/untether/train/a/car', car);
    // The agent went on working while the batch was checked: not committed yet.
    fs.writeFileSync(path.join(wt, 'mine.ts'), 'export const mine = 2; // in progress\n');
    const result = await runTaskPipeline(
      a,
      optionsFor(a, () => false)
    );
    expect(result.state).toBe('needs_you');
    expect(result.blocker?.message).toContain('uncommitted changes on top of a merge batch');
    expect(read(wt, 'mine.ts')).toBe('export const mine = 2; // in progress\n');
    expect(read(repo, 'other-car.ts')).toBeNull();
  }, 30_000);

  it('work of its own that the batch on board already holds is still its own: never "no changes" (2026-11-11)', async () => {
    // Real case (task a35010d2, 2026-11-11 00:06): four commits of its own, not merged, and it
    // came back "ready · no-changes" and was to be closed. Its work was counted against the
    // batch's tip, which held it (through a car built on its car of an earlier pass).
    const a = makeTask('a', 'mine.ts', 'export const mine = 1;\n');
    const aOwn = git(a.worktreePath as string, 'rev-parse', 'HEAD');
    const other = makeTask('other', 'other.ts', 'export const other = 1;\n');
    git(other.worktreePath as string, 'merge', '-q', '--no-edit', aOwn);
    const otherHead = git(other.worktreePath as string, 'rev-parse', 'HEAD');
    const main = git(repo, 'rev-parse', 'main');
    const key = mergeQueueKey(repo, 'main');
    const trains = mergeTrainsFor(queue);
    // A task waits its turn behind, so the batch keeps boarding.
    const behind = queue.join(key, { id: 'behind', at: Date.now() + 3_600_000 });
    const discard = new AbortController();
    const otherVerdict = trains.board(
      key,
      {
        id: 'other',
        head: otherHead,
        onto: main,
        level: 'related',
        files: ['other.ts'],
        signal: discard.signal,
        fullCheck: async () => {
          throw new Error('this batch is never checked');
        },
        move: async () => ({ kind: 'merged' }),
      },
      main
    );
    expect(trains.cars(key)).toEqual(['other']);

    let ended: PipelineResult | undefined;
    const run = runTaskPipeline(
      a,
      optionsFor(a, () => false)
    ).then((result) => {
      ended = result;
      return result;
    });
    const mergeLog = path.join(tmp, 'logs', 'a', 'merge.log');
    await vi.waitFor(
      () => expect(read(path.dirname(mergeLog), 'merge.log')).toContain('holds this task'),
      { timeout: 20_000, interval: 10 }
    );
    // It waits for that batch, out of the line (the batch could not leave behind it).
    expect(ended).toBeUndefined();
    expect(queue.line(key)).not.toContain('a');

    // The other car is discarded: the batch is gone, and A merges its own work on main.
    discard.abort();
    expect(await otherVerdict).toEqual({ kind: 'left' });
    behind.leave();
    const result = await run;
    expect(result.state).toBe('merged');
    expect(result.blocker).toBeUndefined();
    expect(read(repo, 'mine.ts')).toBe('export const mine = 1;\n');
    expect(read(repo, 'other.ts')).toBeNull();
  }, 60_000);

  it('a base that cannot move (main checkout dirty in a file the car changes): the car stops with the base reason, back on its own work', async () => {
    const a = makeTask('a', 'lib.ts', 'export const x = 2;\n');
    const own = git(a.worktreePath as string, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'lib.ts'), 'export const x = 99; // not committed\n');
    const result = await runTaskPipeline(
      a,
      optionsFor(a, () => false)
    );
    expect(result.state).toBe('needs_you');
    expect(result.blocker).toMatchObject({ kind: 'dirty-base', detail: ['lib.ts'] });
    expect(read(repo, 'lib.ts')).toBe('export const x = 99; // not committed\n');
    // Its branch is its own work again (main was merged in at step 3: nothing else of anyone's).
    expect(git(a.worktreePath as string, 'merge-base', '--is-ancestor', own, 'HEAD')).toBe('');
    expect(git(repo, 'for-each-ref', 'refs/untether/')).toBe('');
  }, 30_000);
});
