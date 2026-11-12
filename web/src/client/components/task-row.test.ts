// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createTestSession, createTestTask as task } from '@/test/utils/test-factories';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import type { TaskStore } from '../services/task-store.js';

const { confirmDialog, toast } = vi.hoisted(() => ({
  confirmDialog: vi.fn(async () => true),
  toast: vi.fn(() => () => {}),
}));
vi.mock('../utils/confirm-dialog.js', () => ({ confirmDialog }));
vi.mock('../utils/action-toast.js', () => ({ toast }));

import { lazyViews } from '../utils/lazy-views.js';
import './task-row.js';
import { taskErrorText } from '../utils/task-status.js';
import type { TaskRow } from './task-row.js';

describe('task-row', () => {
  let store: { act: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    await setLocale('es');
    store = {
      act: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
      cancel: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
    };
    confirmDialog.mockClear();
    confirmDialog.mockResolvedValue(true);
    toast.mockClear();
  });

  afterEach(async () => {
    fixtureCleanup();
    vi.restoreAllMocks();
    await setLocale('en');
  });

  async function mount(record: TaskRecord, session?: Session, attempts = 0) {
    const row = await fixture<TaskRow>(
      html`<task-row
        .task=${record}
        .session=${session}
        .attempts=${attempts}
        .store=${store as unknown as TaskStore}
      ></task-row>`
    );
    await row.updateComplete;
    return row;
  }

  /** «Más»: everything past the card's one line (2026-11-08). */
  const more = async (row: TaskRow) => {
    (row.querySelector('[data-testid="task-more-toggle"]') as HTMLButtonElement).click();
    await row.updateComplete;
  };

  const button = (row: TaskRow, action: string) =>
    row.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);

  it('a long title keeps what tells it apart: two lines on a card, its end on a one-line row', async () => {
    // 2026-11-10: three queued tasks of one project read the same on a phone.
    const name = 'Revisión 2ª vuelta: arreglos claros de agentes e infraestructura';
    for (const variant of ['row', 'card', 'done'] as const) {
      const row = await mount(task({ name, state: variant === 'done' ? 'merged' : 'queued' }));
      row.variant = variant;
      await row.updateComplete;
      const title = row.querySelector('.psr-title') as HTMLElement;
      expect(title.classList.contains('ut-title-lines'), variant).toBe(true);
      expect(title.textContent?.trim()).toBe(name);
      // Its end apart, for the second line when two lines still cut it.
      expect(title.querySelector('.ut-mid-end')?.textContent, variant).toBe(' e infraestructura');
      expect(title.hasAttribute('data-cut'), variant).toBe(false);
      Object.defineProperty(title, 'scrollHeight', { value: 60, configurable: true });
      Object.defineProperty(title, 'clientHeight', { value: 40, configurable: true });
      row.requestUpdate();
      await row.updateComplete;
      expect(title.hasAttribute('data-cut'), variant).toBe(true);
    }
    const side = await mount(task({ name, state: 'queued' }));
    side.variant = 'side';
    await side.updateComplete;
    const title = side.querySelector('.ut-side-name') as HTMLElement;
    expect(title.classList.contains('ut-mid')).toBe(true);
    expect(title.querySelector('.ut-mid-start')?.textContent).toBe(
      'Revisión 2ª vuelta: arreglos claros de agentes'
    );
    expect(title.querySelector('.ut-mid-end')?.textContent).toBe(' e infraestructura');
    expect(title.textContent?.trim()).toBe(name);
  });

  it('reads like a session row: title, coloured pill, reason, branch and counts', async () => {
    const row = await mount(
      task({
        state: 'needs_you',
        blocker: { kind: 'verify', message: 'check failed' },
        verify: { command: 'pnpm test', cwd: '/', startedAt: '', tail: 'FAIL a.test.ts' },
        stats: { commits: 1, files: 2, insertions: 10, deletions: 1 },
      }),
      createTestSession({ id: 's1' })
    );
    const root = row.querySelector('[data-testid="task-row"]') as HTMLElement;
    expect(root.dataset.bucket).toBe('needs');
    expect(row.querySelector('.psr-title')?.textContent?.trim()).toBe('Login con Google');
    const pill = row.querySelector('[data-testid="task-pill"]') as HTMLElement;
    expect(pill.textContent?.trim()).toBe('te necesita');
    expect(pill.classList.contains('tsk-pill--needs')).toBe(true);
    expect(row.querySelector('[data-testid="task-line"]')?.textContent).toBe(
      'no pasa la comprobación'
    );
    // The check's output and the branch with its counts wait behind «Más».
    expect(row.querySelector('[data-testid="task-detail"]')).toBeNull();
    expect(row.querySelector('[data-testid="task-caption"]')).toBeNull();
    await more(row);
    expect(row.querySelector('[data-testid="task-detail"]')?.textContent).toBe('FAIL a.test.ts');
    expect(row.querySelector('[data-testid="task-caption"]')?.textContent).toContain(
      'ut/login-google · 2 archivos · +10 −1'
    );
    // Que lo arregle first, then Ver cambios and Descartar.
    expect([...row.querySelectorAll<HTMLElement>('.tsk-btn')].map((b) => b.dataset.action)).toEqual(
      ['fix', 'changes', 'discard']
    );
    expect(button(row, 'fix')?.classList.contains('tsk-btn--primary')).toBe(true);
  });

  it('a working task shows its pulse and only Descartar, to stop it', async () => {
    const row = await mount(task(), createTestSession({ id: 's1' }));
    expect(row.querySelector('.tsk-pulse')).not.toBeNull();
    expect(
      [...row.querySelectorAll('[data-testid="task-actions"] button')].map((b) =>
        b.getAttribute('data-action')
      )
    ).toEqual(['discard']);
  });

  it('a tap opens its session exactly like a session row', async () => {
    const session = createTestSession({ id: 's1' });
    const row = await mount(task({ sessionId: 's1' }), session);
    const selected = vi.fn();
    row.addEventListener('session-select', selected);
    (row.querySelector('.tsk-main') as HTMLElement).click();
    expect(selected).toHaveBeenCalledTimes(1);
    expect((selected.mock.calls[0][0] as CustomEvent).detail).toBe(session);
  });

  it('without a session yet a tap says so instead of opening nothing', async () => {
    const row = await mount(task({ state: 'preparing' }));
    const selected = vi.fn();
    row.addEventListener('session-select', selected);
    (row.querySelector('.tsk-main') as HTMLElement).click();
    expect(selected).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ kind: 'info', text: 'Su sesión aún no ha empezado' });
  });

  it('Fusionar merges at once and says so', async () => {
    const row = await mount(task({ id: 't1', state: 'ready' }), createTestSession({ id: 's1' }));
    button(row, 'merge')?.click();
    await vi.waitFor(() => expect(store.act).toHaveBeenCalledWith('t1', 'merge'));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'success',
        text: 'Fusionando «Login con Google»…',
      })
    );
  });

  it('Urgente puts a task waiting for its check ahead in line (2026-11-01, fast lane)', async () => {
    const row = await mount(
      task({ id: 't1', state: 'verifying' }),
      createTestSession({ id: 's1' })
    );
    button(row, 'urgent')?.click();
    await vi.waitFor(() =>
      expect(store.act).toHaveBeenCalledWith('t1', 'priority', { level: 'urgent' })
    );
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'success',
        text: '«Login con Google» pasa delante en la cola de fusión',
      })
    );
  });

  it('Descartar asks first, then discards with the user’s OK', async () => {
    const row = await mount(task({ id: 't1', state: 'ready' }), createTestSession({ id: 's1' }));
    confirmDialog.mockResolvedValueOnce(false);
    button(row, 'discard')?.click();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(store.act).not.toHaveBeenCalled();

    button(row, 'discard')?.click();
    await vi.waitFor(() =>
      expect(store.act).toHaveBeenCalledWith('t1', 'discard', { confirm: true })
    );
    expect(confirmDialog.mock.calls[1][0]).toMatchObject({
      title: '¿Descartar «Login con Google»?',
      tone: 'danger',
    });
  });

  it('a risky change merges only after confirming the listed files', async () => {
    const row = await mount(
      task({
        id: 't1',
        state: 'needs_you',
        blocker: { kind: 'risk', message: 'risky' },
        risk: [{ rule: 'secret', file: '.env' }],
      }),
      createTestSession({ id: 's1' })
    );
    button(row, 'mergeRisk')?.click();
    await vi.waitFor(() =>
      expect(store.act).toHaveBeenCalledWith('t1', 'merge', { acceptRisk: true })
    );
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({ details: ['.env · secret'] });
  });

  it('an AI review lists its issues; Fusionar igualmente asks first, keeping accepted risk', async () => {
    const review = {
      verdict: 'concerns' as const,
      summary: 'Divide entre n-1',
      issues: [
        { file: 'src/split.ts', line: 3, severity: 'high' as const, what: 'Divide entre n-1' },
        { file: 'src/split.ts', severity: 'low' as const, what: 'Sin tipos' },
      ],
      at: 'x',
      model: 'sonnet',
      headSha: 'h',
    };
    const row = await mount(
      task({
        id: 't1',
        state: 'needs_you',
        blocker: { kind: 'review', message: 'Divide entre n-1' },
        review,
        risk: [{ rule: 'secret', file: '.env' }],
      }),
      createTestSession({ id: 's1' })
    );
    expect(row.querySelector('[data-testid="task-line"]')?.textContent).toBe(
      'la revisión IA ve problemas'
    );
    expect(row.querySelector('[data-testid="task-review"]')).toBeNull();
    await more(row);
    expect(row.querySelector('[data-testid="task-detail"]')?.textContent).toBe('Divide entre n-1');
    const block = row.querySelector('[data-testid="task-review"]');
    expect(block?.getAttribute('data-verdict')).toBe('concerns');
    expect(block?.textContent).toContain('Revisión IA: problemas');
    const issues = [...row.querySelectorAll('[data-testid="task-review-issues"] li')];
    expect(issues.map((li) => li.getAttribute('data-severity'))).toEqual(['high', 'low']);
    expect(issues[0].textContent).toContain('alta');
    expect(issues[0].textContent).toContain('src/split.ts:3');
    expect(button(row, 'fix')).not.toBeNull();
    expect(button(row, 'mergeReview')?.textContent?.trim()).toBe('Fusionar igualmente');

    confirmDialog.mockResolvedValueOnce(false);
    button(row, 'mergeReview')?.click();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(store.act).not.toHaveBeenCalled();
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({
      title: '¿Fusionar «Login con Google» pese a la revisión?',
      body: 'Divide entre n-1',
      details: ['src/split.ts:3 · Divide entre n-1', 'src/split.ts · Sin tipos'],
    });
    button(row, 'mergeReview')?.click();
    await vi.waitFor(() =>
      expect(store.act).toHaveBeenCalledWith('t1', 'merge', {
        acceptReview: true,
        acceptRisk: true,
      })
    );
  });

  it('says where its time went: each phase in all and its rounds (2026-10-31)', async () => {
    const at = (min: number, sec = 0) =>
      new Date(Date.UTC(2026, 9, 31, 13, min, sec)).toISOString();
    const row = await mount(
      task({
        state: 'merged',
        timings: [
          {
            phase: 'verify',
            startedAt: at(21, 31),
            finishedAt: at(23, 0),
            round: 1,
            outcome: 'cancelled',
          },
          {
            phase: 'review',
            startedAt: at(21, 31),
            finishedAt: at(22, 1),
            round: 1,
            outcome: 'concerns',
          },
          { phase: 'fix', startedAt: at(22, 2), finishedAt: at(31, 33), round: 1 },
          { phase: 'verify', startedAt: at(31, 33), finishedAt: at(36, 11), round: 2 },
          { phase: 'review', startedAt: at(31, 33), finishedAt: at(31, 42), round: 2 },
          { phase: 'merge', startedAt: at(36, 11), finishedAt: at(36, 20), round: 2 },
        ],
      })
    );
    await more(row);
    const line = row.querySelector('[data-testid="task-timings"]')?.textContent ?? '';
    expect(line).toContain('check 6m 7s · revisión IA 39s · arreglo del agente 9m 31s · fusión 9s');
    expect(line).toContain('2 rondas · 14m 49s en total');
    // Without timings: no line.
    fixtureCleanup();
    const plain = await mount(task({ state: 'ready' }));
    expect(plain.querySelector('[data-testid="task-timings"]')).toBeNull();
  });

  it('an ok review shows its line; an unavailable one says so, in "Hechas" too', async () => {
    const ok = await mount(
      task({
        state: 'ready',
        review: { verdict: 'ok', summary: 'Correcto', issues: [], at: 'x', model: 'sonnet' },
      })
    );
    await more(ok);
    expect(ok.querySelector('[data-testid="task-review"]')?.textContent).toContain(
      'Revisión IA: bien'
    );
    expect(ok.querySelector('[data-testid="task-review"]')?.textContent).toContain('Correcto');
    expect(ok.querySelector('[data-testid="task-review-issues"]')).toBeNull();
    fixtureCleanup();
    const row = await fixture<TaskRow>(
      html`<task-row
        variant="done"
        .task=${task({
          state: 'merged',
          review: {
            verdict: 'unavailable',
            summary: '',
            issues: [],
            reason: 'timeout',
            at: 'x',
            model: 'sonnet',
          },
        })}
        .store=${store as unknown as TaskStore}
      ></task-row>`
    );
    await row.updateComplete;
    await more(row);
    expect(row.querySelector('[data-testid="task-review"]')?.textContent?.trim()).toBe(
      'Revisión no disponible'
    );
  });

  it('Que lo arregle hands the blocker to the agent', async () => {
    const row = await mount(
      task({ id: 't1', state: 'failed', blocker: { kind: 'verify', message: 'x' } }),
      createTestSession({ id: 's1' })
    );
    button(row, 'fix')?.click();
    await vi.waitFor(() => expect(store.act).toHaveBeenCalledWith('t1', 'fix'));
  });

  it('Ver cambios opens the changes sheet on its worktree, counted from its base', async () => {
    const openChangesSheet = vi.fn();
    vi.spyOn(lazyViews.changesSheet, 'use').mockImplementation((fn) =>
      fn({ openChangesSheet } as never)
    );
    const row = await mount(task({ state: 'ready' }), createTestSession({ id: 's1' }));
    button(row, 'changes')?.click();
    expect(openChangesSheet).toHaveBeenCalledWith('/repos/.untether-worktrees/app/login-google', {
      since: 'main',
    });
  });

  it('a request waiting for the user’s OK says so; a failure shows the reason', async () => {
    store.act.mockResolvedValueOnce({ ok: true, status: 202, data: {} });
    const row = await mount(task({ id: 't1', state: 'ready' }), createTestSession({ id: 's1' }));
    button(row, 'merge')?.click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'info',
        text: 'Esperando tu OK (te llega un aviso)',
      })
    );
    store.act.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'busy',
      message: 'The task is busy',
    });
    await vi.waitFor(() => expect(button(row, 'merge')?.disabled).toBe(false));
    button(row, 'merge')?.click();
    // The server's code in the user's language, not its English message (2026-10-20).
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'error',
        text: 'No se pudo: la tarea está ocupada; prueba dentro de un momento',
      })
    );
  });

  it('task errors: known codes and messages translated, unknown ones kept, offline said', () => {
    expect(taskErrorText({ ok: false, status: 0, error: 'Failed to fetch' })).toBe(
      'no hay conexión con el ordenador'
    );
    expect(
      taskErrorText({
        ok: false,
        status: 409,
        error: 'The task still has its branch: discard it',
      })
    ).toBe('ya tiene su propia rama: descártala');
    expect(taskErrorText({ ok: false, status: 503, error: 'Service Unavailable' })).toBe(
      'las tareas aún no están disponibles en el ordenador'
    );
    expect(taskErrorText({ ok: false, status: 400, error: 'name: Required' })).toBe(
      'name: Required'
    );
  });

  it('keeps its buttons disabled until the store has the new state (2026-10-20)', async () => {
    let refreshed: () => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          refreshed = resolve;
        })
    );
    (store as unknown as { refresh: typeof refresh }).refresh = refresh;
    const row = await mount(task({ id: 't1', state: 'ready' }), createTestSession({ id: 's1' }));
    button(row, 'merge')?.click();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    await row.updateComplete;
    expect(button(row, 'merge')?.disabled).toBe(true);
    refreshed();
    await vi.waitFor(() => expect(button(row, 'merge')?.disabled).toBe(false));
  });

  it('cancelling a scheduled task: «Cancelar tarea» or «Mantener», never two «Cancelar»', async () => {
    const row = await mount(task({ id: 't1', state: 'scheduled' }));
    button(row, 'cancel')?.click();
    await vi.waitFor(() => expect(store.cancel).toHaveBeenCalledWith('t1'));
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({
      confirmLabel: 'Cancelar tarea',
      cancelLabel: 'Mantener',
    });
  });

  it('a task stuck getting ready shows its setup log and can be discarded', async () => {
    const log = vi.fn(async () => ({ ok: true, status: 200, data: { text: 'npm install…' } }));
    (store as unknown as { log: typeof log }).log = log;
    const row = await mount(task({ id: 't1', state: 'preparing' }));
    expect(button(row, 'discard')).not.toBeNull();
    button(row, 'log')?.click();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('t1', 'setup'));
    document.querySelector('[data-testid="task-log-sheet"]')?.closest('.psr-sheet')?.remove();
  });

  it('in a parallel group Fusionar becomes Quedarme con este', async () => {
    const row = await mount(task({ id: 't1', state: 'ready' }), createTestSession({ id: 's1' }), 1);
    expect(button(row, 'merge')).toBeNull();
    button(row, 'keep')?.click();
    await vi.waitFor(() => expect(store.act).toHaveBeenCalledWith('t1', 'keep', { confirm: true }));
  });

  it('"Hechas" rows have no buttons but Deshacer on a recent merge', async () => {
    const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const row = await fixture<TaskRow>(
      html`<task-row .task=${task({ state: 'merged', finishedAt: old, stateSince: old })} .variant=${'done'}></task-row>`
    );
    expect(row.querySelector('[data-testid="task-actions"]')).toBeNull();
    expect(row.querySelector('[data-testid="task-pill"]')?.textContent?.trim()).toBe('fusionada');
    const recent = new Date().toISOString();
    const fresh = await fixture<TaskRow>(
      html`<task-row .task=${task({ state: 'merged', finishedAt: recent, stateSince: recent, mergedSha: 'b2', mergedOnto: 'a1' })} .variant=${'done'}></task-row>`
    );
    const buttons = [...fresh.querySelectorAll('[data-testid^="task-action-"]')];
    expect(buttons.map((b) => b.getAttribute('data-action'))).toEqual(['revert']);
    expect(buttons[0]?.textContent?.trim()).toBe('Deshacer');
  });
  it('a task fixing itself reads as in progress, with its attempt and no main button', async () => {
    const row = await mount(
      {
        ...task({
          state: 'working',
          worktreePath: '/wt/a',
          blocker: undefined,
        }),
        autoFix: { attempts: 2, max: 3, reason: 'verify', at: new Date().toISOString() },
      } as TaskRecord,
      createTestSession({ id: 's1' })
    );
    const root = row.querySelector('[data-testid="task-row"]') as HTMLElement;
    expect(root.dataset.bucket).toBe('working');
    expect(row.querySelector('[data-testid="task-pill"]')?.textContent?.trim()).toBe(
      'arreglándose sola'
    );
    expect(row.querySelector('[data-testid="task-line"]')?.textContent).toBe(
      'intento 2 de 3 · no pasaba la comprobación'
    );
    expect(row.querySelector('.tsk-btn--primary')).toBeNull();
    const actions = [...row.querySelectorAll('[data-testid^="task-action-"]')].map((b) =>
      b.getAttribute('data-action')
    );
    expect(actions).toEqual(['log', 'changes', 'discard']);
  });

  it('a review that could not run waits for its retry; merging anyway says it goes in unreviewed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Also when an assertion in between fails: the next test gets the real clock.
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date(2026, 9, 20, 12, 0));
    const retry = new Date(2026, 9, 20, 14, 5).toISOString();
    const record = task({
      state: 'ready',
      blocker: { kind: 'review-unavailable' as 'review', message: 'claude timed out' },
      review: { verdict: 'unavailable', summary: '', issues: [], at: '', model: 'x' },
    });
    const row = await mount(
      {
        ...record,
        reviewRetryAt: retry,
      } as TaskRecord,
      createTestSession({ id: 's1' })
    );
    expect(row.querySelector('[data-testid="task-pill"]')?.textContent?.trim()).toBe(
      'revisión pendiente'
    );
    expect(row.querySelector('[data-testid="task-line"]')?.textContent).toBe(
      'Se reintenta sola a las 14:05'
    );
    // Only waiting: no pulsing dot on «revisión pendiente».
    expect(row.querySelector('[data-testid="task-pill"] .tsk-pulse')).toBeNull();
    vi.useRealTimers();
    // Its pill and line already say it: no second «Revisión no disponible» line, not even in «Más».
    await more(row);
    expect(row.querySelector('[data-testid="task-review"]')).toBeNull();
    expect(row.querySelector('.tsk-btn--primary')).toBeNull();
    button(row, 'mergeReview')?.click();
    await vi.waitFor(() => expect(store.act).toHaveBeenCalled());
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: '¿Fusionar «Login con Google» sin revisión?' })
    );
    expect(store.act).toHaveBeenCalledWith(record.id, 'merge', { acceptReview: true });
  });

  it('Deshacer asks, makes the revert task and brings it into view', async () => {
    store.act.mockResolvedValue({ ok: true, status: 200, data: { task: { id: 'revert-1' } } });
    const shown: string[] = [];
    const listener = (e: Event) => shown.push((e as CustomEvent).detail.taskId);
    window.addEventListener('ut-show-task', listener);
    const merged = task({
      state: 'merged',
      finishedAt: new Date().toISOString(),
      mergedSha: 'b2',
      mergedOnto: 'a1',
    });
    const row = await mount(merged);
    // A second tap while it asks makes no second undo task.
    button(row, 'revert')?.click();
    button(row, 'revert')?.click();
    await vi.waitFor(() => expect(shown).toEqual(['revert-1']));
    window.removeEventListener('ut-show-task', listener);
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Se creará una tarea que deshace estos cambios; pasará tests y revisión antes de entrar.',
      })
    );
    expect(store.act).toHaveBeenCalledWith(merged.id, 'revert');
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(store.act).toHaveBeenCalledTimes(1);
    // Asked for: no «Deshacer» again while the board catches up.
    await row.updateComplete;
    expect(button(row, 'revert')).toBeNull();
  });

  it('Deshacer hides while its undo task is open; once that merged the row reads «deshecha»', async () => {
    const original = task({
      id: 'orig',
      state: 'merged',
      finishedAt: new Date().toISOString(),
      mergedSha: 'b2',
      mergedOnto: 'a1',
      revertedBy: 'undo',
    });
    const withUndo = (state: TaskRecord['state']) =>
      Object.assign(store, { tasks: [original, task({ id: 'undo', state })] });
    withUndo('working');
    let row = await mount(original);
    expect(button(row, 'revert')).toBeNull();
    expect(row.querySelector('[data-testid="task-pill"]')?.textContent?.trim()).toBe('fusionada');
    fixtureCleanup();
    withUndo('merged');
    row = await mount(original);
    expect(button(row, 'revert')).toBeNull();
    expect(row.querySelector('[data-testid="task-pill"]')?.textContent?.trim()).toBe('deshecha');
    fixtureCleanup();
    // Its undo task thrown away: it can be undone again.
    withUndo('discarded');
    row = await mount(original);
    expect(button(row, 'revert')).not.toBeNull();
  });

  it('Deshacer refused for want of a record says so in Spanish', async () => {
    store.act.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'not-fixable',
      message: 'Untether has no record of exactly what this task merged',
    });
    const row = await mount(
      task({
        state: 'merged',
        finishedAt: new Date().toISOString(),
        mergedSha: 'b',
        mergedOnto: 'a',
      })
    );
    button(row, 'revert')?.click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'error',
        text: 'No se pudo: no consta qué se fusionó: no se puede deshacer automáticamente',
      })
    );
  });

  it('Reintentar refused because of its own work says what to do', async () => {
    store.act.mockResolvedValue({ ok: false, status: 409, error: 'not-fixable', message: 'x' });
    const row = await mount(
      task({ state: 'failed', blocker: { kind: 'setup', message: 'setup failed' } })
    );
    button(row, 'retry')?.click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'error',
        text: 'No se pudo: tiene trabajo propio: pide a su agente que lo arregle o descártala',
      })
    );
  });

  it('an undo task is titled «Deshacer: <name>»', async () => {
    const row = await mount(
      task({ name: 'Undo: Login con Google', revertOf: { taskId: 'o', from: 'a', to: 'b' } })
    );
    expect(row.querySelector('.psr-title')?.textContent?.trim()).toBe('Deshacer: Login con Google');
  });

  it('a task asking for permission while it was fixing itself shows Abrir, not «arreglándose sola»', async () => {
    const row = await mount(
      {
        ...task({
          state: 'needs_you',
          blocker: { kind: 'permission', message: 'Bash(rm -rf dist)' },
        }),
        autoFix: { attempts: 1, max: 2, reason: 'review', at: '' },
      } as TaskRecord,
      createTestSession({ id: 's1' })
    );
    expect(row.querySelector('[data-testid="task-pill"]')?.textContent?.trim()).toBe('te necesita');
    expect(row.querySelector('.tsk-btn--primary')?.getAttribute('data-action')).toBe('open');
  });

  it('Fusionar igualmente on one of several attempts keeps it, past the review', async () => {
    const row = await mount(
      task({
        id: 't1',
        groupId: 'g',
        state: 'needs_you',
        blocker: { kind: 'review', message: 'Divide entre n-1' },
        review: {
          verdict: 'concerns',
          summary: 'Divide entre n-1',
          issues: [],
          at: '',
          model: 'x',
        },
      }),
      createTestSession({ id: 's1' }),
      1
    );
    button(row, 'mergeReview')?.click();
    await vi.waitFor(() =>
      expect(store.act).toHaveBeenCalledWith('t1', 'keep', { confirm: true, acceptReview: true })
    );
    // The dialog says the other attempts go too.
    expect(confirmDialog.mock.calls[0][0]).toMatchObject({
      body: expect.stringContaining('Divide entre n-1'),
    });
    expect(String((confirmDialog.mock.calls[0][0] as { body: string }).body)).toContain('\n\n');
  });

  it('a finished task without a session opens what it did instead of «aún no ha empezado»', async () => {
    const row = await mount(
      task({ state: 'failed', blocker: { kind: 'verify', message: 'FAIL a.test.ts' } })
    );
    (row.querySelector('.tsk-main') as HTMLElement).click();
    expect(toast).not.toHaveBeenCalledWith({ kind: 'info', text: 'Su sesión aún no ha empezado' });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="task-detail-sheet"]')).not.toBeNull()
    );
    const sheet = document.querySelector('[data-testid="task-detail-sheet"]') as HTMLElement;
    expect(sheet.querySelector('[data-testid="task-detail-status"]')?.textContent).toContain(
      'falló'
    );
    expect(sheet.textContent).toContain('FAIL a.test.ts');
    expect(sheet.querySelector('[data-testid="task-detail-note"]')?.textContent).toBe(
      'Su sesión ya terminó.'
    );
    expect(sheet.querySelector('[data-testid="task-detail-log"]')).not.toBeNull();
    (document.querySelector('[data-testid="psr-sheet-cancel"]') as HTMLElement | null)?.click();
  });

  it('keeping an attempt says the others go once it is merged', async () => {
    store.act.mockResolvedValue({ ok: true, status: 200, data: { discardOnMerge: true } });
    const row = await mount(task({ state: 'ready', groupId: 'g' }), undefined, 1);
    button(row, 'keep')?.click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'success',
          text: 'Fusionando «Login con Google»; los otros intentos se descartarán cuando entre',
        })
      )
    );
  });

  it("2026-11-01: shows the agent's structured result in order, and its mismatch", async () => {
    const row = await mount(
      task({
        state: 'ready',
        blocker: {
          kind: 'partial',
          message: 'The agent says the work is partial; left to do: doc',
        },
        result: {
          outcome: 'partial',
          files: [{ path: 'src/a.ts', why: 'el arreglo' }],
          tests: [
            { command: 'pnpm test', result: 'passed', detail: '212 passed' },
            { command: 'pnpm e2e', result: 'failed' },
          ],
          risks: ['lento en repos grandes'],
          followUps: ['falta la doc'],
          measurements: [{ name: 'p95', value: 120, unit: 'ms', before: 180 }],
        },
        resultMismatch: "The diff changes files the agent's result does not name: src/b.ts",
      })
    );
    expect(row.querySelector('[data-testid="task-result"]')).toBeNull();
    await more(row);
    const result = row.querySelector('[data-testid="task-result"]') as HTMLElement;
    expect(result.dataset.outcome).toBe('partial');
    expect(row.querySelector('[data-testid="task-result-outcome"]')?.textContent).toBe('a medias');
    expect(row.querySelector('[data-testid="task-line"]')?.textContent).toContain('a medias');
    expect(row.querySelector('[data-testid="task-result-mismatch"]')?.textContent).toContain(
      'No cuadra con sus cambios'
    );
    const text = (id: string) =>
      row.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
    expect(text('task-result-followups')).toContain('falta la doc');
    expect(text('task-result-risks')).toContain('lento en repos grandes');
    expect(text('task-result-tests')).toContain('falló · pnpm e2e');
    expect(text('task-result-files')).toContain('src/a.ts — el arreglo');
    expect(text('task-result-measurements')).toContain('p95: 180 → 120 ms');
    // A failed test opens its group; the files stay folded.
    expect(
      (row.querySelector('[data-testid="task-result-tests"]') as HTMLDetailsElement).open
    ).toBe(true);
    expect(
      (row.querySelector('[data-testid="task-result-files"]') as HTMLDetailsElement).open
    ).toBe(false);
    // Its main button opens the session or merges; merging stays a tap away.
    expect(button(row, 'merge')).not.toBeNull();
  });

  it('2026-11-08: one line at a glance; «Más» shows the whole summary and the details', async () => {
    const summary =
      'Añadido el login con Google y la pantalla de consentimiento con sus textos en los ocho idiomas.\nVerificado: pnpm test pasa.\nPara deshacer: revertir el commit.';
    const row = await mount(
      task({
        state: 'ready',
        summary,
        model: 'claude-opus-5-5',
        stats: { commits: 1, files: 2, insertions: 10, deletions: 1 },
        review: { verdict: 'ok', summary: 'Correcto', issues: [], at: 'x', model: 'sonnet' },
      })
    );
    const line = row.querySelector('[data-testid="task-line"]') as HTMLElement;
    // The summary's first line, cut to 80 characters: never a paragraph.
    expect([...(line.textContent ?? '')].length).toBeLessThanOrEqual(80);
    expect(line.textContent?.endsWith('…')).toBe(true);
    expect(line.textContent?.startsWith('Añadido el login con Google')).toBe(true);
    for (const id of ['task-detail', 'task-agent', 'task-review', 'task-caption', 'task-more']) {
      expect(row.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
    const toggle = row.querySelector<HTMLButtonElement>('[data-testid="task-more-toggle"]');
    expect(toggle?.textContent?.trim()).toBe('Más');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // «Más» unfolds in place: it does not open the session.
    const selected = vi.fn();
    row.addEventListener('session-select', selected);
    await more(row);
    expect(selected).not.toHaveBeenCalled();
    const detail = row.querySelector('[data-testid="task-detail"]') as HTMLElement;
    expect(detail.textContent).toBe(summary);
    expect(detail.classList.contains('tsk-detail--summary')).toBe(true);
    expect(row.querySelector('[data-testid="task-agent"]')?.textContent).toContain(
      'claude-opus-5-5'
    );
    expect(row.querySelector('[data-testid="task-review"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="task-caption"]')?.textContent).toContain('2 archivos');
    expect(toggle?.textContent?.trim()).toBe('Menos');
    await more(row);
    expect(row.querySelector('[data-testid="task-more"]')).toBeNull();
  });

  it('a working task says what its agent does now, from its session’s line', async () => {
    const session = {
      ...createTestSession({ id: 's1' }),
      explain: { text: 'Ejecuta los tests de login tras arreglar el token', at: Date.now() },
    };
    const row = await mount(task({ state: 'working' }), session);
    expect(row.querySelector('[data-testid="task-line"]')?.textContent).toBe(
      'Ejecuta los tests de login tras arreglar el token'
    );
    // Stopped, the task's own reason, not the agent's old line.
    fixtureCleanup();
    const stopped = await mount(
      task({ state: 'needs_you', blocker: { kind: 'verify', message: 'x' } }),
      session
    );
    expect(stopped.querySelector('[data-testid="task-line"]')?.textContent).toBe(
      'no pasa la comprobación'
    );
  });

  it('nothing past its line: no «Más»', async () => {
    const row = await mount(
      task({ state: 'working', branch: undefined, stats: undefined }),
      createTestSession({ id: 's1' })
    );
    expect(row.querySelector('[data-testid="task-more-toggle"]')).toBeNull();
  });
});
