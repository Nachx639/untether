// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import {
  closeChangesSheet,
  findChangedFile,
  isChangesSheetOpen,
  openChangesSheet,
  parseUnifiedDiff,
  splitPath,
} from './changes-sheet.js';
import type { CompactMenu } from './compact-menu.js';
import './compact-menu.js';

const CHANGES = {
  isGitRepo: true,
  repoPath: '/repo',
  files: [
    { path: 'src/app.ts', status: 'M', additions: 3, deletions: 1, binary: false },
    { path: 'notes <b>.md', status: '??', additions: 2, deletions: 0, binary: false },
  ],
  totals: { files: 2, additions: 5, deletions: 1 },
};

const DIFF = {
  file: 'src/app.ts',
  diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n ctx\n-old <img src=x onerror=alert(1)>\n+new\n',
  binary: false,
  truncated: false,
  untracked: false,
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function tap(target: Element) {
  for (const type of ['pointerdown', 'pointerup']) {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: 5, clientY: 5 })
    );
  }
  (target as HTMLElement).click(); // iOS's trailing click must not act twice
}

describe('diff parsing', () => {
  it('numbers lines per hunk and drops file headers', () => {
    expect(parseUnifiedDiff(DIFF.diff)).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: 'ctx', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'old <img src=x onerror=alert(1)>', oldNo: 2 },
      { kind: 'add', text: 'new', newNo: 2 },
    ]);
    expect(splitPath('a/b/c.ts')).toEqual(['a/b/', 'c.ts']);
    expect(splitPath('c.ts')).toEqual(['', 'c.ts']);
  });
});

describe('changes sheet', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.startsWith('/api/git/changes/diff') ? DIFF : CHANGES),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    closeChangesSheet();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const sheet = () => document.querySelector('[data-testid="changes-sheet"]') as HTMLElement;

  it('counts a task worktree from its base branch (since) in the list and the diffs', async () => {
    openChangesSheet('/wt/task', { since: 'main' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/git/changes?path=%2Fwt%2Ftask&since=main');
    await flush();
    vi.setSystemTime(Date.now() + 600);
    tap(sheet().querySelectorAll('[data-testid="changes-file"]')[0]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/git/changes/diff?path=%2Fwt%2Ftask&file=src%2Fapp.ts&since=main'
    );
  });

  it('lists changed files with a summary, then opens a file diff and goes back', async () => {
    openChangesSheet('/repo/sub dir');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/git/changes?path=%2Frepo%2Fsub%20dir');
    await flush();

    expect(sheet().querySelector('[data-testid="changes-summary"]')?.textContent).toMatch(
      /2 files\s*\+5\s*−1/
    );
    const rows = sheet().querySelectorAll('[data-testid="changes-file"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent?.replace(/\s+/g, ' ').trim()).toBe('M src/app.ts +3 −1');
    expect(rows[1].querySelector('.ut-chg-base')?.textContent).toBe('notes <b>.md');
    expect(rows[1].querySelector('b')).toBeNull();

    // The click finishing the gesture that opened the sheet is ignored.
    (rows[0] as HTMLElement).click();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 600);
    tap(rows[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/git/changes/diff?path=%2Frepo%2Fsub+dir&file=src%2Fapp.ts'
    );
    await flush();

    const diff = sheet().querySelector('[data-testid="changes-diff"]') as HTMLElement;
    expect(diff.querySelector('img')).toBeNull();
    expect(diff.querySelector('.ut-dl-del .ut-dl-text')?.textContent).toBe(
      'old <img src=x onerror=alert(1)>'
    );
    expect(diff.querySelector('.ut-dl-add .ut-dl-text')?.textContent).toBe('new');
    expect(diff.querySelector('.ut-dl-hunk')?.textContent).toBe('@@ -1,2 +1,2 @@');

    vi.setSystemTime(Date.now() + 1000);
    tap(sheet().querySelector('[data-testid="changes-back"]') as Element);
    expect(sheet().querySelectorAll('[data-testid="changes-file"]')).toHaveLength(2);
  });

  it('says so when nothing changed, and closes', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        ...CHANGES,
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
      }),
    }));
    openChangesSheet('/repo');
    await flush();
    expect(sheet().querySelector('[data-testid="changes-empty"]')).not.toBeNull();
    vi.setSystemTime(Date.now() + 600);
    (sheet().querySelector('[data-testid="changes-close"]') as HTMLElement).click();
    expect(isChangesSheetOpen()).toBe(false);
    expect(sheet()).toBeNull();
  });
});

// Phones: the ⋯ menu is a bottom sheet rendered into <body> (compact-menu.ts, 2026-10-12).
describe('compact menu Changes item', () => {
  it('shows the changed-file count and opens through the session view callback', async () => {
    vi.useFakeTimers();
    const onShowChanges = vi.fn();
    const session = { gitModifiedCount: 2, gitAddedCount: 1, gitDeletedCount: 0 } as Session;
    const menu = await fixture<CompactMenu>(
      html`<compact-menu .session=${session} .hasGitRepo=${true} .onShowChanges=${onShowChanges}></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    const item = document.body.querySelector(
      '[data-testid="session-menu-sheet"] [data-testid="compact-changes"]'
    ) as HTMLElement;
    expect(item.querySelector('[data-testid="compact-changes-badge"]')?.textContent).toBe('3');
    item.click();
    vi.advanceTimersByTime(60);
    expect(onShowChanges).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    menu.remove();
  });

  it('shows greyed out with the reason outside a git repository', async () => {
    const onShowChanges = vi.fn();
    const menu = await fixture<CompactMenu>(
      html`<compact-menu .onShowChanges=${onShowChanges}></compact-menu>`
    );
    (menu.querySelector('button[data-menu-button]') as HTMLElement).click();
    await menu.updateComplete;
    expect(
      document.body.querySelector(
        '[data-testid="session-menu-sheet"] [data-testid="compact-changes"]'
      )
    ).toBeNull();
    const unavailable = document.body.querySelector(
      '[data-testid="session-menu-sheet"] [data-testid="compact-changes-unavailable"]'
    ) as HTMLElement;
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');
    expect(unavailable.textContent).toContain('Not a git repository');
    unavailable.click();
    expect(onShowChanges).not.toHaveBeenCalled();
    menu.remove();
  });
});

describe('findChangedFile', () => {
  const files = [
    { path: 'src/app.ts', status: 'M' as const, additions: 1, deletions: 0, binary: false },
    { path: 'app.ts', status: 'A' as const, additions: 1, deletions: 0, binary: false },
  ];

  it('matches an absolute path under the repository, or a relative one', () => {
    expect(findChangedFile(files, '/repo/src/app.ts', '/repo')?.path).toBe('src/app.ts');
    expect(findChangedFile(files, '/repo/app.ts', '/repo/')?.path).toBe('app.ts');
    expect(findChangedFile(files, 'src/app.ts')?.path).toBe('src/app.ts');
    expect(findChangedFile(files, '/elsewhere/other.ts', '/repo')).toBeUndefined();
  });
});
