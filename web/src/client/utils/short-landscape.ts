import type { ReactiveController, ReactiveControllerHost } from 'lit';

import { createLogger } from './logger.js';

const logger = createLogger('short-landscape');

/**
 * A phone on its side: wider than tall, and short (2026-10-04). An iPhone Pro Max in landscape
 * is 956×440 pt, about 330 pt tall under Safari's bars: the list showed no session at all
 * (header, tabs, Ask box and bottom bar filled it) and the session header took three lines.
 * Layouts that change for it: the two-column session list (session-list.ts), the one-line
 * session header, the centred chat column and the single row of quick keys.
 *
 * The window decides: innerWidth > innerHeight and innerHeight ≤ 500. Not the screen: iOS
 * Safari reports it in portrait whatever the orientation, and a Pro Max's is never short. The
 * device's orientation (screen.orientation) only rules out one case: it says portrait and the
 * window is no wider than the screen's short side, which is a keyboard shrinking a portrait
 * window (Android, `interactive-widget=resizes-content`), not a rotation. A window wider than
 * the short side is on its side whatever the API says. In iOS Safari the keyboard doesn't
 * change innerHeight, and every landscape height (Safari's bars shown or not) is under the
 * threshold, so the layout doesn't jump while you type either.
 */
export const SHORT_LANDSCAPE_MAX_HEIGHT_PT = 500;

export interface Viewport {
  width: number;
  height: number;
  /** screen.orientation.type when the browser has it ("portrait-primary", …). */
  orientation?: string;
  /** The screen's short side (CSS px), to tell a keyboard from a rotation. */
  screenShortSide?: number;
}

export function isShortLandscape(viewport: Viewport): boolean {
  if (!(viewport.width > viewport.height && viewport.height <= SHORT_LANDSCAPE_MAX_HEIGHT_PT)) {
    return false;
  }
  const keyboard =
    viewport.orientation?.startsWith('portrait') === true &&
    viewport.screenShortSide !== undefined &&
    viewport.width <= viewport.screenShortSide;
  return !keyboard;
}

/** This window now. */
export function currentViewport(): Viewport {
  const screen = window.screen;
  const shortSide = Math.min(screen?.width || 0, screen?.height || 0);
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    orientation: screen?.orientation?.type,
    screenShortSide: shortSide > 0 ? shortSide : undefined,
  };
}

const loggedDecisions = new Set<boolean>();

/**
 * Once per page and decision (so at most two lines), what it was decided from, in the
 * server's log: the simulator's Safari can't be inspected from here (2026-10-04 QA).
 */
function logDecision(viewport: Viewport, decision: boolean) {
  if (loggedDecisions.has(decision)) return;
  loggedDecisions.add(decision);
  const vv = window.visualViewport;
  logger.log(
    `short landscape ${decision ? 'on' : 'off'}: inner ${viewport.width}×${viewport.height}, ` +
      `visualViewport ${vv ? `${Math.round(vv.width)}×${Math.round(vv.height)}` : 'none'}, ` +
      `screen.orientation ${viewport.orientation ?? 'none'}, screen short side ${viewport.screenShortSide ?? 'none'}`
  );
}

export function currentShortLandscape(): boolean {
  const viewport = currentViewport();
  const decision = isShortLandscape(viewport);
  logDecision(viewport, decision);
  return decision;
}

/**
 * Keeps `value` current for a Lit element and re-renders it when it changes. iOS fires
 * `orientationchange` before the window has its new size and `resize` after, so both are
 * listened to, and a rotation is checked again on the next frame and a moment later: a
 * rotation re-lays out at once, with no height left from the other orientation.
 */
export class ShortLandscapeController implements ReactiveController {
  value = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
    this.value = currentShortLandscape();
  }

  hostConnected() {
    window.addEventListener('resize', this.check);
    window.addEventListener('orientationchange', this.checkRotation);
    this.check();
  }

  hostDisconnected() {
    window.removeEventListener('resize', this.check);
    window.removeEventListener('orientationchange', this.checkRotation);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private check = () => {
    const next = currentShortLandscape();
    if (next === this.value) return;
    this.value = next;
    this.host.requestUpdate();
  };

  private checkRotation = () => {
    this.check();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.check();
    });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, 300);
  };
}
