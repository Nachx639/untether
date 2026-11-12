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

  it('renders branch info with truncation and title', async () => {
    const session = {
      ...createMockSession(),
      gitRepoPath: '/tmp/repo',
      gitBranch: 'feature/super-long-branch-name',
    } as Session;

    const element = await fixture<GitStatusBadge>(html`
      <git-status-badge .session=${session}></git-status-badge>
    `);

    await element.updateComplete;

    const chip = element.querySelector('[data-testid="git-branch-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.classList.contains('ut-chip--mono')).toBe(true);
    expect(chip?.querySelector('svg')).toBeTruthy();
    expect(chip?.querySelector('.truncate')?.textContent?.trim()).toBe(
      'feature/super-long-branch-name'
    );
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
