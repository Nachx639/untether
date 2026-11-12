// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followRotationsOutsideSession, resetAppHeight } from './app-height.js';

// 2026-10-04: in the home-screen app viewport-init.js sets the page height once, at load. On
// its side the list kept the portrait height (956 pt in a 440 pt window), its bottom off
// screen; loaded on its side and turned upright, it missed the status bar's height.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15';

function homeScreenProMax(window_: [number, number]) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_UA);
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  vi.spyOn(window.screen, 'width', 'get').mockReturnValue(440);
  vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: window_[0] });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: window_[1] });
}

const appHeight = () => document.documentElement.style.getPropertyValue('--app-height');

describe('the page height across rotations, outside a session', () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    // As viewport-init.js leaves it in the home-screen app loaded upright.
    document.documentElement.style.setProperty('--app-height', '956px');
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'standalone');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    document.documentElement.style.removeProperty('--app-height');
  });

  it('drops the portrait height on its side and brings it back upright', () => {
    homeScreenProMax([440, 894]);
    stop = followRotationsOutsideSession(() => false);

    homeScreenProMax([956, 440]);
    window.dispatchEvent(new Event('resize'));
    // The window's own height (100dvh in styles.css).
    expect(appHeight()).toBe('');

    homeScreenProMax([440, 894]);
    window.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('956px');
  });

  it('checks again after orientationchange, when iOS has the new size', () => {
    vi.useFakeTimers();
    try {
      homeScreenProMax([440, 894]);
      stop = followRotationsOutsideSession(() => false);
      window.dispatchEvent(new Event('orientationchange'));
      expect(appHeight()).toBe('956px');
      homeScreenProMax([956, 440]);
      vi.advanceTimersByTime(300);
      expect(appHeight()).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the height to an open session, which tracks it itself', () => {
    stop = followRotationsOutsideSession(() => true);
    homeScreenProMax([956, 440]);
    window.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('956px');
  });

  it('stops when asked', () => {
    stop = followRotationsOutsideSession(() => false);
    stop();
    homeScreenProMax([956, 440]);
    window.dispatchEvent(new Event('resize'));
    expect(appHeight()).toBe('956px');
  });

  it('resetAppHeight outside the home-screen app goes back to the stylesheet', () => {
    resetAppHeight();
    expect(appHeight()).toBe('');
  });
});
