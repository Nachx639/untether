// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import {
  COMPACT_QUICK_KEYS_LAYOUT,
  controlCharacterFor,
  DEFAULT_QUICK_KEYS_LAYOUT,
  getHiddenQuickKeys,
  getQuickKeyDescription,
  isValidQuickKeysLayout,
  loadQuickKeysLayout,
  PHONE_QUICK_KEYS_LAYOUT,
  QUICK_KEYS_LAYOUT_CHANGED_EVENT,
  QUICK_KEYS_STORAGE_KEY,
  resetQuickKeysLayout,
  saveQuickKeysLayout,
} from './quick-keys-layout.js';

describe('quick keys layout preferences', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  it('uses the current fixed layout as the default', () => {
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
  });

  it('defaults phones to the two-row agent layout, still honoring a saved layout', () => {
    const width = vi.spyOn(window.screen, 'width', 'get').mockReturnValue(430);
    const height = vi.spyOn(window.screen, 'height', 'get').mockReturnValue(932);
    try {
      expect(isValidQuickKeysLayout(PHONE_QUICK_KEYS_LAYOUT)).toBe(true);
      expect(loadQuickKeysLayout()).toEqual(PHONE_QUICK_KEYS_LAYOUT);

      saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT);
      expect(loadQuickKeysLayout()).toEqual(COMPACT_QUICK_KEYS_LAYOUT);
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('round-trips a versioned browser-local layout', () => {
    expect(saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT)).toBe(true);
    expect(loadQuickKeysLayout()).toEqual(COMPACT_QUICK_KEYS_LAYOUT);
    expect(JSON.parse(localStorage.getItem(QUICK_KEYS_STORAGE_KEY) ?? '')).toEqual({
      version: 1,
      rows: COMPACT_QUICK_KEYS_LAYOUT,
    });
  });

  it('rejects unknown, duplicate, empty, oversized, and unsupported row layouts', () => {
    expect(isValidQuickKeysLayout([['Escape'], ['not-a-key']])).toBe(false);
    expect(isValidQuickKeysLayout([['Escape'], ['Escape']])).toBe(false);
    expect(isValidQuickKeysLayout([['Escape'], []])).toBe(false);
    expect(
      isValidQuickKeysLayout([
        [
          'Escape',
          'Control',
          'CtrlExpand',
          'F',
          'Tab',
          'shift_tab',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'PageUp',
          'PageDown',
          'Home',
        ],
        ['Paste'],
      ])
    ).toBe(false);
    expect(isValidQuickKeysLayout([['Escape']])).toBe(false);
    expect(isValidQuickKeysLayout([['Escape'], ['Tab'], ['Home'], ['End']])).toBe(false);
  });

  it('falls back to defaults for malformed or future storage values', () => {
    localStorage.setItem(QUICK_KEYS_STORAGE_KEY, '{');
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);

    localStorage.setItem(
      QUICK_KEYS_STORAGE_KEY,
      JSON.stringify({ version: 2, rows: COMPACT_QUICK_KEYS_LAYOUT })
    );
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
  });

  it('removes customization when reset and notifies live components', () => {
    const listener = vi.fn();
    window.addEventListener(QUICK_KEYS_LAYOUT_CHANGED_EVENT, listener);
    saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT);

    expect(resetQuickKeysLayout()).toBe(true);
    expect(localStorage.getItem(QUICK_KEYS_STORAGE_KEY)).toBeNull();
    expect(loadQuickKeysLayout()).toEqual(DEFAULT_QUICK_KEYS_LAYOUT);
    expect(listener).toHaveBeenCalledTimes(2);

    window.removeEventListener(QUICK_KEYS_LAYOUT_CHANGED_EVENT, listener);
  });
});

describe('↵ Enter quick key', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });

  afterEach(() => {
    restoreLocalStorage();
  });

  const store = (rows: string[][]) =>
    localStorage.setItem(QUICK_KEYS_STORAGE_KEY, JSON.stringify({ version: 1, rows }));

  it('is visible in the first two rows of the default and phone presets', () => {
    for (const layout of [DEFAULT_QUICK_KEYS_LAYOUT, PHONE_QUICK_KEYS_LAYOUT]) {
      expect(isValidQuickKeysLayout(layout)).toBe(true);
      expect(layout.slice(0, 2).flat()).toContain('Enter');
    }
  });

  // 2026-11-11: no upgrade of layouts saved by an older app: a saved layout is the user's,
  // whatever preset it once equalled, and one this app cannot read gives way to the factory one.
  it('keeps a saved layout as saved, even one that equals a preset of before', () => {
    const before = [
      PHONE_QUICK_KEYS_LAYOUT[0],
      PHONE_QUICK_KEYS_LAYOUT[1].filter((k) => k !== 'Enter'),
    ];
    store(before);
    expect(loadQuickKeysLayout()).toEqual(before);
  });

  it('replaces a saved layout this app cannot read with the factory one, and saving works after', () => {
    for (const stale of [
      JSON.stringify([['Escape'], ['Tab']]), // bare rows, no version
      JSON.stringify({ version: 1, rows: [['Escape', 'NoSuchKey'], ['Tab']] }),
      JSON.stringify({ version: 1, rows: [['Escape']] }),
      '{not json',
    ]) {
      localStorage.setItem(QUICK_KEYS_STORAGE_KEY, stale);
      const layout = loadQuickKeysLayout();
      expect(isValidQuickKeysLayout(layout)).toBe(true);
      expect([DEFAULT_QUICK_KEYS_LAYOUT, PHONE_QUICK_KEYS_LAYOUT]).toContainEqual(layout);
    }
    expect(saveQuickKeysLayout(COMPACT_QUICK_KEYS_LAYOUT)).toBe(true);
    expect(loadQuickKeysLayout()).toEqual(COMPACT_QUICK_KEYS_LAYOUT);
  });

  it('keeps a hand-edited layout and offers Enter among the hidden keys', () => {
    const custom = [
      ['Escape', 'Tab'],
      ['Paste', '/'],
    ];
    store(custom);

    const layout = loadQuickKeysLayout();
    expect(layout).toEqual(custom);
    expect(getHiddenQuickKeys(layout).map(({ key }) => key)).toContain('Enter');
  });

  it('names the glyph-only keys in the editor, including what ⇤ does in Claude Code', () => {
    expect(getQuickKeyDescription('Enter')).toBe('Enter');
    expect(getQuickKeyDescription('shift_tab')).toBe('Shift Tab · Cycles modes in Claude Code');
    expect(getQuickKeyDescription('/')).toBeUndefined();
  });
});

describe('controlCharacterFor', () => {
  it.each([
    ['c', '\x03'],
    ['C', '\x03'],
    ['[', '\x1b'],
    ['_', '\x1f'],
    [' ', '\x00'],
    ['?', '\x7f'],
  ])('maps Ctrl+%j', (char, expected) => {
    expect(controlCharacterFor(char)).toBe(expected);
  });

  it('returns null for characters without a control code', () => {
    expect(controlCharacterFor('1')).toBeNull();
  });
});
