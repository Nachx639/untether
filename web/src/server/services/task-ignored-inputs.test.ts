/**
 * 2026-11-11: a task's check read a fixture that git ignored (`*.cast`); it passed in the
 * worktree, the merge left the file behind and the base went red (ENOENT). A check refuses to
 * run while ignored files that are not known artifacts exist in the worktree. Real toy
 * repositories; the check's command is a stand-in that reads the fixture from disk.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import type { TaskVerify } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { ignoredInputs, isKnownArtifact } from './task-ignored-inputs.js';
import { startCheck } from './task-merge-check.js';
import { MergeLog } from './task-merge-log.js';
import type { PipelineContext, PipelineOptions, PipelineTask } from './task-merge-types.js';
import { createLimiter, createLoadGate, type RunCheckResult } from './task-verify.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

describe('a check does not pass on files that do not travel with the merge', () => {
  let tmp: string;
  let wt: string;
  let ran: number;
  const FIXTURE = 'src/test/fixtures/session.cast';

  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
    fs.writeFileSync(path.join(wt, file), text);
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-ignored-inputs-')));
    wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    git(wt, 'init', '-q', '-b', 'main');
    // The incident's shape: a recordings rule that swallows the fixtures.
    write('.gitignore', 'node_modules/\n*.cast\n');
    write('a.ts', 'export const a = 1;\n');
    write('src/test/fixtures/other.json', '{}\n');
    write('src/vendor/lib.ts', 'export {};\n');
    git(wt, 'add', '-A');
    git(wt, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    ran = 0;
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  /** Runs the task's check; the stand-in reads the fixture like stream-pruning.test.ts did. */
  const check = async (
    settingsExtra: Partial<ProjectSettings> = {}
  ): Promise<RunCheckResult & { logged: string; verify: TaskVerify }> => {
    const head = git(wt, 'rev-parse', 'HEAD');
    const options: PipelineOptions = {
      mode: 'auto',
      settings: { ...DEFAULT_PROJECT_SETTINGS, ...settingsExtra },
      logDir: path.join(tmp, 'logs'),
      limiter: createLimiter(1),
      loadGate: createLoadGate({ loadavg: () => 1, cores: () => 8 }),
      checkResults: null,
      runCheck: async () => {
        ran += 1;
        const present = fs.existsSync(path.join(wt, FIXTURE));
        return { exitCode: present ? 0 : 1, tail: present ? 'ok' : 'ENOENT', timedOut: false };
      },
    } as PipelineOptions;
    const ctx: PipelineContext = {
      timings: [],
      checks: { runs: 0, runMs: 0, reused: 0, savedMs: 0, loadFailed: 0 },
      stamp: (phase, start) => ({ phase, start }) as never,
    };
    const task = { id: 't1', worktreePath: wt, repoPath: wt } as PipelineTask;
    const log = new MergeLog(path.join(tmp, 'logs', 'merge.log'));
    const verify = await startCheck(task, options, log, ctx, 'pnpm test', head).done;
    return {
      exitCode: verify.exitCode ?? null,
      tail: verify.tail ?? '',
      timedOut: false,
      verify,
      logged: fs.readFileSync(path.join(tmp, 'logs', 'merge.log'), 'utf8'),
    };
  };

  it('an ignored fixture created during the task, among versioned files: the check is refused', async () => {
    write(FIXTURE, '{"version":2}\n');
    const result = await check();
    expect(ran).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.tail).toContain(FIXTURE);
    expect(result.tail).toContain('do not travel with the merge');
    expect(result.tail).toContain('artifactPaths');
    expect(result.logged).toContain('not run, ignored files');
  });

  it('the same fixture versioned (an exception in .gitignore): the check runs and passes', async () => {
    write(FIXTURE, '{"version":2}\n');
    write('.gitignore', 'node_modules/\n*.cast\n!src/test/fixtures/**/*.cast\n');
    git(wt, 'add', '-A');
    git(wt, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'track the fixture');
    const result = await check();
    expect(ran).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('declared as an artifact in the project settings: the check runs', async () => {
    write(FIXTURE, '{}\n');
    const result = await check({ artifactPaths: ['src/test/fixtures/*.cast'] });
    expect(ran).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('a pre-existing ignored file (older than the worktree) never blocks: it is a note', async () => {
    write(FIXTURE, '{}\n');
    const long = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(wt, FIXTURE), long, long);
    const found = await ignoredInputs(wt, { since: Date.now() - 1000 });
    expect(found).toEqual({ blocking: [], note: [FIXTURE] });
    const result = await check();
    expect(ran).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.logged).toContain('not blocking');
    expect(result.verify.ignoredNote).toEqual([FIXTURE]);
  });

  it('an ignored file in a folder with no versioned files, or a whole ignored root: a note', async () => {
    write('data/dev.cast', '1');
    write('docker-volume/x.cast', '1');
    const found = await ignoredInputs(wt, { since: 0 });
    expect(found?.blocking).toEqual([]);
    expect(found?.note.sort()).toEqual(['data/dev.cast', 'docker-volume/x.cast']);
  });

  it('dependencies, build output, logs and env files are artifacts: they do not stop a check', async () => {
    write(FIXTURE, '{}\n');
    git(wt, 'add', '-f', FIXTURE);
    git(wt, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
    write('node_modules/x/index.js', '1');
    write('output/shot.cast', '1');
    write('debug.log', '1');
    write('src/.env.local', '1');
    write('web/public/bundle/app.js', '1');
    expect(await ignoredInputs(wt, { since: 0 })).toEqual({ blocking: [], note: [] });
    expect((await check()).exitCode).toBe(0);
    expect(ran).toBe(1);
  });

  it('the project cloneDirs are artifacts too', async () => {
    write('src/vendor/data.cast', '1');
    expect((await ignoredInputs(wt, { since: 0 }))?.blocking).toEqual(['src/vendor/data.cast']);
    expect(await ignoredInputs(wt, { since: 0, cloneDirs: ['src/vendor'] })).toEqual({
      blocking: [],
      note: [],
    });
  });

  it('an executable created during the task is build output: a note, never a block', async () => {
    write('src/vendor/tool.cast', '#!/bin/sh\n');
    fs.chmodSync(path.join(wt, 'src/vendor/tool.cast'), 0o755);
    expect(await ignoredInputs(wt, { since: 0 })).toEqual({
      blocking: [],
      note: ['src/vendor/tool.cast'],
    });
  });

  it('what is a known artifact', () => {
    expect(isKnownArtifact('web/node_modules/')).toBe(true);
    expect(isKnownArtifact('mac/build/x.o')).toBe(true);
    expect(isKnownArtifact('web/.env.local')).toBe(true);
    expect(isKnownArtifact('web/src/test/fixtures/a.cast')).toBe(false);
  });
});
