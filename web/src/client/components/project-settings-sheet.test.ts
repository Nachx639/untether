// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n/index.js';
import {
  checkCommandFor,
  connectorsToSave,
  openProjectSettingsSheet,
} from './project-settings-sheet.js';

describe('project settings sheet', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await setLocale('es');
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/settings?')) {
        return Response.json({
          repoPath: '/repos/app',
          settings: { mergePolicy: 'ask', riskIgnore: ['docs/**'] },
        });
      }
      if (url.startsWith('/api/projects/detect-check')) {
        return Response.json({ checks: [{ command: 'pnpm run check', dir: 'web' }] });
      }
      if (init?.method === 'PUT') return Response.json({ settings: {} });
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    document.querySelector('project-settings-sheet')?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await setLocale('en');
  });

  it('turns a detected check into one command', () => {
    expect(checkCommandFor({ command: 'pnpm test', dir: '.' })).toBe('pnpm test');
    expect(checkCommandFor({ command: 'pnpm test', dir: 'web' })).toBe('cd web && pnpm test');
    expect(checkCommandFor({ command: 'make', dir: 'my app' })).toBe("cd 'my app' && make");
  });

  it('shows the stored choice, offers the detected check and saves (empty clears)', async () => {
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-merge-ask"]')).not.toBeNull()
    );
    await sheet.updateComplete;
    expect(sheet.querySelector('#project-settings-title')?.textContent?.trim()).toBe(
      'Tareas en app'
    );
    expect(
      sheet.querySelector('[data-testid="project-merge-ask"]')?.getAttribute('aria-checked')
    ).toBe('true');
    expect(sheet.querySelector('[data-testid="project-merge-auto"]')?.textContent).toContain(
      'Fusionar sola si todo va bien'
    );
    expect(sheet.querySelector('[data-testid="project-detected"]')?.textContent).toContain(
      'cd web && pnpm run check'
    );

    // Taps right after opening belong to the gesture that opened it.
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-merge-auto"]')?.click();
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-use-detected"]')?.click();
    await sheet.updateComplete;
    expect(sheet.querySelector<HTMLInputElement>('[data-testid="project-check"]')?.value).toBe(
      'cd web && pnpm run check'
    );
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.click();
    later.mockRestore();

    await vi.waitFor(() => expect(document.querySelector('project-settings-sheet')).toBeNull());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1].body)).toEqual({
      repoPath: '/repos/app',
      settings: {
        mergePolicy: 'auto',
        checkCommand: 'cd web && pnpm run check',
        // No task limit unless one is typed (2026-11-01).
        maxActiveTasks: null,
        // On by default (nothing merges unreviewed): said explicitly either way.
        aiReview: true,
        // Model by difficulty off and the other agent only offered unless chosen (2026-11-01).
        modelRouting: null,
        agentFallback: null,
        // Off by default: the sweep's switch saves nothing until turned on.
        securitySweep: null,
        // No provider connector unless the user sets one up (2026-10-26).
        securityConnectors: null,
        setupCommand: null,
        riskIgnore: ['docs/**'],
      },
    });
  });

  it('saves the tasks-at-once limit as a number (project task limit, 2026-11-01)', async () => {
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() => expect(sheet.querySelector('#project-max-active-tasks')).not.toBeNull());
    await sheet.updateComplete;
    const input = sheet.querySelector<HTMLInputElement>('#project-max-active-tasks');
    expect(input?.value).toBe('');
    if (input) {
      input.value = '2';
      input.dispatchEvent(new Event('input'));
    }
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.click();
    later.mockRestore();
    await vi.waitFor(() => expect(document.querySelector('project-settings-sheet')).toBeNull());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1].body).settings.maxActiveTasks).toBe(2);
  });

  it('model by difficulty and the other agent at a limit: shown as stored, saved as chosen (2026-11-01)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/settings?')) {
        return Response.json({ settings: { mergePolicy: 'auto', agentFallback: 'off' } });
      }
      if (init?.method === 'PUT') return Response.json({ settings: {} });
      return Response.json({});
    });
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-model-routing"]')).not.toBeNull()
    );
    await sheet.updateComplete;
    const routing = () =>
      sheet.querySelector<HTMLButtonElement>('[data-testid="project-model-routing"]');
    const fallback = (mode: string) =>
      sheet.querySelector<HTMLButtonElement>(`[data-testid="project-fallback-${mode}"]`);
    expect(routing()?.getAttribute('aria-checked')).toBe('false');
    expect(routing()?.textContent).toContain('Modelo según la dificultad');
    expect(fallback('off')?.getAttribute('aria-checked')).toBe('true');
    expect(fallback('auto')?.textContent).toContain('Cambiar sola');
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    routing()?.click();
    fallback('auto')?.click();
    await sheet.updateComplete;
    expect(routing()?.getAttribute('aria-checked')).toBe('true');
    expect(fallback('auto')?.getAttribute('aria-checked')).toBe('true');
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.click();
    later.mockRestore();
    await vi.waitFor(() => expect(document.querySelector('project-settings-sheet')).toBeNull());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1].body).settings).toMatchObject({
      modelRouting: true,
      agentFallback: 'auto',
    });
  });

  it('turns the AI review off and on (on is the default)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/settings?')) {
        return Response.json({ settings: { mergePolicy: 'auto' } });
      }
      if (init?.method === 'PUT') return Response.json({ settings: {} });
      return Response.json({});
    });
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-ai-review"]')).not.toBeNull()
    );
    await sheet.updateComplete;
    const toggle = () =>
      sheet.querySelector<HTMLButtonElement>('[data-testid="project-ai-review"]');
    expect(toggle()?.getAttribute('role')).toBe('switch');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(toggle()?.textContent).toContain('Revisión por IA');
    expect(sheet.querySelector('#pss-ai-review-hint')?.textContent).toContain(
      'Nada se fusiona sin revisión'
    );
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    toggle()?.click();
    await sheet.updateComplete;
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    toggle()?.click();
    await sheet.updateComplete;
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    toggle()?.click();
    await sheet.updateComplete;
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.click();
    later.mockRestore();
    await vi.waitFor(() => expect(document.querySelector('project-settings-sheet')).toBeNull());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    // Turned off: stored as false (the default is on).
    expect(JSON.parse(put?.[1].body).settings.aiReview).toBe(false);
  });

  it('the security sweep: one switch, off by default, its rounds and dismissals shown (2026-10-23)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/settings?')) {
        return Response.json({
          settings: { mergePolicy: 'auto', securitySweep: true },
          security: {
            enabled: true,
            paused: false,
            running: false,
            lastRoundAt: '2026-10-23T08:00:00.000Z',
            lastResult: 'dismissed',
            nextRoundAt: '2026-10-23T14:00:00.000Z',
            log: [
              {
                at: '2026-10-23T08:10:00.000Z',
                section: 'web',
                verdict: 'dismissed',
                reason: 'La entrada ya se valida',
                finding: {
                  file: 'src/db.ts',
                  line: 12,
                  severity: 'high',
                  category: 'injection',
                  title: 'SQL armado a mano',
                  exploit: 'x',
                  fix: 'y',
                },
                agent: 'claude',
                reviewer: 'codex',
              },
            ],
          },
        });
      }
      if (init?.method === 'PUT') return Response.json({ settings: {} });
      return Response.json({});
    });
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-security-sweep"]')).not.toBeNull()
    );
    await sheet.updateComplete;
    const toggle = () =>
      sheet.querySelector<HTMLButtonElement>('[data-testid="project-security-sweep"]');
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(toggle()?.textContent).toContain('Barrido de seguridad');
    const status =
      sheet.querySelector('[data-testid="project-security-status"]')?.textContent ?? '';
    expect(status).toContain('Último barrido');
    expect(status).toContain('hallazgos descartados por el revisor');
    expect(status).toContain('Próximo');
    const dismissed =
      sheet.querySelector('[data-testid="project-security-dismissed"]')?.textContent ?? '';
    expect(dismissed).toContain('Descartados por el revisor (1)');
    expect(dismissed).toContain('SQL armado a mano');
    expect(dismissed).toContain('La entrada ya se valida');
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    toggle()?.click();
    await sheet.updateComplete;
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.click();
    later.mockRestore();
    await vi.waitFor(() => expect(document.querySelector('project-settings-sheet')).toBeNull());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    // Off again: back to the default (null clears it).
    expect(JSON.parse(put?.[1].body).settings.securitySweep).toBeNull();
  });

  it('what the project exposes, and a connector set up from the sheet (2026-10-26)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/settings?')) {
        return Response.json({
          settings: { mergePolicy: 'auto', securitySweep: true },
          security: {
            enabled: true,
            paused: false,
            running: false,
            log: [],
            exposure: {
              checkedAt: '2026-10-26T08:00:00.000Z',
              surface: ['Docker Compose (compose.yaml)'],
              findings: [
                {
                  key: 'listener:node:5173',
                  source: 'listener',
                  severity: 'high',
                  title: 'node listens on *:5173',
                  detail: 'x',
                  fix: 'Bind it to 127.0.0.1',
                  fixable: true,
                },
              ],
              errors: ['tailscale: no credential in the environment variable X'],
            },
          },
        });
      }
      if (init?.method === 'PUT') return Response.json({ settings: {} });
      return Response.json({});
    });
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-exposure"]')).not.toBeNull()
    );
    const exposure = sheet.querySelector('[data-testid="project-exposure"]')?.textContent ?? '';
    expect(exposure).toContain('Expuesto: Docker Compose (compose.yaml)');
    expect(exposure).toContain('Alto: node listens on *:5173');
    expect(exposure).toContain('No se pudo mirar (1)');
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-connector-tailscale"]')?.click();
    await sheet.updateComplete;
    const input = (id: string, value: string) => {
      const field = sheet.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
      expect(field).not.toBeNull();
      if (!field) return;
      field.value = value;
      field.dispatchEvent(new Event('input'));
    };
    input('project-connector-tailscale-name', 'my-service');
    input('project-connector-tailscale-tag', 'tag:web');
    await sheet.updateComplete;
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.click();
    later.mockRestore();
    await vi.waitFor(() => expect(document.querySelector('project-settings-sheet')).toBeNull());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1].body).settings.securityConnectors).toEqual([
      {
        provider: 'tailscale',
        credential: { from: 'keychain', name: 'my-service' },
        options: { tag: 'tag:web' },
      },
    ]);
  });

  it('shows paused automatic merges and turns them back on at once', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/settings?')) {
        return Response.json({
          settings: {
            mergePolicy: 'auto',
            autoMergePausedUntil: until,
            autoMergePausedReason: '3 of its tasks still failed after the automatic fixes',
            autoMergePausedCode: 'failures',
            autoMergePausedCount: 3,
          },
        });
      }
      if (init?.method === 'PUT') return Response.json({ settings: {} });
      return Response.json({});
    });
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-settings-paused"]')).not.toBeNull()
    );
    const paused = sheet.querySelector('[data-testid="project-settings-paused"]')?.textContent;
    expect(paused).toContain(
      '3 tareas siguieron fallando tras los arreglos automáticos en las últimas 24 horas'
    );
    expect(paused).not.toContain('still failed');
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-resume"]')?.click();
    later.mockRestore();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-settings-paused"]')).toBeNull()
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1].body)).toEqual({
      repoPath: '/repos/app',
      settings: { autoMergePausedUntil: null },
    });
  });

  it('a refused save says so in Spanish, the server text only under Detalles', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/projects/settings?')) {
        return Response.json({ settings: { mergePolicy: 'auto' } });
      }
      if (init?.method === 'PUT') {
        return Response.json(
          { error: 'checkCommand: Too big: expected string to have <=2000 characters' },
          { status: 400 }
        );
      }
      return Response.json({});
    });
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-settings-save"]')).not.toBeNull()
    );
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-save"]')?.click();
    later.mockRestore();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-settings-error"]')).not.toBeNull()
    );
    expect(sheet.querySelector('[data-testid="project-settings-error"]')?.textContent).toBe(
      'No se pudo guardar: algún valor no es válido'
    );
    expect(
      sheet.querySelector('[data-testid="project-settings-error-details"] code')?.textContent
    ).toContain('Too big');
  });

  it('a settings read that failed can be tried again', async () => {
    let fail = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/projects/settings?')) {
        if (fail) return new Response('', { status: 500 });
        return Response.json({ settings: { mergePolicy: 'auto' } });
      }
      return Response.json({});
    });
    const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-settings-retry"]')).not.toBeNull()
    );
    fail = false;
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="project-settings-retry"]')?.click();
    later.mockRestore();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="project-settings-save"]')).not.toBeNull()
    );
  });

  it('with no check detected, says what autoApprove does instead of a wait (2026-10-24)', async () => {
    const answer = (autoApprove: boolean, mergePolicy: 'auto' | 'ask') =>
      fetchMock.mockImplementation(async (url: string) => {
        if (url.startsWith('/api/projects/settings?')) {
          return Response.json({ repoPath: '/repos/app', settings: { mergePolicy } });
        }
        if (url.startsWith('/api/projects/detect-check')) return Response.json({ checks: [] });
        if (url === '/api/config') return Response.json({ autoApprove });
        return Response.json({});
      });
    const hint = async () => {
      const sheet = openProjectSettingsSheet({ repoPath: '/repos/app', name: 'app' });
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.some(([url]) => url === '/api/config')).toBe(true)
      );
      await vi.waitFor(() =>
        expect(sheet.querySelector('[data-testid="project-detected-none"]')).not.toBeNull()
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await sheet.updateComplete;
      const text = sheet
        .querySelector('[data-testid="project-detected-none"]')
        ?.textContent?.trim();
      sheet.remove();
      fetchMock.mockClear();
      return text;
    };

    answer(false, 'auto');
    expect(await hint()).toBe('No se detecta nada: las tareas terminadas te esperarán.');
    answer(true, 'auto');
    expect(await hint()).toBe(
      'No se detecta nada: las tareas terminadas se fusionan tras una cuenta atrás de 10 minutos que puedes parar.'
    );
    // «Preguntarme siempre» still waits, autoApprove or not.
    answer(true, 'ask');
    expect(await hint()).toBe('No se detecta nada: las tareas terminadas te esperarán.');
  });
});

describe('provider connectors (2026-10-26)', () => {
  it('saves only the ones turned on with a credential name, trimmed, empty options left out', () => {
    expect(connectorsToSave({})).toBeNull();
    expect(
      connectorsToSave({
        tailscale: { on: false, from: 'env', name: 'VAR', account: '', options: {} },
      })
    ).toBeNull();
    expect(
      connectorsToSave({
        tailscale: { on: true, from: 'keychain', name: '  ', account: '', options: {} },
      })
    ).toBeNull();
    expect(
      connectorsToSave({
        tailscale: {
          on: true,
          from: 'env',
          name: ' API_KEY ',
          // An account only matters for the keychain.
          account: 'someone',
          options: { tag: ' tag:web ', sharedPorts: '' },
        },
      })
    ).toEqual([
      {
        provider: 'tailscale',
        credential: { from: 'env', name: 'API_KEY' },
        options: { tag: 'tag:web' },
      },
    ]);
  });
});
