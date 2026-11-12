/**
 * Experiment, off unless `"chatKeyboardFix": true` in the server's config.json (read live, so it
 * goes on and off without a deploy). 2026-10-04.
 *
 * The symptom: in the iPhone home-screen app (standalone), chat mode, keyboard up, a dark band
 * of about 60-70 pt between the composer and the keyboard's accessory bar, with iOS's caret
 * blinking inside it. The SE simulator does not reproduce it. The owner's iPhone (440x956,
 * focus-diagnostics.ts, 700 ms after the composer took the focus) reported:
 *
 *   inner 440x541, vv 440x541 top 353, scroll 0,353, composer 483-531
 *   the direct keyboard's position: fixed input (top -9999px) at client y -10352
 *
 * What those numbers say about WebKit's own geometry (the process that lays out, hit-tests and
 * places the caret):
 * - iOS scrolled the document 353 px to show the composer (scrollY 353), although the page
 *   has nothing to scroll (html and body are overflow: hidden, --app-height tall).
 * - Its layout viewport stayed at the top of the document: position: fixed boxes sit at
 *   document y = their `top` (the input at -9999 shows at client -9999 - 353), and
 *   visualViewport.offsetTop (353) is that scroll, not a pan inside a larger layout viewport
 *   (inner and visual viewport are both 541 tall).
 * - So the pinned layout at `top: var(--vv-top)` = 353 lands exactly on the visible area: the
 *   composer's rect ends 10 px above the keyboard. Layout is right.
 *
 * Yet the layout is painted about 62 pt higher (the band, and the caret, which WebKit draws
 * where layout put the field, inside the band; 62 pt is this device's status-bar inset).
 * WebKit bug 297779 and Apple forum thread 800125 (iOS 26) describe this class of bug:
 * position: fixed and sticky boxes are drawn out of place after the keyboard moves the
 * viewports, while static and absolute content is not. Fixed boxes are moved at paint time by
 * the UI process's scrolling tree from its own idea of the layout viewport, which here
 * disagrees with the web process's by the status-bar inset; content that scrolls with the
 * document is painted with the document's scroll offset, which both sides share.
 *
 * Two things tried before and what they say:
 * - window.scrollTo(0, 0) on that scroll (579bc8d5, df323233, reverted): fine in the simulator,
 *   but on the iPhone the keyboard then covered the composer: the layout kept following an
 *   offsetTop that no longer matched the scroll.
 * - Pinning with position: fixed at top 0 and a translate of (offsetTop - scrollY) would be
 *   translate 0 here, i.e. the layout at document y 0, 353 px above what is on screen: by the
 *   numbers above the composer would leave the screen and iOS would scroll again.
 *
 * So, only while all of these hold: the flag, the home-screen app on iPhone or iPad, the chat
 * composer focused, the page scrolled by iOS (scrollY >= 1) and no pinch zoom, the session
 * layout stops being position: fixed. It becomes position: absolute, placed where the visual
 * viewport is in its containing block's coordinates (visualViewport.pageTop - scrollY gives the
 * visible area's top in client coordinates, minus the containing block's client top) and
 * visualViewport.height tall. Laid out where it was, but now painted with the document scroll,
 * like the composer's caret. No scrollTo: iOS's own scroll is left alone, and the body's clip
 * is lifted while the fix is on (body is --app-height tall and would cut the layout off).
 * Every change of the numbers is logged as one "kbfix:" line, for the next diagnosis.
 */
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('chat-keyboard-fix');

/** The phone's chat composer: the field at the bottom of the pinned session layout. */
const PINNED_COMPOSER = 'terminal-chat-view[composeronly]';
const PINNED_LAYOUT = '.session-view-grid[data-mobile="true"]';
/** On the root element while the fix applies; session-view.ts's CSS keys off it. */
const ACTIVE_ATTRIBUTE = 'data-kbfix';
/** At most this many "kbfix:" lines per composer focus (iOS can fire scrolls by the dozen). */
const LOG_LINES_PER_FOCUS = 12;

export interface ChatKeyboardFixState {
  /** "chatKeyboardFix" from the server's config.json. */
  enabled: boolean;
  /** iPhone or iPad home-screen app (display-mode: standalone). */
  standalone: boolean;
  composerFocused: boolean;
  scrollY: number;
  /** visualViewport.scale: a pinch-zoomed page is panned on purpose. */
  scale: number;
}

/** Whether the pinned layout follows the scrolled page instead of being position: fixed. */
export function chatKeyboardFixApplies(state: ChatKeyboardFixState): boolean {
  return (
    state.enabled &&
    state.standalone &&
    state.composerFocused &&
    state.scrollY >= 1 &&
    Math.abs(state.scale - 1) <= 0.01
  );
}

export interface ChatKeyboardFixGeometry {
  scrollY: number;
  /** visualViewport.pageTop: the visible area's top in document coordinates. */
  vvPageTop: number;
  vvHeight: number;
  /** The containing block's top in client coordinates (its rect top plus its top border). */
  containerTop: number;
}

/**
 * Where the absolutely positioned layout goes: the visible area's top in client coordinates
 * (pageTop - scrollY) relative to its containing block, as tall as the visible area. On the
 * owner's iPhone: pageTop 353, scrollY 353, a containing block at document 0 (client -353)
 * gives top 353 and height 541, the same place the fixed layout had in layout terms.
 */
export function chatKeyboardFixLayout(geometry: ChatKeyboardFixGeometry): {
  top: number;
  height: number;
} {
  return {
    top: Math.round(geometry.vvPageTop - geometry.scrollY - geometry.containerTop),
    height: Math.round(geometry.vvHeight),
  };
}

/** iPhone or iPad (iPadOS asks for pages as a Mac with a touch screen) opened from the home screen. */
export function isAppleHomeScreenApp(): boolean {
  const ua = navigator.userAgent;
  const apple =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (!apple) return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

function composerFocused(): boolean {
  return document.activeElement?.closest?.(PINNED_COMPOSER) != null;
}

export class ChatKeyboardFix {
  private enabled = false;
  private active = false;
  private lastLine = '';
  private linesThisFocus = 0;

  constructor(
    /** Reads "chatKeyboardFix" from the server (cached there for a minute). */
    private readonly loadFlag: () => Promise<boolean>,
    private readonly standalone: () => boolean = isAppleHomeScreenApp
  ) {}

  /** Asks the server again; only in the home-screen app, the one place it can apply. */
  refreshFlag(): void {
    if (!this.standalone()) return;
    void this.loadFlag()
      .then((enabled) => {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        logger.log(`kbfix: ${enabled ? 'on' : 'off'} (config.json chatKeyboardFix)`);
        this.update();
      })
      .catch(() => {});
  }

  /** The composer took or lost the focus: a new round of log lines, and a fresh flag. */
  focusChanged(): void {
    if (composerFocused()) {
      this.linesThisFocus = 0;
      this.refreshFlag();
    }
    this.update();
  }

  /** Re-place the layout (viewport resize or scroll, page scroll, focus change). */
  update(): void {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const grid = document.querySelector<HTMLElement>(PINNED_LAYOUT);
    const state: ChatKeyboardFixState = {
      enabled: this.enabled,
      standalone: this.enabled && this.standalone(),
      composerFocused: composerFocused(),
      scrollY: window.scrollY,
      scale: vv?.scale ?? 1,
    };
    if (!vv || !grid || !chatKeyboardFixApplies(state)) {
      if (this.active) {
        this.stop(
          !state.enabled
            ? 'flag off'
            : !grid
              ? 'no phone layout'
              : !state.composerFocused
                ? 'composer not focused'
                : state.scrollY < 1
                  ? 'page at its top'
                  : 'zoomed'
        );
      }
      return;
    }

    // Absolute first, so offsetParent is the block it is placed in.
    root.setAttribute(ACTIVE_ATTRIBUTE, '');
    this.active = true;
    const container = grid.offsetParent as HTMLElement | null;
    const containerRect = container?.getBoundingClientRect();
    const containerTop = containerRect ? containerRect.top + (container?.clientTop ?? 0) : 0;
    const layout = chatKeyboardFixLayout({
      scrollY: window.scrollY,
      vvPageTop: vv.pageTop,
      vvHeight: vv.height,
      containerTop,
    });
    root.style.setProperty('--kbfix-top', `${layout.top}px`);
    root.style.setProperty('--kbfix-height', `${layout.height}px`);

    const composer = document.querySelector(PINNED_COMPOSER)?.getBoundingClientRect();
    this.log(
      `kbfix: top ${layout.top} height ${layout.height} | inner ${window.innerWidth}x${window.innerHeight}, ` +
        `vv ${Math.round(vv.width)}x${Math.round(vv.height)} offsetTop ${Math.round(vv.offsetTop)} ` +
        `pageTop ${Math.round(vv.pageTop)}, scroll ${Math.round(window.scrollY)}, ` +
        `container ${container?.tagName.toLowerCase() ?? 'none'} top ${Math.round(containerTop)} ` +
        `h ${Math.round(containerRect?.height ?? 0)}` +
        (composer ? `, composer ${Math.round(composer.top)}-${Math.round(composer.bottom)}` : '')
    );
  }

  /** Back to the fixed layout (--vv-top), as without the flag. */
  stop(reason = 'session view closed'): void {
    if (!this.active) return;
    this.active = false;
    const root = document.documentElement;
    root.removeAttribute(ACTIVE_ATTRIBUTE);
    root.style.removeProperty('--kbfix-top');
    root.style.removeProperty('--kbfix-height');
    this.log(`kbfix: off (${reason}), scroll ${Math.round(window.scrollY)}`);
  }

  private log(line: string): void {
    if (line === this.lastLine || this.linesThisFocus >= LOG_LINES_PER_FOCUS) return;
    this.lastLine = line;
    this.linesThisFocus++;
    logger.log(line);
  }
}
