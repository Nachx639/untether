/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: { forceReconnect: vi.fn() },
}));
vi.mock('../../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: vi.fn(async () => ({})) },
}));

import { DIRECT_KEYBOARD_INPUT_ATTRIBUTE } from '../../utils/quick-keys-layout.js';
import { DirectKeyboardManager } from './direct-keyboard-manager.js';
import { LifecycleEventManager } from './lifecycle-event-manager.js';

// 2026-10-12: back from another app (or the lock screen) the session ended at ~60 % of the
// screen with a black band below. iOS hides the keyboard while the page is in the background
// and fires no visualViewport resize on return, so --app-height, --keyboard-offset and
// html[data-keyboard-visible] kept their keyboard-open values until the keyboard was opened
// and closed again.
describe('keyboard state after a return from the background', () => {
  let inner = 852;
  let hidden = false;
  let viewport: EventTarget & { height: number; width: number; offsetTop: number };
  let calls: Record<string, ReturnType<typeof vi.fn>>;
  let keyboardMode = false;
  let manager: LifecycleEventManager;

  const root = () => document.documentElement;
  const appHeight = () => root().style.getPropertyValue('--app-height');

  function setup(initialHeight: number) {
    inner = initialHeight;
    viewport = Object.assign(new EventTarget(), {
      height: initialHeight,
      width: 393,
      offsetTop: 0,
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    calls = {};
    const keyboardManager = {
      getShowQuickKeys: () => false,
      getKeyboardMode: () => keyboardMode,
      exitKeyboardMode: vi.fn(),
      isRecentlyEnteredKeyboardMode: () => false,
      ensureHiddenInputVisible: vi.fn(),
      cleanup: vi.fn(),
    };
    const callbacks = new Proxy(calls, {
      get: (target, name: string) => {
        if (name === 'getDirectKeyboardManager') return () => keyboardManager;
        if (name === 'querySelector') return () => null;
        target[name] ??= vi.fn();
        return target[name];
      },
    });
    manager = new LifecycleEventManager();
    manager.setCallbacks(callbacks as never);
    manager.setupLifecycle();
    (manager as unknown as { setupMobileFeatures(mobile: boolean): void }).setupMobileFeatures(
      true
    );
  }

  /** A keyboard is up for a field: one gets the focus unless the test focused its own. */
  function openKeyboard(viewportHeight: number, innerHeight = inner) {
    if (!(document.activeElement instanceof HTMLTextAreaElement)) {
      const field = document.createElement('textarea');
      document.body.append(field);
      field.focus();
    }
    inner = innerHeight;
    viewport.height = viewportHeight;
    viewport.dispatchEvent(new Event('resize'));
  }

  /** The page goes away; iOS hides the keyboard and blurs the field meanwhile. */
  function background() {
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  function expectFullHeight(height: number) {
    expect(appHeight()).toBe(`${height}px`);
    expect(root().style.getPropertyValue('--keyboard-offset')).toBe('0px');
    expect(root().style.getPropertyValue('--keyboard-height')).toBe('0px');
    expect(root().getAttribute('data-keyboard-visible')).toBe('false');
    expect(document.body.getAttribute('data-keyboard-visible')).toBe('false');
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(0);
  }

  beforeEach(() => {
    hidden = false;
    keyboardMode = false;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    manager.teardownLifecycle();
    manager.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Safari: visible again with the keyboard gone and no resize gives the full height', () => {
    setup(852);
    openKeyboard(516);
    expect(appHeight()).toBe('516px');
    expect(root().getAttribute('data-keyboard-visible')).toBe('true');

    background();
    viewport.height = 852; // no resize event, as iOS does
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expectFullHeight(852);
  });

  it('a bfcache pageshow brings the full height back too', () => {
    setup(852);
    openKeyboard(516);
    background();
    viewport.height = 852;
    hidden = false;
    const pageshow = new Event('pageshow') as Event & { persisted: boolean };
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    expectFullHeight(852);
  });

  it('the window regaining focus brings the full height back too', () => {
    setup(852);
    openKeyboard(516);
    background();
    hidden = false;
    viewport.height = 852;
    window.dispatchEvent(new Event('focus'));
    expectFullHeight(852);
  });

  it('home-screen app: stale sizes on return never leave the short height behind', () => {
    vi.useFakeTimers();
    setup(894);
    // innerHeight shrinks with the keyboard there.
    openKeyboard(560, 560);
    expect(appHeight()).toBe('560px');

    background();
    hidden = false;
    // Both still report the keyboard-up size right after the return.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(appHeight()).not.toBe('560px');
    expect(root().getAttribute('data-keyboard-visible')).toBe('false');

    vi.advanceTimersByTime(100);
    expect(appHeight()).not.toBe('560px');
    // They correct themselves a moment later, with no event.
    inner = 894;
    viewport.height = 894;
    vi.advanceTimersByTime(400);
    expectFullHeight(894);
  });

  it('keeps the keyboard state while a field really has focus', () => {
    setup(852);
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    openKeyboard(516);
    window.dispatchEvent(new Event('focus'));
    expect(appHeight()).toBe('516px');
    expect(root().getAttribute('data-keyboard-visible')).toBe('true');
  });

  it("treats the terminal's hidden input outside keyboard mode as no keyboard", () => {
    setup(852);
    const input = document.createElement('textarea');
    input.setAttribute(DIRECT_KEYBOARD_INPUT_ATTRIBUTE, '');
    document.body.append(input);
    input.focus();
    keyboardMode = true;
    openKeyboard(516);
    keyboardMode = false;
    window.dispatchEvent(new Event('focus'));
    expectFullHeight(852);
  });

  it('a keyboard dismissal with no viewport event resets the page height', () => {
    vi.useFakeTimers();
    setup(852);
    openKeyboard(516);
    viewport.height = 852;
    manager.scheduleViewportResync('dismiss', true);
    expect(appHeight()).toBe('516px'); // waits for the focus to settle
    vi.advanceTimersByTime(0);
    expectFullHeight(852);
  });
});

// 2026-11-11: in the iPhone home-screen app the keyboard's gap sometimes showed with no keyboard
// up; a tap then opened the real one. The gap went by the viewport's numbers alone and only
// when the viewport fired an event. Now: nothing editable focused, no gap; a blur is looked at
// again; and an applied gap is checked every second against the focus and the viewport.
describe("the keyboard's gap with no keyboard", () => {
  let inner = 852;
  let viewport: EventTarget & { height: number; width: number; offsetTop: number };
  let calls: Record<string, ReturnType<typeof vi.fn>>;
  let manager: LifecycleEventManager;
  const exitKeyboardMode = vi.fn();

  const root = () => document.documentElement;
  const gap = () => root().style.getPropertyValue('--keyboard-height');

  function setup(height: number) {
    inner = height;
    viewport = Object.assign(new EventTarget(), { height, width: 393, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    calls = {};
    const keyboardManager = {
      getShowQuickKeys: () => false,
      getKeyboardMode: () => false,
      exitKeyboardMode,
      isRecentlyEnteredKeyboardMode: () => false,
      ensureHiddenInputVisible: vi.fn(),
      cleanup: vi.fn(),
    };
    const callbacks = new Proxy(calls, {
      get: (target, name: string) => {
        if (name === 'getDirectKeyboardManager') return () => keyboardManager;
        if (name === 'querySelector') return () => null;
        target[name] ??= vi.fn();
        return target[name];
      },
    });
    manager = new LifecycleEventManager();
    manager.setCallbacks(callbacks as never);
    manager.setupLifecycle();
    (manager as unknown as { setupMobileFeatures(mobile: boolean): void }).setupMobileFeatures(
      true
    );
  }

  function focusField(): HTMLTextAreaElement {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    return field;
  }

  function viewportSays(viewportHeight: number, innerHeight = inner) {
    inner = innerHeight;
    viewport.height = viewportHeight;
    viewport.dispatchEvent(new Event('resize'));
  }

  function expectNoGap(height: number) {
    expect(gap()).toBe('0px');
    expect(root().style.getPropertyValue('--app-height')).toBe(`${height}px`);
    expect(root().style.getPropertyValue('--keyboard-offset')).toBe('0px');
    expect(root().getAttribute('data-keyboard-visible')).toBe('false');
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    exitKeyboardMode.mockClear();
  });

  afterEach(() => {
    manager.teardownLifecycle();
    manager.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a viewport left at its keyboard-up size gives no gap with nothing editable focused', () => {
    setup(852);
    // Stale numbers arrive with a resize (a session change, a return): no field has the focus.
    viewportSays(516);
    expectNoGap(852);
  });

  it('the hidden input getting the focus outside keyboard mode applies no gap from stale numbers', () => {
    setup(852);
    viewport.height = 516;
    manager.measureKeyboard();
    expectNoGap(852);
  });

  it('a field losing the focus with no viewport event takes the gap away', () => {
    setup(852);
    const field = focusField();
    viewportSays(516);
    expect(gap()).toBe('336px');
    vi.advanceTimersByTime(5000); // typing for a while: the opening's settle passes are over

    field.blur(); // the keyboard goes; the viewport keeps 516 and fires nothing
    expect(gap()).toBe('336px'); // not at once: the focus may be moving to another field
    vi.advanceTimersByTime(300);
    expectNoGap(852);
  });

  it('the focus moving to another field keeps the gap', () => {
    setup(852);
    const first = focusField();
    viewportSays(516);
    first.blur();
    focusField();
    vi.advanceTimersByTime(1000);
    expect(gap()).toBe('336px');
    expect(root().getAttribute('data-keyboard-visible')).toBe('true');
  });

  it('numbers corrected with no event, long after the last one, are read within a second', () => {
    setup(894);
    focusField();
    // Home-screen app: innerHeight shrinks with the keyboard.
    viewportSays(560, 560);
    expect(gap()).toBe('334px');
    vi.advanceTimersByTime(5000); // every resync timer of the opening is long over

    // The keyboard went (the field keeps the focus, as after a return) and iOS said nothing.
    inner = 894;
    viewport.height = 894;
    vi.advanceTimersByTime(1000);
    expectNoGap(894);
  });

  it('leaves an open keyboard alone: same gap, nothing written again', () => {
    setup(852);
    focusField();
    viewportSays(516);
    vi.advanceTimersByTime(1500); // the opening's own settle passes
    const writes = calls.setKeyboardHeight.mock.calls.length;
    const height = root().style.getPropertyValue('--app-height');
    vi.advanceTimersByTime(10_000);
    expect(calls.setKeyboardHeight.mock.calls.length).toBe(writes);
    expect(gap()).toBe('336px');
    expect(root().style.getPropertyValue('--app-height')).toBe(height);
    expect(exitKeyboardMode).not.toHaveBeenCalled();
  });

  it('the gap does not outlive the session view', () => {
    setup(852);
    focusField();
    viewportSays(516);
    expect(root().getAttribute('data-keyboard-visible')).toBe('true');
    manager.teardownLifecycle();
    expect(gap()).toBe('0px');
    expect(root().getAttribute('data-keyboard-visible')).toBe('false');
  });
});

describe('DirectKeyboardManager dismissal', () => {
  it('chat mode taking over tells the one writer of the keyboard height', () => {
    const keyboardDismissed = vi.fn();
    const callbacks = new Proxy({} as Record<string, unknown>, {
      get: (_target, name: string) => {
        if (name === 'keyboardDismissed') return keyboardDismissed;
        return vi.fn();
      },
    });
    const keyboard = new DirectKeyboardManager('gap-test');
    keyboard.setCallbacks(callbacks as never);
    keyboard.blurHiddenInput();
    expect(keyboardDismissed).toHaveBeenCalledTimes(1);
    keyboard.cleanup();
  });

  it('tells the session view when it leaves keyboard mode', () => {
    const manager = new DirectKeyboardManager();
    const keyboardDismissed = vi.fn();
    const callbacks = new Proxy({} as Record<string, unknown>, {
      get: (target, name: string) => {
        if (name === 'keyboardDismissed') return keyboardDismissed;
        target[name] ??= vi.fn();
        return target[name];
      },
    });
    manager.setCallbacks(callbacks as never);
    (manager as unknown as { keyboardMode: boolean }).keyboardMode = true;
    manager.exitKeyboardMode();
    expect(keyboardDismissed).toHaveBeenCalledTimes(1);
    manager.cleanup();
  });
});
