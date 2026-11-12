// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createTestSession, createTestTask as task } from '@/test/utils/test-factories';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import type { ProjectNotice } from '../services/task-store.js';
import type { ProjectGroup } from '../utils/project-groups.js';
import './project-group.js';
import type { ProjectGroupView } from './project-group.js';

describe('project-group', () => {
  beforeEach(async () => {
    await setLocale('es');
  });
  afterEach(async () => {
    fixtureCleanup();
    await setLocale('en');
  });

  const loose = createTestSession({ id: 'loose' });
  const taskSession = createTestSession({ id: 'ts' });

  async function mount(
    group: ProjectGroup,
    options: { name?: string; headless?: boolean; orchestrator?: string | null } = {}
  ) {
    const el = await fixture<ProjectGroupView>(
      html`<project-group
        .group=${group}
        .name=${options.name ?? 'app'}
        .branch=${'main'}
        .headless=${options.headless ?? false}
        .orchestratorSessionId=${options.orchestrator ?? null}
        .sessionsById=${new Map<string, Session>([
          ['loose', loose],
          ['ts', taskSession],
        ])}
        .renderSession=${(session: Session) =>
          html`<div class="fake-row" data-id=${session.id}></div>`}
      ></project-group>`
    );
    await el.updateComplete;
    return el;
  }

  // 2026-11-10: a real iPhone read "UNT…" beside "Orquestador" and "+ Tarea" in full.
  it('keeps a long name whole in the DOM, in two parts so that it is cut in the middle', async () => {
    const el = await mount(
      { key: '/repos/ia', tasks: [], sessions: [loose], needsYou: false },
      { name: 'ia-soberana-espana' }
    );
    const name = el.querySelector('.prj-name') as HTMLElement;
    expect(name.textContent).toBe('ia-soberana-espana');
    expect(name.getAttribute('title')).toBe('ia-soberana-espana');
    expect(name.querySelector('.prj-name-start')?.textContent).toBe('ia-soberana-es');
    expect(name.querySelector('.prj-name-end')?.textContent).toBe('pana');
    // Counted as a reader does: an emoji is one letter, never half of one.
    const emoji = await mount(
      { key: '/repos/mi-huerto-🌱🌿🍅🥕', tasks: [], sessions: [loose], needsYou: false },
      { name: 'mi-huerto-🌱🌿🍅🥕' }
    );
    expect(emoji.querySelector('.prj-name-start')?.textContent).toBe('mi-huerto-');
    expect(emoji.querySelector('.prj-name-end')?.textContent).toBe('🌱🌿🍅🥕');
    // A short name has nothing to give: one part, never cut.
    const short = await mount({ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false });
    expect(short.querySelector('.prj-name-start')).toBeNull();
    expect(short.querySelector('.prj-name-end')?.textContent).toBe('app');
  });

  it('lays the header out as name, branch and actions, measured and never by screen width', async () => {
    const el = await mount({ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false });
    const header = el.querySelector('[data-testid="project-header"]') as HTMLElement;
    // The branch and the actions are the title's siblings: each gives way on its own.
    expect([...header.children].map((child) => child.className.split(' ').pop())).toEqual([
      'prj-title',
      'prj-branch',
      'prj-tools',
    ]);
    expect(header.querySelector('.prj-title [data-testid="project-branch"]')).toBeNull();
    // Measured after rendering (no layout here: everything fits, nothing gives way).
    expect(header.dataset.squeeze).toBe('0');
    // The words leave the screen, never the button's name.
    for (const id of ['project-orchestrate', 'project-new-task']) {
      expect(header.querySelector(`[data-testid="${id}"]`)?.getAttribute('aria-label')).toMatch(
        /app/
      );
    }
    expect(header.querySelector('[data-testid="project-orchestrate"]')?.getAttribute('title')).toBe(
      'Orquestar'
    );
  });

  it('measures the header again when the page changes its style', async () => {
    // 2026-11-10: a header measured before the style arrived kept that measure, since a style
    // that only moves a margin resizes no box.
    const el = await mount({ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false });
    const header = el.querySelector('[data-testid="project-header"]') as HTMLElement;
    header.dataset.squeeze = '3';
    document.documentElement.setAttribute('data-look', 'dark-premium');
    await vi.waitFor(() => expect(header.dataset.squeeze).toBe('0'));
    document.documentElement.removeAttribute('data-look');
  });

  it('does not measure the headers when only --app-height changes', async () => {
    // 2026-11-10: the style watch heard every `style` rewrite (--app-height moves on each
    // viewport resize and scroll) and measured every header with a synchronous layout.
    const el = await mount({ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false });
    const fit = vi.spyOn(el, 'fitHeader');
    document.documentElement.style.setProperty('--app-height', '700px');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fit).not.toHaveBeenCalled();
    // The system text size does change the boxes.
    document.documentElement.style.setProperty('--ut-root-text', '20px');
    await vi.waitFor(() => expect(fit).toHaveBeenCalled());
    document.documentElement.style.removeProperty('--app-height');
    document.documentElement.style.removeProperty('--ut-root-text');
  });

  it('observes its header again after being disconnected and reconnected', async () => {
    // 2026-11-10: repeat() moves nodes; the new observer watched nothing and the squeeze was
    // never measured again on rotation.
    const watched: Element[][] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        seen: Element[] = [];
        constructor() {
          watched.push(this.seen);
        }
        observe(target: Element) {
          this.seen.push(target);
        }
        disconnect() {}
      }
    );
    try {
      const el = await mount({ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false });
      const parent = el.parentElement as HTMLElement;
      el.remove();
      parent.append(el);
      await el.updateComplete;
      const last = watched[watched.length - 1];
      expect(last.some((node) => node.classList.contains('prj-head'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('heads the project with its name, base branch, "+ Tarea" and the gear', async () => {
    const el = await mount({ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false });
    const header = el.querySelector('[data-testid="project-header"]') as HTMLElement;
    expect(header.querySelector('.prj-name')?.textContent).toBe('app');
    expect(header.querySelector('[data-testid="project-branch"]')?.textContent?.trim()).toBe(
      'main'
    );
    expect(header.querySelector('[data-testid="project-new-task"]')?.textContent?.trim()).toBe(
      'Tarea'
    );
    expect(
      header.querySelector('[data-testid="project-settings"]')?.getAttribute('aria-label')
    ).toBe('Ajustes de las tareas de app');
  });

  it('"+ Tarea" and the gear name the project', async () => {
    const el = await mount({ key: '/repos/app', tasks: [], sessions: [], needsYou: false });
    const newTask = vi.fn();
    const settings = vi.fn();
    el.addEventListener('project-new-task', newTask);
    el.addEventListener('project-settings', settings);
    el.querySelector<HTMLButtonElement>('[data-testid="project-new-task"]')?.click();
    el.querySelector<HTMLButtonElement>('[data-testid="project-settings"]')?.click();
    expect((newTask.mock.calls[0][0] as CustomEvent).detail).toEqual({
      repoPath: '/repos/app',
      name: 'app',
    });
    expect((settings.mock.calls[0][0] as CustomEvent).detail.repoPath).toBe('/repos/app');
  });

  it('lists its tasks first (with their sessions), then its other sessions', async () => {
    const el = await mount({
      key: '/repos/app',
      tasks: [task({ id: 't1', sessionId: 'ts', state: 'needs_you' }), task({ id: 't2' })],
      sessions: [loose],
      needsYou: true,
    });
    const list = el.querySelector('[data-testid="phone-session-list"]') as HTMLElement;
    const kinds = [...list.children].map((child) =>
      child.localName === 'task-row' ? (child as HTMLElement).dataset.task : child.className
    );
    expect(kinds).toEqual(['t1', 't2', 'fake-row']);
    const first = list.querySelector('task-row') as HTMLElement & { session?: Session };
    expect(first.session).toBe(taskSession);
  });

  it('"Otras" has no task buttons, and a lone group can go without a header', async () => {
    const others = await mount(
      { key: null, tasks: [], sessions: [loose], needsYou: false },
      { name: 'Otras' }
    );
    expect(others.querySelector('.prj-name')?.textContent).toBe('Otras');
    expect(others.querySelector('[data-testid="project-new-task"]')).toBeNull();
    fixtureCleanup();
    const headless = await mount(
      { key: null, tasks: [], sessions: [loose], needsYou: false },
      { headless: true }
    );
    expect(headless.querySelector('[data-testid="project-header"]')).toBeNull();
    expect(headless.querySelector('.fake-row')).not.toBeNull();
  });

  it('a folder without git offers "+ Tarea" and "Orquestar" (no branch, no gear)', async () => {
    const el = await mount(
      {
        key: '/Users/n/Projects/tele',
        folder: true,
        tasks: [],
        sessions: [loose],
        needsYou: false,
      },
      { name: 'tele' }
    );
    expect(el.querySelector('[data-testid="project-branch"]')).toBeNull();
    expect(el.querySelector('[data-testid="project-settings"]')).toBeNull();
    const newTask = vi.fn();
    const orchestrate = vi.fn();
    el.addEventListener('project-new-task', newTask);
    el.addEventListener('project-orchestrate', orchestrate);
    el.querySelector<HTMLButtonElement>('[data-testid="project-new-task"]')?.click();
    el.querySelector<HTMLButtonElement>('[data-testid="project-orchestrate"]')?.click();
    expect((newTask.mock.calls[0][0] as CustomEvent).detail).toEqual({
      repoPath: '/Users/n/Projects/tele',
      name: 'tele',
      folder: true,
    });
    expect((orchestrate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      repoPath: '/Users/n/Projects/tele',
      name: 'tele',
      folder: true,
      sessionId: null,
    });
  });

  it('shows a parallel group as one card, attempts lettered, each able to be kept', async () => {
    const el = await mount({
      key: '/repos/app',
      tasks: [
        task({
          id: 'a',
          groupId: 'g',
          groupIndex: 0,
          state: 'ready',
          stats: { commits: 1, files: 2, insertions: 5, deletions: 1 },
        }),
        task({ id: 'b', groupId: 'g', groupIndex: 1, state: 'ready' }),
      ],
      sessions: [],
      needsYou: false,
    });
    const card = el.querySelector('[data-testid="task-attempts"]') as HTMLElement;
    expect(card.querySelector('.tsk-attempts-head')?.textContent).toContain('2 intentos');
    const rows = [...card.querySelectorAll('task-row')] as Array<
      HTMLElement & { updateComplete: Promise<unknown> }
    >;
    await Promise.all(rows.map((row) => row.updateComplete));
    expect(rows.map((row) => row.querySelector('.tsk-prefix')?.textContent)).toEqual(['A', 'B']);
    expect(rows[0].querySelector('[data-action="keep"]')?.textContent?.trim()).toBe(
      'Quedarme con este'
    );
    expect(rows[0].querySelector('[data-action="merge"]')).toBeNull();
    // Its branch and counts behind «Más» (2026-11-08).
    (rows[0].querySelector('[data-testid="task-more-toggle"]') as HTMLButtonElement).click();
    await (rows[0] as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    expect(rows[0].querySelector('[data-testid="task-caption"]')?.textContent).toContain(
      '2 archivos · +5 −1'
    );
  });

  it('keys attempt rows by task: dropping the first keeps the next one’s own row', async () => {
    const a = task({ id: 'a', groupId: 'g', groupIndex: 0, state: 'ready' });
    const b = task({ id: 'b', groupId: 'g', groupIndex: 1, state: 'ready' });
    const c = task({ id: 'c', groupId: 'g', groupIndex: 2, state: 'ready' });
    const el = await mount({ key: '/repos/app', tasks: [a, b, c], sessions: [], needsYou: false });
    const before = el.querySelector('task-row[data-task="b"]');
    el.group = { key: '/repos/app', tasks: [b, c], sessions: [], needsYou: false };
    el.stamp = 'next';
    await el.updateComplete;
    expect(el.querySelector('task-row[data-task="b"]')).toBe(before);
  });

  // P7 (2026-10-18): one orchestrator per project.
  it('"Orquestar" opens the goal sheet for the project', async () => {
    const el = await mount({ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false });
    const button = el.querySelector<HTMLButtonElement>('[data-testid="project-orchestrate"]');
    expect(button?.textContent?.trim()).toBe('Orquestar');
    expect(button?.getAttribute('aria-label')).toBe('Orquestar app');
    const orchestrate = vi.fn();
    el.addEventListener('project-orchestrate', orchestrate);
    button?.click();
    expect((orchestrate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      repoPath: '/repos/app',
      name: 'app',
      sessionId: null,
    });
    expect(el.querySelector('[data-testid="project-orchestrator-row"]')).toBeNull();
    // "Otras" has no orchestrator.
    const others = await mount({ key: null, tasks: [], sessions: [loose], needsYou: false });
    expect(others.querySelector('[data-testid="project-orchestrate"]')).toBeNull();
  });

  it("pins the running orchestrator's session on top with its badge", async () => {
    const orch = createTestSession({ id: 'orch' });
    const el = await mount(
      {
        key: '/repos/app',
        tasks: [task({ id: 't1', sessionId: 'ts', state: 'working' })],
        sessions: [loose, orch],
        needsYou: false,
      },
      { orchestrator: 'orch' }
    );
    const list = el.querySelector('[data-testid="phone-session-list"]') as HTMLElement;
    const first = list.firstElementChild as HTMLElement;
    expect(first.dataset.testid).toBe('project-orchestrator-row');
    expect(
      first.querySelector('[data-testid="project-orchestrator-badge"]')?.textContent?.trim()
    ).toBe('Orquestador');
    expect(first.querySelector('.fake-row')?.getAttribute('data-id')).toBe('orch');
    // Shown once: not again among the loose sessions.
    expect(
      [...list.querySelectorAll('.fake-row')].map((row) => row.getAttribute('data-id'))
    ).toEqual(['orch', 'loose']);
    const button = el.querySelector<HTMLButtonElement>('[data-testid="project-orchestrate"]');
    expect(button?.classList.contains('running')).toBe(true);
    expect(button?.textContent?.trim()).toBe('Orquestador');
    const orchestrate = vi.fn();
    el.addEventListener('project-orchestrate', orchestrate);
    button?.click();
    expect((orchestrate.mock.calls[0][0] as CustomEvent).detail.sessionId).toBe('orch');
  });

  it('shows no pinned row when the orchestrator session has ended', async () => {
    const ended = createTestSession({ id: 'orch', status: 'exited' });
    const el = await mount(
      { key: '/repos/app', tasks: [], sessions: [ended], needsYou: false },
      { orchestrator: 'orch' }
    );
    expect(el.querySelector('[data-testid="project-orchestrator-row"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="project-orchestrate"]')?.classList.contains('running')
    ).toBe(false);
  });
  async function mountNotice(notice: ProjectNotice, extra: { pending?: boolean } = {}) {
    const el = await fixture<ProjectGroupView>(
      html`<project-group
        .group=${{ key: '/repos/app', tasks: [], sessions: [loose], needsYou: false }}
        .name=${'app'}
        .branch=${'main'}
        .notice=${notice}
        .orchestratorSessionId=${extra.pending ? 'loose' : null}
        .orchestratorPending=${extra.pending ?? false}
        .sessionsById=${new Map<string, Session>([['loose', loose]])}
        .renderSession=${(session: Session) =>
          html`<div class="fake-row" data-id=${session.id}></div>`}
      ></project-group>`
    );
    await el.updateComplete;
    return el;
  }

  it('a project whose folder is gone says so and offers only Olvidar', async () => {
    const el = await mountNotice({ repoPath: '/repos/app', missingSince: '2026-10-20T10:00:00Z' });
    expect(el.querySelector('[data-testid="project-missing"]')?.textContent?.trim()).toBe(
      'Carpeta no encontrada'
    );
    expect(el.querySelector('[data-testid="project-new-task"]')).toBeNull();
    expect(el.querySelector('[data-testid="project-orchestrate"]')).toBeNull();
    // Laid out to wrap on a 320 px phone (list.css): the header and its tools say it is missing.
    expect(el.querySelector('[data-testid="project-header"]')?.classList).toContain(
      'prj-head--missing'
    );
    expect(el.querySelector('.prj-tools')?.classList).toContain('prj-tools--missing');
    const forget = vi.fn();
    el.addEventListener('project-forget', forget);
    el.querySelector<HTMLButtonElement>('[data-testid="project-forget"]')?.click();
    expect(forget).toHaveBeenCalledTimes(1);
    expect((forget.mock.calls[0][0] as CustomEvent).detail.repoPath).toBe('/repos/app');
  });

  it('a moved project says where it was, for a few days', async () => {
    const recent = await mountNotice({
      repoPath: '/repos/app',
      movedFrom: '/old/skylark',
      movedAt: new Date().toISOString(),
    });
    expect(recent.querySelector('[data-testid="project-moved"]')?.textContent?.trim()).toBe(
      'antes «skylark»'
    );
    fixtureCleanup();
    const old = await mountNotice({
      repoPath: '/repos/app',
      movedFrom: '/old/skylark',
      movedAt: new Date(Date.now() - 10 * 24 * 3600_000).toISOString(),
    });
    expect(old.querySelector('[data-testid="project-moved"]')).toBeNull();
  });

  it('paused automatic merges show a calm line with Reactivar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Also when an assertion in between fails: the next test gets the real clock.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date(2026, 9, 20, 12, 0));
    const el = await mountNotice({
      repoPath: '/repos/app',
      autoMergePausedUntil: new Date(2026, 9, 20, 14, 5).toISOString(),
      autoMergePausedReason: 'Two of its tasks that merged on their own were undone',
      autoMergePausedCode: 'reverts',
      autoMergePausedCount: 2,
    });
    const banner = el.querySelector('[data-testid="project-merge-paused"]');
    // The reason in Spanish from the code and count, never the server's English.
    expect(banner?.textContent?.replace(/\s+/g, ' ')).toContain(
      'Fusión automática en pausa hasta las 14:05: se deshicieron 2 tareas que se habían fusionado solas en las últimas 24 horas'
    );
    expect(banner?.textContent).not.toContain('merged on their own');
    const resume = vi.fn();
    el.addEventListener('project-resume-merges', resume);
    el.querySelector<HTMLButtonElement>('[data-testid="project-resume-merges"]')?.click();
    expect(resume).toHaveBeenCalledTimes(1);
    // While its request is on its way the button waits: no second request.
    el.resuming = true;
    await el.updateComplete;
    const busy = el.querySelector<HTMLButtonElement>('[data-testid="project-resume-merges"]');
    expect(busy?.disabled).toBe(true);
    expect(busy?.getAttribute('aria-busy')).toBe('true');
    busy?.click();
    expect(resume).toHaveBeenCalledTimes(1);
    fixtureCleanup();
    // Ending another day: «mañana a las …»; an unknown code: the generic reason.
    const tomorrow = await mountNotice({
      repoPath: '/repos/app',
      autoMergePausedUntil: new Date(2026, 9, 21, 9, 30).toISOString(),
      autoMergePausedCode: 'something-new',
    });
    expect(
      tomorrow
        .querySelector('[data-testid="project-merge-paused"]')
        ?.textContent?.replace(/\s+/g, ' ')
    ).toContain('hasta mañana a las 09:30: demasiados problemas últimamente');
    vi.useRealTimers();
    fixtureCleanup();
    const over = await mountNotice({
      repoPath: '/repos/app',
      autoMergePausedUntil: new Date(Date.now() - 1000).toISOString(),
    });
    expect(over.querySelector('[data-testid="project-merge-paused"]')).toBeNull();
  });

  it('an orchestrator whose brief is queued reads «Preparando…»', async () => {
    const el = await mountNotice({ repoPath: '/repos/app' }, { pending: true });
    expect(
      el.querySelector('[data-testid="project-orchestrator-badge"]')?.textContent?.trim()
    ).toBe('Preparando…');
    expect(
      el.querySelector('[data-testid="project-orchestrate"]')?.getAttribute('data-pending')
    ).toBe('true');
  });

  // 2026-11-10, user request: fold the projects so they do not all show open.
  describe('folded', () => {
    const group: ProjectGroup = {
      key: '/repos/app',
      tasks: [task({ id: 't1', sessionId: 'ts' })],
      sessions: [loose],
      needsYou: true,
    };
    const summary = { sessions: 3, tasks: 1, needsYou: 1, queued: 2 };

    async function mountFold(
      options: {
        collapsed?: boolean;
        group?: ProjectGroup;
        headless?: boolean;
        locked?: boolean;
        summary?: typeof summary;
      } = {}
    ) {
      const el = await fixture<ProjectGroupView>(
        html`<project-group
          .group=${options.group ?? group}
          .name=${'app'}
          .branch=${'main'}
          .headless=${options.headless ?? false}
          .collapsed=${options.collapsed ?? false}
          .foldLocked=${options.locked ?? false}
          .summary=${options.summary ?? summary}
          .sessionsById=${new Map<string, Session>([
            ['loose', loose],
            ['ts', taskSession],
          ])}
          .renderSession=${(session: Session) =>
            html`<div class="fake-row" data-id=${session.id}></div>`}
        ></project-group>`
      );
      await el.updateComplete;
      return el;
    }
    const toggle = (el: Element) =>
      el.querySelector<HTMLButtonElement>('[data-testid="project-fold"]') as HTMLButtonElement;
    const rows = (el: Element) => el.querySelectorAll('.fake-row, task-row').length;
    const line = (el: Element) =>
      el
        .querySelector('[data-testid="project-fold-summary"]')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim();

    it('an open project has a button that says so and points at its rows', async () => {
      const el = await mountFold();
      const button = toggle(el);
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe('Plegar app');
      expect(el.querySelector(`#${button.getAttribute('aria-controls')}`)).toBe(
        el.querySelector('[data-testid="phone-session-list"]')
      );
      expect(rows(el)).toBe(2);
      expect(el.querySelector('[data-testid="project-fold-summary"]')).toBeNull();
      expect(el.querySelector('.prj')?.getAttribute('data-folded')).toBe('false');
    });

    it('folded, only the header and one line show: what waits for the user first, in its own element', async () => {
      const el = await mountFold({ collapsed: true });
      const button = toggle(el);
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-label')).toBe('Desplegar app');
      expect(rows(el)).toBe(0);
      expect(el.querySelector('[data-testid="phone-session-list"]')).toBeNull();
      expect(line(el)).toBe('1 te necesita · 3 sesiones · 1 tarea · 2 en cola');
      expect(el.querySelector('[data-testid="fold-needs"]')?.textContent).toBe('1 te necesita');
      expect(el.querySelector(`#${button.getAttribute('aria-controls')}`)).toBe(
        el.querySelector('[data-testid="project-fold-summary"]')
      );
      // The header and its actions stay as they are.
      for (const id of [
        'project-menu',
        'project-orchestrate',
        'project-new-task',
        'project-settings',
      ]) {
        expect(el.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
      }
      expect(el.querySelector('.prj')?.getAttribute('data-folded')).toBe('true');
    });

    it('the line names only what there is, each in the language’s own number', async () => {
      const quiet = await mountFold({
        collapsed: true,
        summary: { sessions: 1, tasks: 0, needsYou: 0, queued: 0 },
      });
      expect(line(quiet)).toBe('1 sesión');
      expect(quiet.querySelector('[data-testid="fold-needs"]')).toBeNull();
      const waiting = await mountFold({
        collapsed: true,
        summary: { sessions: 0, tasks: 2, needsYou: 2, queued: 0 },
      });
      expect(line(waiting)).toBe('2 te necesitan · 2 tareas');
      const empty = await mountFold({
        collapsed: true,
        summary: { sessions: 0, tasks: 0, needsYou: 0, queued: 0 },
      });
      expect(line(empty)).toBe('Vacío');
    });

    it('the chevron and the folded line ask to fold or open; the other buttons never do', async () => {
      const el = await mountFold();
      const asked = vi.fn();
      el.addEventListener('project-fold', asked);
      // The keyboard's Enter or Space is the button's click.
      toggle(el).click();
      expect(asked.mock.calls[0][0].detail).toEqual({
        repoPath: '/repos/app',
        name: 'app',
        collapsed: true,
      });
      for (const id of [
        'project-menu',
        'project-orchestrate',
        'project-new-task',
        'project-settings',
      ]) {
        el.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
      }
      expect(asked).toHaveBeenCalledTimes(1);

      const folded = await mountFold({ collapsed: true });
      const opened = vi.fn();
      folded.addEventListener('project-fold', opened);
      toggle(folded).click();
      folded.querySelector<HTMLElement>('[data-testid="project-fold-summary"]')?.click();
      expect(opened.mock.calls.map(([event]) => event.detail.collapsed)).toEqual([false, false]);
    });

    it('"Otras" folds too; a list without header never does', async () => {
      const others: ProjectGroup = { key: null, tasks: [], sessions: [loose], needsYou: false };
      const el = await mountFold({ group: others, collapsed: true });
      expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
      expect(rows(el)).toBe(0);
      const asked = vi.fn();
      el.addEventListener('project-fold', asked);
      toggle(el).click();
      expect(asked.mock.calls[0][0].detail).toMatchObject({ repoPath: null, collapsed: false });
      // Nothing to open it again with: its rows show.
      const headless = await mountFold({ group: others, collapsed: true, headless: true });
      expect(headless.querySelector('[data-testid="project-fold"]')).toBeNull();
      expect(rows(headless)).toBe(1);
    });

    it('a search shows a folded project open, and its chevron waits', async () => {
      const el = await mountFold({ collapsed: true, locked: true });
      expect(rows(el)).toBe(2);
      expect(toggle(el).disabled).toBe(true);
      expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
      const asked = vi.fn();
      el.addEventListener('project-fold', asked);
      toggle(el).click();
      expect(asked).not.toHaveBeenCalled();
    });

    it('rows opened by a tap come in with the short motion; rows there from the start do not', async () => {
      const el = await mountFold({ collapsed: true });
      el.collapsed = false;
      await el.updateComplete;
      expect(
        el.querySelector('[data-testid="phone-session-list"]')?.classList.contains('ut-fold-in')
      ).toBe(true);
      const open = await mountFold();
      expect(
        open.querySelector('[data-testid="phone-session-list"]')?.classList.contains('ut-fold-in')
      ).toBe(false);
    });

    it('a pinned project keeps its pin beside the chevron', async () => {
      const el = await mountFold({ group: { ...group, pinned: true } });
      expect(
        el.querySelector('[data-testid="project-menu"] [data-testid="project-pin-mark"] svg')
      ).not.toBeNull();
      expect((await mountFold()).querySelector('[data-testid="project-pin-mark"]')).toBeNull();
    });
  });
});
