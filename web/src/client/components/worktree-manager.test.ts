// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n/index.js';
import type { GitService, WorktreeListResponse } from '../services/git-service.js';
import type { WorktreeManager } from './worktree-manager.js';
import './worktree-manager.js';

const listing: WorktreeListResponse = {
  baseBranch: 'main',
  worktrees: [
    {
      path: '/repo',
      branch: 'main',
      HEAD: 'abc1234',
      detached: false,
      isMainWorktree: true,
      isCurrentWorktree: true,
    },
    {
      path: '/repo-feature-x',
      branch: 'feature/x',
      HEAD: 'def5678',
      detached: false,
      hasUncommittedChanges: true,
    },
  ],
};

describe('worktree-manager', () => {
  afterEach(async () => {
    await setLocale('en');
    fixtureCleanup();
  });

  it('asks before deleting a worktree in the chosen language, with the branch name in place', async () => {
    await setLocale('es');
    const gitService = { listWorktrees: vi.fn(async () => listing) } as unknown as GitService;
    const manager = await fixture<WorktreeManager>(
      html`<worktree-manager .gitService=${gitService} repoPath="/repo"></worktree-manager>`
    );
    const buttons = () => [...manager.querySelectorAll('button')];
    await vi.waitFor(() =>
      expect(buttons().some((button) => button.textContent?.trim() === 'Eliminar')).toBe(true)
    );

    buttons()
      .find((button) => button.textContent?.trim() === 'Eliminar')
      ?.click();
    await manager.updateComplete;

    const question = [...manager.querySelectorAll('p')].find((p) => p.querySelector('.font-mono'));
    expect(question?.textContent).toBe(
      '¿Seguro que quieres eliminar el worktree de la rama feature/x?'
    );
    expect(question?.querySelector('.font-mono')?.textContent).toBe('feature/x');
    expect(manager.textContent).toContain(
      'Este worktree tiene cambios sin confirmar que se perderán.'
    );
  });

  // 2026-11-10: the server never said which working tree is the main or the current one, so
  // every card (the main one too) offered Delete and a "Switch" that did nothing, and a failed
  // delete left its question open without a word.
  it('offers delete only on linked worktrees and tells when it fails', async () => {
    const { GitService: RealGitService } = await import('../services/git-service.js');
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        baseBranch: 'main',
        worktrees: [
          // The server marks the main working tree (routes/worktrees.ts, 2026-11-11).
          {
            path: '/repo',
            branch: 'main',
            HEAD: 'abc1234',
            detached: false,
            isMainWorktree: true,
          },
          {
            path: '/repo-feature-x',
            branch: 'feature/x',
            HEAD: 'def5678',
            detached: false,
            isMainWorktree: false,
          },
        ],
      }),
    })) as unknown as typeof fetch;
    try {
      const gitService = new RealGitService({ getAuthHeader: () => ({}) } as never);
      gitService.deleteWorktree = vi.fn(async () => {
        throw new Error('worktree is locked');
      });
      const manager = await fixture<WorktreeManager>(
        html`<worktree-manager .gitService=${gitService} repoPath="/repo"></worktree-manager>`
      );
      const named = (text: string) =>
        [...manager.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text);
      await vi.waitFor(() => expect(named('Delete')).toHaveLength(1));
      expect(named('Switch')).toHaveLength(0);
      expect(manager.textContent).toContain('Main');
      expect(manager.textContent).toContain('Current');

      const errors: string[] = [];
      manager.parentElement?.addEventListener('error', (event) =>
        errors.push((event as CustomEvent).detail.message)
      );
      named('Delete')[0].click();
      await manager.updateComplete;
      const confirm = [...manager.querySelectorAll('button')]
        .filter((b) => b.textContent?.trim().startsWith('Delete'))
        .pop();
      confirm?.click();
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toContain('worktree is locked');
      await manager.updateComplete;
      expect(manager.querySelector('p .font-mono')).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
