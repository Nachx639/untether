// @vitest-environment happy-dom

import { fixture } from '@open-wc/testing';
import { html } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  TERMINAL_THEME_CHANGED_EVENT,
  TerminalPreferencesManager,
} from '../utils/terminal-preferences.js';
import { TERMINAL_THEMES } from '../utils/terminal-themes.js';
import './terminal-theme-picker.js';
import type { TerminalThemePicker } from './terminal-theme-picker.js';

describe('terminal-theme-picker', () => {
  let element: TerminalThemePicker;
  const prefs = () => TerminalPreferencesManager.getInstance();
  const radio = (id: string) =>
    element.querySelector(`[data-theme-id="${id}"]`) as HTMLButtonElement;
  const checked = () =>
    [...element.querySelectorAll('[role="radio"][aria-checked="true"]')].map((el) =>
      el.getAttribute('data-theme-id')
    );

  beforeEach(async () => {
    setupLocalStorageMock();
    prefs().resetToDefaults();
    element = await fixture<TerminalThemePicker>(
      html`<terminal-theme-picker></terminal-theme-picker>`
    );
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  it('starts on Auto, with every fixed theme as one radiogroup kept for the Fixed tab', () => {
    expect(
      element.querySelector('[data-testid="terminal-theme-auto"]')?.getAttribute('aria-pressed')
    ).toBe('true');
    const group = element.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group).toBeTruthy();
    // Auto shows the two pairing rows; the grid waits, hidden, for Fixed.
    expect(group.hidden).toBe(true);
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(TERMINAL_THEMES.length);
    expect(checked()).toEqual([]);
  });

  it('Fixed starts on the theme Auto was showing, under its tab, with a check and a roving tabindex', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    (element.querySelector('[data-testid="terminal-theme-fixed"]') as HTMLButtonElement).click();
    await element.updateComplete;
    expect(prefs().getTheme()).toBe('untether');
    expect(checked()).toEqual(['untether']);
    expect((element.querySelector('[role="radiogroup"]') as HTMLElement).hidden).toBe(false);
    expect(radio('untether').querySelector('.tt-check')).toBeTruthy();
    expect(radio('untether').tabIndex).toBe(0);
    expect(radio('dracula').tabIndex).toBe(-1);
    // Light themes sit in the other, hidden tab until it is chosen.
    expect((radio('github-light').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(true);
    (
      element.querySelector('[data-testid="terminal-theme-tab-light"]') as HTMLButtonElement
    ).click();
    await element.updateComplete;
    expect((radio('github-light').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(false);
    document.documentElement.removeAttribute('data-theme');
  });

  it('previews each theme in its own colors with a prompt only', () => {
    const card = radio('gruvbox-dark');
    const preview = card.querySelector('.tt-preview') as HTMLElement;
    expect(preview.getAttribute('style')).toContain('#282828');
    expect(card.querySelector('.tt-prompt')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '❯ ~/app'
    );
    expect(card.textContent).toContain('Gruvbox Dark');
  });

  it('selects on click, persists it and announces it', async () => {
    const announced = vi.fn();
    const changed = vi.fn();
    window.addEventListener(TERMINAL_THEME_CHANGED_EVENT, announced);
    element.addEventListener('theme-change', changed);

    radio('tokyo-night').click();
    await element.updateComplete;

    expect(checked()).toEqual(['tokyo-night']);
    expect(prefs().getTheme()).toBe('tokyo-night');
    expect(JSON.parse(localStorage.getItem('untether_terminal_preferences') ?? '{}').theme).toBe(
      'tokyo-night'
    );
    expect((announced.mock.calls[0][0] as CustomEvent).detail).toBe('tokyo-night');
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toBe('tokyo-night');
    window.removeEventListener(TERMINAL_THEME_CHANGED_EVENT, announced);
  });

  it('moves and selects with the arrow keys, Home and End, across both tabs', async () => {
    radio('untether').click();
    await element.updateComplete;
    const key = (k: string) =>
      element
        .querySelector('[role="radio"][aria-checked="true"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

    key('ArrowRight');
    await element.updateComplete;
    expect(checked()).toEqual(['dark']);

    key('ArrowLeft');
    await element.updateComplete;
    expect(checked()).toEqual(['untether']);

    key('ArrowUp'); // wraps to the last (light) theme and shows its tab
    await element.updateComplete;
    const last = TERMINAL_THEMES.at(-1)?.id as string;
    expect(checked()).toEqual([last]);
    expect((radio(last).closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(false);

    key('Home');
    await element.updateComplete;
    expect(checked()).toEqual(['untether']);

    key('End');
    await element.updateComplete;
    expect(checked()).toEqual([last]);
  });

  it('back to Auto from the segmented control', async () => {
    radio('nord').click();
    await element.updateComplete;
    (element.querySelector('[data-testid="terminal-theme-auto"]') as HTMLButtonElement).click();
    await element.updateComplete;
    expect(prefs().getTheme()).toBe('auto');
    expect(element.querySelector('[data-testid="terminal-theme-auto-pairing"]')).toBeTruthy();
  });

  it('pairs Auto with a dark and a light theme, only offered while Auto is selected', async () => {
    const pairing = () => element.querySelector('[data-testid="terminal-theme-auto-pairing"]');
    expect(pairing()).toBeTruthy();

    const dark = element.querySelector(
      '[data-testid="terminal-theme-auto-dark"]'
    ) as HTMLSelectElement;
    const light = element.querySelector(
      '[data-testid="terminal-theme-auto-light"]'
    ) as HTMLSelectElement;
    expect(dark.value).toBe('untether');
    expect(light.value).toBe('untether-light');
    // Each select only lists themes of its appearance.
    expect([...dark.options].map((o) => o.value)).not.toContain('github-light');
    expect([...light.options].map((o) => o.value)).not.toContain('dracula');

    dark.value = 'kanagawa-wave';
    dark.dispatchEvent(new Event('change'));
    light.value = 'solarized-light';
    light.dispatchEvent(new Event('change'));
    await element.updateComplete;

    expect(prefs().getAutoThemePair()).toEqual({ dark: 'kanagawa-wave', light: 'solarized-light' });

    radio('nord').click();
    await element.updateComplete;
    expect(pairing()).toBeNull();
  });
});
