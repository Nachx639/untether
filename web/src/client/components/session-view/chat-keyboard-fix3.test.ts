/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatKeyboardFix3,
  chatKeyboardFix3Layout,
  composerOverflow,
} from './chat-keyboard-fix3.js';
import { LifecycleEventManager } from './lifecycle-event-manager.js';

const serverConfig = vi.hoisted(() => ({
  chatKeyboardFix: undefined as boolean | undefined,
  chatKeyboardFix2: undefined as boolean | undefined,
  chatKeyboardFix3: undefined as boolean | undefined,
}));
vi.mock('../../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: async () => ({ ...serverConfig }) },
}));

// The owner's iPhone in the home-screen app (2026-10-04): 440x956, keyboard 415; iOS scrolled
// the page 353 to reveal the composer, and the visual viewport's top said 353 or 291.
const SCREEN = 956;
const KEYBOARD = 415;

describe('where the chat keyboard fix, iteration 4, puts the layout', () => {
  it('as tall as the visible area, at its top', () => {
    // Home-screen app, keyboard up: window and visual viewport both 541, whatever iOS's top.
    expect(
      chatKeyboardFix3Layout({ innerHeight: 541, vvHeight: 541, vvOffsetTop: 291, shortfall: 0 })
    ).toEqual({ height: 541, top: 0 });
    // A home-screen app short by its status bar, keyboard down: the screen's height.
    expect(
      chatKeyboardFix3Layout({ innerHeight: 894, vvHeight: 894, vvOffsetTop: 0, shortfall: 62 })
    ).toEqual({ height: 956, top: 0 });
    // A Safari tab: the window stays tall and the visual viewport really pans inside it.
    expect(
      chatKeyboardFix3Layout({ innerHeight: 800, vvHeight: 420, vvOffsetTop: 120.4, shortfall: 0 })
    ).toEqual({ height: 420, top: 120 });
    // The iPhone 27 Pro Max simulator, home-screen app, keyboard up (2026-10-04): innerHeight
    // stays 894 while the visual viewport is 541; the status bar's 62 is not added (was 603).
    expect(
      chatKeyboardFix3Layout({ innerHeight: 894, vvHeight: 541, vvOffsetTop: 0, shortfall: 62 })
    ).toEqual({ height: 541, top: 0 });
  });

  it("measures how far the composer is under the visible area's bottom", () => {
    expect(composerOverflow({ composerBottom: 531, vvOffsetTop: 0, vvHeight: 541 })).toBe(0);
    expect(composerOverflow({ composerBottom: 541.4, vvOffsetTop: 0, vvHeight: 541 })).toBe(0);
    expect(composerOverflow({ composerBottom: 603, vvOffsetTop: 0, vvHeight: 541 })).toBe(62);
    expect(composerOverflow({ composerBottom: 603, vvOffsetTop: 120, vvHeight: 541 })).toBe(0);
  });
});

/** A fake phone: window, visual viewport, iOS's page scroll. */
function fakePhone() {
  const phone = { inner: SCREEN, vvHeight: SCREEN, offsetTop: 0, scrollY: 0, scale: 1 };
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => phone.inner);
  vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => 440);
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => phone.scrollY);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {
    phone.scrollY = 0;
    phone.offsetTop = 0;
  });
  const viewport = Object.assign(new EventTarget(), { width: 440 });
  Object.defineProperty(viewport, 'height', { get: () => phone.vvHeight });
  Object.defineProperty(viewport, 'offsetTop', { get: () => phone.offsetTop });
  Object.defineProperty(viewport, 'scale', { get: () => phone.scale });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });

  /** The phone session layout, the composer in its shadow root, and the fields iOS offered. */
  const mount = () => {
    const list = document.createElement('div');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'show-exited-toggle';
    list.append(toggle);

    const grid = document.createElement('div');
    grid.className = 'session-view-grid';
    grid.dataset.mobile = 'true';
    const terminalInput = document.createElement('textarea');
    terminalInput.id = 'terminal-input';
    terminalInput.setAttribute('inert', '');
    const chat = document.createElement('claude-chat-view');
    const searchProxy = document.createElement('input');
    searchProxy.className = 'search-proxy';
    searchProxy.tabIndex = -1;
    chat.attachShadow({ mode: 'open' }).append(searchProxy);
    const host = document.createElement('terminal-chat-view');
    host.setAttribute('composeronly', '');
    const field = document.createElement('textarea');
    field.id = 'chat-input-field';
    const send = document.createElement('button');
    host.attachShadow({ mode: 'open' }).append(field, send);
    grid.append(terminalInput, chat, host);
    document.body.append(list, grid);
    return { field, toggle, searchProxy, terminalInput, send };
  };

  /** iOS brings the keyboard up and scrolls the page to reveal the composer. */
  const keyboardUp = (offsetTop = 353) => {
    phone.inner = SCREEN - KEYBOARD;
    phone.vvHeight = SCREEN - KEYBOARD;
    phone.scrollY = 353;
    phone.offsetTop = offsetTop;
  };
  const keyboardDown = () => {
    phone.inner = SCREEN;
    phone.vvHeight = SCREEN;
    phone.scrollY = 0;
    phone.offsetTop = 0;
  };

  return { phone, mount, keyboardUp, keyboardDown, viewport };
}

const root = document.documentElement;
const held = () => root.hasAttribute('data-kbfix3');
const height = () => root.style.getPropertyValue('--kbfix3-height');

describe('ChatKeyboardFix3 on the page', () => {
  let flag = true;
  let fix: ChatKeyboardFix3;
  let phone: ReturnType<typeof fakePhone>;
  const logs: string[] = [];
  const flush = () => vi.advanceTimersByTimeAsync(0);
  /** What the session view does on a visualViewport event: --app-height, then the fix. */
  const viewportEvent = () => {
    root.style.setProperty('--app-height', `${phone.phone.vvHeight}px`);
    fix.viewportChanged();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    flag = true;
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    phone = fakePhone();
    fix = new ChatKeyboardFix3(
      async () => flag,
      () => true
    );
    fix.start();
    await flush();
  });

  afterEach(() => {
    fix.stop();
    document.body.innerHTML = '';
    root.style.removeProperty('--app-height');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('holds the page to the visible area and its scroll at 0 while the composer is focused', async () => {
    const { field, toggle, searchProxy, terminalInput } = phone.mount();
    field.focus();
    await flush();
    // Keyboard still to come: the full height, nothing to scroll yet.
    expect(held()).toBe(true);
    expect(height()).toBe(`${SCREEN}px`);

    // The keyboard comes and iOS scrolls 353, its viewport top saying 291 (the band's case).
    phone.keyboardUp(291);
    viewportEvent();
    expect(height()).toBe('541px');
    expect(root.style.getPropertyValue('--app-height')).toBe('541px');
    expect(root.style.getPropertyValue('--kbfix3-top')).toBe('0px');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(window.scrollY).toBe(0);

    // iOS scrolls again: put back at once, on the window's scroll and the viewport's.
    phone.phone.scrollY = 353;
    window.dispatchEvent(new Event('scroll'));
    expect(window.scrollY).toBe(0);
    phone.phone.scrollY = 62;
    viewportEvent();
    expect(window.scrollY).toBe(0);

    // No ↑ ↓ bar: the other fields are inert, the composer and the already inert one as they were.
    expect(toggle.hasAttribute('inert')).toBe(true);
    expect(searchProxy.hasAttribute('inert')).toBe(true);
    expect(field.hasAttribute('inert')).toBe(false);
    expect(terminalInput.hasAttribute('inert')).toBe(true);

    await vi.advanceTimersByTimeAsync(700);
    const line = logs.find((l) => l.includes('kbfix3: holding'));
    expect(line).toContain(
      'kbfix3: holding | inner 440x541, vv 440x541 top 0, scrollY 0, app 541px'
    );
    expect(line).toContain('inert 2');
  });

  it('gives everything back when the composer loses the focus', async () => {
    const { field, toggle, searchProxy, terminalInput } = phone.mount();
    field.focus();
    await flush();
    phone.keyboardUp();
    viewportEvent();
    expect(held()).toBe(true);

    field.blur();
    await flush();
    expect(held()).toBe(false);
    expect(height()).toBe('');
    expect(root.style.getPropertyValue('--kbfix3-top')).toBe('');
    expect(toggle.hasAttribute('inert')).toBe(false);
    expect(searchProxy.hasAttribute('inert')).toBe(false);
    // Not one of its own: left inert.
    expect(terminalInput.hasAttribute('inert')).toBe(true);

    // And it no longer touches the scroll.
    vi.mocked(window.scrollTo).mockClear();
    phone.phone.scrollY = 100;
    window.dispatchEvent(new Event('scroll'));
    viewportEvent();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('lets go when the keyboard goes down with the composer focused, and holds again when it is back', async () => {
    const { field, toggle } = phone.mount();
    field.focus();
    await flush();
    phone.keyboardUp();
    viewportEvent();
    expect(held()).toBe(true);

    phone.keyboardDown();
    viewportEvent();
    expect(held()).toBe(false);
    expect(toggle.hasAttribute('inert')).toBe(false);
    // Not taken again by a later check while the keyboard stays down.
    await vi.advanceTimersByTimeAsync(700);
    expect(held()).toBe(false);

    phone.keyboardUp();
    viewportEvent();
    expect(held()).toBe(true);
    expect(height()).toBe('541px');
  });

  it('does the same whatever the way in: keyboard already up, again, back from the background', async () => {
    const { field } = phone.mount();
    // From the terminal: the keyboard is already up when the composer takes the focus.
    phone.keyboardUp();
    viewportEvent();
    expect(held()).toBe(false);
    field.focus();
    await flush();
    expect(held()).toBe(true);
    expect(height()).toBe('541px');
    expect(window.scrollY).toBe(0);

    // The same events again change nothing.
    viewportEvent();
    viewportEvent();
    expect(height()).toBe('541px');

    // Back from the background, iOS having scrolled meanwhile.
    phone.phone.scrollY = 353;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(window.scrollY).toBe(0);
    expect(held()).toBe(true);

    // A second focus after a blur.
    field.blur();
    await flush();
    expect(held()).toBe(false);
    field.focus();
    await flush();
    expect(held()).toBe(true);
    expect(height()).toBe('541px');
  });

  it('gives the other fields back on a touch elsewhere, inert again if the composer kept the focus', async () => {
    const { field, toggle, send } = phone.mount();
    field.focus();
    await flush();
    expect(toggle.hasAttribute('inert')).toBe(true);

    // A touch in the composer itself changes nothing.
    field.dispatchEvent(new Event('touchstart', { bubbles: true, composed: true }));
    expect(toggle.hasAttribute('inert')).toBe(true);

    send.dispatchEvent(new Event('touchstart', { bubbles: true, composed: true }));
    expect(toggle.hasAttribute('inert')).toBe(false);
    send.dispatchEvent(new Event('touchend', { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(399);
    expect(toggle.hasAttribute('inert')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(toggle.hasAttribute('inert')).toBe(true);
  });

  it('does nothing with the flag off, nor for a pinch-zoomed page', async () => {
    flag = false;
    fix.refreshFlag();
    await flush();
    const { field, toggle } = phone.mount();
    field.focus();
    await flush();
    phone.keyboardUp();
    viewportEvent();
    expect(held()).toBe(false);
    expect(toggle.hasAttribute('inert')).toBe(false);
    expect(window.scrollTo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(logs.some((l) => l.includes('kbfix3: holding') || l.includes('kbfix3: idle'))).toBe(
      false
    );

    // Turned on live while the composer has the focus: held at once.
    flag = true;
    fix.refreshFlag();
    await flush();
    expect(held()).toBe(true);

    phone.phone.scale = 1.6;
    viewportEvent();
    expect(held()).toBe(false);
  });

  it("keeps the composer's bottom on the visible area's with a safe-area inset (simulator)", async () => {
    // iPhone 27 Pro Max simulator, home-screen app: screen 956, window 894 (the status bar's 62
    // left out), and the window does not shrink for the keyboard.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15'
    );
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    Object.defineProperty(window.screen, 'height', { configurable: true, get: () => SCREEN });
    phone.phone.inner = 894;
    phone.phone.vvHeight = 894;
    fix.viewportChanged();

    const { field } = phone.mount();
    const host =
      field.getRootNode() instanceof ShadowRoot
        ? ((field.getRootNode() as ShadowRoot).host as HTMLElement)
        : field;
    const header = document.createElement('div');
    header.className = 'session-header-area';
    host.parentElement?.prepend(header);
    // A content-box header padded by env(safe-area-inset-top): it adds 62 to whatever height
    // the layout is given, and the composer is its last row, 10 px above its bottom.
    let inset = 62;
    const realStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
      element === header
        ? ({ paddingTop: `${inset}px` } as CSSStyleDeclaration)
        : realStyle(element, pseudo)
    );
    host.getBoundingClientRect = () => {
      const given = Number.parseFloat(root.style.getPropertyValue('--kbfix3-height') || '0');
      const padding = Number.parseFloat(window.getComputedStyle(header).paddingTop);
      const bottom = given + padding - 10;
      return { top: bottom - 48, bottom } as DOMRect;
    };

    field.focus();
    await flush();
    // Keyboard up: the visual viewport is 541, the window still 894; no iOS scroll.
    phone.phone.vvHeight = SCREEN - KEYBOARD;
    phone.phone.offsetTop = 0;
    viewportEvent();
    expect(host.getBoundingClientRect().bottom).toBeLessThanOrEqual(SCREEN - KEYBOARD);
    expect(height()).toBe('489px');

    // Nothing padded: exactly the visual viewport, not 603.
    inset = 0;
    viewportEvent();
    expect(height()).toBe('541px');
    expect(root.style.getPropertyValue('--app-height')).toBe('541px');
    expect(host.getBoundingClientRect().bottom).toBeLessThanOrEqual(SCREEN - KEYBOARD);

    await vi.advanceTimersByTimeAsync(700);
    expect(logs.find((l) => l.includes('kbfix3: holding'))).toContain(
      'inner 440x894, vv 440x541 top 0, scrollY 0, app 541px'
    );
    expect(logs.find((l) => l.includes('kbfix3: holding'))).toContain('composer bottom 531');
    Reflect.deleteProperty(navigator, 'standalone');
    Reflect.deleteProperty(window.screen, 'height');
  });

  it('is not asked for where it cannot apply', async () => {
    const load = vi.fn(async () => true);
    fix.stop();
    fix = new ChatKeyboardFix3(load, () => false);
    fix.start();
    await flush();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('the session view with the chat keyboard fix, iteration 4', () => {
  let manager: LifecycleEventManager | null = null;
  let phone: ReturnType<typeof fakePhone>;

  beforeEach(() => {
    serverConfig.chatKeyboardFix = undefined;
    serverConfig.chatKeyboardFix2 = undefined;
    serverConfig.chatKeyboardFix3 = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15'
    );
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    phone = fakePhone();
  });

  afterEach(() => {
    manager?.cleanup();
    manager = null;
    document.body.innerHTML = '';
    Reflect.deleteProperty(navigator, 'standalone');
    vi.restoreAllMocks();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is off by default: the page follows --app-height and keeps iOS scroll as before', async () => {
    const { field, toggle } = phone.mount();
    manager = new LifecycleEventManager();
    await settle();
    field.focus();
    await settle();
    phone.keyboardUp();
    phone.viewport.dispatchEvent(new Event('resize'));
    expect(held()).toBe(false);
    expect(root.style.getPropertyValue('--vv-top')).toBe('353px');
    expect(toggle.hasAttribute('inert')).toBe(false);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('with the flag, holds the page in the visualViewport event itself; older fixes stand down', async () => {
    serverConfig.chatKeyboardFix = true;
    serverConfig.chatKeyboardFix2 = true;
    serverConfig.chatKeyboardFix3 = true;
    const { field } = phone.mount();
    manager = new LifecycleEventManager();
    await settle();
    // Iteration 3 does not take the tap over.
    const end = new Event('touchend', { bubbles: true, composed: true, cancelable: true });
    Object.assign(end, { touches: [], changedTouches: [{ clientX: 200, clientY: 880 }] });
    field.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(false);
    expect(root.hasAttribute('data-kbfix2')).toBe(false);

    field.focus();
    await settle();
    expect(held()).toBe(true);
    phone.keyboardUp(291);
    phone.viewport.dispatchEvent(new Event('resize'));
    expect(root.style.getPropertyValue('--app-height')).toBe('541px');
    expect(height()).toBe('541px');
    expect(window.scrollY).toBe(0);
    window.dispatchEvent(new Event('scroll'));
    expect(root.hasAttribute('data-kbfix')).toBe(false);

    manager.cleanup();
    manager = null;
    expect(held()).toBe(false);
  });
});
