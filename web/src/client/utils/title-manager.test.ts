// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n/index.js';
import { titleManager } from './title-manager.js';

describe('titleManager', () => {
  beforeEach(async () => {
    await setLocale('en');
  });

  afterEach(async () => {
    await setLocale('en');
  });

  it('counts sessions in the page title with the language’s own singular and plural', async () => {
    titleManager.setListTitle(1);
    expect(document.title).toBe('Untether - 1 Session');
    titleManager.setListTitle(3);
    expect(document.title).toBe('Untether - 3 Sessions');
    titleManager.setListTitle(0);
    expect(document.title).toBe('Untether');

    await setLocale('es');
    titleManager.setListTitle(1);
    expect(document.title).toBe('Untether - 1 sesión');
    titleManager.setListTitle(3);
    expect(document.title).toBe('Untether - 3 sesiones');
  });

  it('names the file browser in the chosen language', async () => {
    await setLocale('es');
    titleManager.setFileBrowserTitle();
    expect(document.title).toBe('Untether - Explorador de archivos');
  });

  it('names the session tab "name — Untether", with ● while Claude waits', () => {
    titleManager.setSessionTitle('api');
    expect(document.title).toBe('api — Untether');
    titleManager.setSessionTitle('api', { waiting: true });
    expect(document.title).toBe('● api — Untether');
  });

  // 2026-10-12: only ?session= was read, so /session/<id> counted as the list and a session
  // tab could show "Untether - 3 sessions".
});
