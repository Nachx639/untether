// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '@/shared/types';
import { createMockSession } from '@/test/utils/lit-test-utils';
import type { GitStatusBadge } from './git-status-badge';

describe('GitStatusBadge', () => {
  beforeAll(async () => {
    await import('./git-status-badge');
  });

  it('renders branch info cut in its middle, with its title', async () => {
    const session = {
      ...createMockSession(),
      gitRepoPath: '/tmp/repo',
      gitBranch: 'feature/super-long-branch-name',
      gitIsWorktree: true,
      gitModifiedCount: 2,
    } as Session;

    const element = await fixture<GitStatusBadge>(html`
      <git-status-badge .session=${session}></git-status-badge>
    `);

    await element.updateComplete;

    const chip = element.querySelector('[data-testid="git-branch-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.classList.contains('ut-chip--mono')).toBe(true);
    expect(chip?.querySelector('svg')).toBeTruthy();
    // Two parts (`.ut-mid`): a task's branches differ at their end, which stays on screen.
    const name = chip?.querySelector('.ut-mid');
    expect(name?.textContent?.trim()).toBe('feature/super-long-branch-name');
    expect(name?.querySelector('.ut-mid-start')?.textContent).toBe('feature/supe');
    expect(name?.querySelector('.ut-mid-end')?.textContent).toBe('r-long-branch-name');
    // Each piece is an item of the line that holds the badge, with no box around them: the
    // header's second line decides which gives way (2026-11-12, pieces painted one on another).
    expect([...element.children].map((el) => el.getAttribute('data-testid'))).toEqual([
      'git-branch-chip',
      'git-worktree-chip',
      'git-changed-files',
    ]);
    expect(chip?.getAttribute('title')).toBe('feature/super-long-branch-name');
    // Never the old bracketed form.
    expect(element.textContent).not.toContain('[');
  });

  it('shows HEAD with a tooltip on a detached HEAD, never "[git]"', async () => {
    const session = {
      ...createMockSession(),
      gitRepoPath: '/tmp/repo',
      gitBranch: '',
      gitIsWorktree: true,
    } as Session;

    const element = await fixture<GitStatusBadge>(html`
      <git-status-badge .session=${session}></git-status-badge>
    `);
    await element.updateComplete;

    const chip = element.querySelector('[data-testid="git-branch-chip"]');
    expect(chip?.textContent?.trim()).toBe('HEAD');
    expect(chip?.getAttribute('title')).toBe('Detached HEAD');
    expect(chip?.getAttribute('data-detached')).toBe('true');
    expect(element.textContent).not.toContain('[git');
    expect(element.textContent).not.toContain('•');
    // A worktree gets its own chip.
    expect(element.querySelector('[data-testid="git-worktree-chip"]')?.textContent?.trim()).toBe(
      'worktree'
    );
  });

  it('has no worktree chip in the main checkout', async () => {
    const session = {
      ...createMockSession(),
      gitRepoPath: '/tmp/repo',
      gitBranch: 'main',
    } as Session;
    const element = await fixture<GitStatusBadge>(html`
      <git-status-badge .session=${session}></git-status-badge>
    `);
    await element.updateComplete;
    expect(element.querySelector('[data-testid="git-worktree-chip"]')).toBeNull();
    expect(element.querySelector('.text-muted-foreground')).toBeNull();
  });

  it('renders line insertion and deletion counts', async () => {
    const session = {
      ...createMockSession(),
      gitRepoPath: '/tmp/repo',
      gitBranch: 'main',
      gitInsertionCount: 12,
      gitDeletionCount: 3,
    } as Session;

    const element = await fixture<GitStatusBadge>(html`
      <git-status-badge .session=${session}></git-status-badge>
    `);

    await element.updateComplete;

    expect(element.textContent).toContain('+12');
    expect(element.textContent).toContain('−3');
    expect(element.querySelector('[title="Line insertions"]')).toBeTruthy();
    expect(element.querySelector('[title="Line deletions"]')).toBeTruthy();
  });
});
