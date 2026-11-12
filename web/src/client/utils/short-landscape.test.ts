// @vitest-environment happy-dom
import { LitElement } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentShortLandscape,
  isShortLandscape,
  SHORT_LANDSCAPE_MAX_HEIGHT_PT,
  ShortLandscapeController,
} from './short-landscape.js';

// Windows in pt (CSS px) as Safari gives them, bars included. 2026-10-04: a Pro Max in
// landscape showed no session in the list and a three-line session header.
const VIEWPORTS = [
  ['iPhone SE, portrait', { width: 375, height: 548 }, false],
  ['iPhone SE, landscape', { width: 667, height: 323 }, true],
  ['iPhone Pro Max, portrait', { width: 440, height: 830 }, false],
  ['iPhone Pro Max, landscape', { width: 956, height: 330 }, true],
  ['iPhone Pro Max, landscape, home-screen app', { width: 956, height: 440 }, true],
  ['iPad, portrait', { width: 820, height: 1180 }, false],
  ['iPad, landscape', { width: 1180, height: 820 }, false],
  ['iPad mini, landscape', { width: 1133, height: 744 }, false],
] as const;

function setWindow(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

describe('isShortLandscape', () => {
  it.each(VIEWPORTS)('%s', (_name, viewport, expected) => {
    expect(isShortLandscape(viewport)).toBe(expected);
  });

  it('is short up to 500 pt tall', () => {
    expect(SHORT_LANDSCAPE_MAX_HEIGHT_PT).toBe(500);
    expect(isShortLandscape({ width: 900, height: 500 })).toBe(true);
    expect(isShortLandscape({ width: 900, height: 501 })).toBe(false);
  });

  it('a keyboard that shrinks a portrait window is not a rotation', () => {
    // Android with interactive-widget=resizes-content: a 412 pt wide phone, wider than tall.
    const keyboard = { width: 412, height: 300, screenShortSide: 412 };
    expect(isShortLandscape({ ...keyboard, orientation: 'portrait-primary' })).toBe(false);
    // Without the API it can't be told apart: the window decides.
    expect(isShortLandscape(keyboard)).toBe(true);
  });

  it('a window wider than the screen is short is on its side, whatever the API says', () => {
    // QA 2026-10-04: the orientation may lag or be wrong on iOS; the width can't.
    const proMax = { width: 956, height: 330, screenShortSide: 440 };
    expect(isShortLandscape({ ...proMax, orientation: 'portrait-primary' })).toBe(true);
    expect(isShortLandscape({ ...proMax, orientation: 'landscape-primary' })).toBe(true);
    expect(isShortLandscape(proMax)).toBe(true);
  });
});

describe('currentShortLandscape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setWindow(1024, 768);
  });

  // First: the log is once per page and decision.
  it('logs its inputs once per decision, for the server log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setWindow(956, 330);
    currentShortLandscape();
    currentShortLandscape();
    setWindow(440, 830);
    currentShortLandscape();
    currentShortLandscape();
    const lines = log.mock.calls
      .map((call) => call.join(' '))
      .filter((line) => line.includes('short landscape'));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('short landscape on: inner 956×330');
    expect(lines[1]).toContain('short landscape off: inner 440×830');
    for (const line of lines)
      expect(line).toMatch(/inner \d+×\d+, visualViewport .+, screen.orientation/);
  });

  it('follows the window, not the screen iOS reports in portrait', () => {
    vi.spyOn(window.screen, 'width', 'get').mockReturnValue(440);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(956);
    setWindow(956, 330);
    expect(currentShortLandscape()).toBe(true);
    setWindow(440, 830);
    expect(currentShortLandscape()).toBe(false);
  });

  it('rules out a keyboard only when the device says portrait', () => {
    vi.spyOn(window.screen, 'width', 'get').mockReturnValue(412);
    vi.spyOn(window.screen, 'height', 'get').mockReturnValue(915);
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      value: { type: 'portrait-primary' },
    });
    try {
      setWindow(412, 300);
      expect(currentShortLandscape()).toBe(false);
      setWindow(915, 330);
      expect(currentShortLandscape()).toBe(true);
    } finally {
      Reflect.deleteProperty(window.screen, 'orientation');
    }
  });
});

class Host extends LitElement {
  readonly shortLandscape = new ShortLandscapeController(this);
}
customElements.define('short-landscape-host', Host);

describe('ShortLandscapeController', () => {
  afterEach(() => {
    setWindow(1024, 768);
    document.body.innerHTML = '';
  });

  it('follows rotations both ways and re-renders its element each time', async () => {
    setWindow(440, 830);
    const host = document.createElement('short-landscape-host') as Host;
    document.body.append(host);
    await host.updateComplete;
    const update = vi.spyOn(host, 'requestUpdate');
    expect(host.shortLandscape.value).toBe(false);

    setWindow(956, 330);
    window.dispatchEvent(new Event('resize'));
    expect(host.shortLandscape.value).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);

    setWindow(440, 830);
    window.dispatchEvent(new Event('orientationchange'));
    expect(host.shortLandscape.value).toBe(false);
    expect(update).toHaveBeenCalledTimes(2);

    // A resize that changes nothing re-renders nothing.
    window.dispatchEvent(new Event('resize'));
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('checks again after orientationchange, when iOS has the new size', async () => {
    vi.useFakeTimers();
    try {
      setWindow(440, 830);
      const host = document.createElement('short-landscape-host') as Host;
      document.body.append(host);
      // iOS: orientationchange first, with the old size…
      window.dispatchEvent(new Event('orientationchange'));
      expect(host.shortLandscape.value).toBe(false);
      // …the new one a moment later, even if no resize comes.
      setWindow(956, 330);
      vi.advanceTimersByTime(300);
      expect(host.shortLandscape.value).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops listening when its element leaves the page', async () => {
    setWindow(440, 830);
    const host = document.createElement('short-landscape-host') as Host;
    document.body.append(host);
    host.remove();
    setWindow(956, 330);
    window.dispatchEvent(new Event('resize'));
    expect(host.shortLandscape.value).toBe(false);
  });
});
