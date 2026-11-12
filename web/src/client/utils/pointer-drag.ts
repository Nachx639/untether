/**
 * Where each pointer (or touch) went down, to tell a tap from the end of a drag. iOS Safari
 * sends a pointerup, not a pointercancel, when a scroll that started on a button ends, so a
 * button acting on pointerup fired at the end of a scroll ("+ Add preview" opened while
 * scrolling the session list, 2026-10-03, SE simulator).
 */
const downAt = new Map<number, { x: number; y: number }>();
const touchDownAt = new Map<number, { x: number; y: number }>();
/** Ids grow with every touch: past this many starts, the old ones go. */
const MAX_TRACKED = 32;

if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (downAt.size >= MAX_TRACKED) downAt.clear();
      downAt.set(e.pointerId, { x: e.clientX, y: e.clientY });
    },
    true
  );
  document.addEventListener(
    'touchstart',
    (e) => {
      if (touchDownAt.size >= MAX_TRACKED) touchDownAt.clear();
      for (const touch of Array.from(e.changedTouches ?? [])) {
        touchDownAt.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }
    },
    { capture: true, passive: true }
  );
}

const moved = (start: { x: number; y: number } | undefined, x: number, y: number, slop: number) =>
  !!start && Math.hypot(x - start.x, y - start.y) > slop;

/** The pointer moved more than a tap's slop since it went down: a scroll or a drag. */
export function endsADrag(e: PointerEvent, slop = 10): boolean {
  return moved(downAt.get(e.pointerId), e.clientX, e.clientY, slop);
}

/** The same for a touchend (handlers that act on touchend, see mobile-action-bar). */
export function touchEndsADrag(e: TouchEvent, slop = 10): boolean {
  const touch = e.changedTouches?.[0];
  return !!touch && moved(touchDownAt.get(touch.identifier), touch.clientX, touch.clientY, slop);
}
