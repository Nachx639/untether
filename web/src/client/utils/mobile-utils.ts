/**
 * Mobile device detection utilities
 * Provides consistent mobile detection across the application
 */

/**
 * Detect if the current device is a mobile device (phone or tablet).
 * Uses the same logic as index.html for consistency.
 *
 * @returns true if the device is mobile (iPhone, iPad, iPod, Android)
 */
export function detectMobile(): boolean {
  return (
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (!!navigator.maxTouchPoints && navigator.maxTouchPoints > 1) ||
    window.matchMedia?.('(pointer: coarse)').matches
  );
}

/**
 * Detect if the current device is running iOS.
 *
 * @returns true if the device is running iOS
 */
export function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Detect if the current device is running Android.
 *
 * @returns true if the device is running Android
 */
export function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

/**
 * A phone-sized touch screen: coarse pointer and a short side under 600 px (portrait or
 * landscape). Gate for bottom sheets (phone-spec §0.1); matches the CSS phone gate
 * `(pointer: coarse) and (max-width: 599px), (pointer: coarse) and (max-height: 599px)`.
 */
export function isPhoneScreen(): boolean {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && Math.min(window.innerWidth, window.innerHeight) < 600;
}

export interface SheetDragOptions {
  /** Called once when the drag ends past the threshold (or on a fast downward flick). */
  onDismiss: () => void;
  /**
   * The scrolling body: a pull that starts inside it drags the sheet only while it is
   * scrolled to the top. Anything marked `[data-sheet-handle]` (grabber, header) always drags.
   */
  scroller?: HTMLElement | null;
  /** Element that moves (default: the sheet). */
  target?: HTMLElement | null;
}

/** Fields, sliders and anything marked `[data-no-sheet-drag]` never start a sheet drag. */
const NO_DRAG =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-sheet-drag]';
/** Past this share of the sheet's height a release dismisses it. */
const DISMISS_FRACTION = 0.3;
/** A downward flick faster than this (px/ms) dismisses whatever the distance. */
const FLICK_SPEED = 0.6;
const START_SLOP_PX = 6;

/**
 * Drag-down-to-dismiss for a bottom sheet (phone-spec §3.2, 2026-10-12). The sheet follows
 * the finger; a release past 30% of its height, or a fast flick, calls `onDismiss`, else it
 * springs back. Touch uses touch events (iOS starts scrolling and cancels pointer events);
 * mouse and pen use pointer events, but only from a `[data-sheet-handle]`. The transform is
 * cleared before `onDismiss` so the sheet's own close transition runs from where it is.
 * Returns a function that detaches the listeners.
 */
export function attachSheetDrag(sheet: HTMLElement, options: SheetDragOptions): () => void {
  const moving = options.target ?? sheet;
  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastT = 0;
  let speed = 0;
  let mode: 'idle' | 'pending' | 'drag' = 'idle';
  let dismissed = false;

  const eligible = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element) || dismissed) return false;
    if (target.closest(NO_DRAG)) return false;
    if (target.closest('[data-sheet-handle]')) return true;
    const scroller = options.scroller;
    if (scroller?.contains(target)) return scroller.scrollTop <= 0;
    return true;
  };

  const begin = (x: number, y: number, target: EventTarget | null): boolean => {
    if (!eligible(target)) return false;
    startX = x;
    startY = y;
    lastY = y;
    lastT = performance.now();
    speed = 0;
    mode = 'pending';
    return true;
  };

  /** True while the sheet follows the finger (the caller then cancels the native scroll). */
  const move = (x: number, y: number): boolean => {
    if (mode === 'idle') return false;
    const dy = y - startY;
    if (mode === 'pending') {
      if (Math.abs(dy) < START_SLOP_PX && Math.abs(x - startX) < START_SLOP_PX) return false;
      // Up or sideways: a scroll, not a dismiss.
      if (dy <= 0 || Math.abs(x - startX) > Math.abs(dy)) {
        mode = 'idle';
        return false;
      }
      mode = 'drag';
      moving.style.transition = 'none';
    }
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    speed = 0.8 * ((y - lastY) / dt) + 0.2 * speed;
    lastY = y;
    lastT = now;
    moving.style.transform = `translateY(${Math.max(0, dy)}px)`;
    return true;
  };

  const end = () => {
    if (mode !== 'drag') {
      mode = 'idle';
      return;
    }
    mode = 'idle';
    const dy = Math.max(0, lastY - startY);
    const height = moving.getBoundingClientRect().height || 1;
    moving.style.transition = '';
    moving.style.transform = '';
    // A drag that ended on a button must not also press it (mouse sends a click).
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    sheet.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => sheet.removeEventListener('click', swallow, { capture: true }), 400);
    if (dy > height * DISMISS_FRACTION || (speed > FLICK_SPEED && dy > 24)) {
      dismissed = true;
      options.onDismiss();
    }
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      mode = 'idle';
      return;
    }
    const touch = e.touches[0];
    begin(touch.clientX, touch.clientY, e.target);
  };
  const onTouchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (touch && move(touch.clientX, touch.clientY) && e.cancelable) e.preventDefault();
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    if (!(e.target instanceof Element) || !e.target.closest('[data-sheet-handle]')) return;
    if (begin(e.clientX, e.clientY, e.target)) {
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once: true });
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    move(e.clientX, e.clientY);
  };
  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    end();
  };

  sheet.addEventListener('touchstart', onTouchStart, { passive: true });
  sheet.addEventListener('touchmove', onTouchMove, { passive: false });
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
  sheet.addEventListener('pointerdown', onPointerDown);
  return () => {
    sheet.removeEventListener('touchstart', onTouchStart);
    sheet.removeEventListener('touchmove', onTouchMove);
    sheet.removeEventListener('touchend', end);
    sheet.removeEventListener('touchcancel', end);
    sheet.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };
}
