// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import './git-branch-selector.js';
import type { GitBranchSelector } from './git-branch-selector.js';

describe('git-branch-selector', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('a branch other than the checked-out one says it gets its own worktree', async () => {
    const el = document.createElement('git-branch-selector') as GitBranchSelector;
    el.gitRepoInfo = { isGitRepo: true, repoPath: '/repo', hasChanges: false, isWorktree: false };
    el.availableBranches = ['main', 'develop'];
    el.currentBranch = 'main';
    el.selectedBaseBranch = 'develop';
    document.body.appendChild(el);
    await el.updateComplete;
    const note = el.querySelector('[data-testid="branch-worktree-hint"]');
    expect(note?.textContent).toContain('develop');
    expect(note?.textContent).toContain('main');

    el.selectedBaseBranch = 'main';
    await el.updateComplete;
    expect(el.querySelector('[data-testid="branch-worktree-hint"]')).toBeNull();
  });

  it('uncommitted changes in the checkout do not lock the branch picker', async () => {
    const el = document.createElement('git-branch-selector') as GitBranchSelector;
    el.gitRepoInfo = { isGitRepo: true, repoPath: '/repo', hasChanges: true, isWorktree: false };
    el.availableBranches = ['main', 'develop'];
    el.currentBranch = 'main';
    document.body.appendChild(el);
    await el.updateComplete;
    const select = el.querySelector<HTMLSelectElement>('[data-testid="git-base-branch-select"]');
    expect(select?.disabled).toBe(false);
  });
});
