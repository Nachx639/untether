// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n/index.js';
import type { TaskStore } from '../services/task-store.js';

const { toast } = vi.hoisted(() => ({ toast: vi.fn(() => () => {}) }));
vi.mock('../utils/action-toast.js', () => ({ toast }));
const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(async (): Promise<{ autoApprove?: boolean }> => ({})),
}));
vi.mock('../services/server-config-service.js', () => ({ serverConfigService: { loadConfig } }));
vi.mock('../services/auth-client.js', () => ({
  authClient: { getAuthHeader: () => ({ Authorization: 'Bearer t' }) },
}));

import { type OrchestratorSheet, openOrchestratorSheet } from './orchestrator-sheet.js';

describe('orchestrator-sheet', () => {
  let store: {
    startOrchestrator: ReturnType<typeof vi.fn>;
    adoptOrchestrator: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await setLocale('es');
    toast.mockClear();
    loadConfig.mockReset();
    loadConfig.mockResolvedValue({});
    store = {
      startOrchestrator: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { repoPath: '/repos/app', sessionId: 'orch-1', reused: false },
      })),
      adoptOrchestrator: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { repoPath: '/repos/app', sessionId: 'chat-1', reused: false },
      })),
    };
  });

  afterEach(async () => {
    document.querySelector('orchestrator-sheet')?.remove();
    vi.restoreAllMocks();
    await setLocale('en');
  });

  async function open(running = false, sessions?: Array<{ id: string; title: string }>) {
    const sheet = openOrchestratorSheet({
      repoPath: '/repos/app',
      name: 'app',
      running,
      ...(sessions ? { sessions } : {}),
      store: store as unknown as TaskStore,
    });
    await sheet.updateComplete;
    // Past the guard that ignores the tap which opened it.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    return sheet;
  }

  const type = async (sheet: OrchestratorSheet, text: string) => {
    const area = sheet.querySelector<HTMLTextAreaElement>('[data-testid="orchestrator-goal"]');
    if (!area) throw new Error('no goal field');
    area.value = text;
    area.dispatchEvent(new Event('input'));
    await sheet.updateComplete;
  };

  const start = (sheet: OrchestratorSheet) =>
    sheet.querySelector<HTMLButtonElement>('[data-testid="orchestrator-start"]');

  it('asks for the goal, with dictation, and says what the orchestrator will do', async () => {
    const sheet = await open();
    expect(sheet.querySelector('#orchestrator-sheet-title')?.textContent?.trim()).toBe(
      'Orquestar app'
    );
    expect(sheet.querySelector('[data-testid="orchestrator-mic"]')).not.toBeNull();
    expect(sheet.querySelectorAll('[data-testid="orchestrator-points"] li')).toHaveLength(3);
    expect(start(sheet)?.disabled).toBe(true);
    expect(start(sheet)?.textContent?.trim()).toBe('Empezar');
  });

  it('says what waits for the OK, by the user’s autoApprove (2026-10-24)', async () => {
    const point = (sheet: OrchestratorSheet) =>
      sheet.querySelector('[data-testid="orchestrator-point-ok"]')?.textContent?.trim();
    const off = await open();
    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalledWith(true));
    await off.updateComplete;
    expect(point(off)).toBe('Lo arriesgado y descartar trabajo siempre esperan tu OK.');
    off.remove();

    loadConfig.mockResolvedValue({ autoApprove: true });
    const on = await open();
    await vi.waitFor(() =>
      expect(point(on)).toBe(
        'Lo arriesgado pasa una segunda revisión y una cuenta atrás de 10 minutos que puedes parar; lo demás se hace sin preguntarte, con un aviso.'
      )
    );
    expect(point(on)).not.toContain('esperan tu OK');
  });

  it('keeps today’s line when the setting cannot be read', async () => {
    loadConfig.mockRejectedValue(new Error('offline'));
    const sheet = await open();
    await vi.waitFor(() => expect(loadConfig).toHaveBeenCalled());
    await sheet.updateComplete;
    expect(sheet.querySelector('[data-testid="orchestrator-point-ok"]')?.textContent?.trim()).toBe(
      'Lo arriesgado y descartar trabajo siempre esperan tu OK.'
    );
  });

  it('starts the orchestrator with the goal and closes', async () => {
    const sheet = await open();
    await type(sheet, '  Añade login con Google y GitHub  ');
    start(sheet)?.click();
    await vi.waitFor(() => expect(store.startOrchestrator).toHaveBeenCalled());
    expect(store.startOrchestrator).toHaveBeenCalledWith(
      '/repos/app',
      'Añade login con Google y GitHub'
    );
    await vi.waitFor(() => expect(document.querySelector('orchestrator-sheet')).toBeNull());
    expect(toast).toHaveBeenCalledWith({
      kind: 'success',
      text: 'Orquestador en marcha en app',
    });
  });

  it('says when the brief is queued (pending) rather than typed in', async () => {
    store.startOrchestrator.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { sessionId: 'o', pending: true },
    });
    const sheet = await open();
    await type(sheet, 'Añade login');
    start(sheet)?.click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'success',
        text: 'Orquestador preparándose en app: recibirá el objetivo en cuanto esté listo',
      })
    );
  });

  it('gives a running orchestrator a new goal', async () => {
    store.startOrchestrator.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { reused: true },
    });
    const sheet = await open(true);
    expect(sheet.querySelector('#orchestrator-sheet-title')?.textContent?.trim()).toBe(
      'Nuevo objetivo'
    );
    expect(start(sheet)?.textContent?.trim()).toBe('Enviar objetivo');
    await type(sheet, 'Y el logout');
    start(sheet)?.click();
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        kind: 'success',
        text: 'Objetivo enviado al orquestador de app',
      })
    );
  });

  it('keeps the goal and shows why when it cannot start', async () => {
    store.startOrchestrator.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'Not inside a git repository',
    });
    const sheet = await open();
    await type(sheet, 'Algo');
    start(sheet)?.click();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="orchestrator-error"]')?.textContent).toBe(
        'No se pudo empezar: esta carpeta no es un repositorio git'
      )
    );
    // The server's English stays out of sight, under «Detalles».
    expect(
      sheet.querySelector('[data-testid="orchestrator-error-details"] code')?.textContent
    ).toBe('Not inside a git repository');
    expect(document.querySelector('orchestrator-sheet')).not.toBeNull();
    expect(
      sheet.querySelector<HTMLTextAreaElement>('[data-testid="orchestrator-goal"]')?.value
    ).toBe('Algo');
  });

  it('an unknown server error reads as a generic Spanish sentence', async () => {
    store.startOrchestrator.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: 'ENOSPC: no space left on device',
    });
    const sheet = await open();
    await type(sheet, 'Algo');
    start(sheet)?.click();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="orchestrator-error"]')?.textContent).toBe(
        'No se pudo empezar: algo ha fallado; vuelve a intentarlo'
      )
    );
    expect(
      sheet.querySelector('[data-testid="orchestrator-error-details"] code')?.textContent
    ).toContain('ENOSPC');
  });

  it('a project that already has an orchestrator says so in Spanish', async () => {
    store.startOrchestrator.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'This project already has an orchestrator: stop it first',
    });
    const sheet = await open();
    await type(sheet, 'Algo');
    start(sheet)?.click();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="orchestrator-error"]')?.textContent).toBe(
        'No se pudo empezar: este proyecto ya tiene orquestador: detenlo primero'
      )
    );
  });

  it('offers the open sessions: "Hacer orquestador" keeps one, with the goal if typed', async () => {
    expect((await open()).querySelector('[data-testid="orchestrator-adopt"]')).toBeNull();
    document.querySelector('orchestrator-sheet')?.remove();
    vi.restoreAllMocks();
    const sheet = await open(false, [{ id: 'chat-1', title: 'ATLAS' }]);
    const button = sheet.querySelector<HTMLButtonElement>(
      '[data-testid="orchestrator-adopt-session"]'
    );
    expect(button?.getAttribute('aria-label')).toBe('Hacer orquestador a ATLAS');
    await type(sheet, 'Termina el emparejado');
    button?.click();
    await vi.waitFor(() =>
      expect(store.adoptOrchestrator).toHaveBeenCalledWith(
        '/repos/app',
        'chat-1',
        'Termina el emparejado'
      )
    );
    await vi.waitFor(() => expect(document.querySelector('orchestrator-sheet')).toBeNull());
    expect(toast).toHaveBeenCalledWith({
      kind: 'success',
      text: 'ATLAS ya es el orquestador de app',
    });
  });

  it('lists no sessions while an orchestrator runs', async () => {
    const sheet = await open(true, [{ id: 'chat-1', title: 'ATLAS' }]);
    expect(sheet.querySelector('[data-testid="orchestrator-adopt"]')).toBeNull();
  });

  it('Empezar waits while the dictation is still being transcribed (2026-10-20)', async () => {
    const sheet = await open();
    await type(sheet, 'Añade login');
    (sheet as unknown as { dictation: string }).dictation = 'transcribing';
    await sheet.updateComplete;
    expect(start(sheet)?.disabled).toBe(true);
    start(sheet)?.click();
    expect(store.startOrchestrator).not.toHaveBeenCalled();
  });

  it('says a refusal in the user’s language', async () => {
    store.startOrchestrator.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: 'Orchestrators are not available here',
    });
    const sheet = await open();
    await type(sheet, 'Añade login');
    start(sheet)?.click();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="orchestrator-error"]')?.textContent).toBe(
        'No se pudo empezar: las tareas aún no están disponibles en el ordenador'
      )
    );
  });
});
