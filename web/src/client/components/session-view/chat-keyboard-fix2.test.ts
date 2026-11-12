/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChatKeyboardFix2,
  type ChatKeyboardFix2State,
  chatKeyboardFix2Height,
  chatKeyboardFix2Intercepts,
  composerUnderKeyboard,
  type KeyboardMemory,
  measuredKeyboard,
} from './chat-keyboard-fix2.js';
import { LifecycleEventManager } from './lifecycle-event-manager.js';

const serverConfig = vi.hoisted(() => ({
  chatKeyboardFix: undefined as boolean | undefined,
  chatKeyboardFix2: true as boolean | undefined,
}));
vi.mock('../../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: async () => ({ ...serverConfig }) },
}));

// The owner's iPhone in the home-screen app (2026-10-03/04): 440x956, keyboard 415, so the
// keyboard line is at 541; before any fix iOS scrolled 353 to reveal the composer at 864-912.
const SCREEN = 956;
const KEYBOARD = 415;

describe('the numbers of the chat keyboard fix, iteration 3', () => {
  it('shortens the layout to above the keyboard to come, guessed or remembered', () => {
    // Nothing remembered: 45% of 956 is 430, minus a 16 px margin: bottom 510, line 541.
    expect(chatKeyboardFix2Height({ vvHeight: SCREEN, rememberedKeyboard: null })).toBe(510);
    expect(chatKeyboardFix2Height({ vvHeight: SCREEN, rememberedKeyboard: KEYBOARD })).toBe(525);
    expect(chatKeyboardFix2Height({ vvHeight: 100, rememberedKeyboard: 400 })).toBe(0);
  });

  it('measures the keyboard only once it has really shrunk the viewport', () => {
    expect(measuredKeyboard(SCREEN, SCREEN - KEYBOARD)).toBe(KEYBOARD);
    expect(measuredKeyboard(SCREEN, SCREEN - 40)).toBeNull();
    expect(measuredKeyboard(SCREEN, SCREEN)).toBeNull();
  });

  it("tells a composer under the keyboard from one above it (iOS's scrolled case too)", () => {
    expect(composerUnderKeyboard({ composerBottom: 531, vvOffsetTop: 0, vvHeight: 541 })).toBe(
      false
    );
    expect(composerUnderKeyboard({ composerBottom: 542, vvOffsetTop: 0, vvHeight: 541 })).toBe(
      false
    );
    expect(composerUnderKeyboard({ composerBottom: 603, vvOffsetTop: 0, vvHeight: 541 })).toBe(
      true
    );
    // Before any fix: iOS scrolled 353 and the composer's rect was 483-531.
    expect(composerUnderKeyboard({ composerBottom: 531, vvOffsetTop: 353, vvHeight: 541 })).toBe(
      false
    );
  });

  const on: ChatKeyboardFix2State = {
    enabled: true,
    standalone: true,
    onComposerField: true,
    composerFocused: false,
    dragged: false,
    scale: 1,
  };

  it('takes over only a tap on the unfocused composer, with the flag, in the home-screen app', () => {
    expect(chatKeyboardFix2Intercepts(on)).toBe(true);
    expect(chatKeyboardFix2Intercepts({ ...on, enabled: false })).toBe(false);
    expect(chatKeyboardFix2Intercepts({ ...on, standalone: false })).toBe(false);
    expect(chatKeyboardFix2Intercepts({ ...on, onComposerField: false })).toBe(false);
    expect(chatKeyboardFix2Intercepts({ ...on, composerFocused: true })).toBe(false);
    expect(chatKeyboardFix2Intercepts({ ...on, dragged: true })).toBe(false);
    expect(chatKeyboardFix2Intercepts({ ...on, scale: 1.5 })).toBe(false);
  });
});

/** A fake phone: the visual viewport, iOS's scroll, and a composer laid out by the CSS rules. */
function fakePhone() {
  const phone = {
    vvHeight: SCREEN,
    offsetTop: 0,
    /** Set to force the composer's bottom (client y), as a broken layout would leave it. */
    composerBottom: null as number | null,
  };
  const root = document.documentElement;
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => phone.offsetTop);
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => phone.vvHeight);
  vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => 440);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const viewport = Object.assign(new EventTarget(), { width: 440, scale: 1 });
  Object.defineProperty(viewport, 'height', { get: () => phone.vvHeight });
  Object.defineProperty(viewport, 'offsetTop', { get: () => phone.offsetTop });
  Object.defineProperty(viewport, 'pageTop', { get: () => phone.offsetTop });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });

  /** The phone session layout with the composer's field in its shadow root, as on the page. */
  const mount = () => {
    const grid = document.createElement('div');
    grid.className = 'session-view-grid';
    grid.dataset.mobile = 'true';
    const host = document.createElement('terminal-chat-view');
    host.setAttribute('composeronly', '');
    const field = document.createElement('textarea');
    field.id = 'chat-input-field';
    host.attachShadow({ mode: 'open' }).append(field);
    // session-view.ts: top --vv-top, height --kbfix2-height while held, else --app-height.
    host.getBoundingClientRect = () => {
      const held = root.style.getPropertyValue('--kbfix2-height');
      const bottom = phone.composerBottom ?? (held ? Number.parseFloat(held) : phone.vvHeight);
      return { top: bottom - 48, bottom } as DOMRect;
    };
    grid.append(host);
    document.body.append(grid);
    return { field, host };
  };

  /** A finger on the field and off it again; returns whether the page cancelled the tap. */
  const tap = (field: HTMLElement, move = 0) => {
    const at = { clientX: 200, clientY: 880 };
    const start = new Event('touchstart', { bubbles: true, composed: true });
    Object.assign(start, { touches: [at], changedTouches: [at] });
    field.dispatchEvent(start);
    const end = new Event('touchend', { bubbles: true, composed: true, cancelable: true });
    Object.assign(end, { touches: [], changedTouches: [{ clientX: 200, clientY: 880 + move }] });
    field.dispatchEvent(end);
    return end.defaultPrevented;
  };

  /** iOS brings the keyboard up: the viewport (and, in the home-screen app, innerHeight) shrink. */
  const keyboardUp = () => {
    phone.vvHeight = SCREEN - KEYBOARD;
  };

  return { phone, mount, tap, keyboardUp, viewport };
}

describe('ChatKeyboardFix2 on the page', () => {
  let flag = true;
  let stored: Map<string, number>;
  let fix: ChatKeyboardFix2;
  let phone: ReturnType<typeof fakePhone>;
  const logs: string[] = [];
  const root = document.documentElement;
  const memory: KeyboardMemory = {
    get: (key) => stored.get(key) ?? null,
    set: (key, value) => stored.set(key, value),
  };
  const onStart = (e: Event) => fix.touchStarted(e as TouchEvent);
  const onEnd = (e: Event) => fix.touchEnded(e as TouchEvent);
  const onFocus = () => queueMicrotask(() => fix.focusChanged());
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const kbfix2Lines = () => logs.filter((l) => l.includes('kbfix2:'));

  beforeEach(async () => {
    vi.useFakeTimers();
    flag = true;
    stored = new Map();
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    phone = fakePhone();
    fix = new ChatKeyboardFix2(
      async () => flag,
      () => true,
      memory
    );
    document.addEventListener('touchstart', onStart, true);
    document.addEventListener('touchend', onEnd, true);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onFocus);
    fix.refreshFlag();
    await flush();
  });

  afterEach(() => {
    fix.stop();
    document.removeEventListener('touchstart', onStart, true);
    document.removeEventListener('touchend', onEnd, true);
    document.removeEventListener('focusin', onFocus);
    document.removeEventListener('focusout', onFocus);
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts the composer above the keyboard line before focusing it, then lets go', async () => {
    const { field, host } = phone.mount();
    expect(phone.tap(field)).toBe(true);

    // Focused by the fix, with the layout already short: composer bottom 510 < line 541.
    expect(field.matches(':focus') || host.shadowRoot?.activeElement === field).toBe(true);
    expect(root.hasAttribute('data-kbfix2')).toBe(true);
    expect(root.style.getPropertyValue('--kbfix2-height')).toBe('510px');
    expect(host.getBoundingClientRect().bottom).toBeLessThanOrEqual(SCREEN - KEYBOARD);
    const focusLine = kbfix2Lines().find((l) => l.includes('kbfix2: focus'));
    expect(focusLine).toContain('kbfix2: focus, layout 510 (keyboard guessed)');
    expect(focusLine).toContain('inner 956, vv 956 offsetTop 0, scroll 0, composer 462-510');

    // The keyboard comes up without iOS scrolling: the layout follows the viewport again.
    phone.keyboardUp();
    fix.viewportChanged();
    expect(root.hasAttribute('data-kbfix2')).toBe(false);
    expect(root.style.getPropertyValue('--kbfix2-height')).toBe('');
    expect(stored.get('portrait')).toBe(KEYBOARD);
    expect(kbfix2Lines().some((l) => l.includes('released (keyboard up, 415)'))).toBe(true);

    await vi.advanceTimersByTimeAsync(1500);
    for (const ms of [300, 700, 1500]) {
      expect(kbfix2Lines().some((l) => l.includes(`kbfix2: +${ms} ms | inner 541, vv 541`))).toBe(
        true
      );
    }
    expect(kbfix2Lines().some((l) => l.includes('under the keyboard'))).toBe(false);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('uses the keyboard height measured last time', async () => {
    stored.set('portrait', KEYBOARD);
    const { field } = phone.mount();
    phone.tap(field);
    expect(root.style.getPropertyValue('--kbfix2-height')).toBe('525px');
  });

  it('leaves alone a tap with the flag off, a drag, and a composer already focused', async () => {
    const { field } = phone.mount();
    flag = false;
    fix.refreshFlag();
    await flush();
    expect(phone.tap(field)).toBe(false);
    expect(root.hasAttribute('data-kbfix2')).toBe(false);

    flag = true;
    fix.refreshFlag();
    await flush();
    expect(phone.tap(field, 40)).toBe(false);
    expect(root.hasAttribute('data-kbfix2')).toBe(false);

    expect(phone.tap(field)).toBe(true);
    phone.keyboardUp();
    fix.viewportChanged();
    // A second tap moves the caret: iOS's own, the keyboard is up already.
    expect(phone.tap(field)).toBe(false);
  });

  it('turns on and off from config.json at the next touch on the composer', async () => {
    flag = false;
    fix.refreshFlag();
    await flush();
    const { field } = phone.mount();
    flag = true;
    expect(phone.tap(field)).toBe(false); // the answer is not back yet for this tap
    await flush();
    expect(phone.tap(field)).toBe(true);
  });

  it('undoes itself when the composer is under the keyboard at +700 ms, and says so', async () => {
    const { field } = phone.mount();
    phone.tap(field);
    // A keyboard that never shrinks the viewport enough to count, and a layout that ended low.
    phone.phone.vvHeight = SCREEN - 60;
    phone.phone.composerBottom = 912;
    fix.viewportChanged();
    expect(root.hasAttribute('data-kbfix2')).toBe(true);

    await vi.advanceTimersByTimeAsync(700);
    expect(root.hasAttribute('data-kbfix2')).toBe(false);
    expect(
      kbfix2Lines().some((l) =>
        l.includes(
          'released (composer under the keyboard (bottom 912 > 896), undone for this focus)'
        )
      )
    ).toBe(true);
  });

  it('only logs the safety net once the layout is already released', async () => {
    const { field } = phone.mount();
    phone.tap(field);
    phone.keyboardUp();
    fix.viewportChanged();
    phone.phone.composerBottom = 603;
    await vi.advanceTimersByTimeAsync(700);
    expect(
      kbfix2Lines().some((l) =>
        l.includes('composer under the keyboard (bottom 603 > 541), layout already released')
      )
    ).toBe(true);
  });

  it('lets go after 1.5 s when no software keyboard came', async () => {
    const { field } = phone.mount();
    phone.tap(field);
    await vi.advanceTimersByTimeAsync(1499);
    expect(root.hasAttribute('data-kbfix2')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(root.hasAttribute('data-kbfix2')).toBe(false);
    expect(kbfix2Lines().some((l) => l.includes('released (no keyboard came)'))).toBe(true);
  });

  it('lets go when the composer loses the focus', async () => {
    const { field } = phone.mount();
    phone.tap(field);
    field.blur();
    await flush();
    expect(root.hasAttribute('data-kbfix2')).toBe(false);
    expect(kbfix2Lines().some((l) => l.includes('released (composer not focused)'))).toBe(true);
    // Its timers went with it.
    await vi.advanceTimersByTimeAsync(1500);
    expect(kbfix2Lines().some((l) => l.includes('+300 ms'))).toBe(false);
  });

  it('is not asked for outside the home-screen app', async () => {
    const load = vi.fn(async () => true);
    fix.stop();
    fix = new ChatKeyboardFix2(load, () => false, memory);
    fix.refreshFlag();
    const { field } = phone.mount();
    await flush();
    expect(phone.tap(field)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('the session view with the chat keyboard fix, iteration 3', () => {
  let manager: LifecycleEventManager | null = null;
  let phone: ReturnType<typeof fakePhone>;
  const root = document.documentElement;

  beforeEach(() => {
    serverConfig.chatKeyboardFix = true;
    serverConfig.chatKeyboardFix2 = true;
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

  it('takes over the tap, lets go on the keyboard, and the older fix stands down', async () => {
    const { field } = phone.mount();
    manager = new LifecycleEventManager();
    await settle();
    expect(phone.tap(field)).toBe(true);
    expect(root.hasAttribute('data-kbfix2')).toBe(true);
    await settle();

    phone.keyboardUp();
    phone.viewport.dispatchEvent(new Event('resize'));
    expect(root.hasAttribute('data-kbfix2')).toBe(false);

    // Even if iOS scrolled anyway, the older fix (also on in config.json) does not move in.
    phone.phone.offsetTop = 353;
    window.dispatchEvent(new Event('scroll'));
    expect(root.hasAttribute('data-kbfix')).toBe(false);
  });

  it('is off unless config.json turns it on, and gone once the session view closes', async () => {
    serverConfig.chatKeyboardFix2 = undefined;
    const { field } = phone.mount();
    manager = new LifecycleEventManager();
    await settle();
    expect(phone.tap(field)).toBe(false);

    serverConfig.chatKeyboardFix2 = true;
    manager.cleanup();
    manager = null;
    expect(phone.tap(field)).toBe(false);
    expect(root.hasAttribute('data-kbfix2')).toBe(false);
  });
});
