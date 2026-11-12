// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestTask } from '@/test/utils/test-factories';
import type { TaskRecord } from '../../shared/tasks.js';
import type { PreviewItem, Session } from '../../shared/types.js';
import { readStylesheet } from '../../test/utils/stylesheets.js';
import type { AuthClient } from '../services/auth-client.js';
import { taskStore } from '../services/task-store.js';
import { COMPACT_LIST_KEY, writeCompactListPref } from '../utils/phone-list-layout.js';
import type { AskClaudeBox } from './ask-claude-box.js';
import type { NotificationsBanner } from './notifications-banner.js';
import { SessionList } from './session-list.js';
import type { TaskRow } from './task-row.js';

// 2026-10-04: on a 375×667 pt iPhone SE the first screen showed no session at all. Only the
// classes and decisions are checked here (happy-dom has no layout); what fits on the screen
// is checked on the SE simulator.
const session = {
  id: 's1',
  name: 'compact',
  command: ['zsh'],
  workingDir: '/tmp',
  status: 'running',
  startedAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
} as unknown as Session;

const preview = (id: string, port: number, title: string): PreviewItem => ({
  id,
  port,
  path: '/',
  createdAt: 1,
  lastOpenedAt: port,
  sessionAlive: false,
  pinned: false,
  source: 'ut-open',
  state: 'live',
  title,
});

// Newest first in the list: Inicio (opened later), then QA Vite.
const TWO_PREVIEWS = [preview('pvite123', 5173, 'QA Vite'), preview('phola123', 5180, 'Inicio')];

function setScreen(width: number, height: number) {
  Object.defineProperty(window.screen, 'width', { configurable: true, get: () => width });
  Object.defineProperty(window.screen, 'height', { configurable: true, get: () => height });
}

const mount = async (previews: PreviewItem[] = TWO_PREVIEWS) => {
  const list = await fixture<SessionList>(
    html`<session-list
      .sessions=${[session]}
      .previews=${previews}
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`
  );
  await list.updateComplete;
  return list;
};

const content = (list: SessionList) =>
  list.querySelector<HTMLElement>('.phone-list') as HTMLElement;

describe('phone list on a small screen', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  // 2026-10-12 (phone-spec 4.1): compact on every phone; down previews fold.
  const withDown = [TWO_PREVIEWS[0], { ...TWO_PREVIEWS[1], state: 'down' as const }];

  describe('iPhone SE (375×667)', () => {
    beforeEach(() => setScreen(375, 667));

    it('tightens the spacing and turns the compact list on', async () => {
      const list = await mount();
      const classes = content(list).classList;
      expect(classes).toContain('phone-list-tight');
      expect(classes).toContain('phone-list-compact');
      expect(classes).toContain('pt-3');
    });

    it('puts "Tareas" in the Ask card, as a labelled icon', async () => {
      const list = await mount();
      const ask = list.querySelector<AskClaudeBox>('ask-claude-box');
      await ask?.updateComplete;
      expect(ask?.tasks).toBe(true);
      const tasks = ask?.querySelector<HTMLButtonElement>('[data-testid="open-tasks"]');
      expect(tasks?.getAttribute('aria-label')).toBe('Tasks');
      expect(tasks?.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(list.querySelector('.task-entry')).toBeNull();
      expect(list.querySelectorAll('[data-testid="open-tasks"]').length).toBe(1);
    });

    it('asks the notifications banner for one line', async () => {
      const list = await mount();
      expect(list.querySelector<NotificationsBanner>('notifications-banner')?.compact).toBe(true);
    });

    it('shows live previews, and folds the down ones until the disclosure opens', async () => {
      const list = await mount(withDown);
      const toggle = list.querySelector<HTMLButtonElement>('[data-testid="preview-rows-toggle"]');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      // Folded, it counts what opening it adds, not the live one already shown.
      expect(toggle?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Previews+1');
      expect(list.querySelectorAll('preview-row').length).toBe(1);
      const add = list.querySelector('[data-testid="preview-add"]');
      expect(add?.getAttribute('aria-label')).toBe('+ Add preview');

      toggle?.click();
      await list.updateComplete;
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.textContent).toContain('Previews (2)');
      expect(list.querySelectorAll('preview-row').length).toBe(2);
    });

    it('with every preview live there is nothing to fold', async () => {
      const list = await mount();
      expect(list.querySelector('[data-testid="preview-rows-toggle"]')).toBeNull();
      expect(list.querySelectorAll('preview-row').length).toBe(2);
    });

    it('with "Compact list" off nothing folds', async () => {
      store.set(COMPACT_LIST_KEY, 'off');
      const list = await mount(withDown);
      expect(content(list).classList).not.toContain('phone-list-compact');
      expect(list.querySelectorAll('preview-row').length).toBe(2);
    });

    it('follows the setting at once when it changes', async () => {
      const list = await mount(withDown);
      writeCompactListPref('off');
      await list.updateComplete;
      expect(content(list).classList).not.toContain('phone-list-compact');
      expect(list.querySelectorAll('preview-row').length).toBe(2);
    });
  });

  describe('larger phones keep roomier spacing, compact by default', () => {
    it.each([
      ['iPhone 15', 393, 852],
      ['iPhone Pro Max', 440, 956],
    ])('%s', async (_name, width, height) => {
      setScreen(width, height);
      const list = await mount(withDown);
      const classes = content(list).classList;
      expect(classes).toContain('pt-4');
      expect(classes).not.toContain('phone-list-tight');
      expect(classes).toContain('phone-list-compact');
      expect(list.querySelector<AskClaudeBox>('ask-claude-box')?.tasks).toBe(true);
      expect(list.querySelector('[data-testid="preview-rows-toggle"]')).not.toBeNull();
    });
  });

  it('an iPhone SE (320) keeps a task row whole: pill, reason and its buttons', async () => {
    setScreen(320, 568);
    taskStore.set([
      createTestTask({
        id: 't1',
        state: 'needs_you',
        blocker: { kind: 'verify', message: 'x' },
        sessionId: 's1',
      }),
    ]);
    try {
      const list = await mount([]);
      const row = list.querySelector('task-row') as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.querySelector('[data-testid="task-pill"]')).not.toBeNull();
      expect(row.querySelectorAll('.tsk-btn').length).toBeGreaterThan(1);
      expect(list.querySelector('[data-testid="project-new-task"]')).not.toBeNull();
      // No layout here: the narrow rules are checked in the stylesheet (buttons wrap; "+ Tarea"
      // keeps its icon and a hidden label once the header has measured that its word does not
      // fit: data-squeeze 3, project-group.ts; the real widths are ui-shots --audit-layout's).
      const css = readStylesheet('styles/list.css');
      expect(css).toMatch(
        /\.prj-head\[data-squeeze="3"\] \.prj-new > span \{[^}]*clip-path: inset\(50%\)/
      );
      // No viewport width decides it any more (2026-11-10: 430 pt showed the words, the name cut).
      expect(css).not.toMatch(/@media \(max-width: \d+px\) \{\s*\.prj-(new|orch)/);
      expect(css).toMatch(/\.tsk-actions \{[^}]*flex-wrap: wrap;/);
    } finally {
      taskStore.reset();
    }
  });

  it('the sidebar opened from a session keeps its own layout, even on an SE', async () => {
    setScreen(375, 667);
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${[session]}
        .previews=${TWO_PREVIEWS}
        .compactMode=${true}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    expect(list.querySelector('.phone-list-tight, .phone-list-compact')).toBeNull();
    expect(list.querySelectorAll('preview-row').length).toBe(2);
  });
});

// 2026-11-08: the Mac's sidebar listed only sessions, so a task still waiting to start showed
// nowhere there.
describe('split-view sidebar: open tasks', () => {
  const repo = '/repos/app';
  const inRepo = (id: string, over: Partial<Session> = {}) =>
    ({ ...session, id, name: id, gitRepoPath: repo, gitBranch: 'main', ...over }) as Session;

  const sidebar = async (sessions: Session[], hideExited = true) => {
    const list = await fixture<SessionList>(
      html`<session-list
        .sessions=${sessions}
        .compactMode=${true}
        .hideExited=${hideExited}
        .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
      ></session-list>`
    );
    await list.updateComplete;
    for (const row of list.querySelectorAll<TaskRow>('task-row')) await row.updateComplete;
    return list;
  };
  const taskRows = (list: Element) =>
    [...list.querySelectorAll<HTMLElement>('[data-testid="compact-task-row"]')].map(
      (row) => row.dataset.taskId
    );
  const taskRow = (list: Element, id: string) =>
    list.querySelector(`[data-testid="compact-task-row"][data-task-id="${id}"]`) as HTMLElement;
  const stateOf = (list: Element, id: string) =>
    taskRow(list, id).querySelector('[data-testid="compact-task-state"]')?.textContent?.trim();
  const cards = (list: Element) =>
    [...list.querySelectorAll<HTMLElement>('[data-testid="compact-session-card"]')].map(
      (card) => card.dataset.sessionId
    );
  const headerCount = (list: Element) =>
    list.querySelector<HTMLElement & { count: number }>('.ut-side-list repository-header')?.count;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({}))
    );
    vi.spyOn(
      SessionList.prototype as unknown as { usePhoneRows: () => boolean },
      'usePhoneRows'
    ).mockReturnValue(false);
  });
  afterEach(() => {
    taskStore.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fixtureCleanup();
  });

  it('shows a task without a session, and does not say nothing is running', async () => {
    taskStore.set([
      createTestTask({
        id: 'q',
        state: 'queued',
        queued: { position: 2, of: 3 },
      } as Partial<TaskRecord>),
    ]);
    const list = await sidebar([]);
    expect(taskRows(list)).toEqual(['q']);
    expect(stateOf(list, 'q')).toBe('queued');
    expect(taskRow(list, 'q').getAttribute('title')).toBe('queued · 2 of 3');
    expect(list.querySelector('.ut-side-group')?.getAttribute('data-group-key')).toBe(repo);
    expect(list.querySelector('.ut-side-list')?.textContent).not.toContain('No running sessions');
  });

  it('a tap on a task that has not started opens nothing', async () => {
    taskStore.set([createTestTask({ id: 'p', state: 'preparing' })]);
    const list = await sidebar([]);
    const selected = vi.fn();
    list.addEventListener('navigate-to-session', selected);
    expect(stateOf(list, 'p')).toBe('getting ready');
    taskRow(list, 'p').click();
    expect(selected).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="task-detail-sheet"]')).toBeNull();
  });

  it('a tap on a stopped task whose session is gone opens its detail sheet', async () => {
    taskStore.set([createTestTask({ id: 'stopped', state: 'failed' })]);
    const list = await sidebar([]);
    taskRow(list, 'stopped').click();
    await list.updateComplete;
    expect(document.querySelector('[data-testid="task-detail-sheet"]')).not.toBeNull();
  });

  it('a task with a session is one row, and a tap opens that session', async () => {
    taskStore.set([createTestTask({ id: 't', state: 'needs_you', sessionId: 'task-s' })]);
    const list = await sidebar([inRepo('task-s'), inRepo('loose')]);
    expect(taskRows(list)).toEqual(['t']);
    expect(cards(list)).toEqual(['loose']);
    expect(stateOf(list, 't')).toBe('needs you');
    const selected = vi.fn();
    list.addEventListener('navigate-to-session', selected);
    taskRow(list, 't').click();
    expect(selected).toHaveBeenCalledTimes(1);
    expect((selected.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      sessionId: 'task-s',
    });
  });

  it('an open task keeps its ended session out of "Finished"; a merged one does not', async () => {
    taskStore.set([
      createTestTask({ id: 'open', state: 'needs_you', sessionId: 'ended' }),
      createTestTask({ id: 'gone', state: 'merged', sessionId: 'merged-s' }),
    ]);
    const list = await sidebar(
      [inRepo('ended', { status: 'exited' }), inRepo('merged-s', { status: 'exited' })],
      false
    );
    expect(taskRows(list)).toEqual(['open']);
    expect(cards(list)).toEqual(['merged-s']);
  });

  it('several tasks of a project: te necesita first, counted with its sessions', async () => {
    taskStore.set([
      createTestTask({ id: 'later', state: 'scheduled' }),
      createTestTask({ id: 'busy', state: 'working', sessionId: 'task-s' }),
      createTestTask({ id: 'asks', state: 'needs_you' }),
    ]);
    const list = await sidebar([inRepo('task-s'), inRepo('loose')]);
    expect(list.querySelectorAll('.ut-side-group').length).toBe(1);
    expect(taskRows(list)).toEqual(['asks', 'busy', 'later']);
    expect(cards(list)).toEqual(['loose']);
    expect(headerCount(list)).toBe(4);
  });

  it('a project with only tasks has its own group, next to the others', async () => {
    taskStore.set([createTestTask({ id: 'other', state: 'queued', repoPath: '/repos/other' })]);
    const list = await sidebar([inRepo('loose')]);
    expect(
      [...list.querySelectorAll<HTMLElement>('.ut-side-group')]
        .map((g) => g.dataset.groupKey)
        .sort()
    ).toEqual(['/repos/app', '/repos/other']);
  });

  it('a task on an external model provider carries its badge', async () => {
    taskStore.set([createTestTask({ id: 'm', state: 'working', modelProvider: 'zai' })]);
    const list = await sidebar([]);
    expect(
      taskRow(list, 'm').querySelector('[data-testid="compact-task-provider-badge"]')
    ).not.toBeNull();
  });

  it('a parallel group keeps its heading and letters', async () => {
    taskStore.set([
      createTestTask({ id: 'a', groupId: 'g', groupIndex: 0, state: 'working' }),
      createTestTask({ id: 'b', groupId: 'g', groupIndex: 1, state: 'working' }),
    ]);
    const list = await sidebar([]);
    expect(list.querySelector('[data-testid="task-attempts"]')).not.toBeNull();
    expect(taskRow(list, 'b').querySelector('.tsk-prefix')?.textContent).toBe('B');
  });
});
