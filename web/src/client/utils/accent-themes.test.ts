/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCENT_STORAGE_KEY, applyAccent, getAccent } from './accent-themes.js';

describe('accent themes', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-accent');
  });

  it('applies and remembers a color theme, falling back to the brand orange for unknown ids', () => {
    expect(getAccent()).toBe('untether');

    applyAccent('violet');
    expect(document.documentElement.getAttribute('data-accent')).toBe('violet');
    expect(getAccent()).toBe('violet');

    localStorage.setItem(ACCENT_STORAGE_KEY, 'neon-pink');
    expect(getAccent()).toBe('untether');
    applyAccent('neon-pink');
    expect(document.documentElement.getAttribute('data-accent')).toBe('untether');
  });
});
