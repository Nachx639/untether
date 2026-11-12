import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { buildInstalledApp, builtAppPath, prepareBuildWorktree } from './installed-app-build.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
const gitDep = async (cwd: string, args: string[]) => git(cwd, ...args);

describe("the app's build has a worktree of its own", () => {
  let tmp: string;
  let repo: string;
  let worktree: string;
  let first: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-app-build-')));
    repo = path.join(tmp, 'repo');
    worktree = path.join(tmp, '.untether-worktrees', 'repo', '.app-build');
    fs.mkdirSync(path.join(repo, 'mac'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.node-builds\n');
    fs.writeFileSync(path.join(repo, 'mac', 'a.swift'), '// 1\n');
    fs.writeFileSync(path.join(repo, 'web', 'package.json'), '{}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'one');
    first = git(repo, 'rev-parse', 'HEAD');
  });
  afterEach(() => fs.rmSync(tmp, RM_TEST_DIR));

  it('is made on the commit to build and leaves the checkout the server runs from alone', async () => {
    fs.writeFileSync(path.join(repo, 'mac', 'a.swift'), '// edited, not committed\n');
    await prepareBuildWorktree({ repo, worktree, commit: first, git: gitDep });
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(first);
    expect(fs.readFileSync(path.join(worktree, 'mac', 'a.swift'), 'utf8')).toBe('// 1\n');
    // The checkout: same branch, its uncommitted edit still there.
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'mac', 'a.swift'), 'utf8')).toBe(
      '// edited, not committed\n'
    );
  });

  it('is kept between builds (its node_modules) and moved to the next commit, dropping a build’s edits', async () => {
    await prepareBuildWorktree({ repo, worktree, commit: first, git: gitDep });
    fs.mkdirSync(path.join(worktree, 'web', 'node_modules'));
    fs.writeFileSync(path.join(worktree, 'web', 'node_modules', 'kept'), '');
    fs.writeFileSync(path.join(worktree, 'mac', 'a.swift'), '// what a build left\n');
    fs.writeFileSync(path.join(repo, 'mac', 'a.swift'), '// 2\n');
    git(repo, 'commit', '-q', '-am', 'two');
    const second = git(repo, 'rev-parse', 'HEAD');

    await prepareBuildWorktree({ repo, worktree, commit: second, git: gitDep });

    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(second);
    expect(fs.readFileSync(path.join(worktree, 'mac', 'a.swift'), 'utf8')).toBe('// 2\n');
    expect(fs.existsSync(path.join(worktree, 'web', 'node_modules', 'kept'))).toBe(true);
  });

  it('uses the custom Node the checkout already compiled instead of compiling one', async () => {
    fs.mkdirSync(path.join(repo, 'web', '.node-builds', 'node-v24.16.0-minimal'), {
      recursive: true,
    });
    await prepareBuildWorktree({ repo, worktree, commit: first, git: gitDep });
    expect(fs.realpathSync(path.join(worktree, 'web', '.node-builds'))).toBe(
      path.join(repo, 'web', '.node-builds')
    );
  });

  it('takes the signing settings the checkout keeps out of git, and follows their changes', async () => {
    fs.mkdirSync(path.join(repo, 'mac', 'Untether'));
    fs.writeFileSync(path.join(repo, 'mac', 'Untether', 'keep.swift'), '//\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'Local.xcconfig\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'mac folder');
    const head = git(repo, 'rev-parse', 'HEAD');
    const local = path.join('mac', 'Untether', 'Local.xcconfig');
    fs.writeFileSync(path.join(repo, local), 'DEVELOPMENT_TEAM = TEAM1\n');

    await prepareBuildWorktree({ repo, worktree, commit: head, git: gitDep });
    expect(fs.readFileSync(path.join(worktree, local), 'utf8')).toBe('DEVELOPMENT_TEAM = TEAM1\n');

    fs.writeFileSync(path.join(repo, local), 'DEVELOPMENT_TEAM = TEAM2\n');
    await prepareBuildWorktree({ repo, worktree, commit: head, git: gitDep });
    expect(fs.readFileSync(path.join(worktree, local), 'utf8')).toBe('DEVELOPMENT_TEAM = TEAM2\n');

    fs.rmSync(path.join(repo, local));
    await prepareBuildWorktree({ repo, worktree, commit: head, git: gitDep });
    expect(fs.existsSync(path.join(worktree, local))).toBe(false);
    // Never something git would carry away from the worktree.
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('refuses the checkout the server runs from as the place to build', async () => {
    await expect(
      prepareBuildWorktree({ repo, worktree: repo, commit: first, git: gitDep })
    ).rejects.toThrow('never built in the checkout the server runs from');
  });

  it('runs the build in mac/ of the worktree and returns the bundle it printed', async () => {
    const app = path.join(tmp, 'products', 'Untether.app');
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
    const run = vi.fn(async (_cwd: string, logPath: string) => {
      fs.writeFileSync(logPath, `Building Untether...\nBuild complete: ${app}\nVersion: 1 (2)\n`);
      return { exitCode: 0, tail: '' };
    });
    const logPath = path.join(tmp, 'state', 'build.log');
    expect(
      await buildInstalledApp({ repo, worktree, commit: first, run, logPath, git: gitDep })
    ).toEqual({ appPath: app });
    expect(run).toHaveBeenCalledWith(path.join(worktree, 'mac'), logPath);
  });

  it('fails with the end of the output when the build fails, or its app is not there', async () => {
    const logPath = path.join(tmp, 'state', 'build.log');
    await expect(
      buildInstalledApp({
        repo,
        worktree,
        commit: first,
        logPath,
        git: gitDep,
        run: async () => ({ exitCode: 65, tail: 'errSecInternalComponent' }),
      })
    ).rejects.toThrow(/build\.sh ended with 65\nerrSecInternalComponent/);
    await expect(
      buildInstalledApp({
        repo,
        worktree,
        commit: first,
        logPath,
        git: gitDep,
        run: async () => ({ exitCode: 0, tail: 'Build complete: /nowhere/Untether.app' }),
      })
    ).rejects.toThrow('its app was not found');
  });

  it('reads the bundle from the last "Build complete" line', () => {
    expect(builtAppPath('x\nBuild complete: /a/Untether.app\nVersion: 1\n')).toBe(
      '/a/Untether.app'
    );
    expect(builtAppPath('nothing')).toBeUndefined();
  });
});
