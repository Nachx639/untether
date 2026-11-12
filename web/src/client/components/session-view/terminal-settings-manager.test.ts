// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lastFixedWidth,
  TERMINAL_BG_VAR,
  TerminalSettingsManager,
} from './terminal-settings-manager.js';

const callbacks = () => ({
  getSession: () => null,
  getTerminalElement: () => null,
  requestUpdate: vi.fn(),
  setTerminalMaxCols: vi.fn(),
  setTerminalFontSize: vi.fn(),
  setTerminalTheme: vi.fn(),
  setShowWidthSelector: vi.fn(),
  setCustomWidth: vi.fn(),
  getTerminalLifecycleManager: () => null,
});

// The session header and the terminal inset take the terminal theme's background (2026-10-12).
describe('TerminalSettingsManager terminal background', () => {
  const root = document.documentElement;
  afterEach(() => {
    root.style.removeProperty(TERMINAL_BG_VAR);
    root.removeAttribute('data-theme');
  });

  it('sets --ut-terminal-bg from the active theme and removes it on dispose', () => {
    const manager = new TerminalSettingsManager();
    vi.spyOn(manager, 'resolveTerminalBackground').mockReturnValue('#141210');
    manager.setCallbacks(callbacks());
    expect(root.style.getPropertyValue(TERMINAL_BG_VAR)).toBe('#141210');

    manager.dispose();
    expect(root.style.getPropertyValue(TERMINAL_BG_VAR)).toBe('');
  });

  it('follows a theme change and the light/dark switch', async () => {
    const manager = new TerminalSettingsManager();
    const resolve = vi.spyOn(manager, 'resolveTerminalBackground').mockReturnValue('#141210');
    manager.setCallbacks(callbacks());

    resolve.mockReturnValue('#FAF6F1');
    root.setAttribute('data-theme', 'light');
    await new Promise((r) => setTimeout(r, 0));
    expect(root.style.getPropertyValue(TERMINAL_BG_VAR)).toBe('#FAF6F1');

    resolve.mockReturnValue('#2E3440');
    manager.handleThemeChange('nord');
    expect(root.style.getPropertyValue(TERMINAL_BG_VAR)).toBe('#2E3440');
    manager.dispose();
  });

  it('resolves a real theme to a color', () => {
    const manager = new TerminalSettingsManager();
    expect(manager.resolveTerminalBackground()).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// "Ajustar a la ventana" off again restores the width it replaced (2026-10-20).
describe('TerminalSettingsManager fit to the window', () => {
  const store = new Map<string, string>();
  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
  });

  it('remembers the fixed width and goes back to it when fit is turned off', () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, String(value));
    });
    const manager = new TerminalSettingsManager();
    const cb = callbacks();
    manager.setCallbacks(cb);
    manager.handleWidthSelect(100);
    manager.handleWidthSelect(0);
    expect(lastFixedWidth()).toBe(100);
    cb.setTerminalMaxCols.mockClear();
    manager.handleFitOff();
    expect(cb.setTerminalMaxCols).toHaveBeenCalledWith(100);
    expect(manager.getMaxCols()).toBe(100);
    manager.dispose();
  });

  it('without a width remembered, turning fit off opens the width list', () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => null);
    const manager = new TerminalSettingsManager();
    const cb = callbacks();
    manager.setCallbacks(cb);
    manager.handleFitOff();
    expect(cb.setShowWidthSelector).toHaveBeenCalledWith(true);
    manager.dispose();
  });
});
