// @vitest-environment happy-dom
// 2026-11-10 (user request: fold the projects so they do not all show open): each project of the
// phone list and the
// sidebar folds from its header, shows what it holds in one line, and stays folded: the state
// is the server's (PUT /api/projects/collapsed-groups, GET /api/tasks `collapsedGroups`), so a
// reload, a server restart or another device show the same.
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import { createTestTask } from '@/test/utils/test-factories';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { taskStore } from '../services/task-store.js';
import { FOLDED_OTHERS } from '../utils/group-fold.js';
import type { ProjectGroupView } from './project-group.js';
import type { SessionList } from './session-list.js';

const ALPHA = '/Users/me/Projects/alpha';
const BETA = '/Users/me/Projects/beta';

const session = (id: string, repo: string | null, extra: Partial<Session> = {}) =>
  ({
    ...createMockSession({ id, name: id, status: 'running', command: ['claude'] }),
    ...(repo ? { gitRepoPath: repo, gitMainRepoPath: repo, gitBranch: 'main' } : {}),
    workingDir: repo ?? '/tmp/loose',
    startedAt: '2026-11-10T10:00:00.000Z',
    lastModified: '2026-11-10T10:00:00.000Z',
    ...extra,
  }) as Session;

const asking = (id: string, repo: string) =>
  session(id, repo, {
    claudeStatus: {
      status: 'waiting',
      waitingFor: 'permission prompt',
      since: Date.now() - 60_000,
    },
  } as Partial<Session>);

type Call = { url: string; method: string; body: { collapsed?: string[] } | undefined };

describe('folding projects', () => {
  let element: SessionList;
  let calls: Call[];
  /** What the server holds: the next poll of GET /api/tasks answers with it. */
  let server: { collapsed: string[]; tasks: TaskRecord[]; fail: boolean };

  beforeAll(async () => {
    await import('./session-list.js');
  });

  beforeEach(async () => {
    await setLocale('es');
    calls = [];
    server = { collapsed: [], tasks: [], fail: false };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        if (url.includes('/api/projects/collapsed-groups')) {
          if (server.fail) return Response.json({ error: 'no' }, { status: 500 });
          server.collapsed = body.collapsed;
          return Response.json({ collapsed: body.collapsed });
        }
        if (url.includes('/api/tasks')) {
          return Response.json({ tasks: server.tasks, collapsedGroups: server.collapsed });
        }
        if (url.includes('/api/sessions')) return Response.json([]);
        return Response.json({});
      })
    );
  });

  afterEach(async () => {
    element?.remove();
    for (const toast of document.body.querySelectorAll('.ut-toast-stack')) toast.remove();
    taskStore.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await setLocale('en');
  });

  async function mount(layout: 'phone' | 'sidebar', sessions: Session[]) {
    element = await fixture<SessionList>(html`<session-list
      .authClient=${{ getAuthHeader: () => ({}) } as unknown as AuthClient}
    ></session-list>`);
    vi.spyOn(element as unknown as { usePhoneRows: () => boolean }, 'usePhoneRows').mockReturnValue(
      layout === 'phone'
    );
    element.compactMode = layout === 'sidebar';
    element.sessions = sessions;
    await settle();
    return element;
  }

  /** The list and its phone projects (which render on their own update). */
  async function settle() {
    await element.updateComplete;
    await Promise.all(
      [...element.querySelectorAll<ProjectGroupView>('project-group')].map(
        (group) => group.updateComplete
      )
    );
  }

  const saves = () =>
    calls
      .filter((call) => call.url.includes('/api/projects/collapsed-groups'))
      .map((call) => [call.method, call.body]);
  const text = (el: Element | null | undefined) =>
    el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  describe('the sidebar', () => {
    const group = (key: string) =>
      element.querySelector<HTMLElement>(`[data-group-key="${key}"]`) as HTMLElement;
    const toggle = (key: string) =>
      group(key).querySelector<HTMLButtonElement>(
        '[data-testid="project-fold"]'
      ) as HTMLButtonElement;
    const cards = (key: string) => group(key).querySelectorAll('compact-session-card').length;

    it('a click on a project’s name folds it: its rows go, one line says what it holds, the server keeps it', async () => {
      await mount('sidebar', [session('a1', ALPHA), asking('a2', ALPHA), session('b1', BETA)]);
      expect(cards(ALPHA)).toBe(2);
      expect(toggle(ALPHA).getAttribute('aria-expanded')).toBe('true');

      toggle(ALPHA).click();
      await vi.waitFor(async () => {
        await settle();
        expect(cards(ALPHA)).toBe(0);
      });
      expect(toggle(ALPHA).getAttribute('aria-expanded')).toBe('false');
      // What waits for the user is said first, in its own element (its colour).
      expect(text(group(ALPHA).querySelector('[data-testid="project-fold-summary"]'))).toBe(
        '1 te necesita · 2 sesiones'
      );
      expect(text(group(ALPHA).querySelector('[data-testid="fold-needs"]'))).toBe('1 te necesita');
      // The other project stays open, and the line between the two has its group to hang from.
      expect(cards(BETA)).toBe(1);
      expect(group(BETA).previousElementSibling).toBe(group(ALPHA));
      await vi.waitFor(() => expect(saves()).toEqual([['PUT', { collapsed: [ALPHA] }]]));
      expect(taskStore.collapsedGroups).toEqual([ALPHA]);

      // Its actions still work folded, and never open it.
      group(ALPHA).querySelector<HTMLElement>('[data-testid="project-new-task"]')?.click();
      await settle();
      expect(cards(ALPHA)).toBe(0);
      expect(saves()).toHaveLength(1);

      // The same button opens it again; so does the line.
      toggle(ALPHA).click();
      await vi.waitFor(async () => {
        await settle();
        expect(cards(ALPHA)).toBe(2);
      });
      await vi.waitFor(() => expect(taskStore.collapsedGroups).toEqual([]));
      toggle(ALPHA).click();
      await vi.waitFor(async () => {
        await settle();
        expect(cards(ALPHA)).toBe(0);
      });
      group(ALPHA).querySelector<HTMLElement>('[data-testid="project-fold-summary"]')?.click();
      await vi.waitFor(async () => {
        await settle();
        expect(cards(ALPHA)).toBe(2);
      });
      await vi.waitFor(() => expect(server.collapsed).toEqual([]));
    });

    it('remembers what was folded: after a reload the server says it, "Otras" too', async () => {
      server.collapsed = [BETA, FOLDED_OTHERS];
      await mount('sidebar', [session('a1', ALPHA), session('b1', BETA), session('x1', null)]);
      // A new page: nothing in the browser, the first poll brings it.
      await taskStore.refresh();
      await settle();
      expect(cards(ALPHA)).toBe(1);
      expect(cards(BETA)).toBe(0);
      expect(toggle(BETA).getAttribute('aria-expanded')).toBe('false');
      expect(cards('')).toBe(0);
      expect(toggle('').getAttribute('aria-expanded')).toBe('false');
      expect(text(group('').querySelector('[data-testid="project-fold-summary"]'))).toBe(
        '1 sesión'
      );
      expect(saves()).toEqual([]);
    });

    it('a save that fails opens it again and says so', async () => {
      server.fail = true;
      await mount('sidebar', [session('a1', ALPHA), session('b1', BETA)]);
      toggle(ALPHA).click();
      await vi.waitFor(() =>
        expect(text(document.body.querySelector('.ut-toast-stack'))).toContain(
          'No se pudo guardar qué proyectos están plegados'
        )
      );
      await settle();
      expect(cards(ALPHA)).toBe(1);
      expect(taskStore.collapsedGroups).toEqual([]);
    });
  });

  describe('the phone list', () => {
    const project = (key: string) =>
      element.querySelector<HTMLElement>(
        `[data-testid="project-group"][data-project="${key}"]`
      ) as HTMLElement;
    const toggle = (key: string) =>
      project(key).querySelector<HTMLButtonElement>(
        '[data-testid="project-fold"]'
      ) as HTMLButtonElement;
    const rows = (key: string) =>
      project(key).querySelectorAll('[data-testid="phone-session-row"], task-row').length;

    it('the chevron folds a project and the «Te necesita» section stays as it was', async () => {
      server.tasks = [
        createTestTask({ id: 'q1', state: 'queued', repoPath: ALPHA, workingDir: ALPHA }),
        createTestTask({ id: 'q2', state: 'queued', repoPath: ALPHA, workingDir: ALPHA }),
      ];
      await mount('phone', [session('a1', ALPHA), asking('a2', ALPHA), session('b1', BETA)]);
      await taskStore.refresh();
      await settle();
      expect(rows(ALPHA)).toBe(4);
      const needs = () =>
        [...element.querySelectorAll('[data-testid="needs-you-strip"] [data-key]')].map((el) =>
          el.getAttribute('data-key')
        );
      const before = needs();
      expect(before).toEqual(['session:a2']);

      toggle(ALPHA).click();
      await vi.waitFor(async () => {
        await settle();
        expect(rows(ALPHA)).toBe(0);
      });
      expect(toggle(ALPHA).getAttribute('aria-expanded')).toBe('false');
      expect(text(project(ALPHA).querySelector('[data-testid="project-fold-summary"]'))).toBe(
        '1 te necesita · 2 sesiones · 2 tareas · 2 en cola'
      );
      expect(needs()).toEqual(before);
      expect(rows(BETA)).toBe(1);
      // The header keeps its buttons.
      for (const id of ['project-menu', 'project-orchestrate', 'project-new-task']) {
        expect(project(ALPHA).querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
      }
      await vi.waitFor(() => expect(saves()).toEqual([['PUT', { collapsed: [ALPHA] }]]));

      // The next poll (or another device's) agrees: it stays folded.
      await taskStore.refresh();
      await settle();
      expect(rows(ALPHA)).toBe(0);
    });

    // A folded project never hides what waits for the user: the section above still lists it,
    // and «Abrir» there opens the project to show its row.
    it('«Te necesita» reaches a task inside a folded project: the project opens', async () => {
      server.collapsed = [ALPHA];
      server.tasks = [
        createTestTask({
          id: 'stuck',
          state: 'needs_you',
          repoPath: ALPHA,
          workingDir: ALPHA,
          blocker: { kind: 'conflict', message: 'x' },
        }),
      ];
      await mount('phone', [session('a1', ALPHA), session('b1', BETA)]);
      await taskStore.refresh();
      await settle();
      expect(rows(ALPHA)).toBe(0);
      expect(text(project(ALPHA).querySelector('[data-testid="fold-needs"]'))).toBe(
        '1 te necesita'
      );
      const item = element.querySelector<HTMLElement>(
        '[data-testid="needs-you-strip"] [data-key="task:stuck"] .ut-needs-main'
      );
      expect(item).not.toBeNull();
      item?.click();
      await vi.waitFor(async () => {
        await settle();
        expect(project(ALPHA).querySelector('task-row[data-task="stuck"]')).not.toBeNull();
      });
      await vi.waitFor(() => expect(server.collapsed).toEqual([]));
    });

    it('remembers what was folded after a reload', async () => {
      server.collapsed = [ALPHA];
      await mount('phone', [session('a1', ALPHA), session('b1', BETA)]);
      await taskStore.refresh();
      await settle();
      expect(rows(ALPHA)).toBe(0);
      expect(rows(BETA)).toBe(1);
      expect(text(project(ALPHA).querySelector('[data-testid="project-fold-summary"]'))).toBe(
        '1 sesión'
      );
    });
  });
});
