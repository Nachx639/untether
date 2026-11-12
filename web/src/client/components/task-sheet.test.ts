// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import type { TaskSheet } from './task-sheet.js';

const confirmDialog = vi.hoisted(() => vi.fn(async (_options: unknown) => true));
vi.mock('../utils/confirm-dialog.js', () => ({ confirmDialog }));

vi.mock('../services/auth-client.js', () => ({
  authClient: { getAuthHeader: () => ({ Authorization: 'Bearer t' }) },
}));

let openTaskSheet: typeof import('./task-sheet.js').openTaskSheet;

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

/** The setup's fetch: each test replaces it, afterEach puts it back. */
const setupFetch = globalThis.fetch;

describe('task-sheet', () => {
  let calls: Call[];
  let tasks: TaskRecord[];
  let templates: Array<{ id: string; name: string; prompt: string }>;

  beforeAll(async () => {
    ({ openTaskSheet } = await import('./task-sheet.js'));
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 3, 15, 30));
    calls = [];
    tasks = [];
    templates = [{ id: 'mine', name: 'Docs', prompt: 'Documenta {folder}' }];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      let reply: unknown = {};
      if (url === '/api/task-templates' && method === 'GET') reply = { templates };
      else if (url === '/api/tasks' && method === 'GET') reply = { tasks };
      else if (url === '/api/tasks' && method === 'POST') {
        reply = {
          task: {
            ...body,
            id: 'new',
            state: body?.runAt ? 'scheduled' : 'working',
            isolation: body?.isolation ?? 'none',
            sessionId: body?.runAt ? undefined : 'sess-9',
          },
        };
      }
      return new Response(JSON.stringify(reply), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = setupFetch;
    document.querySelector('task-sheet')?.remove();
    vi.useRealTimers();
  });

  const open = async (onStarted = vi.fn()) => {
    const sheet = openTaskSheet({
      folders: ['/Users/me/app', '/Users/me/web'],
      commands: { claude: ['claude', '--model', 'opus'], codex: ['codex'] },
      onStarted,
    });
    // Past the 500 ms that ignore the tap which opened the sheet.
    vi.setSystemTime(Date.now() + 600);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sheet.updateComplete;
    return sheet;
  };

  const touch = async (sheet: TaskSheet, selector: string) => {
    const el = sheet.querySelector(selector) as HTMLElement;
    expect(el, selector).toBeTruthy();
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sheet.updateComplete;
  };

  it('keeps its main button in view, pinned under a form that scrolls', async () => {
    // On an iPhone SE "Run now" sat below the form, out of sight (2026-10-03).
    const sheet = await open();
    const style = sheet.querySelector('style')?.textContent ?? '';
    expect(style).toMatch(/\.task-primary \{[^}]*position: sticky;[^}]*bottom: 0;/);
    // Opaque even disabled (before a prompt is typed): the form scrolls beneath it.
    expect(style).not.toMatch(/\.task-primary:disabled \{[^}]*opacity/);
    expect(sheet.querySelector('.task-body > [data-testid="task-submit"]')).toBeTruthy();
  });

  it('shows the built-in templates and yours, and a chip fills the name and prompt', async () => {
    const sheet = await open();
    const chips = [...sheet.querySelectorAll('.task-chip')].map((chip) => chip.textContent?.trim());
    expect(chips).toHaveLength(6);
    expect(chips.at(-1)).toBe('Docs');
    await touch(sheet, '.task-chip[data-id="builtin-tests"]');
    expect((sheet.querySelector('[data-testid="task-prompt"]') as HTMLTextAreaElement).value).toBe(
      'Review the tests and fix the ones that fail'
    );
    expect((sheet.querySelector('[data-testid="task-name"]') as HTMLInputElement).value).toBe(
      'Fix tests'
    );
  });

  it('a scroll of the form that starts on a chip or Run now does nothing', async () => {
    const sheet = await open();
    // iOS ends a scroll that began on a button with a pointerup on it.
    const drag = (selector: string) => {
      const el = sheet.querySelector(selector) as HTMLElement;
      const at = (y: number) => ({
        pointerType: 'touch',
        pointerId: 7,
        clientX: 40,
        clientY: y,
        bubbles: true,
      });
      el.dispatchEvent(new PointerEvent('pointerdown', at(400)));
      el.dispatchEvent(new PointerEvent('pointerup', at(300)));
    };
    const name = () => (sheet.querySelector('[data-testid="task-name"]') as HTMLInputElement).value;
    drag('.task-chip[data-id="builtin-tests"]');
    await sheet.updateComplete;
    expect(name()).toBe('');
    await touch(sheet, '.task-chip[data-id="builtin-tests"]');
    expect(name()).toBe('Fix tests');
    drag('[data-testid="task-submit"]');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('"En rama aparte" makes it a worktree task: the home board shows it, no session to open', async () => {
    const onStarted = vi.fn();
    const sheet = await open(onStarted);
    expect(sheet.querySelector('[data-testid="task-isolated"]')?.getAttribute('aria-checked')).toBe(
      'false'
    );
    await touch(sheet, '.task-chip[data-id="builtin-lint"]');
    await touch(sheet, '[data-testid="task-isolated"]');
    expect(sheet.textContent).toContain('git');
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(document.querySelector('task-sheet')).toBeNull());
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ isolation: 'worktree', workingDir: '/Users/me/app' });
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('starts a task now, shielded, with the agent command, and opens its session', async () => {
    const onStarted = vi.fn();
    const sheet = await open(onStarted);
    await touch(sheet, '.task-chip[data-id="builtin-lint"]');
    await touch(sheet, '[data-testid="task-shielded"]');
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith('sess-9'));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Fix lint',
      prompt: 'Fix the lint errors',
      workingDir: '/Users/me/app',
      command: ['claude', '--model', 'opus'],
      agent: 'claude',
      shielded: true,
      notify: true,
    });
    // One tap, one task: the click after the pointerup is swallowed.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('schedules for tonight at 2:00 and shows the Scheduled tab', async () => {
    const sheet = await open();
    await touch(sheet, '.task-chip[data-id="builtin-summary"]');
    await touch(sheet, '[data-testid="task-when"] [data-value="tonight"]');
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body?.runAt).toBe(new Date(2026, 9, 4, 2, 0).toISOString());
  });

  it('offers a native datetime-local input for a custom time', async () => {
    const sheet = await open();
    await touch(sheet, '[data-testid="task-when"] [data-value="custom"]');
    const input = sheet.querySelector('[data-testid="task-time"]') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe('2026-10-03T16:30');
  });

  it('ignores the click that opened it', async () => {
    const sheet = openTaskSheet({
      folders: ['~'],
      commands: { claude: ['claude'], codex: ['codex'] },
    });
    await sheet.updateComplete;
    (sheet.querySelector('.task-chip') as HTMLElement).click();
    await sheet.updateComplete;
    expect(sheet.querySelector('.task-chip.selected')).toBeNull();
  });

  it('carries the mark of a task on an external model provider', async () => {
    tasks = [record({ modelProvider: 'acme', model: 'large' })];
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="task-item-provider-badge"]')).toBeTruthy()
    );
    const badge = sheet.querySelector('[data-testid="task-item-provider-badge"]') as HTMLElement & {
      providerId?: string;
      model?: string;
    };
    expect(badge.providerId).toBe('acme');
    expect(badge.model).toBe('large');
  });

  it('lists scheduled tasks and cancels one', async () => {
    tasks = [
      {
        id: 'a',
        name: 'Nightly tests',
        prompt: 'p',
        workingDir: '/Users/me/app',
        command: ['claude'],
        agent: 'claude',
        shielded: false,
        notify: true,
        runAt: new Date(2026, 9, 4, 2, 0).toISOString(),
        createdAt: new Date().toISOString(),
        state: 'scheduled',
      },
    ];
    confirmDialog.mockClear();
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-item')).toBeTruthy());
    expect(sheet.querySelector('.task-item-name')?.textContent).toBe('Nightly tests');
    await touch(sheet, '.task-item [data-action="remove"]');
    await vi.waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/tasks/a')).toBe(
        true
      )
    );
    // Asked through the app's own dialog, as a danger action (never window.confirm).
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }));
  });

  const record = (over: Partial<TaskRecord>): TaskRecord => ({
    id: 'a',
    name: 'Nightly tests',
    prompt: 'p',
    workingDir: '/Users/me/app',
    command: ['claude'],
    agent: 'claude',
    shielded: false,
    notify: true,
    runAt: new Date(2026, 9, 4, 2, 0).toISOString(),
    createdAt: new Date().toISOString(),
    state: 'scheduled',
    ...over,
  });

  it('editing a scheduled task keeps its time unless another is picked', async () => {
    tasks = [record({})];
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-item')).toBeTruthy());
    await touch(sheet, '.task-item [data-action="edit"]');
    await vi.waitFor(() => expect(sheet.querySelector('[data-testid="task-when"]')).toBeTruthy());
    expect(
      sheet
        .querySelector('[data-testid="task-when"] [data-value="custom"]')
        ?.getAttribute('aria-checked')
    ).toBe('true');
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/tasks/a');
    expect(put?.body?.runAt).toBe(new Date(2026, 9, 4, 2, 0).toISOString());
  });

  // 2026-11-11: "Now" is back in the edit form: the server takes runAt null as "run it now".
  // (2026-11-10 it was hidden: a PUT without runAt silently kept the original time.)
  it('"Now" while editing a scheduled task sends runAt null, never a PUT without a time', async () => {
    tasks = [record({})];
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-item')).toBeTruthy());
    await touch(sheet, '.task-item [data-action="edit"]');
    await vi.waitFor(() => expect(sheet.querySelector('[data-testid="task-when"]')).toBeTruthy());
    await touch(sheet, '[data-testid="task-when"] [data-value="now"]');
    expect(sheet.querySelector('[data-testid="task-time"]')).toBeNull();
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('/api/tasks/a');
    expect(put?.body).toHaveProperty('runAt', null);
  });

  it('a new task for now sends no runAt at all', async () => {
    const sheet = await open();
    await vi.waitFor(() => expect(sheet.querySelector('[data-testid="task-submit"]')).toBeTruthy());
    const prompt = sheet.querySelector<HTMLTextAreaElement>('[data-testid="task-prompt"]');
    expect(prompt).toBeTruthy();
    if (prompt) {
      prompt.value = 'Haz algo';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/tasks');
    expect(post?.body).not.toHaveProperty('runAt');
  });

  it('a refused Cancelar says why on the Scheduled tab itself (2026-10-20)', async () => {
    tasks = [record({})];
    const ok = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) =>
      init.method === 'DELETE'
        ? new Response(JSON.stringify({ error: 'Task not found' }), { status: 404 })
        : ok(url, init)
    ) as unknown as typeof fetch;
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-item')).toBeTruthy());
    await touch(sheet, '.task-item [data-action="remove"]');
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="task-scheduled-error"]')?.textContent).toContain(
        'that task no longer exists'
      )
    );
  });

  it('an open worktree task offers Descartar (Quitar is refused for it), asking first', async () => {
    tasks = [record({ state: 'working', isolation: 'worktree', files: [] })];
    confirmDialog.mockClear();
    const sheet = await open();
    await touch(sheet, '[data-testid="task-tab-scheduled"]');
    await vi.waitFor(() => expect(sheet.querySelector('.task-item')).toBeTruthy());
    const button = sheet.querySelector('[data-testid="task-item-remove"]') as HTMLElement;
    expect(button.dataset.action).toBe('discard');
    expect(button.textContent?.trim()).toBe('Discard');
    await touch(sheet, '[data-testid="task-item-remove"]');
    await vi.waitFor(() =>
      expect(
        calls.some((call) => call.method === 'POST' && call.url === '/api/tasks/a/discard')
      ).toBe(true)
    );
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }));
  });

  it('a 202 (waiting for the user’s OK) closes the sheet instead of failing', async () => {
    const ok = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) =>
      url === '/api/tasks' && init.method === 'POST'
        ? new Response(JSON.stringify({ status: 'pending-confirmation' }), { status: 202 })
        : ok(url, init)
    ) as unknown as typeof fetch;
    const sheet = await open();
    (sheet.querySelector('[data-testid="task-prompt"]') as HTMLTextAreaElement).value = 'Do it';
    sheet
      .querySelector('[data-testid="task-prompt"]')
      ?.dispatchEvent(new Event('input', { bubbles: true }));
    await sheet.updateComplete;
    await touch(sheet, '[data-testid="task-submit"]');
    await vi.waitFor(() => expect(document.querySelector('task-sheet')).toBeNull());
  });
});
