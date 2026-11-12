// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { isBrowserShortcut, isCopyPasteShortcut, matchAppShortcut } from './browser-shortcuts.js';

const originalPlatform = navigator.platform;
const originalUserAgent = navigator.userAgent;
const originalMaxTouchPoints = navigator.maxTouchPoints;

afterEach(() => {
  Object.defineProperties(navigator, {
    platform: { value: originalPlatform, configurable: true },
    userAgent: { value: originalUserAgent, configurable: true },
    maxTouchPoints: { value: originalMaxTouchPoints, configurable: true },
  });
});

describe('browser shortcuts', () => {
  it('preserves iPhone Command shortcuts', () => {
    Object.defineProperties(navigator, {
      platform: { value: 'iPhone', configurable: true },
      userAgent: { value: 'Mobile Safari on iPhone', configurable: true },
    });

    expect(
      isBrowserShortcut({
        key: 'l',
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(true);
    expect(
      isCopyPasteShortcut({
        key: 'v',
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(true);
  });

  it('preserves iPadOS Command shortcuts with desktop platform reporting', () => {
    Object.defineProperties(navigator, {
      platform: { value: 'MacIntel', configurable: true },
      userAgent: { value: 'Mobile Safari', configurable: true },
      maxTouchPoints: { value: 5, configurable: true },
    });

    expect(
      isBrowserShortcut({
        key: 'c',
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(true);
  });
});

describe('app shortcuts', () => {
  const key = (
    k: string,
    mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}
  ) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('maps the Command shortcuts and leaves Ctrl chords to the terminal', () => {
    expect(matchAppShortcut(key('k', { metaKey: true }))).toEqual({ kind: 'palette' });
    expect(matchAppShortcut(key(',', { metaKey: true }))).toEqual({ kind: 'settings' });
    expect(matchAppShortcut(key('o', { metaKey: true }))).toEqual({ kind: 'files' });
    expect(matchAppShortcut(key('b', { metaKey: true }))).toEqual({ kind: 'sidebar' });
    expect(matchAppShortcut(key('3', { metaKey: true }))).toEqual({ kind: 'switch', index: 2 });
    expect(matchAppShortcut(key('N', { metaKey: true, shiftKey: true }))).toEqual({
      kind: 'new-session',
    });
    expect(matchAppShortcut(key('?', { shiftKey: true }))).toEqual({ kind: 'help' });
    expect(matchAppShortcut(key('k', { ctrlKey: true }))).toBeNull();
    expect(matchAppShortcut(key('b', { ctrlKey: true }))).toBeNull();
    expect(matchAppShortcut(key('0', { metaKey: true }))).toBeNull();
    expect(matchAppShortcut(key('k', { metaKey: true, altKey: true }))).toBeNull();
  });
});
