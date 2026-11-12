import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  baseCheckoutDirty,
  branchChanges,
  checkoutInTheWay,
  commitLeftovers,
  createTaskWorktree,
  defaultWorktreeRoot,
  dirtyFiles,
  hasUncommittedChanges,
  leftoverExcludes,
  NEVER_COMMITTED,
  refCommit,
  removeTaskWorktree,
  resolveMainRepo,
  revertRange,
  slugifyTaskName,
  TaskWorktreeError,
  unsavedChanges,
} from './task-worktree.js';

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

describe('task worktrees', () => {
  let tmp: string;
  let repo: string;
  // 2026-11-02: the one-commit repo is built once per file and copied into each test's folder
  // (3 git processes per test became 0). A fresh repo holds no absolute paths, so the copy is
  // the same state; tests that need worktrees or more commits make them on the copy.
  let template: string;

  beforeAll(() => {
    template = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-task-wt-template-')));
    git(template, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(template, 'a.txt'), 'one\n');
    fs.writeFileSync(path.join(template, '.gitignore'), 'node_modules/\n');
    git(template, 'add', '.');
    git(template, 'commit', '-q', '-m', 'init');
  });

  afterAll(() => {
    fs.rmSync(template, RM_TEST_DIR);
  });

  beforeEach(() => {
    // run() inherits process.env: commits made by the module need an identity too.
    for (const [key, value] of Object.entries(GIT_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-task-wt-')));
    repo = path.join(tmp, 'app');
    fs.cpSync(template, repo, { recursive: true });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('2026-11-04: the base checkout is in the way only when its uncommitted work is in files the task changes', async () => {
    git(repo, 'branch', 'task');
    const wt = path.join(tmp, 'task-wt');
    git(repo, 'worktree', 'add', '-q', wt, 'task');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'from the task\n');
    fs.writeFileSync(path.join(wt, 'added.txt'), 'new\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'task');
    expect(await baseCheckoutDirty(repo, 'main', 'task')).toBe(false);
    // Uncommitted work in other files, tracked or not: not in the way.
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nbuild/\n');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'x\n');
    expect(await baseCheckoutDirty(repo, 'main', 'task')).toBe(false);
    expect(await checkoutInTheWay(repo, ['main', 'task'])).toEqual({ overlap: [], local: 1 });
    // A file the task changes.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    expect(await baseCheckoutDirty(repo, 'main', 'task')).toBe(true);
    expect((await checkoutInTheWay(repo, ['main', 'task']))?.overlap).toEqual(['a.txt']);
    git(repo, 'checkout', '-q', '--', 'a.txt');
    // An untracked file, or folder, where the task adds one.
    fs.writeFileSync(path.join(repo, 'added.txt'), 'mine\n');
    expect((await checkoutInTheWay(repo, ['main', 'task']))?.overlap).toEqual(['added.txt']);
    fs.rmSync(path.join(repo, 'added.txt'));
    fs.mkdirSync(path.join(repo, 'added.txt'));
    fs.writeFileSync(path.join(repo, 'added.txt', 'inside'), 'mine\n');
    expect((await checkoutInTheWay(repo, ['main', 'task']))?.overlap).toEqual(['added.txt']);
    fs.rmSync(path.join(repo, 'added.txt'), RM_TEST_DIR);
    expect(await baseCheckoutDirty(repo, 'main', 'task')).toBe(false);
    // A branch checked out nowhere moves without touching a folder.
    git(repo, 'branch', 'other');
    expect(await baseCheckoutDirty(repo, 'other', 'task')).toBe(false);
  });

  it('2026-11-04: an added path under an untracked file, or an ignored one, is told apart', async () => {
    git(repo, 'branch', 'task');
    const wt = path.join(tmp, 'task-wt');
    git(repo, 'worktree', 'add', '-q', wt, 'task');
    fs.mkdirSync(path.join(wt, 'docs'));
    fs.writeFileSync(path.join(wt, 'docs', 'guide.md'), 'g\n');
    fs.mkdirSync(path.join(wt, 'node_modules'));
    fs.writeFileSync(path.join(wt, 'node_modules', 'pinned.js'), 'p\n');
    git(wt, 'add', 'docs');
    git(wt, 'add', '-f', 'node_modules/pinned.js');
    git(wt, 'commit', '-q', '-m', 'task');
    // A file named like the folder the task adds into: in the way.
    fs.writeFileSync(path.join(repo, 'docs'), 'a file\n');
    expect((await checkoutInTheWay(repo, ['main', 'task']))?.overlap).toEqual(['docs']);
    fs.rmSync(path.join(repo, 'docs'));
    // An ignored file git replaces anyway: not counted.
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules', 'pinned.js'), 'local\n');
    expect(await checkoutInTheWay(repo, ['main', 'task'])).toEqual({ overlap: [], local: 0 });
    expect(await checkoutInTheWay(path.join(tmp, 'nowhere'), ['main', 'task'])).toBeNull();
  });

  it('2026-11-04: a tracked folder the merge turns into a file is in the way only with untracked files in it', async () => {
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs', 'a.txt'), 'a\n');
    git(repo, 'add', 'docs');
    git(repo, 'commit', '-q', '-m', 'docs folder');
    git(repo, 'branch', 'task');
    const wt = path.join(tmp, 'task-wt');
    git(repo, 'worktree', 'add', '-q', wt, 'task');
    git(wt, 'rm', '-q', '-r', 'docs');
    fs.writeFileSync(path.join(wt, 'docs'), 'now a file\n');
    git(wt, 'add', 'docs');
    git(wt, 'commit', '-q', '-m', 'docs becomes a file');
    // Clean checkout: nothing in the way (the review's case: it waited forever).
    expect(await checkoutInTheWay(repo, ['main', 'task'])).toEqual({ overlap: [], local: 0 });
    expect(await baseCheckoutDirty(repo, 'main', 'task')).toBe(false);
    // An ignored file in it: git replaces it anyway.
    fs.mkdirSync(path.join(repo, 'docs', 'node_modules'));
    fs.writeFileSync(path.join(repo, 'docs', 'node_modules', 'x.js'), 'x\n');
    expect((await checkoutInTheWay(repo, ['main', 'task']))?.overlap).toEqual([]);
    // The user's untracked file in it: in the way.
    fs.writeFileSync(path.join(repo, 'docs', 'mine.md'), 'mine\n');
    expect((await checkoutInTheWay(repo, ['main', 'task']))?.overlap).toEqual(['docs']);
    fs.rmSync(path.join(repo, 'docs', 'mine.md'));
    // A local edit to the tracked file the merge deletes: in the way, by that file.
    fs.writeFileSync(path.join(repo, 'docs', 'a.txt'), 'edited\n');
    expect((await checkoutInTheWay(repo, ['main', 'task']))?.overlap).toEqual(['docs/a.txt']);
  });

  it('2026-10-24: lists the dirty files of a checkout with how they look, null outside git', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules', 'x.js'), 'x\n');
    const files = await dirtyFiles(path.join(repo));
    expect(files?.map((entry) => entry.file).sort()).toEqual(['a.txt', 'new.txt']);
    const before = files?.find((entry) => entry.file === 'a.txt')?.sig;
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two, then more\n');
    const after = (await dirtyFiles(repo))?.find((entry) => entry.file === 'a.txt')?.sig;
    expect(after).not.toBe(before);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-not-git-'));
    expect(await dirtyFiles(outside)).toBeNull();
    fs.rmSync(outside, RM_TEST_DIR);
  });

  it('slugs a title: no accents, dashes, at most 40 characters', () => {
    expect(slugifyTaskName('Arregla el login de Google')).toBe('arregla-el-login-de-google');
    expect(slugifyTaskName('  Añade inscripción ¡ya!  ')).toBe('anade-inscripcion-ya');
    expect(slugifyTaskName('x'.repeat(60))).toHaveLength(40);
    expect(slugifyTaskName('a '.repeat(30)).endsWith('-')).toBe(false);
    expect(slugifyTaskName('¿?')).toBe('task');
  });

  it('makes ut/<slug> from the checked-out branch next to the repo, recording the base commit', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const wt = await createTaskWorktree({ dir: repo, name: 'Arregla el login' });
    expect(wt).toMatchObject({
      repoPath: repo,
      baseBranch: 'main',
      baseSha: head,
      branch: 'ut/arregla-el-login',
      worktreePath: path.join(defaultWorktreeRoot(repo), 'arregla-el-login'),
    });
    expect(wt.worktreePath.startsWith(path.join(tmp, '.untether-worktrees', 'app'))).toBe(true);
    expect(git(wt.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ut/arregla-el-login');
    expect(await resolveMainRepo(wt.worktreePath)).toBe(repo);

    // The same title again gets a free name; a group member its suffix.
    const again = await createTaskWorktree({ dir: repo, name: 'Arregla el login' });
    expect(again.branch).toBe('ut/arregla-el-login-2');
    const member = await createTaskWorktree({ dir: repo, name: 'Arregla el login', suffix: 'a' });
    expect(member.branch).toBe('ut/arregla-el-login-a');
  });

  it('bases a task started in a linked worktree on that worktree’s branch, not the main checkout’s', async () => {
    git(repo, 'branch', 'feature');
    const linked = path.join(tmp, 'app-feature');
    git(repo, 'worktree', 'add', '-q', linked, 'feature');

    const wt = await createTaskWorktree({ dir: linked, name: 'Desde el worktree' });
    expect(wt).toMatchObject({ repoPath: repo, baseBranch: 'feature' });

    // Started from a task's own worktree: the main checkout's branch, never ut/….
    const nested = await createTaskWorktree({ dir: wt.worktreePath, name: 'Otra' });
    expect(nested.baseBranch).toBe('main');
  });

  it('refuses a folder outside git and a bad or missing base branch', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    await expect(createTaskWorktree({ dir: plain, name: 'x' })).rejects.toBeInstanceOf(
      TaskWorktreeError
    );
    await expect(
      createTaskWorktree({ dir: repo, name: 'x', baseBranch: '--force' })
    ).rejects.toThrow(/Invalid base branch/);
    await expect(createTaskWorktree({ dir: repo, name: 'x', baseBranch: 'nope' })).rejects.toThrow(
      /Base branch not found/
    );
  });

  it('clones node_modules next to a lockfile instead of installing', async () => {
    fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    git(repo, 'add', 'pnpm-lock.yaml');
    git(repo, 'commit', '-q', '-m', 'lock');
    fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'x');
    const logPath = path.join(tmp, 'logs', 'setup.log');
    const wt = await createTaskWorktree({ dir: repo, name: 'deps', logPath });
    expect(
      fs.readFileSync(path.join(wt.worktreePath, 'node_modules', 'dep', 'index.js'), 'utf8')
    ).toBe('x');
    expect(wt.clonedDirs).toEqual(['node_modules']);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('clone node_modules');
  });

  it('runs the project setup command, and a failing one removes the worktree again', async () => {
    const wt = await createTaskWorktree({
      dir: repo,
      name: 'setup',
      setupCommand: 'echo ready > setup-ran.txt',
    });
    expect(fs.existsSync(path.join(wt.worktreePath, 'setup-ran.txt'))).toBe(true);

    const error = await createTaskWorktree({
      dir: repo,
      name: 'broken',
      setupCommand: 'echo nope; exit 3',
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TaskWorktreeError);
    expect(error.detail).toContain('nope');
    expect(fs.existsSync(path.join(defaultWorktreeRoot(repo), 'broken'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'ut/broken')).toBe('');
  });

  it('puts back tracked files the setup changed or deleted (2026-10-24: bun deleted mac/bun.lock)', async () => {
    fs.mkdirSync(path.join(repo, 'mac'));
    fs.writeFileSync(path.join(repo, 'mac', 'bun.lock'), '{ "lockfileVersion": 1 }\n');
    git(repo, 'add', 'mac/bun.lock');
    git(repo, 'commit', '-q', '-m', 'lock');
    const logPath = path.join(tmp, 'logs', 'setup-undo.log');
    const wt = await createTaskWorktree({
      dir: repo,
      name: 'setup-undo',
      logPath,
      setupCommand: 'rm mac/bun.lock && echo changed >> a.txt && echo new > made.txt',
    });
    expect(fs.readFileSync(path.join(wt.worktreePath, 'mac', 'bun.lock'), 'utf8')).toBe(
      '{ "lockfileVersion": 1 }\n'
    );
    expect(git(wt.worktreePath, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // What it made that is not tracked stays (generated files, caches).
    expect(fs.existsSync(path.join(wt.worktreePath, 'made.txt'))).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain(
      'setup changed tracked files, put back: a.txt, mac/bun.lock'
    );
  });

  it('commits leftovers (never node_modules) and counts the branch changes', async () => {
    const wt = await createTaskWorktree({ dir: repo, name: 'work' });
    fs.writeFileSync(path.join(wt.worktreePath, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(wt.worktreePath, 'b.txt'), 'new\n');
    fs.rmSync(path.join(wt.worktreePath, '.gitignore'));
    fs.mkdirSync(path.join(wt.worktreePath, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, 'node_modules', 'x', 'i.js'), 'x');
    expect(await hasUncommittedChanges(wt.worktreePath)).toBe(true);
    expect(await commitLeftovers(wt.worktreePath, 'leftovers', NEVER_COMMITTED)).toBe(true);
    expect(git(wt.worktreePath, 'ls-files')).not.toContain('node_modules');
    expect(await commitLeftovers(wt.worktreePath, 'again', NEVER_COMMITTED)).toBe(false);

    const changes = await branchChanges(wt.worktreePath, wt.baseSha);
    expect(changes.files.sort()).toEqual(['.gitignore', 'a.txt', 'b.txt']);
    expect(changes.stats).toEqual({ commits: 1, files: 3, insertions: 2, deletions: 1 });
  });

  it('gives renamed files with the path they had', async () => {
    const wt = await createTaskWorktree({ dir: repo, name: 'move' });
    git(wt.worktreePath, 'mv', 'a.txt', 'moved.txt');
    git(wt.worktreePath, 'commit', '-q', '-m', 'move');
    const changes = await branchChanges(wt.worktreePath, wt.baseSha);
    expect(changes.files).toEqual(['moved.txt']);
    expect(changes.renamed).toEqual([{ from: 'a.txt', to: 'moved.txt' }]);
  });

  it('counts only the branch own changes against the base tip after the base was merged in (2026-11-02)', async () => {
    const wt = await createTaskWorktree({ dir: repo, name: 'mine' });
    fs.writeFileSync(path.join(wt.worktreePath, 'mine.txt'), 'mine\n');
    git(wt.worktreePath, 'add', 'mine.txt');
    git(wt.worktreePath, 'commit', '-q', '-m', 'mine');
    // Another task lands on main; the branch merges main in.
    fs.writeFileSync(path.join(repo, 'theirs.txt'), 'theirs\n');
    git(repo, 'add', 'theirs.txt');
    git(repo, 'commit', '-q', '-m', 'theirs');
    git(wt.worktreePath, 'merge', '-q', '--no-edit', 'main');
    // From the start commit, main's file shows up as the branch's (the bug).
    expect((await branchChanges(wt.worktreePath, wt.baseSha)).files.sort()).toEqual([
      'mine.txt',
      'theirs.txt',
    ]);
    const tip = await refCommit(wt.worktreePath, 'refs/heads/main');
    expect(tip).toBe(git(repo, 'rev-parse', 'main'));
    expect((await branchChanges(wt.worktreePath, tip as string)).files).toEqual(['mine.txt']);
    expect(await refCommit(wt.worktreePath, 'refs/heads/nope')).toBeNull();
  });

  it('never commits a worktree that lost half its tracked files (2026-10-18)', async () => {
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'many');
    const wt = await createTaskWorktree({ dir: repo, name: 'half' });
    for (let i = 0; i < 25; i++) fs.rmSync(path.join(wt.worktreePath, `f${i}.txt`));
    const error = await commitLeftovers(wt.worktreePath, 'm').catch((e) => e);
    expect(error).toBeInstanceOf(TaskWorktreeError);
    expect(error.message).toContain('half deleted');
    // A few deletions are an agent's work as usual.
    fs.writeFileSync(path.join(wt.worktreePath, 'f0.txt'), '0\n');
    for (let i = 1; i < 25; i++)
      fs.writeFileSync(path.join(wt.worktreePath, `f${i}.txt`), `${i}\n`);
    fs.rmSync(path.join(wt.worktreePath, 'f29.txt'));
    expect(await commitLeftovers(wt.worktreePath, 'm')).toBe(true);
  });

  it('a failing commit hook surfaces its output', async () => {
    const wt = await createTaskWorktree({ dir: repo, name: 'hook' });
    const hooks = path.join(repo, '.git', 'hooks');
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed"\nexit 1\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(wt.worktreePath, 'c.txt'), 'x\n');
    const error = await commitLeftovers(wt.worktreePath, 'm').catch((e) => e);
    expect(error).toBeInstanceOf(TaskWorktreeError);
    expect(error.detail.join('\n')).toContain('lint failed');
  });

  it('removes the worktree and a merged branch; an unmerged one only when confirmed', async () => {
    const merged = await createTaskWorktree({ dir: repo, name: 'merged' });
    const result = await removeTaskWorktree({ repoPath: repo, ...merged });
    expect(result).toEqual({ worktreeRemoved: true, branchDeleted: true });
    expect(fs.existsSync(merged.worktreePath)).toBe(false);

    const work = await createTaskWorktree({ dir: repo, name: 'unmerged' });
    fs.writeFileSync(path.join(work.worktreePath, 'n.txt'), 'x\n');
    await commitLeftovers(work.worktreePath, 'work');
    const kept = await removeTaskWorktree({ repoPath: repo, ...work });
    expect(kept.worktreeRemoved).toBe(true);
    expect(kept.branchDeleted).toBe(false);
    expect(git(repo, 'branch', '--list', 'ut/unmerged')).toContain('ut/unmerged');
    const gone = await removeTaskWorktree({
      repoPath: repo,
      branch: work.branch,
      deleteUnmerged: true,
    });
    expect(gone.branchDeleted).toBe(true);
    expect(git(repo, 'branch', '--list', 'ut/unmerged')).toBe('');
    // Its last worktree gone, the empty .untether-worktrees folders go too.
    expect(fs.existsSync(path.join(tmp, '.untether-worktrees'))).toBe(false);
  });

  it('2026-10-20: names the folder and branch before making them; cloneDirs never auto-committed', async () => {
    const plans: unknown[] = [];
    const made = await createTaskWorktree({
      dir: repo,
      name: 'Plan it',
      cloneDirs: [],
      onPlanned: (plan) => plans.push(plan),
    });
    expect(plans).toEqual([
      { repoPath: repo, branch: made.branch, worktreePath: made.worktreePath },
    ]);
    expect(leftoverExcludes(['vendor/', '../out', '.venv'])).toEqual([
      ...NEVER_COMMITTED,
      'vendor/**',
      '.venv/**',
    ]);
    const wt = made.worktreePath;
    fs.mkdirSync(path.join(wt, 'vendor'));
    fs.writeFileSync(path.join(wt, 'vendor', 'x.js'), 'x\n');
    fs.writeFileSync(path.join(wt, 'mine.txt'), 'mine\n');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
    expect(await unsavedChanges(wt, leftoverExcludes(['vendor']))).toEqual({
      tracked: ['a.txt'],
      untracked: ['mine.txt'],
    });
    expect(await commitLeftovers(wt, 'left', leftoverExcludes(['vendor']))).toBe(true);
    expect(git(wt, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'a.txt',
      'mine.txt',
    ]);
    // Deleted tracked files are not unsaved work (their content is in the branch).
    fs.rmSync(path.join(wt, 'a.txt'));
    expect(await unsavedChanges(wt, leftoverExcludes(['vendor']))).toEqual({
      tracked: [],
      untracked: [],
    });
  });

  it('2026-10-20: never commits leftovers while a merge is under way', async () => {
    const made = await createTaskWorktree({ dir: repo, name: 'Merge me', cloneDirs: [] });
    const wt = made.worktreePath;
    fs.writeFileSync(path.join(wt, 'a.txt'), 'task\n');
    git(wt, 'commit', '-qam', 'task side');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'main\n');
    git(repo, 'commit', '-qam', 'main side');
    expect(() => git(wt, 'merge', 'main')).toThrow();
    await expect(commitLeftovers(wt, 'left')).rejects.toThrow(/merge is under way/);
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('never deletes a branch outside ut/', async () => {
    git(repo, 'branch', 'feature');
    const result = await removeTaskWorktree({
      repoPath: repo,
      branch: 'feature',
      deleteUnmerged: true,
    });
    expect(result.branchDeleted).toBe(false);
    expect(git(repo, 'branch', '--list', 'feature')).toContain('feature');
  });

  it("undoes a merged task's change into one commit; a conflict is reset and named (2026-10-20)", async () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'x.txt'), 'one\n');
    git(repo, 'add', 'x.txt');
    git(repo, 'commit', '-q', '-m', 'task: a');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '-q', '-m', 'task: b');
    const after = git(repo, 'rev-parse', 'HEAD');
    const result = await revertRange(repo, { from: before, to: after }, 'Undo the task');
    expect(result).toEqual({ ok: true, commits: 2 });
    expect(fs.existsSync(path.join(repo, 'x.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Undo the task');

    // A later change on the same lines: the revert conflicts and is aborted.
    fs.writeFileSync(path.join(repo, 'c.txt'), 'first\n');
    git(repo, 'add', 'c.txt');
    git(repo, 'commit', '-q', '-m', 'task: c');
    const c = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'later\n');
    git(repo, 'commit', '-q', '-am', 'someone else');
    const head = git(repo, 'rev-parse', 'HEAD');
    const conflict = await revertRange(repo, { from: `${c}~1`, to: c }, 'Undo c');
    expect(conflict).toMatchObject({ ok: false, conflict: true, files: ['c.txt'] });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(await revertRange(repo, { from: head, to: head }, 'x')).toMatchObject({
      ok: false,
      conflict: false,
    });
  });

  it('undoes what a "merge base into branch" commit changed too (2026-10-20, conflict resolutions)', async () => {
    fs.writeFileSync(path.join(repo, 'r.txt'), 'line1\nline2\n');
    git(repo, 'add', 'r.txt');
    git(repo, 'commit', '-q', '-m', 'base: r');
    const start = git(repo, 'rev-parse', 'HEAD');
    // The task's branch edits r.txt; the base edits the same line meanwhile.
    git(repo, 'checkout', '-q', '-b', 'task');
    fs.writeFileSync(path.join(repo, 'r.txt'), 'TASK\nline2\n');
    git(repo, 'commit', '-q', '-am', 'task edit');
    git(repo, 'checkout', '-q', '-');
    fs.writeFileSync(path.join(repo, 'r.txt'), 'BASE\nline2\n');
    git(repo, 'commit', '-q', '-am', 'base edit');
    const mergedOnto = git(repo, 'rev-parse', 'HEAD');
    // The agent merges the base in, resolves, and adds a file in the merge commit itself.
    git(repo, 'checkout', '-q', 'task');
    try {
      git(repo, 'merge', '-q', mergedOnto);
    } catch {
      // the conflict it resolves next
    }
    fs.writeFileSync(path.join(repo, 'r.txt'), 'RESOLVED\nline2\n');
    fs.writeFileSync(path.join(repo, 'only-in-merge.txt'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'merge base, resolved');
    const mergedSha = git(repo, 'rev-parse', 'HEAD');
    // Merged (fast-forward) into the base, then undone there.
    git(repo, 'checkout', '-q', '-');
    git(repo, 'merge', '-q', '--ff-only', mergedSha);
    const result = await revertRange(repo, { from: mergedOnto, to: mergedSha }, 'Undo: task');
    expect(result).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(repo, 'r.txt'), 'utf8')).toBe('BASE\nline2\n');
    expect(fs.existsSync(path.join(repo, 'only-in-merge.txt'))).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Undo: task');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(start).not.toBe(mergedOnto);
  });
});
