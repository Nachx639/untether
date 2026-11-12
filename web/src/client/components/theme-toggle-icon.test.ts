// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ACCENT_THEMES, applyAccent } from '../utils/accent-themes.js';
import type { ThemeToggleIcon } from './theme-toggle-icon';

describe('theme-toggle-icon', () => {
  beforeAll(async () => {
    await import('./theme-toggle-icon');
  });

  const pressed = (element: ThemeToggleIcon): number[] =>
    [...element.querySelectorAll<HTMLElement>('.appearance-swatch')].flatMap((swatch, index) =>
      swatch.getAttribute('aria-pressed') === 'true' ? [index] : []
    );

  it('marks the accent picked elsewhere (Settings) while its panel is open (2026-11-10)', async () => {
    applyAccent(ACCENT_THEMES[0].id);
    const element = await fixture<ThemeToggleIcon>(html`<theme-toggle-icon></theme-toggle-icon>`);
    element.querySelector('button')?.click();
    await element.updateComplete;
    const before = pressed(element);
    expect(before).toEqual([0]);

    // Another component applies an accent: the event is the only signal this one gets.
    applyAccent(ACCENT_THEMES[1].id);
    await element.updateComplete;
    const after = pressed(element);
    expect(after).toEqual([1]);
  });

  it('stops listening for accent changes once removed', async () => {
    const element = await fixture<ThemeToggleIcon>(html`<theme-toggle-icon></theme-toggle-icon>`);
    const spy = vi.spyOn(window, 'removeEventListener');
    element.remove();
    expect(spy).toHaveBeenCalledWith('untether-accent-changed', expect.any(Function));
    spy.mockRestore();
  });

  it('still starts when storage throws', async () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      const element = await fixture<ThemeToggleIcon>(html`<theme-toggle-icon></theme-toggle-icon>`);
      expect(element.theme).toBe('system');
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
