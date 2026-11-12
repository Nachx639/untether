// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitInitPreview, GitInitReview } from '../../shared/git-init.js';
import { setLocale } from '../i18n/index.js';
import { defaultExcluded, formatSize, mergeRows, openGitInitSheet } from './git-init-sheet.js';

const PREVIEW: GitInitPreview = {
  folder: '/Users/n/Projects/tele',
  files: 12,
  size: 3 * 1024 * 1024,
  capped: false,
  ignore: [
    { pattern: 'node_modules/', matches: 1 },
    { pattern: '.env', matches: 1 },
  ],
  flagged: [
    {
      path: 'notes/keys.txt',
      size: 40,
      reasons: [{ kind: 'secret-content', detail: 'AWS access key' }],
      defaultExcluded: true,
    },
    {
      path: 'video.mp4',
      size: 6 * 1024 * 1024,
      reasons: [{ kind: 'big' }],
      defaultExcluded: false,
    },
    { path: 'big.zip', size: 7 * 1024 * 1024, reasons: [{ kind: 'big' }], defaultExcluded: false },
  ],
  hasGitignore: false,
};

describe('git-init sheet', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let review: GitInitReview | Promise<never>;
  let resolveReview: (() => void) | null;

  beforeEach(async () => {
    await setLocale('es');
    resolveReview = null;
    review = {
      status: 'done',
      summary: 'Hay una clave y un vídeo pesado',
      verdicts: [
        { path: 'video.mp4', action: 'exclude', reason: 'Vídeo generado' },
        { path: 'data/dump.sql', action: 'exclude', reason: 'Volcado con datos personales' },
      ],
    };
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects/git-init/preview') return Response.json(PREVIEW);
      if (url === '/api/projects/git-init/review') {
        if (review instanceof Promise) return review;
        const body = review;
        return new Promise<Response>((resolve) => {
          resolveReview = () => resolve(Response.json(body));
        });
      }
      if (url === '/api/projects/git-init') {
        return Response.json({ repoPath: '/Users/n/Projects/tele', commit: 'abc', files: 10 });
      }
      return Response.json({}, { status: 404, statusText: String(init?.method) });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    document.querySelector('git-init-sheet')?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await setLocale('en');
  });

  const checked = (sheet: HTMLElement, path: string) =>
    sheet
      .querySelector(`[data-path="${path}"] [data-testid="git-init-check"]`)
      ?.getAttribute('aria-checked');

  it('formats sizes and merges rule flags with AI verdicts', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(6 * 1024 * 1024)).toBe('6.0 MB');
    const rows = mergeRows(PREVIEW.flagged, [
      { path: 'video.mp4', action: 'exclude', reason: 'x' },
      { path: 'notes/keys.txt', action: 'include', reason: 'falso positivo' },
      { path: 'other.txt', action: 'include', reason: 'bien' },
      { path: 'dump.sql', action: 'exclude', reason: 'datos' },
    ]);
    expect(rows.map((row) => row.path)).toEqual([
      'notes/keys.txt',
      'video.mp4',
      'big.zip',
      'dump.sql',
    ]);
    // A secret by the rules stays out even if the AI says include; a big file goes in unless
    // the AI says to leave it out.
    expect(rows.map(defaultExcluded)).toEqual([true, true, false, true]);
  });

  it('shows the preview, then the AI review, and activates with the unticked files', async () => {
    const onActivated = vi.fn();
    const sheet = openGitInitSheet({
      folder: '/Users/n/Projects/tele',
      name: 'tele',
      onActivated,
    });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="git-init-summary"]')).not.toBeNull()
    );
    expect(sheet.querySelector('#git-init-title')?.textContent?.trim()).toBe(
      'Control de versiones en tele'
    );
    expect(sheet.querySelector('[data-testid="git-init-intro"]')?.textContent?.trim()).toBe(
      'Esta carpeta aún no tiene control de versiones. Actívalo para que las tareas trabajen aisladas y se puedan fusionar o deshacer.'
    );
    expect(sheet.querySelector('[data-testid="git-init-summary"]')?.textContent?.trim()).toBe(
      'Entrarán 12 archivos · 3.0 MB'
    );
    expect(sheet.querySelector('[data-testid="git-init-ignore"]')?.textContent).toContain(
      'node_modules/'
    );
    expect(sheet.querySelector('[data-testid="git-init-review"]')?.textContent?.trim()).toBe(
      'Comprobando con IA…'
    );
    // Rules only so far: the key out, the big files in.
    expect(checked(sheet, 'notes/keys.txt')).toBe('false');
    expect(checked(sheet, 'video.mp4')).toBe('true');
    expect(sheet.querySelector('[data-path="notes/keys.txt"]')?.textContent).toContain(
      'Parece contener una clave (AWS access key)'
    );

    // The user keeps big.zip out by hand before the AI answers.
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet
      .querySelector<HTMLButtonElement>('[data-path="big.zip"] [data-testid="git-init-check"]')
      ?.click();
    await sheet.updateComplete;
    expect(checked(sheet, 'big.zip')).toBe('false');

    resolveReview?.();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="git-init-review"]')?.textContent?.trim()).toBe(
        'Revisión IA: Hay una clave y un vídeo pesado'
      )
    );
    // The AI moved the untouched video out and added a file of its own, with reasons.
    expect(checked(sheet, 'video.mp4')).toBe('false');
    expect(sheet.querySelector('[data-path="video.mp4"]')?.textContent).toContain(
      'La IA sugiere dejarlo fuera: Vídeo generado'
    );
    expect(checked(sheet, 'data/dump.sql')).toBe('false');
    // …and the user lets the video in after all.
    sheet
      .querySelector<HTMLButtonElement>('[data-path="video.mp4"] [data-testid="git-init-check"]')
      ?.click();
    await sheet.updateComplete;

    sheet.querySelector<HTMLButtonElement>('[data-testid="git-init-activate"]')?.click();
    later.mockRestore();
    await vi.waitFor(() => expect(onActivated).toHaveBeenCalledWith('/Users/n/Projects/tele'));
    expect(document.querySelector('git-init-sheet')).toBeNull();
    const init = fetchMock.mock.calls.find(([url]) => url === '/api/projects/git-init');
    expect(JSON.parse(init?.[1].body)).toEqual({
      folder: '/Users/n/Projects/tele',
      exclude: ['notes/keys.txt', 'big.zip', 'data/dump.sql'],
    });
    const reviewCall = fetchMock.mock.calls.find(
      ([url]) => url === '/api/projects/git-init/review'
    );
    expect(JSON.parse(reviewCall?.[1].body)).toEqual({
      folder: '/Users/n/Projects/tele',
      locale: 'es',
    });
  });

  it('says when the AI review could not run, and Cancelar creates nothing', async () => {
    review = Promise.reject(new Error('offline'));
    const onActivated = vi.fn();
    const sheet = openGitInitSheet({ folder: '/Users/n/Projects/tele', name: 'tele', onActivated });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="git-init-review"]')?.textContent?.trim()).toBe(
        'La revisión con IA no ha podido hacerse; las reglas de arriba siguen valiendo.'
      )
    );
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="git-init-cancel"]')?.click();
    later.mockRestore();
    expect(document.querySelector('git-init-sheet')).toBeNull();
    expect(onActivated).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/projects/git-init')).toBe(false);
  });

  it('shows why the folder cannot be turned into a repository', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ error: 'Already inside a git repository' }, { status: 409 })
    );
    const sheet = openGitInitSheet({ folder: '/Users/n/Projects/tele', name: 'tele' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('.ans-error')?.textContent).toContain(
        'No se pudo revisar la carpeta: Already inside a git repository'
      )
    );
    expect(sheet.querySelector('[data-testid="git-init-activate"]')).toBeNull();
  });
  it('a folder too big to be a project says what to do, and can be tried again', async () => {
    let tooBig = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/projects/git-init/preview') {
        if (tooBig) {
          return Response.json(
            { error: 'The folder has more than 20000 files', code: 'bad-request' },
            { status: 400 }
          );
        }
        return Response.json(PREVIEW);
      }
      return Response.json({ status: 'unavailable', verdicts: [] });
    });
    const sheet = openGitInitSheet({ folder: '/Users/n', name: 'n' });
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="git-init-error"]')).not.toBeNull()
    );
    expect(sheet.querySelector('[data-testid="git-init-error"]')?.textContent).toContain(
      'Esta carpeta tiene más de 20000 archivos'
    );
    tooBig = false;
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    sheet.querySelector<HTMLButtonElement>('[data-testid="git-init-retry"]')?.click();
    later.mockRestore();
    await vi.waitFor(() =>
      expect(sheet.querySelector('[data-testid="git-init-summary"]')).not.toBeNull()
    );
  });
});
