import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { branchWorktreePath, sessionDirForBranch } from './session-branch-dir.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('sessionDirForBranch (2026-10-20: POST /sessions ignored gitBranch)', () => {
  let root: string;
  let repo: string;
  // 2026-11-02: the repo (main + feature/x, identity in its own config) is built once per file
  // and copied into each test's folder: 6 git processes per test became 0. A repo without
  // worktrees or remotes holds no absolute paths, so the copy is the same state.
  let template: string;

  beforeAll(() => {
    template = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-branch-dir-template-')));
    fs.mkdirSync(path.join(template, 'src'));
    git(template, 'init', '-q', '-b', 'main');
    git(template, 'config', 'user.email', 't@example.com');
    git(template, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(template, 'src', 'a.txt'), 'a');
    git(template, 'add', '.');
    git(template, 'commit', '-q', '-m', 'init');
    git(template, 'branch', 'feature/x');
  });

  afterAll(() => {
    fs.rmSync(template, RM_TEST_DIR);
  });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-branch-dir-')));
    repo = path.join(root, 'app');
    fs.cpSync(template, repo, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, RM_TEST_DIR);
  });

  it('the branch the folder has out: the folder itself', async () => {
    expect(await sessionDirForBranch(repo, 'main')).toEqual({
      ok: true,
      workingDir: repo,
      how: 'current',
    });
  });

  it("another branch: a worktree for it, the user's checkout untouched", async () => {
    const result = await sessionDirForBranch(repo, 'feature/x');
    const expected = branchWorktreePath(repo, 'feature/x');
    expect(expected).toBe(`${repo}-feature-x`);
    expect(result).toEqual({ ok: true, workingDir: expected, how: 'created' });
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(expected, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/x');
    // Asked again (from the main checkout's subfolder): the same worktree, same subfolder.
    expect(await sessionDirForBranch(path.join(repo, 'src'), 'feature/x')).toEqual({
      ok: true,
      workingDir: path.join(expected, 'src'),
      how: 'worktree',
    });
  });

  it('a branch checked out in a worktree elsewhere: that worktree', async () => {
    const elsewhere = path.join(root, 'mine');
    git(repo, 'worktree', 'add', '-q', elsewhere, 'feature/x');
    expect(await sessionDirForBranch(repo, 'feature/x')).toEqual({
      ok: true,
      workingDir: elsewhere,
      how: 'worktree',
    });
  });

  it('a taken folder name gets a suffix', async () => {
    fs.mkdirSync(`${repo}-feature-x`);
    const result = await sessionDirForBranch(repo, 'feature/x');
    expect(result).toEqual({ ok: true, workingDir: `${repo}-feature-x-2`, how: 'created' });
  });

  it("a branch only on the remote: a worktree tracking the remote's", async () => {
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', repo, clone);
    const result = await sessionDirForBranch(clone, 'feature/x');
    expect(result).toEqual({ ok: true, workingDir: `${clone}-feature-x`, how: 'created' });
    expect(git(`${clone}-feature-x`, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(
      'origin/feature/x'
    );
  });

  it('refuses a branch that does not exist, a bad name and a folder outside git', async () => {
    expect(await sessionDirForBranch(repo, 'nope')).toMatchObject({
      ok: false,
      code: 'branch-not-found',
    });
    expect(await sessionDirForBranch(repo, '-x')).toMatchObject({ ok: false, code: 'bad-branch' });
    expect(await sessionDirForBranch(repo, 'a..b')).toMatchObject({
      ok: false,
      code: 'bad-branch',
    });
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await sessionDirForBranch(plain, 'main')).toMatchObject({
      ok: false,
      code: 'not-a-repo',
    });
    expect(fs.readdirSync(root).sort()).toEqual(['app', 'plain']);
  });

  describe('round 3 (2026-10-20)', () => {
    it('a worktree folder deleted by hand: pruned and made again, not a 500', async () => {
      const first = await sessionDirForBranch(repo, 'feature/x');
      expect(first).toMatchObject({ ok: true, how: 'created' });
      fs.rmSync(`${repo}-feature-x`, RM_TEST_DIR);
      expect(await sessionDirForBranch(repo, 'feature/x')).toEqual({
        ok: true,
        workingDir: `${repo}-feature-x`,
        how: 'created',
      });
      expect(git(`${repo}-feature-x`, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/x');
    });

    it('a tag named like a remote-only branch: the branch, not a detached tag', async () => {
      git(repo, 'checkout', '-q', 'feature/x');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'on feature');
      git(repo, 'checkout', '-q', 'main');
      const clone = path.join(root, 'clone');
      git(root, 'clone', '-q', repo, clone);
      git(clone, 'tag', 'feature/x', 'main');
      const result = await sessionDirForBranch(clone, 'feature/x');
      expect(result).toEqual({ ok: true, workingDir: `${clone}-feature-x`, how: 'created' });
      expect(git(`${clone}-feature-x`, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/x');
      expect(fs.existsSync(path.join(`${clone}-feature-x`, 'b.txt'))).toBe(true);
      // Same for a local branch with a same-named tag.
      git(repo, 'tag', 'feature/x', 'main');
      expect(await sessionDirForBranch(repo, 'feature/x')).toMatchObject({ ok: true });
      expect(git(`${repo}-feature-x`, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature/x');
      // And asked from the worktree that has it out: that folder, as 'current'.
      expect(await sessionDirForBranch(`${repo}-feature-x`, 'feature/x')).toMatchObject({
        how: 'current',
      });
    });

    it('a working folder that is gone: missing-dir, not bad-branch', async () => {
      expect(await sessionDirForBranch(path.join(root, 'gone'), 'main')).toMatchObject({
        ok: false,
        code: 'missing-dir',
      });
    });

    it('two branches mapping to the same folder, asked at once: both get one', async () => {
      git(repo, 'branch', 'feature-x');
      const [a, b] = await Promise.all([
        sessionDirForBranch(repo, 'feature/x'),
        sessionDirForBranch(repo, 'feature-x'),
      ]);
      expect(a.ok && b.ok).toBe(true);
      const dirs = [a, b].map((r) => (r.ok ? r.workingDir : '')).sort();
      expect(dirs).toEqual([`${repo}-feature-x`, `${repo}-feature-x-2`]);
    });

    it('a very long branch name: a capped folder name, unique by hash', () => {
      const long = `feature/${'a'.repeat(300)}`;
      const other = `feature/${'a'.repeat(299)}b`;
      const one = path.basename(branchWorktreePath('/r/app', long));
      expect(one.length).toBeLessThanOrEqual('app-'.length + 100);
      expect(one).toMatch(/-[0-9a-f]{10}$/);
      expect(branchWorktreePath('/r/app', other)).not.toBe(branchWorktreePath('/r/app', long));
      expect(branchWorktreePath('/r/app', 'feature/x')).toBe('/r/app-feature-x');
    });
  });
});
