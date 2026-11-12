// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { setLocale } from '../i18n/index.js';
import type { TaskStore } from '../services/task-store.js';

const { toast } = vi.hoisted(() => ({ toast: vi.fn(() => () => {}) }));
vi.mock('../utils/action-toast.js', () => ({ toast }));
// The real browser lists folders from the server; here it is only the element and its events.
vi.mock('./file-browser.js', () => ({}));

import { type NewProjectSheet, openNewProjectSheet } from './new-project-sheet.js';

describe('new-project-sheet', () => {
  let store: {
    newProjectStart: ReturnType<typeof vi.fn>;
    createProject: ReturnType<typeof vi.fn>;
  };
  let created: Array<{ repoPath: string; name: string }>;

  beforeEach(async () => {
    await setLocale('es');
    toast.mockClear();
    created = [];
    store = {
      newProjectStart: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { parent: '/Users/me/Work' },
      })),
      createProject: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: {
          repoPath: '/Users/me/Work/tele-ambiente',
          name: 'Tele Ambiente',
          branch: 'main',
          commit: 'abc',
        },
      })),
    };
  });

  afterEach(async () => {
    document.querySelector('new-project-sheet')?.remove();
    vi.restoreAllMocks();
    await setLocale('en');
  });

  async function open() {
    const sheet = openNewProjectSheet({
      store: store as unknown as TaskStore,
      onCreated: (project) => created.push(project),
    });
    await sheet.updateComplete;
    await Promise.resolve();
    await sheet.updateComplete;
    // Past the guard that ignores the tap which opened it.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    return sheet;
  }

  const q = <T extends Element>(sheet: NewProjectSheet, id: string) =>
    sheet.querySelector<T>(`[data-testid="${id}"]`);

  const typeName = async (sheet: NewProjectSheet, text: string) => {
    const input = q<HTMLInputElement>(sheet, 'new-project-name');
    if (!input) throw new Error('no name field');
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await sheet.updateComplete;
  };

  const typeGoal = async (sheet: NewProjectSheet, text: string) => {
    const area = q<HTMLTextAreaElement>(sheet, 'new-project-goal');
    if (!area) throw new Error('no goal field');
    area.value = text;
    area.dispatchEvent(new Event('input'));
    await sheet.updateComplete;
  };

  /** «Dónde»: the browser opens where it should start, and the user picks `dir`. */
  const pick = async (sheet: NewProjectSheet, dir: string) => {
    q<HTMLButtonElement>(sheet, 'new-project-dir')?.click();
    await sheet.updateComplete;
    const browser = sheet.querySelector('file-browser') as
      | (HTMLElement & { session: Session | null; mode: string })
      | null;
    if (!browser) throw new Error('no browser');
    const start = browser.session?.workingDir;
    browser.dispatchEvent(new CustomEvent('directory-selected', { detail: dir }));
    await sheet.updateComplete;
    return { start, mode: browser.mode };
  };

  const create = (sheet: NewProjectSheet) => q<HTMLButtonElement>(sheet, 'new-project-create');

  it('needs a name and «Dónde»: no parent is filled in for the user', async () => {
    const sheet = await open();
    expect(sheet.querySelector('#new-project-sheet-title')?.textContent?.trim()).toBe(
      'Nuevo proyecto'
    );
    expect(q(sheet, 'new-project-dir')?.textContent?.trim()).toBe('Elige una carpeta…');
    expect(create(sheet)?.disabled).toBe(true);
    await typeName(sheet, 'Tele Ambiente');
    // Named, but nowhere yet.
    expect(create(sheet)?.disabled).toBe(true);
    expect(q(sheet, 'new-project-path')).toBeNull();
    expect(store.createProject).not.toHaveBeenCalled();
  });

  it('starts the browser at the last parent picked, shows the folder and creates it', async () => {
    const sheet = await open();
    await typeName(sheet, 'Tele Ambiente');
    const browsed = await pick(sheet, '/Users/me/Work');
    expect(browsed).toEqual({ start: '/Users/me/Work', mode: 'select' });
    expect(sheet.querySelector('file-browser')).toBeNull();
    expect(q(sheet, 'new-project-path')?.textContent?.trim()).toBe(
      'Se creará en ~/Work/tele-ambiente'
    );
    expect(create(sheet)?.disabled).toBe(false);
    expect(create(sheet)?.textContent?.trim()).toBe('Crear proyecto');
    create(sheet)?.click();
    await vi.waitFor(() => expect(store.createProject).toHaveBeenCalled());
    expect(store.createProject).toHaveBeenCalledWith({
      name: 'Tele Ambiente',
      dir: '/Users/me/Work',
      goal: '',
    });
    await vi.waitFor(() => expect(document.querySelector('new-project-sheet')).toBeNull());
    expect(created).toEqual([{ repoPath: '/Users/me/Work/tele-ambiente', name: 'Tele Ambiente' }]);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', text: 'Proyecto Tele Ambiente creado' })
    );
  });

  it('with a goal, creates and orchestrates', async () => {
    store.createProject.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        repoPath: '/Users/me/Work/atlas',
        name: 'Atlas',
        orchestrator: { ok: true, sessionId: 'orch-1' },
      },
    });
    const sheet = await open();
    await typeName(sheet, 'Atlas');
    await pick(sheet, '/Users/me/Work');
    await typeGoal(sheet, 'Un bot de recados');
    expect(create(sheet)?.textContent?.trim()).toBe('Crear y orquestar');
    create(sheet)?.click();
    await vi.waitFor(() =>
      expect(store.createProject).toHaveBeenCalledWith({
        name: 'Atlas',
        dir: '/Users/me/Work',
        goal: 'Un bot de recados',
      })
    );
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Proyecto Atlas creado; su orquestador está arrancando' })
      )
    );
  });

  it('says a refusal in plain words and keeps what was typed', async () => {
    store.createProject.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'exists',
      message: '/Users/me/Work/tele-ambiente exists already',
    });
    const sheet = await open();
    await typeName(sheet, 'Tele Ambiente');
    await pick(sheet, '/Users/me/Work');
    create(sheet)?.click();
    await vi.waitFor(() => expect(q(sheet, 'new-project-error')).not.toBeNull());
    expect(q(sheet, 'new-project-error')?.textContent).toBe(
      'Ya existe una carpeta llamada tele-ambiente ahí: elige otro nombre u otro sitio'
    );
    expect(q(sheet, 'new-project-error-details')?.textContent).toContain('exists already');
    expect(q<HTMLInputElement>(sheet, 'new-project-name')?.value).toBe('Tele Ambiente');
    expect(document.querySelector('new-project-sheet')).not.toBeNull();
  });

  it('a name that is a path is refused before anything is sent', async () => {
    const sheet = await open();
    await typeName(sheet, '../x');
    await pick(sheet, '/Users/me/Work');
    expect(q(sheet, 'new-project-name-bad')).not.toBeNull();
    expect(create(sheet)?.disabled).toBe(true);
  });
});
