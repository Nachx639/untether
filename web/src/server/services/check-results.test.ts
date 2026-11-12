/**
 * A check's passed result is kept by what it checked (2026-11-11): the git tree of the files
 * (uncommitted and new ones included), the command, the folder, the lockfiles and who ran it.
 * Real git repositories: the tree is git's own.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  CheckResults,
  checkIdentity,
  commitTree,
  lockHash,
  RESULT_MAX_AGE_MS,
  RESULTS_MAX,
  reusedLine,
  worktreeTree,
} from './check-results.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

describe('what a check ran on', () => {
  let tmp: string;
  let repo: string;
  const savedEnv: Record<string, string | undefined> = {};

  const git = (...args: string[]): string =>
    childProcess
      .execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
      .toString()
      .trim();
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  };

  beforeEach(() => {
    for (const [key, value] of Object.entries(GIT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-check-results-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('.gitignore', 'node_modules/\nignored.log\npnpm-lock.yaml\n');
    write('src/a.ts', 'export const a = 1;\n');
    write('web/package.json', '{}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('a clean folder is its commit; an edit, a new file or a deletion is another tree', async () => {
    const clean = await worktreeTree(repo);
    expect(clean).toBe(git('rev-parse', 'HEAD^{tree}'));

    // One byte.
    write('src/a.ts', 'export const a = 2;\n');
    const edited = await worktreeTree(repo);
    expect(edited).toMatch(/^[0-9a-f]{40}$/);
    expect(edited).not.toBe(clean);
    // Back to the byte it was: the same tree again (it is content, not time).
    write('src/a.ts', 'export const a = 1;\n');
    expect(await worktreeTree(repo)).toBe(clean);

    // A file git does not know yet counts.
    write('src/new.ts', 'export {};\n');
    const withNew = await worktreeTree(repo);
    expect(withNew).not.toBe(clean);
    fs.rmSync(path.join(repo, 'src/new.ts'));

    // A deleted one too.
    fs.rmSync(path.join(repo, 'web/package.json'));
    expect(await worktreeTree(repo)).not.toBe(clean);
  });

  it('an edit of the same size, made right after git looked, is another tree', async () => {
    // 2026-11-11: a pass was kept although the files changed under the check; the edit had the
    // size of what it replaced and came within the second of git's last look. Not left to the
    // clock (that needed the edit and git's look to fall in one second, so it looped dozens of
    // git runs and timed out under load): the times are set. The file keeps the time git recorded
    // for it and git's index carries that same time (so git compares the content); the copy of
    // the index must keep it too: one "written now" is later than the edit and git would trust
    // the recorded size and time.
    const file = path.join(repo, 'src/a.ts');
    const past = Math.floor(Date.now() / 1000) - 60;
    git('config', 'core.trustctime', 'false');
    fs.utimesSync(file, past, past);
    git('update-index', '--refresh');
    fs.utimesSync(path.join(repo, '.git/index'), past, past);
    const clean = await worktreeTree(repo);
    expect(clean).toBe(git('rev-parse', 'HEAD^{tree}'));

    // Same size and same time as git recorded: only the content says it changed.
    write('src/a.ts', 'export const a = 2;\n');
    fs.utimesSync(file, past, past);
    expect(await worktreeTree(repo)).not.toBe(clean);
    write('src/a.ts', 'export const a = 1;\n');
    fs.utimesSync(file, past, past);
    expect(await worktreeTree(repo)).toBe(clean);
  });

  it('uncommitted work and the same work committed are one tree', async () => {
    write('src/a.ts', 'export const a = 3;\n');
    write('src/b.ts', 'export const b = 1;\n');
    const before = await worktreeTree(repo);
    git('add', '-A');
    git('commit', '-q', '-m', 'work');
    expect(git('rev-parse', 'HEAD^{tree}')).toBe(before);
    expect(await worktreeTree(repo)).toBe(before);
    expect(await commitTree(repo, 'HEAD')).toBe(before);
    expect(await commitTree(repo, 'no-such-commit')).toBeNull();
  });

  it('ignored files and excluded folders are in no tree', async () => {
    const clean = await worktreeTree(repo);
    write('ignored.log', 'noise\n');
    write('node_modules/x/index.js', 'x\n');
    expect(await worktreeTree(repo)).toBe(clean);
    write('vendor/lib.js', 'x\n');
    expect(await worktreeTree(repo)).not.toBe(clean);
    expect(await worktreeTree(repo, ['vendor/**'])).toBe(clean);
  });

  it('reads without touching the folder: its index, its staged files and its git folder stay as they were', async () => {
    write('src/staged.ts', 'export {};\n');
    git('add', 'src/staged.ts');
    write('src/a.ts', 'export const a = 9;\n');
    write('src/untracked.ts', 'export {};\n');
    const status = git('status', '--porcelain');
    const index = fs.readFileSync(path.join(repo, '.git/index'));
    const tree = await worktreeTree(repo);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(git('status', '--porcelain')).toBe(status);
    expect(fs.readFileSync(path.join(repo, '.git/index')).equals(index)).toBe(true);
    expect(fs.readdirSync(path.join(repo, '.git')).filter((f) => /untether-check/.test(f))).toEqual(
      []
    );
    // In a linked worktree as well (its git folder is elsewhere).
    const wt = path.join(tmp, 'wt');
    git('worktree', 'add', '-q', '-b', 'ut/x', wt, 'HEAD');
    fs.writeFileSync(path.join(wt, 'src/a.ts'), 'export const a = 9;\n');
    expect(await worktreeTree(wt)).toMatch(/^[0-9a-f]{40}$/);
    expect(await worktreeTree(wt)).not.toBe(git('rev-parse', 'HEAD^{tree}'));
  });

  it('outside a repository there is nothing to stand on', async () => {
    expect(await worktreeTree(tmp)).toBeNull();
    expect(await checkIdentity(tmp)).toBeNull();
  });

  it('the lockfiles on disk: an ignored one changes no tree, and still counts', async () => {
    expect(await lockHash(repo)).toBe('');
    write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const first = await lockHash(repo);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    const tree = await worktreeTree(repo);
    expect(tree).toBe(git('rev-parse', 'HEAD^{tree}'));
    write('pnpm-lock.yaml', 'lockfileVersion: 9\n# another dependency\n');
    expect(await lockHash(repo)).not.toBe(first);
    expect(await worktreeTree(repo)).toBe(tree);
    // A tracked one in a package's folder counts wherever the check runs.
    write('web/yarn.lock', 'a@1\n');
    git('add', 'web/yarn.lock');
    const tracked = await lockHash(repo);
    expect(tracked).not.toBe(await lockHash(tmp));
    write('web/yarn.lock', 'a@2\n');
    expect(await lockHash(repo)).not.toBe(tracked);
  });

  it('the identity of a run: tree, lockfiles and the folder it runs in', async () => {
    const root = await checkIdentity(repo);
    expect(root).toEqual({ tree: git('rev-parse', 'HEAD^{tree}'), lock: '', dir: '' });
    expect((await checkIdentity(path.join(repo, 'web')))?.dir).toBe('web');
    write('src/a.ts', 'export const a = 5;\n');
    // Of the files as they are, or of a commit (what a merge takes).
    expect((await checkIdentity(repo))?.tree).not.toBe(root?.tree);
    expect((await checkIdentity(repo, { commit: 'HEAD' }))?.tree).toBe(root?.tree);
  });
});

describe('the kept passes', () => {
  const identity = { tree: 'a'.repeat(40), lock: 'l1', dir: '' };
  let now: number;
  let results: CheckResults;

  beforeEach(() => {
    now = Date.UTC(2026, 10, 11, 3, 0);
    results = new CheckResults({ now: () => now });
  });

  it('a pass is found again for the same tree, command, folder, lockfiles and runner; anything else is not', () => {
    expect(results.find(identity, 'pnpm test', 'untether')).toBeUndefined();
    results.record({ ...identity, command: 'pnpm test', runner: 'untether', ms: 278_000 });
    expect(results.find(identity, 'pnpm test', 'untether')).toMatchObject({ ms: 278_000, at: now });
    // The command as written (the space around it aside).
    expect(results.find(identity, '  pnpm test\n', 'untether')).toBeDefined();
    expect(results.find(identity, 'pnpm  test', 'untether')).toBeUndefined();
    expect(results.find(identity, 'pnpm test --run', 'untether')).toBeUndefined();
    expect(
      results.find({ ...identity, tree: 'b'.repeat(40) }, 'pnpm test', 'untether')
    ).toBeUndefined();
    expect(results.find({ ...identity, lock: 'l2' }, 'pnpm test', 'untether')).toBeUndefined();
    expect(results.find({ ...identity, dir: 'web' }, 'pnpm test', 'untether')).toBeUndefined();
  });

  it("a verification never stands on a shell's pass; a shell run stands on either", () => {
    results.record({ ...identity, command: 'pnpm test', runner: 'shell', ms: 1000 });
    expect(results.find(identity, 'pnpm test', 'untether')).toBeUndefined();
    expect(results.find(identity, 'pnpm test', 'shell')).toMatchObject({ runner: 'shell' });
    results.record({ ...identity, command: 'scripts/check.sh', runner: 'untether', ms: 1000 });
    expect(results.find(identity, 'scripts/check.sh', 'shell')).toMatchObject({
      runner: 'untether',
    });
  });

  it('a pass gets old, and only so many are kept', () => {
    results.record({ ...identity, command: 'pnpm test', runner: 'untether', ms: 1 });
    now += RESULT_MAX_AGE_MS - 1;
    expect(results.find(identity, 'pnpm test', 'untether')).toBeDefined();
    now += 2;
    expect(results.find(identity, 'pnpm test', 'untether')).toBeUndefined();
    for (let i = 0; i < RESULTS_MAX + 20; i++) {
      results.record({ ...identity, command: `check ${i}`, runner: 'untether', ms: 1 });
    }
    expect(results.size).toBe(RESULTS_MAX);
    expect(results.find(identity, 'check 0', 'untether')).toBeUndefined();
    expect(results.find(identity, `check ${RESULTS_MAX + 19}`, 'untether')).toBeDefined();
  });

  it('survives a restart in its file, readable by its owner only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-check-results-file-'));
    try {
      const file = path.join(dir, 'check-results.json');
      const first = new CheckResults({ file, now: () => now });
      first.record({ ...identity, command: 'pnpm test', runner: 'untether', ms: 5, taskId: 't1' });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const second = new CheckResults({ file, now: () => now });
      expect(second.find(identity, 'pnpm test', 'untether')).toMatchObject({ taskId: 't1' });
      // A broken file is no passes, not an error.
      fs.writeFileSync(file, '{ not json');
      expect(new CheckResults({ file }).size).toBe(0);
      fs.writeFileSync(file, JSON.stringify({ passes: [{ tree: 1 }, null, 'x'] }));
      expect(new CheckResults({ file }).size).toBe(0);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('says it as the user reads it', () => {
    const line = reusedLine({ at: now - 25 * 60_000, ms: 278_000, tree: 'abcdef0123456789' }, now);
    expect(line).toBe(
      'check: reused, same tree as 2026-11-11T02:35:00.000Z (25 min ago; tree abcdef012345, it passed in 5 min): not run again'
    );
  });
});
