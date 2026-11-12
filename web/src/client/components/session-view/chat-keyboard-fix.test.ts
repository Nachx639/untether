/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatKeyboardFix,
  type ChatKeyboardFixState,
  chatKeyboardFixApplies,
  chatKeyboardFixLayout,
} from './chat-keyboard-fix.js';
import { LifecycleEventManager } from './lifecycle-event-manager.js';

const serverConfig = vi.hoisted(() => ({ chatKeyboardFix: true as boolean | undefined }));
vi.mock('../../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: async () => ({ ...serverConfig }) },
}));

// The owner's iPhone in the home-screen app, 700 ms after the chat composer took the focus
// (2026-10-03): inner 440x541, vv 440x541 top 353, scroll 0,353, composer 483-531.
const IPHONE = { scrollY: 353, vvPageTop: 353, vvOffsetTop: 353, vvHeight: 541 };

describe('where the chat keyboard fix puts the session layout', () => {
  it('on the visible area, in the coordinates of the block it is placed in', () => {
    // The containing block starts at the top of the document: client y -353 once scrolled.
    expect(
      chatKeyboardFixLayout({
        scrollY: IPHONE.scrollY,
        vvPageTop: IPHONE.vvPageTop,
        vvHeight: IPHONE.vvHeight,
        containerTop: -353,
      })
    ).toEqual({ top: 353, height: 541 });
  });

  it('follows a visible area panned below the scroll, and a block that starts lower', () => {
    expect(
      chatKeyboardFixLayout({ scrollY: 300, vvPageTop: 340.4, vvHeight: 540.6, containerTop: -250 })
    ).toEqual({ top: 290, height: 541 });
  });

  const on: ChatKeyboardFixState = {
    enabled: true,
    standalone: true,
    composerFocused: true,
    scrollY: 353,
    scale: 1,
  };

  it('applies only with the flag, in the home-screen app, composer focused, page scrolled', () => {
    expect(chatKeyboardFixApplies(on)).toBe(true);
    expect(chatKeyboardFixApplies({ ...on, enabled: false })).toBe(false);
    expect(chatKeyboardFixApplies({ ...on, standalone: false })).toBe(false);
    expect(chatKeyboardFixApplies({ ...on, composerFocused: false })).toBe(false);
    expect(chatKeyboardFixApplies({ ...on, scrollY: 0 })).toBe(false);
    expect(chatKeyboardFixApplies({ ...on, scrollY: 0.5 })).toBe(false);
    expect(chatKeyboardFixApplies({ ...on, scale: 2 })).toBe(false);
  });
});

describe('ChatKeyboardFix on the page', () => {
  let pageY = 0;
  let flag = true;
  let fix: ChatKeyboardFix;
  const logs: string[] = [];
  const root = document.documentElement;

  const mount = () => {
    const grid = document.createElement('div');
    grid.className = 'session-view-grid';
    grid.dataset.mobile = 'true';
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ top: -pageY, height: 956 }) as DOMRect;
    Object.defineProperty(grid, 'offsetParent', { configurable: true, get: () => container });
    const composer = document.createElement('terminal-chat-view');
    composer.setAttribute('composeronly', '');
    composer.tabIndex = 0;
    composer.getBoundingClientRect = () => ({ top: 483, bottom: 531 }) as DOMRect;
    grid.append(composer);
    container.append(grid);
    document.body.append(container);
    return composer;
  };
  /** iOS scrolls the page to show the composer above the keyboard. */
  const iosScrolls = (y: number) => {
    pageY = y;
    fix.update();
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    pageY = 0;
    flag = true;
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => pageY);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const viewport = Object.assign(new EventTarget(), {
      width: 440,
      height: IPHONE.vvHeight,
      scale: 1,
    });
    Object.defineProperty(viewport, 'offsetTop', { get: () => pageY });
    Object.defineProperty(viewport, 'pageTop', { get: () => pageY });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    fix = new ChatKeyboardFix(
      async () => flag,
      () => true
    );
  });

  afterEach(() => {
    fix.stop();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('places the layout over the visible area without scrolling the page back', async () => {
    const composer = mount();
    fix.refreshFlag();
    await settle();
    composer.focus();
    fix.focusChanged();
    await settle();
    expect(root.hasAttribute('data-kbfix')).toBe(false);

    iosScrolls(353);
    expect(root.hasAttribute('data-kbfix')).toBe(true);
    expect(root.style.getPropertyValue('--kbfix-top')).toBe('353px');
    expect(root.style.getPropertyValue('--kbfix-height')).toBe('541px');
    expect(window.scrollTo).not.toHaveBeenCalled();
    const line = logs.find((l) => l.includes('kbfix: top'));
    expect(line).toContain('kbfix: top 353 height 541');
    expect(line).toContain('offsetTop 353');
    expect(line).toContain('scroll 353');
    expect(line).toContain('composer 483-531');

    // The keyboard closes: the layout is position: fixed again.
    composer.blur();
    fix.focusChanged();
    expect(root.hasAttribute('data-kbfix')).toBe(false);
    expect(root.style.getPropertyValue('--kbfix-top')).toBe('');
    expect(logs.some((l) => l.includes('kbfix: off (composer not focused)'))).toBe(true);
  });

  it('lets go once the page is back at its top', async () => {
    const composer = mount();
    fix.refreshFlag();
    await settle();
    composer.focus();
    iosScrolls(353);
    expect(root.hasAttribute('data-kbfix')).toBe(true);
    iosScrolls(0);
    expect(root.hasAttribute('data-kbfix')).toBe(false);
  });

  it('does nothing with the flag off, and stops when it is turned off', async () => {
    flag = false;
    const composer = mount();
    fix.refreshFlag();
    await settle();
    composer.focus();
    iosScrolls(353);
    expect(root.hasAttribute('data-kbfix')).toBe(false);
    expect(logs.some((l) => l.includes('kbfix:'))).toBe(false);

    flag = true;
    fix.focusChanged();
    await settle();
    expect(root.hasAttribute('data-kbfix')).toBe(true);

    // Turned off in config.json: the next focus asks the server again.
    flag = false;
    fix.focusChanged();
    await settle();
    expect(root.hasAttribute('data-kbfix')).toBe(false);
  });

  it('is not asked for outside the home-screen app', async () => {
    const load = vi.fn(async () => true);
    fix = new ChatKeyboardFix(load, () => false);
    const composer = mount();
    fix.refreshFlag();
    await settle();
    composer.focus();
    iosScrolls(353);
    expect(load).not.toHaveBeenCalled();
    expect(root.hasAttribute('data-kbfix')).toBe(false);
  });

  it('logs a line only when its numbers change', async () => {
    const composer = mount();
    fix.refreshFlag();
    await settle();
    composer.focus();
    iosScrolls(353);
    iosScrolls(353);
    iosScrolls(353);
    expect(logs.filter((l) => l.includes('kbfix: top'))).toHaveLength(1);
  });
});

describe('the session view with the chat keyboard fix', () => {
  let pageY = 0;
  let manager: LifecycleEventManager | null = null;
  const root = document.documentElement;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    pageY = 0;
    serverConfig.chatKeyboardFix = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15'
    );
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => pageY);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const viewport = Object.assign(new EventTarget(), { width: 440, height: 541, scale: 1 });
    Object.defineProperty(viewport, 'offsetTop', { get: () => pageY });
    Object.defineProperty(viewport, 'pageTop', { get: () => pageY });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });

  afterEach(() => {
    manager?.cleanup();
    manager = null;
    document.body.innerHTML = '';
    Reflect.deleteProperty(navigator, 'standalone');
    vi.restoreAllMocks();
  });

  const openPhoneChat = async () => {
    const grid = document.createElement('div');
    grid.className = 'session-view-grid';
    grid.dataset.mobile = 'true';
    const composer = document.createElement('terminal-chat-view');
    composer.setAttribute('composeronly', '');
    composer.tabIndex = 0;
    grid.append(composer);
    document.body.append(grid);
    manager = new LifecycleEventManager();
    await settle();
    composer.focus();
    await settle();
    return composer;
  };

  it("follows iOS's scroll of the page while the composer is focused, never undoing it", async () => {
    const composer = await openPhoneChat();
    pageY = 353;
    window.dispatchEvent(new Event('scroll'));
    expect(root.hasAttribute('data-kbfix')).toBe(true);
    expect(window.scrollTo).not.toHaveBeenCalled();

    composer.blur();
    await settle();
    expect(root.hasAttribute('data-kbfix')).toBe(false);
  });

  it('is off unless config.json turns it on', async () => {
    serverConfig.chatKeyboardFix = undefined;
    await openPhoneChat();
    pageY = 353;
    window.dispatchEvent(new Event('scroll'));
    expect(root.hasAttribute('data-kbfix')).toBe(false);
  });

  it('lets go when the session view closes', async () => {
    await openPhoneChat();
    pageY = 353;
    window.dispatchEvent(new Event('scroll'));
    expect(root.hasAttribute('data-kbfix')).toBe(true);
    manager?.cleanup();
    manager = null;
    expect(root.hasAttribute('data-kbfix')).toBe(false);
    window.dispatchEvent(new Event('scroll'));
    expect(root.hasAttribute('data-kbfix')).toBe(false);
  });
});
