import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { getBranchStats } from './worktree-git.js';

describe('getBranchStats', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: repo,
      stdio: 'pipe',
    });
  const commit = (file: string) => {
    fs.writeFileSync(path.join(repo, file), file);
    git('add', file);
    git('commit', '-q', '--no-verify', '-m', file);
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-branch-stats-'));
    git('init', '-q', '-b', 'main');
    commit('a');
  });
  afterEach(() => fs.rmSync(repo, RM_TEST_DIR));

  it('counts only what the branch has and its base lacks (2026-11-10)', async () => {
    git('branch', 'feature');
    commit('b');
    commit('c');
    // Two commits behind main, none of its own: it used to say "2 ahead".
    expect((await getBranchStats(repo, 'feature', 'main')).commitsAhead).toBe(0);
    git('checkout', '-q', 'feature');
    commit('d');
    expect((await getBranchStats(repo, 'feature', 'main')).commitsAhead).toBe(1);
  });
});
