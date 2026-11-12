/**
 * The merge pipeline does not run a check again on a tree it already passed on (2026-11-11,
 * check-results.ts). The same code was checked several times: at every round (a review, a
 * conflict, its turn in the merge queue) Untether ran the whole check again, even when the
 * files were the very same. Real repositories and the real pipeline; only the check's command
 * is a stand-in that counts how often it ran and on what.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { KeyedMutex } from '../utils/repo-mutex.js';
import { CheckResults } from './check-results.js';
import { createMergeQueue } from './merge-queue.js';
import {
  type PipelineOptions,
  type PipelineResult,
  type PipelineTask,
  runTaskPipeline,
} from './task-merge.js';
import { createLimiter, createLoadGate, type RunCheckResult } from './task-verify.js';

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

describe('a check is not run again on a tree it passed on', () => {
  let tmp: string;
  let repo: string;
  let wt: string;
  let settings: ProjectSettings;
  let results: CheckResults;
  let task: PipelineTask;
  /** Each run of the check: the tree of the files it found. */
  let ran: string[];
  let outcome: (cwd: string) => RunCheckResult | Promise<RunCheckResult>;
  let now: number;

  const PASS: RunCheckResult = { exitCode: 0, tail: 'all good', timedOut: false };
  const FAIL: RunCheckResult = { exitCode: 1, tail: 'FAIL a test', timedOut: false };

  const write = (dir: string, file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (dir: string, file: string, text: string): string => {
    write(dir, file, text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `edit ${file}`);
    return git(dir, 'rev-parse', 'HEAD');
  };

  beforeEach(() => {
    for (const [key, value] of Object.entries(GIT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-merge-reuse-')));
    repo = path.join(tmp, 'project');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    write(repo, '.gitignore', 'pnpm-lock.yaml\n');
    write(repo, 'a.ts', 'export const a = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const baseSha = git(repo, 'rev-parse', 'main');
    wt = path.join(tmp, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'ut/t1', wt, baseSha);
    commit(wt, 'feature.ts', 'export const feature = 1;\n');
    // Checked, then left ready (the project asks before merging): each run of the pipeline is
    // one more "is it still good?" on whatever the branch holds then.
    settings = {
      ...DEFAULT_PROJECT_SETTINGS,
      checkCommand: 'pnpm test',
      aiReview: false,
      mergePolicy: 'ask',
    };
    task = {
      id: 't1',
      name: 't1',
      repoPath: repo,
      baseBranch: 'main',
      baseSha,
      branch: 'ut/t1',
      worktreePath: wt,
    };
    results = new CheckResults({ now: () => now });
    ran = [];
    outcome = () => PASS;
    now = Date.UTC(2026, 10, 11, 3, 0);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  const options = (extra: Partial<PipelineOptions> = {}): PipelineOptions => ({
    mode: 'auto',
    settings,
    logDir: path.join(tmp, 'logs'),
    limiter: createLimiter(1),
    loadGate: createLoadGate({ loadavg: () => 1, cores: () => 8 }),
    mutex: new KeyedMutex(),
    mergeQueue: createMergeQueue(),
    checkResults: results,
    // The check "takes" five minutes of the pipeline's clock.
    now: () => now,
    runCheck: async (opts) => {
      ran.push(git(opts.cwd, 'rev-parse', 'HEAD^{tree}'));
      now += 300_000;
      return outcome(opts.cwd);
    },
    ...extra,
  });
  const pipeline = (extra: Partial<PipelineOptions> = {}): Promise<PipelineResult> =>
    runTaskPipeline(task, options(extra));
  const mergeLog = () => fs.readFileSync(path.join(tmp, 'logs', 'merge.log'), 'utf8');

  it('the same tree: one run, and the second time says it was reused', async () => {
    const first = await pipeline();
    expect(first.state).toBe('ready');
    expect(first.verify).toMatchObject({ exitCode: 0, command: 'pnpm test' });
    expect(first.verify?.reused).toBeUndefined();
    expect(first.checks).toEqual({ runs: 1, runMs: 300_000, reused: 0, savedMs: 0, loadFailed: 0 });
    const passedAt = new Date(now).toISOString();

    // Asked again later, nothing changed (the record of its first check is not even at hand).
    now += 25 * 60_000;
    const second = await pipeline();
    expect(second.state).toBe('ready');
    expect(ran).toHaveLength(1);
    expect(second.verify).toMatchObject({
      exitCode: 0,
      command: 'pnpm test',
      headSha: git(wt, 'rev-parse', 'HEAD'),
      reused: { at: passedAt, ms: 300_000, tree: ran[0] },
    });
    expect(second.verify?.tail).toMatch(
      /^check: reused, same tree as .* \(25 min ago; tree [0-9a-f]{12}, it passed in 5 min\): not run again$/
    );
    expect(second.checks).toEqual({
      runs: 0,
      runMs: 0,
      reused: 1,
      savedMs: 300_000,
      loadFailed: 0,
    });
    expect(second.timings).toContainEqual(
      expect.objectContaining({ phase: 'verify', outcome: 'reused', savedMs: 300_000 })
    );
    expect(mergeLog()).toMatch(/# check: reused, same tree as .*not run again \(pnpm test\)/);
  });

  it('another commit with the very same files (its message rewritten) is the same tree: not run again', async () => {
    const first = await pipeline();
    task.verify = first.verify;
    git(wt, 'commit', '-q', '--amend', '-m', 'the same work, said better');
    expect(git(wt, 'rev-parse', 'HEAD')).not.toBe(first.verify?.headSha);
    const second = await pipeline();
    expect(ran).toHaveLength(1);
    expect(second.verify?.reused?.tree).toBe(ran[0]);
  });

  it('a tree that differs by one byte is checked', async () => {
    await pipeline();
    commit(wt, 'feature.ts', 'export const feature = 2;\n');
    const second = await pipeline();
    expect(ran).toHaveLength(2);
    expect(ran[1]).not.toBe(ran[0]);
    expect(second.verify?.reused).toBeUndefined();
    expect(second.checks).toMatchObject({ runs: 1, reused: 0 });
    // And back to the byte it was: that tree did pass.
    commit(wt, 'feature.ts', 'export const feature = 1;\n');
    const third = await pipeline();
    expect(ran).toHaveLength(2);
    expect(third.verify?.reused?.tree).toBe(ran[0]);
  });

  it('uncommitted leftovers are part of what is checked', async () => {
    await pipeline();
    // The agent left an edit behind: the pipeline commits it, and that is another tree.
    write(wt, 'feature.ts', 'export const feature = 3;\n');
    await pipeline();
    expect(ran).toHaveLength(2);
    expect(ran[1]).not.toBe(ran[0]);
  });

  it('other lockfiles (dependencies changed under the same tree): it is checked', async () => {
    write(wt, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    await pipeline();
    await pipeline();
    expect(ran).toHaveLength(1);
    // Ignored by git: the tree is the same, the dependencies are not.
    write(wt, 'pnpm-lock.yaml', 'lockfileVersion: 9\n# left-pad 2\n');
    const third = await pipeline();
    expect(ran).toHaveLength(3 - 1);
    expect(ran[1]).toBe(ran[0]);
    expect(third.verify?.reused).toBeUndefined();
  });

  it('another command on the same tree is checked', async () => {
    await pipeline();
    settings = { ...settings, checkCommand: 'pnpm test --coverage' };
    const second = await pipeline();
    expect(ran).toHaveLength(2);
    expect(second.verify?.reused).toBeUndefined();
  });

  it('a failure is never reused: the same tree is run again, and only its pass is kept', async () => {
    outcome = () => FAIL;
    const first = await pipeline();
    expect(first.state).toBe('failed');
    expect(results.size).toBe(0);
    const second = await pipeline();
    expect(second.state).toBe('failed');
    expect(ran).toHaveLength(2);
    expect(second.verify?.reused).toBeUndefined();
    outcome = () => PASS;
    const third = await pipeline();
    expect(third.state).toBe('ready');
    expect(ran).toHaveLength(3);
    expect(third.verify?.reused).toBeUndefined();
    await pipeline();
    expect(ran).toHaveLength(3);
  });

  it('a timed out run is not a pass either', async () => {
    outcome = () => ({ exitCode: 0, tail: '', timedOut: true });
    await pipeline();
    expect(results.size).toBe(0);
    outcome = () => PASS;
    await pipeline();
    expect(ran).toHaveLength(2);
  });

  it('a failure by the load of the Mac does not count: the rerun does, and the failure is counted apart', async () => {
    let high = true;
    let calls = 0;
    outcome = () => {
      high = false;
      return calls++ === 0 ? FAIL : PASS;
    };
    const first = await pipeline({
      loadGate: createLoadGate({
        loadavg: () => (high ? 100 : 1),
        cores: () => 8,
        pollMs: 5,
      }),
    });
    expect(first.state).toBe('ready');
    expect(first.verify?.firstRunLoad).toBe(100);
    expect(first.checks).toMatchObject({ runs: 2, loadFailed: 1, reused: 0 });
    // The pass of the rerun is what is kept.
    const second = await pipeline();
    expect(ran).toHaveLength(2);
    expect(second.checks).toMatchObject({ runs: 0, reused: 1 });
  });

  it('after the base moved with changes it is checked on the new tree, the one that would enter the base', async () => {
    await pipeline();
    // Another task merged meanwhile: the base has a file this branch does not.
    commit(repo, 'other.ts', 'export const other = 1;\n');
    const second = await pipeline();
    expect(second.state).toBe('ready');
    expect(ran).toHaveLength(2);
    expect(ran[1]).not.toBe(ran[0]);
    expect(second.verify?.reused).toBeUndefined();
    // What was checked is the branch with the base merged in: both files are in that tree.
    const files = git(wt, 'ls-tree', '--name-only', ran[1]).split('\n');
    expect(files).toEqual(expect.arrayContaining(['feature.ts', 'other.ts']));
    expect(git(wt, 'rev-parse', `${second.verify?.headSha}^{tree}`)).toBe(ran[1]);

    // The base moved again, without touching any file (an empty commit): the merged result is
    // byte for byte the tree that passed, and only then is the run skipped.
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'a note');
    const third = await pipeline();
    expect(ran).toHaveLength(2);
    expect(third.verify?.reused?.tree).toBe(ran[1]);
    expect(third.verify?.headSha).not.toBe(second.verify?.headSha);
  });

  it('what merges is the tree that was checked', async () => {
    settings = { ...settings, mergePolicy: 'auto' };
    await pipeline({ mode: 'verify' });
    expect(ran).toHaveLength(1);
    // Its merge finds the pass of that very tree: the base gets exactly it, with no second run.
    const merged = await pipeline();
    expect(merged.state).toBe('merged');
    expect(ran).toHaveLength(1);
    expect(git(repo, 'rev-parse', 'main^{tree}')).toBe(ran[0]);
  });

  it('a check the user asks for by name runs, whatever was kept', async () => {
    await pipeline();
    const asked = await pipeline({ mode: 'verify' });
    expect(ran).toHaveLength(2);
    expect(asked.verify?.reused).toBeUndefined();
  });

  it('a pass on files that changed under the check is not kept', async () => {
    // The agent was still editing while its check ran.
    outcome = (cwd) => {
      if (ran.length === 1) write(cwd, 'feature.ts', 'export const feature = 7;\n');
      return PASS;
    };
    await pipeline();
    expect(results.size).toBe(0);
    expect(mergeLog()).toContain('its pass is not kept');
  });

  it('two tasks with the same tree in line for one slot: one run', async () => {
    // A second worktree at the very same commit.
    const wt2 = path.join(tmp, 'wt2');
    git(repo, 'worktree', 'add', '-q', '-b', 'ut/t2', wt2, git(wt, 'rev-parse', 'HEAD'));
    const limiter = createLimiter(1);
    let release: (() => void) | undefined;
    outcome = () =>
      new Promise<RunCheckResult>((resolve) => {
        release = () => resolve(PASS);
      });
    const one = pipeline({ limiter });
    await expect.poll(() => ran.length, { timeout: 20_000 }).toBe(1);
    const two = runTaskPipeline(
      { ...task, id: 't2', name: 't2', branch: 'ut/t2', worktreePath: wt2 },
      options({ limiter, logDir: path.join(tmp, 'logs2') })
    );
    await expect.poll(() => limiter.queued, { timeout: 20_000 }).toBe(1);
    release?.();
    const [first, second] = await Promise.all([one, two]);
    expect(first.verify?.exitCode).toBe(0);
    expect(ran).toHaveLength(1);
    expect(second.verify?.reused).toMatchObject({ tree: ran[0], taskId: 't1' });
  });

  it('without a store nothing is kept nor reused', async () => {
    await pipeline({ checkResults: null });
    await pipeline({ checkResults: null });
    expect(ran).toHaveLength(2);
  });
});
