import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';

const gitCalls: Array<{ args: string[]; cwd: string }> = [];
/** What the faked `git status` prints. */
let statusOutput = '';
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      args: string[],
      options: { cwd: string },
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      gitCalls.push({ args, cwd: options.cwd });
      // Answered a little later, like a real git.
      setTimeout(() => callback(null, { stdout: statusOutput, stderr: '' }), 10);
    },
  };
});

const { clearGitInfoCache, detectGitInfo, parseGitStatus } = await import('./git-info.js');

let root: string;
let repo: string;
let worktree: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-info-')));
  repo = path.join(root, 'repo');
  worktree = path.join(root, 'wt');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'sub', 'deeper'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/wt\n`);
  fs.mkdirSync(path.join(root, 'plain'));
});
afterAll(() => {
  if (root) fs.rmSync(root, RM_TEST_DIR);
});

const STATUS = [
  '# branch.oid 0123456789abcdef0123456789abcdef01234567',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -3',
  '1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts',
  '',
].join('\n');

describe('detectGitInfo', () => {
  beforeEach(() => {
    gitCalls.length = 0;
    statusOutput = STATUS;
    clearGitInfoCache();
  });

  it('answers a folder outside any repository without running git', async () => {
    // 2026-11-02: 4 git processes per folder per 5 s, repository or not.
    expect(await detectGitInfo(path.join(root, 'plain'))).toEqual({});
    expect(await detectGitInfo(path.join(root, 'missing'))).toEqual({});
    expect(gitCalls).toHaveLength(0);
  });

  it('reads branch, ahead/behind and changes from one git status', async () => {
    const info = await detectGitInfo(path.join(repo, 'sub', 'deeper'));
    expect(info).toEqual({
      gitRepoPath: repo,
      gitBranch: 'main',
      gitAheadCount: 2,
      gitBehindCount: 3,
      gitHasChanges: true,
      gitIsWorktree: false,
      gitMainRepoPath: repo,
    });
    expect(gitCalls).toEqual([
      {
        args: ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
        cwd: path.join(repo, 'sub', 'deeper'),
      },
    ]);
  });

  it('tells a worktree and its main repository, from any folder inside it', async () => {
    const info = await detectGitInfo(path.join(worktree, 'src'));
    expect(info.gitRepoPath).toBe(worktree);
    expect(info.gitIsWorktree).toBe(true);
    expect(info.gitMainRepoPath).toBe(repo);
  });

  it('runs git once for concurrent lookups of the same directory', async () => {
    await Promise.all(Array.from({ length: 30 }, () => detectGitInfo(repo)));
    expect(gitCalls).toHaveLength(1);
    await detectGitInfo(repo);
    expect(gitCalls).toHaveLength(1); // cached
    await detectGitInfo(path.join(repo, 'sub'));
    expect(gitCalls).toHaveLength(2);
  });
});

describe('parseGitStatus', () => {
  it('reads a clean branch without upstream and a detached HEAD', () => {
    expect(parseGitStatus('# branch.oid abc\n# branch.head feature\n')).toEqual({
      gitBranch: 'feature',
      gitAheadCount: undefined,
      gitBehindCount: undefined,
      gitHasChanges: false,
    });
    expect(
      parseGitStatus('# branch.oid abc\n# branch.head (detached)\n2 R. N... 1 1 1 a b R100 n\to\n')
    ).toMatchObject({ gitBranch: '', gitHasChanges: true });
    expect(parseGitStatus('# branch.head main\nu UU N... 1 1 1 1 a b c f\n').gitHasChanges).toBe(
      true
    );
  });
});
