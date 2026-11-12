// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { describe, expect, it, vi } from 'vitest';
import type { RepositoryHeader } from './repository-header';
import './repository-header';

const mount = (extra: Partial<RepositoryHeader> = {}) =>
  fixture<RepositoryHeader>(html`<repository-header
    .repoPath=${'/repos/app'}
    .label=${'app'}
    .count=${2}
    .compact=${true}
    .orchestratorSessionId=${extra.orchestratorSessionId ?? null}
    .folder=${extra.folder ?? false}
    .notice=${extra.notice}
    .projectIcon=${extra.projectIcon ?? null}
    .foldable=${extra.foldable ?? false}
    .collapsed=${extra.collapsed ?? false}
    .foldBodyId=${extra.foldBodyId ?? ''}
  ></repository-header>`);

const button = (el: Element, id: string) =>
  el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

describe('RepositoryHeader compact (the split-view sidebar)', () => {
  // 2026-10-24: the sidebar's header had only a "⋯" on hover: no way to see the project's
  // actions or its orchestrator.
  it('offers Orquestar and + Tarea, which say what they do and fire their events', async () => {
    const header = await mount();
    const orchestrate = button(header, 'project-orchestrate');
    const newTask = button(header, 'project-new-task');
    expect(orchestrate?.getAttribute('aria-label')).toBe('Orchestrate app');
    expect(orchestrate?.title).toBe('Orchestrate');
    expect(orchestrate?.querySelector('.prj-orch-dot')).toBeNull();
    expect(newTask?.getAttribute('aria-label')).toBe('New task in app');
    expect(button(header, 'repo-branch-chip')).not.toBeNull();

    const orchestrated = vi.fn();
    const created = vi.fn();
    header.addEventListener('project-orchestrate', orchestrated);
    header.addEventListener('project-new-task', created);
    orchestrate?.click();
    newTask?.click();
    expect(orchestrated.mock.calls[0][0].detail).toEqual({
      repoPath: '/repos/app',
      name: 'app',
      sessionId: null,
    });
    expect(created.mock.calls[0][0].detail).toEqual({ repoPath: '/repos/app', name: 'app' });
  });

  it('shows a running orchestrator with its dot, and passes its session on', async () => {
    const header = await mount({ orchestratorSessionId: 'orch' });
    const orchestrate = button(header, 'project-orchestrate');
    expect(orchestrate?.classList.contains('running')).toBe(true);
    expect(orchestrate?.querySelector('.prj-orch-dot')).not.toBeNull();
    expect(orchestrate?.getAttribute('aria-label')).toBe('Orchestrator of app');
    const orchestrated = vi.fn();
    header.addEventListener('project-orchestrate', orchestrated);
    orchestrate?.click();
    expect(orchestrated.mock.calls[0][0].detail.sessionId).toBe('orch');
  });

  it('tells a folder without git apart, as the full header does', async () => {
    const header = await mount({ folder: true });
    const created = vi.fn();
    header.addEventListener('project-new-task', created);
    button(header, 'project-new-task')?.click();
    expect(created.mock.calls[0][0].detail).toEqual({
      repoPath: '/repos/app',
      name: 'app',
      folder: true,
    });
  });

  it('has no actions for a project whose folder is gone, only the warning and "⋯"', async () => {
    const header = await mount({ notice: { missingSince: Date.now() } as never });
    expect(button(header, 'project-orchestrate')).toBeNull();
    expect(button(header, 'project-new-task')).toBeNull();
    expect(header.querySelector('[data-testid="repo-missing"]')?.getAttribute('aria-label')).toBe(
      'Folder not found'
    );
    expect(button(header, 'repo-branch-chip')).not.toBeNull();
  });
});

// 2026-10-24: the project's app icon showed only on the phone, not in the sidebar or the grid.
describe("RepositoryHeader project's app icon", () => {
  const ICON = 'blob:http://localhost/app-icon';
  const iconOf = (el: Element) =>
    el.querySelector<HTMLImageElement>('[data-testid="repo-project-icon"]');

  it('shows it before the name in the compact header, and nothing without one', async () => {
    const header = await mount();
    expect(iconOf(header)).toBeNull();
    // iconFor is null until the icon has loaded: it shows once it arrives.
    header.projectIcon = ICON;
    await header.updateComplete;
    const img = iconOf(header);
    expect(img?.getAttribute('src')).toBe(ICON);
    expect(img?.nextElementSibling?.textContent).toBe('app');
  });

  it('takes the folder icon s place in the desktop header, which comes back without it', async () => {
    const header = await mount({ projectIcon: ICON });
    header.compact = false;
    await header.updateComplete;
    const row = header.querySelector('[data-testid="repo-header"]') as HTMLElement;
    expect(iconOf(header)?.getAttribute('src')).toBe(ICON);
    expect(iconOf(header)?.nextElementSibling?.classList.contains('ut-repo-name')).toBe(true);
    expect(row.querySelector(':scope > svg')).toBeNull();
    // An icon that can't load gives the folder back.
    iconOf(header)?.dispatchEvent(new Event('error'));
    await header.updateComplete;
    expect(iconOf(header)).toBeNull();
    expect(row.querySelector(':scope > svg')).not.toBeNull();
  });

  it('keeps the plain desktop header for a project without an icon', async () => {
    const header = await mount();
    header.compact = false;
    await header.updateComplete;
    expect(iconOf(header)).toBeNull();
    expect(header.querySelector('[data-testid="repo-header"] > svg')).not.toBeNull();
  });

  // 2026-11-10: the sidebar's projects fold; the name is the button.
  it('folds its project from its name, a button that says whether it is open', async () => {
    const header = await mount({ foldable: true, foldBodyId: 'side-fold-0' });
    const fold = button(header, 'project-fold');
    expect(fold?.tagName).toBe('BUTTON');
    expect(fold?.getAttribute('aria-expanded')).toBe('true');
    expect(fold?.getAttribute('aria-controls')).toBe('side-fold-0');
    expect(fold?.getAttribute('aria-label')).toBe('Fold app');
    expect(fold?.querySelector('.ut-section-label')?.textContent).toBe('app');
    const asked = vi.fn();
    header.addEventListener('project-fold', asked);
    fold?.click();
    // Its actions are not part of it.
    button(header, 'project-orchestrate')?.click();
    button(header, 'project-new-task')?.click();
    button(header, 'repo-branch-chip')?.click();
    expect(asked.mock.calls.map(([event]) => event.detail)).toEqual([
      { repoPath: '/repos/app', name: 'app', collapsed: true },
    ]);

    const folded = await mount({ foldable: true, collapsed: true });
    const open = button(folded, 'project-fold');
    expect(open?.getAttribute('aria-expanded')).toBe('false');
    expect(open?.getAttribute('aria-label')).toBe('Unfold app');
    const opened = vi.fn();
    folded.addEventListener('project-fold', opened);
    open?.click();
    expect(opened.mock.calls[0][0].detail.collapsed).toBe(false);
    // Without `foldable` (the desktop grid) the name is plain text.
    expect(button(await mount(), 'project-fold')).toBeNull();
  });
});

describe('RepositoryHeader in the desktop grid', () => {
  const grid = (extra: Partial<RepositoryHeader> = {}) =>
    fixture<RepositoryHeader>(html`<repository-header
      .repoPath=${'/repos/ia-soberana-espana'}
      .label=${'ia-soberana-espana'}
      .taskActions=${true}
      .notice=${extra.notice}
    ></repository-header>`);

  /** The row is `room` px wide and its last piece ends `overflow(level)` px past it. */
  const narrow = (header: RepositoryHeader, fitsFrom: number) => {
    const head = header.querySelector('.ut-repo-head') as HTMLElement;
    const box = (right: number) =>
      ({ left: 0, top: 0, bottom: 28, right, width: right }) as DOMRect;
    vi.spyOn(head, 'getBoundingClientRect').mockImplementation(() => box(380));
    vi.spyOn(head.lastElementChild as Element, 'getBoundingClientRect').mockImplementation(() =>
      box(Number(head.dataset.squeeze) >= fitsFrom ? 380 : 420)
    );
    return head;
  };

  // 2026-11-11: one column wide, the header read «b…» and «ia-s…» beside "Orquestador" and
  // "+ Tarea" in full: the name now gets the room first.
  it('gives way one step at a time until the row fits, the name last', async () => {
    const header = await grid();
    const head = header.querySelector('.ut-repo-head') as HTMLElement;
    expect(head.classList.contains('ut-repo-head--fit')).toBe(true);
    // Room for everything: nothing gives way.
    expect(head.dataset.squeeze).toBe('0');
    for (const level of [1, 2, 3]) {
      narrow(header, level);
      header.fitHeader();
      expect(head.dataset.squeeze).toBe(String(level));
      vi.restoreAllMocks();
    }
    // Not even as icons: it stops at 3, where the styles let the name be cut.
    narrow(header, 9);
    header.fitHeader();
    expect(head.dataset.squeeze).toBe('3');
    vi.restoreAllMocks();
  });

  it('keeps the words of its buttons in the page, for the styles to hide and a reader to read', async () => {
    const header = await grid();
    expect(button(header, 'project-orchestrate')?.querySelector('.ut-repo-word')?.textContent).toBe(
      'Orchestrate'
    );
    expect(button(header, 'project-new-task')?.querySelector('.ut-repo-word')?.textContent).toBe(
      'Task'
    );
  });

  it('measures again when the page takes another style', async () => {
    const header = await grid();
    const head = header.querySelector('.ut-repo-head') as HTMLElement;
    head.dataset.squeeze = '3';
    document.documentElement.setAttribute('data-look', 'clay');
    await vi.waitFor(() => expect(head.dataset.squeeze).toBe('0'));
    document.documentElement.removeAttribute('data-look');
  });

  it('does not measure the sidebar header, nor one whose folder is gone', async () => {
    expect((await mount()).querySelector('[data-squeeze]')).toBeNull();
    const gone = await grid({ notice: { missingSince: '2026-11-01T00:00:00Z' } as never });
    expect(gone.querySelector('.ut-repo-head--fit')).toBeNull();
    expect(gone.querySelector('[data-squeeze]')).toBeNull();
  });
});
