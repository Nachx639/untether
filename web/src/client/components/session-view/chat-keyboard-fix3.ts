/**
 * Experiment, iteration 4, off unless `"chatKeyboardFix3": true` in the server's config.json
 * (read live; wins over "chatKeyboardFix" and "chatKeyboardFix2"). 2026-10-04.
 *
 * The symptom (chat-keyboard-fix.ts has the full numbers): on the owner's iPhone (440x956,
 * home-screen app), chat mode, the composer focused: the whole page goes up, the session
 * header half under the status bar, and a ~60 pt black band between the composer and the
 * keyboard. Intermittent. His focus-diagnostics.ts lines, 700 ms after the focus:
 *
 *   inner 440x541, vv 440x541 top 353, scroll 0,353     (no band)
 *   inner 440x541, vv 440x541 top 291, scroll 0,353     (band: 353 - 291 = 62, the inset)
 *
 * The window shrank to 541, but the document was scrolled 353: something still made it taller
 * than what is visible. iOS scrolls to reveal the composer while the page is still full height
 * (session-view's own 100dvh box and the app root do not follow the keyboard), and that scroll
 * survives the shrink. Whenever the visual viewport's offsetTop and the scroll disagree, the
 * position: fixed layout is painted that far off (WebKit bug 297779).
 *
 * The earlier tries only chased the scroll (scrollTo(0, 0); fix 1 following it with
 * position: absolute; fix 2 dodging it on the first tap) and left the document's height alone:
 * after scrollTo(0, 0) iOS could scroll it again, and the layout kept following a stale
 * offsetTop under the keyboard. So, while the composer has the focus in the phone session
 * layout (home-screen app or a mobile browser), this:
 *   1. sizes the page (html, body, the app root, session-view, the layout: data-kbfix3 in
 *      session-view.ts's CSS) to the visual viewport's height, in the visualViewport event's
 *      own frame: the document is never taller than what is visible, nothing left to scroll;
 *      Then it measures the composer: if anything still puts its bottom under the visible
 *      area's (a content-box padding of the safe-area inset, a calc with it), the layout gives
 *      that much up, so the composer always ends on the keyboard's accessory bar;
 *   2. only then puts the document's scroll back to 0, and again on every visualViewport
 *      resize or scroll and window scroll while the composer has the focus;
 *   3. pins the layout at top 0 when the window is the visual viewport (resizes-content: a
 *      nonzero offsetTop there can only be that scroll), else at offsetTop (a Safari tab, where
 *      the visual viewport really pans inside a taller window);
 *   4. makes every other field inert while the composer has the focus, so iOS shows no ↑ ↓
 *      bar (it offered input#show-exited-toggle and input.search-proxy). A touch anywhere but
 *      on the composer gives them back at once (a button may focus one), and they go inert
 *      again 400 ms later if the composer still has the focus.
 * All of it is recomputed from the live numbers each time, so it does not matter how the focus
 * came (from the terminal with the keyboard already up, a second time, after the background,
 * with the conversation scrolled). It is given back when the composer loses the focus, when the
 * keyboard goes down with the composer still focused, or when the session view closes.
 * One "kbfix3:" line is logged 700 ms after each composer focus: inner, visual viewport size and
 * top, scrollY, --app-height, html's own height, the document's scrollHeight (never under the
 * window's height: 894 in the simulator, where innerHeight does not follow the keyboard, is the
 * window, not an overflow) and the composer's bottom (it must be at most vv top + height).
 */
import { iosStandaloneShortfall } from '../../utils/app-height.js';
import { allFields } from '../../utils/focus-diagnostics.js';
import { createLogger } from '../../utils/logger.js';
import { isAppleHomeScreenApp } from './chat-keyboard-fix.js';

const logger = createLogger('chat-keyboard-fix3');

const PINNED_COMPOSER = 'terminal-chat-view[composeronly]';
const PINNED_LAYOUT = '.session-view-grid[data-mobile="true"]';
/** On the root element while the fix holds the page; session-view.ts's CSS keys off it. */
const ACTIVE_ATTRIBUTE = 'data-kbfix3';
const HEIGHT_PROPERTY = '--kbfix3-height';
const TOP_PROPERTY = '--kbfix3-top';
/** A visual viewport this much shorter than the tallest seen at this width: keyboard up. */
const KEYBOARD_MIN = 100;
/** After a composer focus: look again as iOS settles (the keyboard animates for ~300 ms). */
const RECHECK_MS = [0, 100, 300, 700] as const;
const LOG_AT_MS = 700;
/** A touch elsewhere gave the other fields back; inert again this long after it ends. */
const INERT_AGAIN_MS = 400;

/**
 * Where the layout goes: as tall as the visible area, at its top. The status bar a home-screen
 * app's innerHeight leaves out is added back only while the window is the visual viewport (no
 * keyboard): with the keyboard up the visible area is the visual viewport, accessory bar
 * already left out. 2026-10-04, iPhone 27 Pro Max simulator: innerHeight stays 894 there with
 * the keyboard up (541 on the owner's device), so the 62 px "shortfall" was added to 541 and
 * the composer went behind iOS's ↑ ↓ ✓ bar (app 603).
 */
export function chatKeyboardFix3Layout(geometry: {
  innerHeight: number;
  vvHeight: number;
  vvOffsetTop: number;
  /** iosStandaloneShortfall(): the status bar a home-screen app's innerHeight leaves out. */
  shortfall: number;
}): { height: number; top: number } {
  const windowIsVisualViewport = Math.abs(geometry.innerHeight - geometry.vvHeight) < 1;
  return {
    height: Math.round(geometry.vvHeight + (windowIsVisualViewport ? geometry.shortfall : 0)),
    top: windowIsVisualViewport ? 0 : Math.max(0, Math.round(geometry.vvOffsetTop)),
  };
}

/**
 * How far the composer's bottom (client y) is below the visible area's bottom, 0 if it is not:
 * what the layout still has to give up when something (a content-box padding of the safe-area
 * inset, a calc with it) makes it taller than the height it was given.
 */
export function composerOverflow(geometry: {
  composerBottom: number;
  vvOffsetTop: number;
  vvHeight: number;
}): number {
  const overflow = geometry.composerBottom - (geometry.vvOffsetTop + geometry.vvHeight);
  return overflow > 0.5 ? Math.ceil(overflow) : 0;
}

/** Where the flag is worth asking for: an Apple home-screen app or any touch device. */
function phoneLike(): boolean {
  return isAppleHomeScreenApp() || navigator.maxTouchPoints > 0;
}

/** The composer's text field if it has the focus, in the phone session layout. */
function focusedComposerField(): HTMLElement | null {
  const host = document.activeElement?.closest?.(PINNED_COMPOSER);
  if (!host?.closest(PINNED_LAYOUT)) return null;
  const field = host.shadowRoot?.activeElement;
  return field instanceof HTMLElement ? field : (host as HTMLElement);
}

export class ChatKeyboardFix3 {
  private enabled = false;
  /** The page is held (data-kbfix3 on the root). */
  private active = false;
  /**
   * The software keyboard during this composer focus: still to come, up, or gone down again
   * with the composer focused (the page is given back until it comes up again).
   */
  private keyboard: 'coming' | 'up' | 'down' = 'coming';
  private composerHadFocus = false;
  private tallest = { width: 0, height: 0 };
  /** Fields this fix made inert, and only those: given back as they were. */
  private readonly inerted = new Set<HTMLElement>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private inertTimer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;

  constructor(
    /** Reads "chatKeyboardFix3" from the server (cached there for a minute). */
    private readonly loadFlag: () => Promise<boolean>,
    private readonly eligible: () => boolean = phoneLike
  ) {}

  /** Whether the flag is on (the older fixes stand down while it is). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Listens for what it needs besides visualViewport (the session view passes that on). */
  start(): void {
    if (!this.listening) {
      this.listening = true;
      document.addEventListener('focusin', this.onFocus);
      document.addEventListener('focusout', this.onFocus);
      document.addEventListener('visibilitychange', this.onVisible);
      document.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: true });
      document.addEventListener('touchend', this.onTouchEnd, { capture: true, passive: true });
      window.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('pageshow', this.onVisible);
    }
    this.measure();
    this.refreshFlag();
  }

  stop(): void {
    if (this.listening) {
      this.listening = false;
      document.removeEventListener('focusin', this.onFocus);
      document.removeEventListener('focusout', this.onFocus);
      document.removeEventListener('visibilitychange', this.onVisible);
      document.removeEventListener('touchstart', this.onTouchStart, true);
      document.removeEventListener('touchend', this.onTouchEnd, true);
      window.removeEventListener('scroll', this.onScroll);
      window.removeEventListener('pageshow', this.onVisible);
    }
    this.clearTimers();
    this.composerHadFocus = false;
    this.release();
  }

  /** Asks the server again (on and off live from config.json). */
  refreshFlag(): void {
    if (!this.eligible()) return;
    void this.loadFlag()
      .then((enabled) => {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        logger.log(`kbfix3: ${enabled ? 'on' : 'off'} (config.json chatKeyboardFix3)`);
        this.sync();
      })
      .catch(() => {});
  }

  /** visualViewport resize or scroll; --app-height has just been set for the new numbers. */
  viewportChanged(): void {
    this.measure();
    this.sync();
  }

  /** The focus settled somewhere (focusout comes before focusin). */
  focusChanged(): void {
    const focused = focusedComposerField() !== null;
    if (focused && !this.composerHadFocus) {
      this.keyboard = this.keyboardUp() ? 'up' : 'coming';
      this.refreshFlag();
      this.clearTimers();
      for (const ms of RECHECK_MS) {
        this.timers.push(
          setTimeout(() => {
            this.sync();
            if (ms === LOG_AT_MS) this.logLine();
          }, ms)
        );
      }
    }
    if (!focused && this.composerHadFocus) this.clearTimers();
    this.composerHadFocus = focused;
    this.sync();
  }

  private onFocus = () => queueMicrotask(() => this.focusChanged());

  private onScroll = () => {
    if (this.active) this.resetScroll();
  };

  /** Back from the background: iOS may have laid the page out again meanwhile. */
  private onVisible = () => {
    if (document.visibilityState === 'hidden') return;
    this.measure();
    this.sync();
    this.timers.push(setTimeout(() => this.sync(), RECHECK_MS[2]));
  };

  /** A finger down anywhere but the composer: the other fields are usable again at once. */
  private onTouchStart = (event: TouchEvent) => {
    if (this.inerted.size === 0) return;
    const field = focusedComposerField();
    if (field && event.composedPath().includes(field)) return;
    this.releaseInert();
  };

  private onTouchEnd = () => {
    if (!this.active) return;
    if (this.inertTimer) clearTimeout(this.inertTimer);
    this.inertTimer = setTimeout(() => {
      this.inertTimer = null;
      if (this.active && focusedComposerField()) this.applyInert();
    }, INERT_AGAIN_MS);
  };

  /** The tallest visual viewport at this width: the keyboard's absence. */
  private measure(): void {
    const vv = window.visualViewport;
    const width = Math.round(vv?.width ?? window.innerWidth);
    const height = vv?.height ?? window.innerHeight;
    if (width !== this.tallest.width) this.tallest = { width, height };
    else this.tallest.height = Math.max(this.tallest.height, height);
  }

  private keyboardUp(): boolean {
    const height = window.visualViewport?.height ?? window.innerHeight;
    return this.tallest.height - height >= KEYBOARD_MIN;
  }

  /** Holds or gives back the page for the current state; idempotent. */
  private sync(): void {
    const scale = window.visualViewport?.scale ?? 1;
    if (!this.enabled || !focusedComposerField() || Math.abs(scale - 1) > 0.01) {
      this.release();
      return;
    }
    if (this.keyboardUp()) this.keyboard = 'up';
    else if (this.keyboard === 'up') this.keyboard = 'down';
    // The keyboard went down with the composer still focused: as without the flag.
    if (this.keyboard === 'down') this.release();
    else this.apply();
  }

  private apply(): void {
    const vv = window.visualViewport;
    const innerHeight = window.innerHeight;
    const vvHeight = vv?.height ?? innerHeight;
    const layout = chatKeyboardFix3Layout({
      innerHeight,
      vvHeight,
      vvOffsetTop: vv?.offsetTop ?? 0,
      shortfall: iosStandaloneShortfall(innerHeight),
    });
    const root = document.documentElement;
    const setHeight = (height: number) => {
      root.style.setProperty('--app-height', `${height}px`);
      root.style.setProperty(HEIGHT_PROPERTY, `${height}px`);
    };
    setHeight(layout.height);
    root.style.setProperty(TOP_PROPERTY, `${layout.top}px`);
    if (!root.hasAttribute(ACTIVE_ATTRIBUTE)) root.setAttribute(ACTIVE_ATTRIBUTE, '');
    if (!this.active) {
      this.active = true;
      this.applyInert();
    }
    // The short page is laid out before its scroll is put back: nothing left to scroll to.
    void root.offsetHeight;
    this.resetScroll();
    // Then the composer is measured: if anything still pushes it under the visible area's
    // bottom, the layout gives that much up (in the same frame, before it is painted).
    const composer = document.querySelector(PINNED_COMPOSER)?.getBoundingClientRect();
    if (!composer) return;
    const overflow = composerOverflow({
      composerBottom: composer.bottom,
      vvOffsetTop: vv?.offsetTop ?? 0,
      vvHeight,
    });
    if (overflow > 0 && overflow < layout.height) setHeight(layout.height - overflow);
  }

  private resetScroll(): void {
    const scroller = document.scrollingElement ?? document.documentElement;
    if (scroller.scrollTop !== 0) scroller.scrollTop = 0;
    if (document.body && document.body.scrollTop !== 0) document.body.scrollTop = 0;
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }

  private applyInert(): void {
    const composer = focusedComposerField();
    for (const field of allFields(document)) {
      if (field === composer || this.inerted.has(field)) continue;
      if ((field as HTMLInputElement).disabled || field.closest('[inert]')) continue;
      field.setAttribute('inert', '');
      this.inerted.add(field);
    }
  }

  private releaseInert(): void {
    for (const field of this.inerted) field.removeAttribute('inert');
    this.inerted.clear();
  }

  /** Back to the page without the flag: --app-height / --vv-top, as the session view sets them. */
  private release(): void {
    if (this.inertTimer) {
      clearTimeout(this.inertTimer);
      this.inertTimer = null;
    }
    this.releaseInert();
    if (!this.active) return;
    this.active = false;
    const root = document.documentElement;
    root.removeAttribute(ACTIVE_ATTRIBUTE);
    root.style.removeProperty(HEIGHT_PROPERTY);
    root.style.removeProperty(TOP_PROPERTY);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** The owner's proof: inner, visual viewport size and top, scroll, the page's height. */
  private logLine(): void {
    if (!this.enabled) return;
    const vv = window.visualViewport;
    const root = document.documentElement;
    const app = root.style.getPropertyValue('--app-height') || 'unset';
    const doc = (document.scrollingElement ?? root).scrollHeight;
    const page = Math.round(root.getBoundingClientRect().height);
    const composer = document.querySelector(PINNED_COMPOSER)?.getBoundingClientRect();
    logger.log(
      `kbfix3: ${this.active ? 'holding' : 'idle'} | inner ${window.innerWidth}x${window.innerHeight}, ` +
        `vv ${Math.round(vv?.width ?? 0)}x${Math.round(vv?.height ?? 0)} top ${Math.round(vv?.offsetTop ?? 0)}, ` +
        `scrollY ${Math.round(window.scrollY)}, app ${app}, html ${page}, doc ${doc}, ` +
        `composer bottom ${composer ? Math.round(composer.bottom) : '-'}, inert ${this.inerted.size}`
    );
  }
}
