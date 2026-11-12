// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitService } from '../../services/git-service.js';
import './git-branch-selector.js';
import type { GitBranchSelector } from './git-branch-selector.js';

describe('Worktree Creation UI', () => {
  let element: GitBranchSelector;
  let _mockGitService: GitService;

  beforeEach(async () => {
    // Create mock git service
    _mockGitService = {
      checkGitRepo: vi.fn(),
      listWorktrees: vi.fn(),
      createWorktree: vi.fn(),
      deleteWorktree: vi.fn(),
      setFollowMode: vi.fn(),
    } as unknown as GitService;

    // Create element
    element = document.createElement('git-branch-selector') as GitBranchSelector;
    element.gitRepoInfo = {
      isGitRepo: true,
      repoPath: '/test/repo',
      hasChanges: false,
      isWorktree: false,
    };
    element.availableBranches = ['main', 'develop', 'feature/existing'];
    element.currentBranch = 'main';
    element.selectedBaseBranch = 'main';

    document.body.appendChild(element);
    await element.updateComplete;
  });

  afterEach(() => {
    element.remove();
    vi.clearAllMocks();
  });

  describe('Branch Name Validation', () => {
    it('should validate branch names correctly', () => {
      // @ts-expect-error - accessing private method for testing
      const validate = (name: string) => element.validateBranchName(name);

      // Valid names
      expect(validate('feature/new-feature')).toBeNull();
      expect(validate('bugfix/123')).toBeNull();
      expect(validate('release-1.0')).toBeNull();

      // Invalid names
      expect(validate('-invalid')).toContain('cannot start or end with a hyphen');
      expect(validate('invalid-')).toContain('cannot start or end with a hyphen');
      expect(validate('feature..branch')).toContain('invalid characters');
      expect(validate('feature~branch')).toContain('invalid characters');
      expect(validate('feature^branch')).toContain('invalid characters');
      expect(validate('feature:branch')).toContain('invalid characters');
      expect(validate('branch.lock')).toContain('cannot end with .lock');
      expect(validate('feature//branch')).toContain('consecutive slashes');
      expect(validate('HEAD')).toContain('reserved Git name');
      expect(validate('FETCH_HEAD')).toContain('reserved Git name');

      // Existing branch
      expect(validate('feature/existing')).toContain('already exists');
    });
  });

  describe('Worktree Creation Flow', () => {
    type Internals = { showCreateWorktree: boolean; isCreatingWorktree: boolean };
    const internals = () => element as unknown as Internals;
    const nameInput = () =>
      element.querySelector('input[placeholder="New branch name"]') as HTMLInputElement;
    const createButton = () =>
      [...element.querySelectorAll('button')].find((button) =>
        (button.textContent?.trim() ?? '').startsWith('Creat')
      ) as HTMLButtonElement;

    async function openAndType(name: string) {
      internals().showCreateWorktree = true;
      await element.updateComplete;
      nameInput().value = name;
      nameInput().dispatchEvent(new Event('input'));
      await element.updateComplete;
    }

    it('asks for the worktree and stays busy until told how it went', async () => {
      await openAndType('feature/new-branch');
      const asked = vi.fn();
      element.addEventListener('create-worktree', (event) => asked((event as CustomEvent).detail));
      createButton().click();
      await element.updateComplete;

      expect(asked).toHaveBeenCalledTimes(1);
      const detail = asked.mock.calls[0][0];
      expect(detail).toMatchObject({
        branchName: 'feature/new-branch',
        baseBranch: 'main',
        customPath: null,
      });
      expect(internals().isCreatingWorktree).toBe(true);
      expect(createButton().disabled).toBe(true);
      expect(nameInput().disabled).toBe(true);

      // It failed: the panel stays with what was typed, usable again.
      detail.done(false);
      await element.updateComplete;
      expect(internals().isCreatingWorktree).toBe(false);
      expect(nameInput().value).toBe('feature/new-branch');
      expect(createButton().disabled).toBe(false);
    });

    it('closes the panel once the worktree is created', async () => {
      await openAndType('feature/new-branch');
      let done: (created: boolean) => void = () => {};
      element.addEventListener('create-worktree', (event) => {
        done = (event as CustomEvent).detail.done;
      });
      createButton().click();
      done(true);
      await element.updateComplete;

      expect(internals().isCreatingWorktree).toBe(false);
      expect(internals().showCreateWorktree).toBe(false);
      expect(nameInput()).toBeNull();
    });

    it('tells why a branch name is refused and asks for nothing', async () => {
      await openAndType('-invalid-name');
      const asked = vi.fn();
      const errors: string[] = [];
      element.addEventListener('create-worktree', asked);
      element.addEventListener('error', (event) => errors.push((event as CustomEvent).detail));
      createButton().click();

      expect(asked).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('cannot start or end with a hyphen');
      expect(internals().isCreatingWorktree).toBe(false);
    });

    it('offers nothing to create without a branch name', async () => {
      internals().showCreateWorktree = true;
      await element.updateComplete;
      expect(createButton().disabled).toBe(true);
    });
  });
});
