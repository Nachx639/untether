/**
 * "Use the system text size" (Settings → Appearance), off by default.
 *
 * iOS Dynamic Type only grew Safari's own chrome: the page kept its 16 px root (2026-10-04).
 * With this on, a probe styled `font: -apple-system-body` reads the user's text size (WebKit
 * maps it to Dynamic Type: 17 px at the default "Large", 53 px at AX5) and the root font
 * follows it, clamped to 16–22 px, so every rem text size scales: the phone list, chat,
 * composer, answer cards and menus. Spacing stays in 4 px steps, as iOS grows text and not
 * margins. Chrome (`.ut-chrome`: headers, the list's bottom bar, the Settings header and
 * footer) grows at most 1.15×.
 *
 * Why a cap: at AX5 unclamped (53 px) the list's bottom bar took half the screen, the
 * header showed "V…" and Settings wrapped one word per line (2026-10-04, iPhone SE). 22 px
 * is about 1.3× the default 17 px (iOS's own XXL is 21, XXXL 23); beyond that the screen
 * no longer fits a row, and iOS users at the AX sizes also have Zoom.
 *
 * Only on touch WebKit (styles.css checks `-webkit-touch-callout`): on a Mac the same
 * keyword is 13 px. The terminal keeps its own font size. assets/theme-init.js applies the
 * saved choice before the first paint with the same numbers (system-text-size.test.ts
 * checks they agree); the app re-reads the size whenever the page becomes visible again,
 * which is when a change in iOS Settings can have happened.
 */

export const SYSTEM_TEXT_SIZE_KEY = 'ut-system-text-size';
export const SYSTEM_TEXT_SIZE_CHANGED_EVENT = 'ut-system-text-size-changed';
/** Root font bounds in px: never under the 16 px default, at most ~1.3× iOS's 17 px. */
export const ROOT_TEXT_MIN_PX = 16;
export const ROOT_TEXT_MAX_PX = 22;
/** Chrome (headers, bottom bar) grows at most this much over 16 px. */
export const CHROME_MAX_SCALE = 1.15;

/** Touch WebKit (iPhone, iPad), where styles.css applies it; elsewhere it would do nothing. */
export function systemTextSizeSupported(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports?.('-webkit-touch-callout', 'none') === true;
}

export function readSystemTextSize(): boolean {
  try {
    return localStorage.getItem(SYSTEM_TEXT_SIZE_KEY) === 'on';
  } catch {
    return false;
  }
}

/** The root size for a Dynamic Type body size; 16 px when it can't be read. */
export function clampRootText(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return ROOT_TEXT_MIN_PX;
  return Math.min(Math.max(bodyPx, ROOT_TEXT_MIN_PX), ROOT_TEXT_MAX_PX);
}

/** The user's Dynamic Type body size in px, read from a probe styled -apple-system-body. */
export function measureSystemBodyPx(): number {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'font: -apple-system-body; position: absolute; visibility: hidden; pointer-events: none;';
  document.documentElement.appendChild(probe);
  const px = Number.parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return px;
}

/**
 * Sets or clears what styles.css keys on: `data-text-size` on <html>, the root size
 * (--ut-root-text) and the chrome's scale (--ut-chrome-scale).
 */
export function applySystemTextSize(on: boolean): void {
  const root = document.documentElement;
  if (!on) {
    root.removeAttribute('data-text-size');
    root.style.removeProperty('--ut-root-text');
    root.style.removeProperty('--ut-chrome-scale');
    return;
  }
  const size = clampRootText(measureSystemBodyPx());
  root.setAttribute('data-text-size', 'system');
  root.style.setProperty('--ut-root-text', `${size}px`);
  root.style.setProperty(
    '--ut-chrome-scale',
    String(Math.min(size / ROOT_TEXT_MIN_PX, CHROME_MAX_SCALE))
  );
}

export function writeSystemTextSize(on: boolean): void {
  try {
    if (on) localStorage.setItem(SYSTEM_TEXT_SIZE_KEY, 'on');
    else localStorage.removeItem(SYSTEM_TEXT_SIZE_KEY);
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
  applySystemTextSize(on);
  window.dispatchEvent(new CustomEvent(SYSTEM_TEXT_SIZE_CHANGED_EVENT, { detail: on }));
}

let watching = false;

/** Re-reads the size when the page comes back (the user may have changed it in Settings). */
export function watchSystemTextSize(): void {
  if (watching) return;
  watching = true;
  const refresh = () => {
    if (document.visibilityState === 'visible' && readSystemTextSize()) applySystemTextSize(true);
  };
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pageshow', refresh);
}
