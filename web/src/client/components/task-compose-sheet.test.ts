// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n/index.js';
import type { TaskStore } from '../services/task-store.js';

const { toast } = vi.hoisted(() => ({ toast: vi.fn(() => () => {}) }));
vi.mock('../utils/action-toast.js', () => ({ toast }));
vi.mock('../services/auth-client.js', () => ({
  authClient: { getAuthHeader: () => ({ Authorization: 'Bearer t' }) },
}));

import {
  agentDisplayLabel,
  openTaskComposeSheet,
  type TaskComposeSheet,
} from './task-compose-sheet.js';

const AGENTS = [
  { agent: 'claude' as const, label: 'claude', command: ['claude', '--model', 'opus'] },
  { agent: 'codex' as const, label: 'codex', command: ['codex'] },
];

describe('task-compose-sheet', () => {
  let store: { create: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    await setLocale('es');
    toast.mockClear();
    store = {
      create: vi.fn(async (body: Record<string, unknown>) => ({
        ok: true,
        status: 200,
        data: { tasks: Array.from({ length: Number(body.parallel) }, (_, i) => ({ id: `t${i}` })) },
      })),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/projects') {
          return Response.json({ projects: [{ repoPath: '/repos/server-only' }] });
        }
        if (url === '/api/config') return Response.json({ repositoryBasePath: '~/Projects' });
        if (url.startsWith('/api/repositories/discover')) {
          return Response.json([{ path: '/repos/found' }]);
        }
        return Response.json({});
      })
    );
  });

  afterEach(async () => {
    document.querySelector('task-compose-sheet')?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await setLocale('en');
  });

  async function open(repo?: string) {
    const sheet = openTaskComposeSheet({
      repos: ['/repos/app', '/repos/web'],
      ...(repo ? { repo } : {}),
      agents: AGENTS,
      store: store as unknown as TaskStore,
    });
    await sheet.updateComplete;
    // Past the guard that ignores the tap which opened it.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    return sheet;
  }

  const tap = async (sheet: TaskComposeSheet, selector: string) => {
    const el = sheet.querySelector<HTMLElement>(selector);
    expect(el, selector).toBeTruthy();
    el?.click();
    await sheet.updateComplete;
  };

  const type = async (sheet: TaskComposeSheet, text: string) => {
    const area = sheet.querySelector<HTMLTextAreaElement>('[data-testid="compose-prompt"]');
    if (!area) throw new Error('no prompt');
    area.value = text;
    area.dispatchEvent(new Event('input'));
    await sheet.updateComplete;
  };

  it('starts in the project it was opened from, and adds the server’s projects', async () => {
    const sheet = await open('/repos/web');
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-repo="/repos/server-only"]')).not.toBeNull()
    );
    expect(sheet.querySelector('[aria-checked="true"][data-repo]')?.getAttribute('data-repo')).toBe(
      '/repos/web'
    );
    expect(sheet.querySelector('#task-compose-title')?.textContent).toBe('Nueva tarea');
    // Dictation sits in the prompt.
    expect(sheet.querySelector('[data-testid="compose-mic"]')).not.toBeNull();
  });

  it('launches a worktree task with the chosen agent’s command', async () => {
    const sheet = await open();
    expect(sheet.querySelector<HTMLButtonElement>('[data-testid="compose-launch"]')?.disabled).toBe(
      true
    );
    await type(sheet, 'Añade login con Google\ny tests');
    // Named like the Ask box (screenshot review 2026-10-18): "Claude" / "Codex", not the
    // quick start's lowercase program name.
    expect(
      [...sheet.querySelectorAll('[data-testid="compose-agents"] button')].map((b) =>
        b.textContent?.trim()
      )
    ).toEqual(['Claude', 'Codex']);
    await tap(sheet, '[data-testid="compose-agents"] button:nth-child(2)');
    await tap(sheet, '[data-testid="compose-launch"]');
    await vi.waitFor(() => expect(store.create).toHaveBeenCalled());
    expect(store.create.mock.calls[0][0]).toEqual({
      name: 'Añade login con Google',
      prompt: 'Añade login con Google\ny tests',
      workingDir: '/repos/app',
      repoPath: '/repos/app',
      isolation: 'worktree',
      agent: 'codex',
      command: ['codex'],
      parallel: 1,
    });
    await vi.waitFor(() => expect(document.querySelector('task-compose-sheet')).toBeNull());
    expect(toast).toHaveBeenCalledWith({
      kind: 'success',
      text: 'Tarea lanzada: «Añade login con Google»',
    });
  });

  it('"Lanzar en paralelo" goes from 1 to 4 and sends N', async () => {
    const sheet = await open();
    const value = () => sheet.querySelector('.tks-stepper-value')?.textContent;
    expect(sheet.querySelector<HTMLButtonElement>('[data-testid="compose-fewer"]')?.disabled).toBe(
      true
    );
    for (let i = 0; i < 5; i++) await tap(sheet, '[data-testid="compose-more"]');
    expect(value()).toBe('×4');
    expect(sheet.querySelector<HTMLButtonElement>('[data-testid="compose-more"]')?.disabled).toBe(
      true
    );
    await tap(sheet, '[data-testid="compose-fewer"]');
    expect(value()).toBe('×3');
    expect(sheet.querySelector('[data-testid="compose-parallel-hint"]')?.textContent).toBe(
      'El mismo encargo a 3 agentes; te quedas con el mejor.'
    );
    await type(sheet, 'Arregla el teclado');
    expect(sheet.querySelector('[data-testid="compose-launch"]')?.textContent?.trim()).toBe(
      'Lanzar ×3'
    );
    await tap(sheet, '[data-testid="compose-launch"]');
    await vi.waitFor(() => expect(store.create).toHaveBeenCalled());
    expect(store.create.mock.calls[0][0]).toMatchObject({ parallel: 3 });
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'success',
        text: '3 intentos lanzados: «Arregla el teclado»',
      })
    );
  });

  it('keeps the text and says why when it cannot launch', async () => {
    store.create.mockResolvedValueOnce({ ok: false, status: 400, error: 'Not a git repository' });
    const sheet = await open();
    await type(sheet, 'Algo');
    await tap(sheet, '[data-testid="compose-launch"]');
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="compose-error"]')?.textContent).toBe(
        'No se pudo lanzar: Not a git repository'
      )
    );
    expect(sheet.querySelector<HTMLTextAreaElement>('[data-testid="compose-prompt"]')?.value).toBe(
      'Algo'
    );
    expect(document.querySelector('task-compose-sheet')).not.toBeNull();
  });

  it('"Más proyectos…" offers the repositories under the base folder', async () => {
    const sheet = await open();
    await tap(sheet, '[data-testid="compose-more-projects"]');
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-repo="/repos/found"]')).not.toBeNull()
    );
    await tap(sheet, '[data-repo="/repos/found"]');
    expect(sheet.querySelector('[aria-checked="true"][data-repo]')?.getAttribute('data-repo')).toBe(
      '/repos/found'
    );
  });

  it('keeps a named quick start as it is', () => {
    expect(agentDisplayLabel({ agent: 'claude', label: ' claude ', command: ['claude'] })).toBe(
      'Claude'
    );
    expect(agentDisplayLabel({ agent: 'codex', label: 'codex', command: ['codex'] })).toBe('Codex');
    expect(
      agentDisplayLabel({ agent: 'claude', label: 'Claude (yolo)', command: ['claude'] })
    ).toBe('Claude (yolo)');
  });

  it('Lanzar waits while the dictation is still being transcribed (2026-10-20)', async () => {
    const sheet = await open();
    await type(sheet, 'Añade login');
    (sheet as unknown as { dictation: string }).dictation = 'transcribing';
    await sheet.updateComplete;
    const launch = sheet.querySelector<HTMLButtonElement>('[data-testid="compose-launch"]');
    expect(launch?.disabled).toBe(true);
    launch?.click();
    expect(store.create).not.toHaveBeenCalled();
  });

  it('a 202 (waiting for the user’s OK) says so instead of «lanzada»', async () => {
    store.create.mockResolvedValueOnce({ ok: true, status: 202, data: {} });
    const sheet = await open();
    await type(sheet, 'Añade login');
    await tap(sheet, '[data-testid="compose-launch"]');
    await vi.waitFor(() => expect(document.querySelector('task-compose-sheet')).toBeNull());
    expect(toast).toHaveBeenCalledWith({
      kind: 'info',
      text: 'Esperando tu OK (te llega un aviso)',
    });
  });
});
