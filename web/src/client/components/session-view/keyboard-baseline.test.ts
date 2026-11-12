/**
 * @vitest-environment happy-dom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifecycleEventManager } from './lifecycle-event-manager.js';

// The home-screen app shrinks innerHeight with the keyboard too: the keyboard was only seen
// against the tallest viewport, which started at 0, so the first measurement (the keyboard
// opening) became the baseline and the keyboard went unnoticed (2026-10-03).
describe('soft keyboard detection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sees the keyboard from the first viewport change after the session opens', () => {
    const viewport = Object.assign(new EventTarget(), { height: 894, width: 440, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    let inner = 894;
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
    const calls: Record<string, ReturnType<typeof vi.fn>> = {};
    const callbacks = new Proxy(calls, {
      get: (target, name: string) => {
        target[name] ??= vi.fn();
        return target[name];
      },
    });
    const manager = new LifecycleEventManager();
    manager.setCallbacks(callbacks as never);
    (manager as unknown as { setupMobileFeatures(mobile: boolean): void }).setupMobileFeatures(
      true
    );

    // The keyboard opens for a field: innerHeight and the visual viewport shrink together.
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    inner = 560;
    viewport.height = 560;
    viewport.dispatchEvent(new Event('resize'));
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(334);
    field.remove();
  });
});

// 2026-11-11: two places computed the keyboard's height. The viewport handler compared with the
// tallest viewport seen; the hidden input's focus wrote `innerHeight - viewport.height` on its
// own, which in Chrome on iOS (innerHeight shrinks with the keyboard) is 0 with the keyboard up.
describe('one calculation of the keyboard height', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** A session view in touch mode on a 440×894 screen whose innerHeight follows `inner.value`. */
  const open = (mobile = true, keyboardManager: Record<string, unknown> | null = null) => {
    const viewport = Object.assign(new EventTarget(), { height: 894, width: 440, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const inner = { value: 894 };
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner.value);
    const state = { mobile };
    const calls: Record<string, ReturnType<typeof vi.fn>> = {
      getIsMobile: vi.fn(() => state.mobile),
      setIsMobile: vi.fn((value: boolean) => {
        state.mobile = value;
      }),
      getDirectKeyboardManager: vi.fn(() => keyboardManager),
      setKeyboardHeight: vi.fn(),
    };
    const callbacks = new Proxy(calls, {
      get: (target, name: string) => {
        target[name] ??= vi.fn();
        return target[name];
      },
    });
    const manager = new LifecycleEventManager();
    manager.setCallbacks(callbacks as never);
    const internals = manager as unknown as {
      setupMobileFeatures(mobile: boolean): void;
      setupEventListeners(mobile: boolean): void;
    };
    internals.setupMobileFeatures(mobile);
    internals.setupEventListeners(mobile);
    /** Chrome on iOS: the keyboard shrinks innerHeight and the visual viewport together. */
    const field = document.createElement('textarea');
    document.body.append(field);
    const chromeKeyboard = (height: number) => {
      // A keyboard is up for a field (2026-11-11: nothing editable focused, no keyboard).
      if (height < 894) field.focus();
      else field.blur();
      inner.value = height;
      viewport.height = height;
    };
    return { manager, viewport, calls, chromeKeyboard, state };
  };

  it('the focus path measures against the tallest viewport too (Chrome on iOS)', () => {
    const { manager, calls, chromeKeyboard } = open();
    chromeKeyboard(560);
    manager.measureKeyboard();
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(334);
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('334px');
    expect(document.documentElement.getAttribute('data-keyboard-visible')).toBe('true');
    manager.cleanup();
  });

  it('the session view has no keyboard arithmetic of its own: it asks the lifecycle manager', () => {
    const view = readFileSync(resolve(__dirname, '../session-view.ts'), 'utf8');
    expect(view).toContain('measureKeyboard: () => this.lifecycleEventManager?.measureKeyboard()');
    expect(view).not.toMatch(/innerHeight\s*-\s*(window\.visualViewport|viewport)\.height/);
    const direct = readFileSync(resolve(__dirname, 'direct-keyboard-manager.ts'), 'utf8');
    expect(direct).not.toMatch(/innerHeight\s*-/);
  });

  it('the deferred "keyboard closed" check does not leave keyboard mode with the keyboard up', () => {
    vi.useFakeTimers();
    const keyboard = {
      getShowQuickKeys: () => true,
      isRecentlyEnteredKeyboardMode: () => true,
      exitKeyboardMode: vi.fn(),
      getKeyboardMode: () => true,
    };
    const { manager, viewport, chromeKeyboard } = open(true, keyboard);
    // The hidden input has the focus, as while typing: focus alone does not say "no keyboard".
    const input = document.createElement('textarea');
    input.setAttribute('data-direct-keyboard-input', '');
    document.body.appendChild(input);
    input.focus();
    chromeKeyboard(560);
    viewport.dispatchEvent(new Event('resize'));
    // The keyboard animation reports the full height for a moment, then the keyboard is back.
    chromeKeyboard(894);
    viewport.dispatchEvent(new Event('resize'));
    chromeKeyboard(560);
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(2200);
    expect(keyboard.exitKeyboardMode).not.toHaveBeenCalled();

    // And it does leave it when the keyboard really went.
    chromeKeyboard(894);
    viewport.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(2200);
    expect(keyboard.exitKeyboardMode).toHaveBeenCalledTimes(1);
    manager.cleanup();
    input.remove();
  });

  it('a window that becomes touch-sized starts measuring the keyboard; back to desktop, it stops', () => {
    const { manager, viewport, calls, chromeKeyboard, state } = open(false);
    // What the device detection answers (on an iPad with a trackpad: the window under 1024 px).
    const touch = vi.spyOn(
      manager as unknown as { shouldEnableTouchKeyboard(): boolean },
      'shouldEnableTouchKeyboard'
    );
    touch.mockReturnValue(false);
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');

    // Desktop: the viewport is not listened to.
    chromeKeyboard(560);
    viewport.dispatchEvent(new Event('resize'));
    expect(calls.setKeyboardHeight).not.toHaveBeenCalled();
    chromeKeyboard(894);

    // The window crosses into touch mode.
    touch.mockReturnValue(true);
    manager.handleWindowResize();
    expect(state.mobile).toBe(true);
    expect(removed).toHaveBeenCalledWith('keydown', manager.keyboardHandler);
    expect(added).toHaveBeenCalledWith('keydown', manager.mobileHardwareKeyboardHandler);
    expect(added).toHaveBeenCalledWith('touchstart', manager.touchStartHandler, { passive: true });
    chromeKeyboard(560);
    viewport.dispatchEvent(new Event('resize'));
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(334);

    // And back: desktop keys again, no keyboard height left behind, the viewport let go.
    touch.mockReturnValue(false);
    manager.handleWindowResize();
    expect(state.mobile).toBe(false);
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(0);
    expect(added).toHaveBeenCalledWith('keydown', manager.keyboardHandler);
    expect(removed).toHaveBeenCalledWith('touchstart', manager.touchStartHandler);
    const before = calls.setKeyboardHeight.mock.calls.length;
    viewport.dispatchEvent(new Event('resize'));
    expect(calls.setKeyboardHeight.mock.calls.length).toBe(before);
    manager.cleanup();
  });
});

// Phone spec 4.2 (2026-10-12): with the keyboard up the header collapses to 36 px, the action
// bar hides (the quick keys take its place) and the terminal keeps ≥ 45 % of --app-height.
describe('keyboard-up portrait budget', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/session.css'), 'utf8');
  const quickKeys = readFileSync(resolve(__dirname, '../terminal-quick-keys.ts'), 'utf8');
  const px = (source: string, pattern: RegExp) => {
    const match = source.match(pattern);
    if (!match) throw new Error(`not found: ${pattern}`);
    return Number(match[1]);
  };

  it('collapses the header to 36 px and keeps the terminal at ≥ 45 % of the height', () => {
    expect(css).toMatch(/html\[data-keyboard-visible='true'\] \.ut-ph-header \{\s*height: 36px;/);
    const header = 36;
    const keyHeight = px(quickKeys, /\.qk-key \{[^}]*?height: (\d+)px;/s);
    const rowGap = px(quickKeys, /\.quick-keys-bar > div \+ div \{\s*margin-top: (\d+)px;/);
    const barPadding = px(quickKeys, /\.quick-keys-bar \{[^}]*?padding: (\d+)px /s);
    const hint = 22; // the one-time swipe hint, first time only
    const quickKeysBar = 2 * keyHeight + rowGap + 2 * barPadding + 1 + hint;
    // iPhone SE in Safari with the keyboard up (the tightest real case), 15 Pro in Safari, and
    // the 15 Pro home-screen app.
    for (const appHeight of [367, 359, 516]) {
      const terminal = appHeight - header - quickKeysBar;
      expect(terminal / appHeight).toBeGreaterThanOrEqual(0.45);
    }
  });

  it('hides the action bar while the soft keyboard is up', () => {
    const bar = readFileSync(resolve(__dirname, '../mobile-action-bar.ts'), 'utf8');
    expect(bar).toMatch(/if \(!this\.visible \|\| !this\.isMobile \|\| this\.keyboardVisible\)/);
  });
});
