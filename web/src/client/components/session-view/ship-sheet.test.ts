// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeChangesSheet, openChangesSheet } from './changes-sheet.js';
import { closeShipSheet, isShipSheetOpen, openShipSheet } from './ship-sheet.js';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function tap(target: Element) {
  for (const type of ['pointerdown', 'pointerup']) {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: 5, clientY: 5 })
    );
  }
  (target as HTMLElement).click(); // iOS's trailing click must not act twice
}

const later = (ms = 600) => vi.setSystemTime(Date.now() + ms);

const STATUS = {
  repoPath: '/repo',
  branch: 'feature/x',
  detached: false,
  head: 'abc',
  upstream: 'origin/feature/x',
  upstreamRemote: 'origin',
  upstreamBranch: 'feature/x',
  ahead: 2,
  behind: 0,
  remotes: ['origin'],
  protectedBranch: false,
  files: [
    { path: 'src/a.ts', status: 'M', additions: 1, deletions: 0, binary: false },
    { path: 'src/new.ts', status: '??', additions: 3, deletions: 0, binary: false },
  ],
};

describe('ship sheet', () => {
  const fetchMock = vi.fn();
  let status: Record<string, unknown>;
  let postResponse: { ok: boolean; body: unknown };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'));
    status = { ...STATUS };
    postResponse = { ok: true, body: { ok: true, output: 'done' } };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return {
          ok: postResponse.ok,
          status: postResponse.ok ? 200 : 409,
          json: async () => postResponse.body,
        };
      }
      if (url.startsWith('/api/git/changes')) {
        return {
          ok: true,
          json: async () => ({
            isGitRepo: true,
            repoPath: '/repo',
            files: STATUS.files,
            totals: { files: 2, additions: 4, deletions: 0 },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => status };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    closeShipSheet();
    closeChangesSheet();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST');

  it('commits only the ticked files with a generated, editable message', async () => {
    openShipSheet('s 1', 'commit');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/s%201/git/ship-status');
    await flush();
    const boxes = document.querySelectorAll<HTMLInputElement>('[data-testid="ship-file"]');
    expect([...boxes].map((b) => b.checked)).toEqual([true, true]);
    boxes[1].checked = false;
    boxes[1].dispatchEvent(new Event('change'));

    later();
    tap(q('ship-generate'));
    await flush();
    const textarea = q('ship-message') as HTMLTextAreaElement;
    expect(textarea.value).toBe('fix: update a.ts');

    tap(q('ship-review'));
    expect(q('ship-confirm-files').textContent).toContain('src/a.ts');
    expect(q('ship-confirm-files').textContent).not.toContain('src/new.ts');
    expect(q('ship-confirm-message').textContent).toBe('fix: update a.ts');

    // The tap that opened the confirm view cannot also confirm it.
    tap(q('ship-confirm-button'));
    expect(posts()).toHaveLength(0);

    later();
    tap(q('ship-confirm-button'));
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0];
    expect(url).toBe('/api/sessions/s%201/git/commit');
    expect(JSON.parse(init.body)).toEqual({
      files: [{ path: 'src/a.ts' }],
      message: 'fix: update a.ts',
    });
    await flush();
    expect(q('ship-result').textContent).toContain('Committed');
  });

  it('offers the push right after a commit, when there is somewhere to push it', async () => {
    const commit = async () => {
      openShipSheet('s1', 'commit');
      await flush();
      later();
      tap(q('ship-generate'));
      await flush();
      tap(q('ship-review'));
      later();
      tap(q('ship-confirm-button'));
      await flush();
    };
    await commit();
    expect(q('ship-result').textContent).toContain('Committed');
    later();
    tap(q('ship-push-next'));
    await flush();
    // The push sheet, reloaded: its own status request and its own confirmation.
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/sessions/s1/git/ship-status');
    expect(document.querySelector('[data-testid="ship-sheet"]')?.textContent).toContain('Push');

    closeShipSheet();
    status = { ...STATUS, upstream: null, upstreamRemote: null, upstreamBranch: null, remotes: [] };
    await commit();
    expect(q('ship-push-next')).toBeNull();
  });

  it('shows hook output when the commit fails', async () => {
    postResponse = {
      ok: false,
      body: { error: 'The commit failed', code: 'commit-failed', output: 'lint: 3 errors' },
    };
    openShipSheet('s1', 'commit');
    await flush();
    const textarea = q('ship-message') as HTMLTextAreaElement;
    textarea.value = 'msg';
    textarea.dispatchEvent(new Event('input'));
    later();
    tap(q('ship-review'));
    later();
    tap(q('ship-confirm-button'));
    await flush();
    expect(q('ship-result').textContent).toContain('hook');
    expect(q('ship-output').textContent).toBe('lint: 3 errors');
  });

  it('pushes to main only after the explicit tick', async () => {
    status = {
      ...STATUS,
      branch: 'main',
      upstream: 'origin/main',
      upstreamBranch: 'main',
      protectedBranch: true,
    };
    openShipSheet('s1', 'push');
    await flush();
    expect(q('ship-ahead').textContent).toContain('↑2');
    later();
    tap(q('ship-review'));
    expect(q('ship-confirm-command').textContent).toBe('git push origin main:main');
    const button = q('ship-confirm-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    later();
    tap(button);
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    expect(posts()).toHaveLength(0);

    const tick = q('ship-confirm-main') as HTMLInputElement;
    tick.checked = true;
    tick.dispatchEvent(new Event('change'));
    later();
    tap(q('ship-confirm-button'));
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body)).toEqual({ setUpstream: false, confirmMain: true });
  });

  it('offers to publish a branch without upstream with -u', async () => {
    status = { ...STATUS, upstream: null, upstreamRemote: null, upstreamBranch: null, ahead: 1 };
    openShipSheet('s1', 'push');
    await flush();
    later();
    tap(q('ship-review'));
    expect(q('ship-confirm-command').textContent).toBe('git push -u origin feature/x');
    expect(q('ship-confirm-main')).toBeNull();
    later();
    tap(q('ship-confirm-button'));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ setUpstream: true, confirmMain: false });
  });

  it('refuses a detached HEAD', async () => {
    status = { ...STATUS, branch: null, detached: true };
    openShipSheet('s1', 'push');
    await flush();
    expect(q('ship-detached')).not.toBeNull();
    expect(q('ship-review')).toBeNull();
  });

  it('creates a PR and links to it', async () => {
    status = {
      ...STATUS,
      ahead: 0,
      pr: {
        gh: { available: true, authenticated: true, defaultBranch: 'main' },
        base: 'main',
        bases: ['main', 'develop'],
        title: 'feat: thing',
        body: '- feat: thing',
        commits: [{ subject: 'feat: thing' }],
      },
    };
    postResponse = { ok: true, body: { ok: true, url: 'https://github.com/a/b/pull/7' } };
    openShipSheet('s1', 'pr');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/s1/git/ship-status?pr=1');
    await flush();
    expect((q('ship-pr-title') as HTMLInputElement).value).toBe('feat: thing');
    const draft = q('ship-pr-draft') as HTMLInputElement;
    draft.checked = true;
    draft.dispatchEvent(new Event('change'));
    later();
    tap(q('ship-review'));
    expect(q('ship-confirm').textContent).toContain('feature/x');
    later();
    tap(q('ship-confirm-button'));
    expect(JSON.parse(posts()[0][1].body)).toEqual({
      title: 'feat: thing',
      body: '- feat: thing',
      base: 'main',
      draft: true,
    });
    await flush();
    const link = q('ship-pr-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/a/b/pull/7');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  // 2026-11-10: choosing another base asked for the suggestion again and replaced a title
  // already written.
  it('keeps the title the user wrote when another base is chosen', async () => {
    const pr = {
      gh: { available: true, authenticated: true, defaultBranch: 'main' },
      base: 'main',
      bases: ['main', 'develop'],
      title: 'feat: thing',
      body: '- feat: thing',
      commits: [{ subject: 'feat: thing' }],
    };
    status = { ...STATUS, ahead: 0, pr };
    openShipSheet('s1', 'pr');
    await flush();
    const title = q('ship-pr-title') as HTMLInputElement;
    title.value = 'My own title';
    title.dispatchEvent(new Event('input'));

    status = { ...STATUS, ahead: 0, pr: { ...pr, base: 'develop', title: 'other', body: 'b2' } };
    const baseSelect = document.querySelector('#ut-ship-base') as HTMLSelectElement;
    baseSelect.value = 'develop';
    baseSelect.dispatchEvent(new Event('change'));
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('base=develop');
    await flush();

    expect((q('ship-pr-title') as HTMLInputElement).value).toBe('My own title');
    // The body was not touched: it follows the new base's suggestion.
    expect((document.querySelector('#ut-ship-body') as HTMLTextAreaElement).value).toBe('b2');
  });

  it('explains when gh is missing or not signed in', async () => {
    status = {
      ...STATUS,
      pr: {
        gh: { available: false, authenticated: false },
        base: 'main',
        bases: [],
        title: '',
        body: '',
        commits: [],
      },
    };
    openShipSheet('s1', 'pr');
    await flush();
    expect(q('ship-gh-missing').textContent).toContain('gh');
    status = {
      ...STATUS,
      pr: {
        gh: { available: true, authenticated: false },
        base: 'main',
        bases: [],
        title: '',
        body: '',
        commits: [],
      },
    };
    openShipSheet('s1', 'pr');
    await flush();
    expect(q('ship-gh-unauth').textContent).toContain('gh auth login');
  });

  it('is reached from the Changes sheet of a session', async () => {
    openChangesSheet('/repo', { sessionId: 's1' });
    await flush();
    later();
    tap(q('changes-push'));
    expect(isShipSheetOpen()).toBe(true);
    closeChangesSheet();
    expect(isShipSheetOpen()).toBe(false);

    openChangesSheet('/repo');
    await flush();
    expect(q('changes-ship')).toBeNull();
  });
});
