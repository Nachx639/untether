/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';

const STORAGE_KEY = 'untether_terminal_preferences';

/** A fresh singleton reading whatever localStorage holds now. */
async function freshManager() {
  vi.resetModules();
  const { TerminalPreferencesManager } = await import('./terminal-preferences.js');
  return TerminalPreferencesManager.getInstance();
}

describe('TerminalPreferencesManager themes', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });
  afterEach(() => {
    restoreLocalStorage();
  });

  it('defaults to Auto paired with Untether / Untether Light', async () => {
    const prefs = await freshManager();
    expect(prefs.getTheme()).toBe('auto');
    expect(prefs.getAutoThemePair()).toEqual({ dark: 'untether', light: 'untether-light' });
  });

  it('persists the theme and the Auto pair across reloads', async () => {
    const prefs = await freshManager();
    prefs.setTheme('catppuccin-mocha');
    prefs.setAutoTheme('dark', 'tokyo-night');
    prefs.setAutoTheme('light', 'rose-pine-dawn');

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(saved).toMatchObject({
      theme: 'catppuccin-mocha',
      autoDarkTheme: 'tokyo-night',
      autoLightTheme: 'rose-pine-dawn',
    });

    const reloaded = await freshManager();
    expect(reloaded.getTheme()).toBe('catppuccin-mocha');
    expect(reloaded.getAutoThemePair()).toEqual({ dark: 'tokyo-night', light: 'rose-pine-dawn' });
  });

  it('refuses a theme of the wrong appearance for the Auto pair', async () => {
    const prefs = await freshManager();
    prefs.setAutoTheme('dark', 'github-light');
    prefs.setAutoTheme('light', 'dracula');
    expect(prefs.getAutoThemePair()).toEqual({ dark: 'untether', light: 'untether-light' });
  });

  it('falls back to the defaults for unknown or mismatched saved ids', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        theme: 'neon',
        autoDarkTheme: 'github-light',
        autoLightTheme: 'nope',
        fontSize: 15,
      })
    );
    const prefs = await freshManager();
    expect(prefs.getTheme()).toBe('auto');
    expect(prefs.getAutoThemePair()).toEqual({ dark: 'untether', light: 'untether-light' });
    expect(prefs.getFontSize()).toBe(15);
  });
});
