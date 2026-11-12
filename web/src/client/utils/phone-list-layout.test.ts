// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPACT_LIST_CHANGED_EVENT,
  COMPACT_LIST_KEY,
  type CompactListPref,
  phoneListLayout,
  previewsFolded,
  readCompactListPref,
  writeCompactListPref,
} from './phone-list-layout.js';

// Screens in pt (CSS px), portrait. 2026-10-04: an iPhone SE showed no session on its first
// screen; larger phones keep the classic layout.
const SE = { width: 375, height: 667 };
const MINI = { width: 375, height: 812 };
const IPHONE_15 = { width: 393, height: 852 };
const PRO_MAX = { width: 440, height: 956 };

describe('phone list layout decision', () => {
  it.each([
    ['iPhone SE', SE, 'auto', { tight: true, compact: true }],
    ['iPhone SE in landscape', { width: 667, height: 375 }, 'auto', { tight: true, compact: true }],
    // Narrow but tall: tighter spacing only, nothing changes shape.
    // 2026-10-12: compact by default on every phone; the screen decides the spacing.
    ['iPhone mini', MINI, 'auto', { tight: true, compact: true }],
    ['iPhone 15', IPHONE_15, 'auto', { tight: false, compact: true }],
    ['iPhone Pro Max', PRO_MAX, 'auto', { tight: false, compact: true }],
    // The setting, once chosen, wins over the screen…
    ['iPhone SE, compact list off', SE, 'off', { tight: true, compact: false }],
    ['iPhone 15, compact list on', IPHONE_15, 'on', { tight: true, compact: true }],
    // …but spacing on a small screen stays tight even with it off.
    ['iPhone mini, compact list off', MINI, 'off', { tight: true, compact: false }],
  ] as const)('%s', (_name, screen, pref, expected) => {
    expect(phoneListLayout(screen, pref as CompactListPref)).toEqual(expected);
  });

  it('the spacing thresholds are 700 pt tall and 375 pt wide (tight)', () => {
    expect(phoneListLayout({ width: 400, height: 700 }, 'auto')).toEqual({
      tight: true,
      compact: true,
    });
    expect(phoneListLayout({ width: 400, height: 701 }, 'auto')).toEqual({
      tight: false,
      compact: true,
    });
    expect(phoneListLayout({ width: 376, height: 812 }, 'auto').tight).toBe(false);
  });
});

describe('a phone on its side', () => {
  // iOS reports the screen in portrait whatever the orientation: on its own, the screen of a
  // Pro Max in landscape (about 300 pt tall) never counted as short (2026-10-04).
  it('tightens the spacing, and leaves "compact" to the setting', () => {
    expect(phoneListLayout(PRO_MAX, 'auto', true)).toEqual({ tight: true, compact: true });
    expect(phoneListLayout(PRO_MAX, 'on', true)).toEqual({ tight: true, compact: true });
    expect(phoneListLayout(PRO_MAX, 'off', true)).toEqual({ tight: true, compact: false });
    expect(phoneListLayout(SE, 'auto', true)).toEqual({ tight: true, compact: true });
  });

  it('portrait keeps the roomier spacing', () => {
    expect(phoneListLayout(PRO_MAX, 'auto', false)).toEqual({ tight: false, compact: true });
    expect(phoneListLayout(IPHONE_15, 'auto')).toEqual({ tight: false, compact: true });
  });
});

describe('folding the previews whose server is down', () => {
  const base = { compact: true, count: 2, searching: false, expanded: false, highlighted: false };

  it('folds any down preview in the compact list', () => {
    expect(previewsFolded(base)).toBe(true);
    expect(previewsFolded({ ...base, count: 1 })).toBe(true);
    expect(previewsFolded({ ...base, count: 5 })).toBe(true);
  });

  it('has nothing to fold without down previews, or outside the compact list', () => {
    expect(previewsFolded({ ...base, count: 0 })).toBe(false);
    expect(previewsFolded({ ...base, compact: false })).toBe(false);
  });

  it('opens while searching, once tapped open, or when `ut open` highlights one', () => {
    expect(previewsFolded({ ...base, searching: true })).toBe(false);
    expect(previewsFolded({ ...base, expanded: true })).toBe(false);
    expect(previewsFolded({ ...base, highlighted: true })).toBe(false);
  });
});

describe('compact list setting', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is "auto" until chosen, and remembers on / off', () => {
    expect(readCompactListPref()).toBe('auto');
    writeCompactListPref('off');
    expect(store.get(COMPACT_LIST_KEY)).toBe('off');
    expect(readCompactListPref()).toBe('off');
    writeCompactListPref('on');
    expect(readCompactListPref()).toBe('on');
    writeCompactListPref('auto');
    expect(store.has(COMPACT_LIST_KEY)).toBe(false);
  });

  it('ignores a stored value it does not know', () => {
    store.set(COMPACT_LIST_KEY, 'maybe');
    expect(readCompactListPref()).toBe('auto');
  });

  it('tells the open list when it changes', () => {
    const changed = vi.fn();
    window.addEventListener(COMPACT_LIST_CHANGED_EVENT, changed);
    writeCompactListPref('on');
    window.removeEventListener(COMPACT_LIST_CHANGED_EVENT, changed);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('falls back to "auto" with blocked storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readCompactListPref()).toBe('auto');
    expect(() => writeCompactListPref('on')).not.toThrow();
  });
});
