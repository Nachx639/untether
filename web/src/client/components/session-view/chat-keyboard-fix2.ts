/**
 * Experiment, iteration 3, off unless `"chatKeyboardFix2": true` in the server's config.json
 * (read live; wins over "chatKeyboardFix"). 2026-10-04.
 *
 * The symptom (chat-keyboard-fix.ts has the full numbers): in the iPhone home-screen app, the
 * chat composer focused, a 60-70 pt dark band between the composer and the keyboard bar. It
 * only shows once iOS has scrolled the page to reveal the composer: 353 px on the owner's
 * iPhone (440x956, keyboard 415), and then WebKit paints the position: fixed layout higher
 * than it lays it out (WebKit bug 297779, Apple forum thread 800125: fixed boxes drawn out of
 * place once the keyboard has moved the viewports).
 *
 * Chasing that scroll failed twice: scrollTo(0, 0) left the composer under the keyboard, and
 * following it with position: absolute made iOS scroll again (353, 415, 353) until the
 * composer was painted near the top. So this iteration gives iOS no reason to scroll at all.
 *
 * Why not shorten the document (html/body as tall as the visual viewport, overflow hidden):
 * with the keyboard up iOS lets the page scroll by the keyboard's height whatever the
 * document's (iteration 2 logged scroll 415 with a 541 px document: 415 is the keyboard), so
 * a short document still leaves it a scroll range.
 *
 * Why this works instead: iOS scrolls to reveal the field it is focusing, from where that
 * field is when it takes the focus. At that moment the composer sits at the bottom of the
 * full-height layout (864-912), well under the coming keyboard line (956 - 415 = 541). So on
 * the first tap on the composer (touchend, the field not focused yet, no drag) this:
 *   1. cancels the tap's default (no synthesized click, no native focus),
 *   2. shortens the session layout to where the keyboard will end it (the keyboard height
 *      remembered from the last focus, else 45% of the viewport, minus a margin) and lays it
 *      out at once,
 *   3. focuses the field itself, still inside the tap's gesture so the keyboard comes up.
 * The composer is then already above the keyboard line when iOS looks, nothing to reveal,
 * no scroll, and the layout keeps following --app-height / --vv-top as without the flag
 * (vv-top stays 0 when iOS does not scroll; if it scrolls anyway, following it at least keeps
 * the composer visible, which a layout fixed at top 0 did not). The shortened height is let go
 * as soon as the keyboard has shrunk the viewport (the layout is that tall by then), or after
 * 1.5 s if no keyboard came (a hardware keyboard).
 *
 * Safety net: 700 ms after the focus, if the composer's bottom is below the visible area
 * (visualViewport.offsetTop + height), the fix is undone for this focus and that is logged.
 * Every focus logs "kbfix2:" lines (innerHeight, visual viewport height and offsetTop,
 * scrollY, the composer's rect) at the focus and +300 / +700 / +1500 ms.
 */
import { createLogger } from '../../utils/logger.js';
import { isAppleHomeScreenApp } from './chat-keyboard-fix.js';

const logger = createLogger('chat-keyboard-fix2');

const PINNED_COMPOSER = 'terminal-chat-view[composeronly]';
const PINNED_LAYOUT = '.session-view-grid[data-mobile="true"]';
/** The composer's text field, inside terminal-chat-view's shadow root. */
const COMPOSER_FIELD_ID = 'chat-input-field';
/** On the root element while the layout is shortened; session-view.ts's CSS keys off it. */
const ACTIVE_ATTRIBUTE = 'data-kbfix2';
const HEIGHT_PROPERTY = '--kbfix2-height';
/** First focus, nothing remembered: the owner's keyboard is 415 of 956 (43%). */
const DEFAULT_KEYBOARD_FRACTION = 0.45;
/** Room between the composer and the keyboard line, so iOS's reveal has nothing to do. */
const MARGIN = 16;
/** A viewport this much shorter than at the tap means the software keyboard is up. */
const KEYBOARD_MIN = 100;
/** A finger that moved more than this was dragging, not tapping. */
const TAP_SLOP = 10;
const LOG_AT_MS = [300, 700, 1500] as const;
const SAFETY_CHECK_MS = 700;
const GIVE_UP_MS = 1500;
const STORAGE_KEY = 'ut-kbfix2-keyboard';

export interface ChatKeyboardFix2State {
  /** "chatKeyboardFix2" from the server's config.json. */
  enabled: boolean;
  /** iPhone or iPad home-screen app. */
  standalone: boolean;
  /** The tap ended on the composer's text field, in the phone session layout. */
  onComposerField: boolean;
  composerFocused: boolean;
  /** The finger moved past the tap slop (a drag in the field, not a tap). */
  dragged: boolean;
  /** visualViewport.scale: leave a pinch-zoomed page alone. */
  scale: number;
}

/** Whether this tap is taken over: shorten the layout first, then focus the field. */
export function chatKeyboardFix2Intercepts(state: ChatKeyboardFix2State): boolean {
  return (
    state.enabled &&
    state.standalone &&
    state.onComposerField &&
    !state.composerFocused &&
    !state.dragged &&
    Math.abs(state.scale - 1) <= 0.01
  );
}

/**
 * The layout's height before the keyboard is up: the viewport minus the keyboard to come
 * (remembered, else a share of the viewport) minus a margin. Owner's iPhone, nothing
 * remembered: 956 - 430 - 16 = 510, composer bottom 510, keyboard line 541.
 */
export function chatKeyboardFix2Height(geometry: {
  vvHeight: number;
  rememberedKeyboard: number | null;
}): number {
  const keyboard =
    geometry.rememberedKeyboard ?? Math.round(geometry.vvHeight * DEFAULT_KEYBOARD_FRACTION);
  return Math.max(0, Math.round(geometry.vvHeight - keyboard - MARGIN));
}

/** The keyboard's height from the viewport before the tap and now; null while it is not up. */
export function measuredKeyboard(vvHeightAtTap: number, vvHeightNow: number): number | null {
  const keyboard = Math.round(vvHeightAtTap - vvHeightNow);
  return keyboard >= KEYBOARD_MIN ? keyboard : null;
}

/** The safety net's test: the composer's bottom (client y) below the visible area. */
export function composerUnderKeyboard(geometry: {
  composerBottom: number;
  vvOffsetTop: number;
  vvHeight: number;
}): boolean {
  return geometry.composerBottom > geometry.vvOffsetTop + geometry.vvHeight + 1;
}

export interface KeyboardMemory {
  get(key: string): number | null;
  set(key: string, value: number): void;
}

/** The keyboard height per orientation, kept in localStorage when it can be (a convenience). */
export const localKeyboardMemory: KeyboardMemory = {
  get(key) {
    try {
      const value = Number(localStorage.getItem(`${STORAGE_KEY}-${key}`));
      return Number.isFinite(value) && value >= KEYBOARD_MIN ? value : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`${STORAGE_KEY}-${key}`, String(Math.round(value)));
    } catch {}
  },
};

function orientation(): string {
  return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
}

function composerFocused(): boolean {
  return document.activeElement?.closest?.(PINNED_COMPOSER) != null;
}

/** The composer's text field if the event's original target is it, in the phone layout. */
function composerFieldOf(event: Event): HTMLTextAreaElement | null {
  const path = event.composedPath();
  const target = path[0];
  if (!(target instanceof HTMLTextAreaElement) || target.id !== COMPOSER_FIELD_ID) return null;
  const host = path.find(
    (node): node is Element => node instanceof Element && node.matches(PINNED_COMPOSER)
  );
  return host?.closest(PINNED_LAYOUT) ? target : null;
}

export class ChatKeyboardFix2 {
  private enabled = false;
  /** The layout is shortened (data-kbfix2 on the root). */
  private holding = false;
  private vvHeightAtTap = 0;
  private touchStart: { x: number; y: number } | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    /** Reads "chatKeyboardFix2" from the server (cached there for a minute). */
    private readonly loadFlag: () => Promise<boolean>,
    private readonly standalone: () => boolean = isAppleHomeScreenApp,
    private readonly memory: KeyboardMemory = localKeyboardMemory
  ) {}

  /** Whether the flag is on (the older fix stands down while it is). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Asks the server again; only in the home-screen app, the one place it can apply. */
  refreshFlag(): void {
    if (!this.standalone()) return;
    void this.loadFlag()
      .then((enabled) => {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        logger.log(`kbfix2: ${enabled ? 'on' : 'off'} (config.json chatKeyboardFix2)`);
        if (!enabled) this.release('flag off');
      })
      .catch(() => {});
  }

  /** A finger down: remember where; on the composer, ask for the flag again (on and off live). */
  touchStarted(event: TouchEvent): void {
    const touch = event.touches[0];
    this.touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
    if (composerFieldOf(event)) this.refreshFlag();
  }

  /** The end of a tap: on the unfocused composer, shorten the layout, then focus it. */
  touchEnded(event: TouchEvent): void {
    if (!this.enabled) return;
    const touch = event.changedTouches[0];
    const start = this.touchStart;
    this.touchStart = null;
    const field = composerFieldOf(event);
    const state: ChatKeyboardFix2State = {
      enabled: this.enabled,
      standalone: this.standalone(),
      onComposerField: field !== null,
      composerFocused: composerFocused(),
      dragged:
        !start || !touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP,
      scale: window.visualViewport?.scale ?? 1,
    };
    const vv = window.visualViewport;
    const grid = document.querySelector<HTMLElement>(PINNED_LAYOUT);
    if (!field || !vv || !grid || !chatKeyboardFix2Intercepts(state)) return;

    event.preventDefault();
    this.clearTimers();
    this.vvHeightAtTap = vv.height;
    const remembered = this.memory.get(orientation());
    const height = chatKeyboardFix2Height({ vvHeight: vv.height, rememberedKeyboard: remembered });
    const root = document.documentElement;
    root.style.setProperty(HEIGHT_PROPERTY, `${height}px`);
    root.setAttribute(ACTIVE_ATTRIBUTE, '');
    this.holding = true;
    // Lay the shortened layout out now, so the field is above the keyboard line when focused.
    void grid.offsetHeight;
    field.focus({ preventScroll: true });
    const end = field.value.length;
    field.setSelectionRange(end, end);

    this.log(
      `focus, layout ${height} (keyboard ${remembered ?? 'guessed'}${remembered ? ' remembered' : ''})`
    );
    for (const ms of LOG_AT_MS) {
      this.timers.push(setTimeout(() => this.checkpoint(ms), ms));
    }
  }

  /** visualViewport resize: once the keyboard is up the layout is short anyway; let go. */
  viewportChanged(): void {
    const vv = window.visualViewport;
    if (!this.holding || !vv) return;
    const keyboard = measuredKeyboard(this.vvHeightAtTap, vv.height);
    if (keyboard === null) return;
    this.memory.set(orientation(), keyboard);
    this.release(`keyboard up, ${keyboard}`);
  }

  /** The composer lost the focus: nothing left to watch for this focus. */
  focusChanged(): void {
    if (composerFocused()) return;
    if (this.holding || this.timers.length > 0) {
      this.clearTimers();
      this.release('composer not focused');
    }
  }

  stop(): void {
    this.clearTimers();
    this.release('session view closed');
  }

  private checkpoint(ms: number): void {
    this.log(`+${ms} ms`);
    if (ms === SAFETY_CHECK_MS) {
      const vv = window.visualViewport;
      const composer = this.composerRect();
      if (
        vv &&
        composer &&
        composerUnderKeyboard({
          composerBottom: composer.bottom,
          vvOffsetTop: vv.offsetTop,
          vvHeight: vv.height,
        })
      ) {
        const where =
          `composer under the keyboard (bottom ${Math.round(composer.bottom)} > ` +
          `${Math.round(vv.offsetTop + vv.height)})`;
        // Without the shortened height the layout follows the visible area again.
        if (this.holding) this.release(`${where}, undone for this focus`);
        else this.log(`${where}, layout already released`);
      }
    }
    if (ms === GIVE_UP_MS) this.release('no keyboard came');
    if (ms === LOG_AT_MS[LOG_AT_MS.length - 1]) this.timers = [];
  }

  /** Back to the layout without the flag (--app-height, --vv-top). */
  private release(reason: string): void {
    if (!this.holding) return;
    this.holding = false;
    const root = document.documentElement;
    root.removeAttribute(ACTIVE_ATTRIBUTE);
    root.style.removeProperty(HEIGHT_PROPERTY);
    this.log(`released (${reason})`);
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private composerRect(): DOMRect | null {
    return document.querySelector(PINNED_COMPOSER)?.getBoundingClientRect() ?? null;
  }

  private log(what: string): void {
    const vv = window.visualViewport;
    const composer = this.composerRect();
    logger.log(
      `kbfix2: ${what} | inner ${window.innerHeight}, ` +
        `vv ${Math.round(vv?.height ?? 0)} offsetTop ${Math.round(vv?.offsetTop ?? 0)}, ` +
        `scroll ${Math.round(window.scrollY)}` +
        (composer ? `, composer ${Math.round(composer.top)}-${Math.round(composer.bottom)}` : '')
    );
  }
}
