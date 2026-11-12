import { describe, expect, it } from 'vitest';
import {
  ANSI_COLOR_KEYS,
  DEFAULT_AUTO_DARK_THEME,
  DEFAULT_AUTO_LIGHT_THEME,
  getTerminalTheme,
  isTerminalThemeId,
  resolveTerminalTheme,
  TERMINAL_THEMES,
  themesByAppearance,
} from '../../client/utils/terminal-themes.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

describe('terminal-themes', () => {
  it('ships the house, dark and light themes', () => {
    const ids = TERMINAL_THEMES.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'untether',
        'untether-light',
        'catppuccin-mocha',
        'catppuccin-macchiato',
        'tokyo-night',
        'gruvbox-dark',
        'one-dark',
        'rose-pine',
        'kanagawa-wave',
        'everforest-dark',
        'solarized-dark',
        'github-dark',
        'monokai-pro',
        'ayu-mirage',
        'catppuccin-latte',
        'solarized-light',
        'github-light',
        'rose-pine-dawn',
        'gruvbox-light',
      ])
    );
    expect(ids).not.toContain('auto');
  });

  it('has unique ids and names', () => {
    const ids = TERMINAL_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = TERMINAL_THEMES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every theme a name, a description and an appearance', () => {
    for (const theme of TERMINAL_THEMES) {
      expect(theme.name.trim()).not.toBe('');
      expect(theme.description.trim()).not.toBe('');
      expect(['dark', 'light']).toContain(theme.appearance);
    }
  });

  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))(
    '%s: 16 ANSI colors and the base colors are valid hex',
    (_id, theme) => {
      const ansi = ANSI_COLOR_KEYS.map((key) => theme.colors[key]);
      expect(ansi).toHaveLength(16);
      for (const color of ansi) expect(color).toMatch(HEX);
      for (const key of [
        'background',
        'foreground',
        'cursorAccent',
        'selectionBackground',
      ] as const) {
        expect(theme.colors[key]).toMatch(HEX);
      }
      if (theme.colors.selectionForeground !== undefined) {
        expect(theme.colors.selectionForeground).toMatch(HEX);
      }
      // The cursor is hex, or follows the accent.
      expect(theme.colors.cursor).toMatch(/^(#[0-9a-fA-F]{6}|var\(--color-primary\))$/);
    }
  );

  it('marks appearance consistently with the background lightness', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const theme of TERMINAL_THEMES) {
      const light = luminance(theme.colors.background) > 0.5;
      expect(`${theme.id}:${light ? 'light' : 'dark'}`).toBe(`${theme.id}:${theme.appearance}`);
    }
  });

  it('pairs Auto with the house themes by default', () => {
    expect(getTerminalTheme(DEFAULT_AUTO_DARK_THEME)?.appearance).toBe('dark');
    expect(getTerminalTheme(DEFAULT_AUTO_LIGHT_THEME)?.appearance).toBe('light');
    expect(themesByAppearance('dark')[0].id).toBe('untether');
    expect(themesByAppearance('light')[0].id).toBe('untether-light');
  });

  it('resolves Auto to the paired theme for the current appearance', () => {
    const pair = { dark: 'nord', light: 'github-light' } as const;
    expect(resolveTerminalTheme('auto', 'dark', pair).id).toBe('nord');
    expect(resolveTerminalTheme('auto', 'light', pair).id).toBe('github-light');
    expect(resolveTerminalTheme('dracula', 'light', pair).id).toBe('dracula');
  });

  it('recognises valid theme ids only', () => {
    expect(isTerminalThemeId('auto')).toBe(true);
    expect(isTerminalThemeId('tokyo-night')).toBe(true);
    expect(isTerminalThemeId('no-such-theme')).toBe(false);
    expect(isTerminalThemeId(42)).toBe(false);
  });
});
