/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: { forceReconnect: vi.fn() },
}));
vi.mock('../../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: vi.fn(async () => ({})) },
}));

import { sessionAppHeight } from '../../utils/app-height.js';
import { LifecycleEventManager } from './lifecycle-event-manager.js';

// 2026-10-12, owner's iPhone 17 Pro Max (956 pt), home-screen app, iOS 26: with the terminal
// keyboard up the second quick-keys row sat under iOS's ^ v ✓ bar, only on some openings.
// The log: inner 440x894, vv 440x568 (keyboard 388). innerHeight had dropped by the status bar
// (62), iosStandaloneShortfall() read that as the home-screen-app shortfall and --app-height
// became 568 + 62: the column's bottom 62 px went under the bar above the keyboard.
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15';

function homeScreenApp() {
  vi.stubGlobal('navigator', { userAgent: IPHONE, standalone: true, maxTouchPoints: 5 });
  vi.stubGlobal('screen', { height: 956, width: 440 });
  Object.defineProperty(window, 'innerWidth', { value: 440, configurable: true });
}

describe('sessionAppHeight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds the status-bar shortfall only with no keyboard', () => {
    homeScreenApp();
    expect(sessionAppHeight(894, 894)).toBe(956); // keyboard down, short window
    expect(sessionAppHeight(956, 956)).toBe(956); // keyboard down, full window
    expect(sessionAppHeight(894, 568)).toBe(568); // keyboard up, window lost the status bar
    expect(sessionAppHeight(956, 568)).toBe(568); // keyboard up, window kept its height
    expect(sessionAppHeight(568, 568)).toBe(568); // keyboard up, window shrank with it
  });

  it('Safari and other browsers: just the visual viewport', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, standalone: false });
    vi.stubGlobal('screen', { height: 956, width: 440 });
    Object.defineProperty(window, 'innerWidth', { value: 440, configurable: true });
    expect(sessionAppHeight(894, 894)).toBe(894);
    expect(sessionAppHeight(894, 506)).toBe(506);
  });
});

describe('session column with the keyboard up in the home-screen app', () => {
  let inner = 956;
  let viewport: EventTarget & { height: number; width: number; offsetTop: number };
  let calls: Record<string, ReturnType<typeof vi.fn>>;
  let manager: LifecycleEventManager;
  const root = () => document.documentElement;
  const appHeight = () => root().style.getPropertyValue('--app-height');

  function setup(initialInner: number) {
    homeScreenApp();
    inner = initialInner;
    viewport = Object.assign(new EventTarget(), { height: initialInner, width: 440, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
    calls = {};
    const keyboardManager = {
      getShowQuickKeys: () => true,
      getKeyboardMode: () => true,
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
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
  }

  afterEach(() => {
    manager.teardownLifecycle();
    manager.cleanup();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ends the column at the visible area when innerHeight drops by the status bar', () => {
    setup(956);
    inner = 894;
    viewport.height = 568;
    viewport.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('568px'); // was 630px: 62 px under the ^ v ✓ bar
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(388);
  });

  it('keeps the shortfall with the keyboard down', () => {
    setup(894);
    viewport.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('956px');
  });

  it('re-measures after the keyboard animation when iOS reports no last resize', () => {
    vi.useFakeTimers();
    setup(956);
    // First resize mid-animation: keyboard partly up.
    viewport.height = 640;
    viewport.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('640px');
    // iOS settles on the final size (keyboard and its bar) without another event.
    inner = 894;
    viewport.height = 568;
    vi.advanceTimersByTime(1000);
    expect(appHeight()).toBe('568px');
    expect(calls.setKeyboardHeight).toHaveBeenLastCalledWith(388);
    expect(root().getAttribute('data-keyboard-visible')).toBe('true');
  });
});
