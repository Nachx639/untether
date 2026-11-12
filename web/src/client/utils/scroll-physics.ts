/**
 * Pure pieces of the terminal's touch scrolling (components/terminal-touch-scroll.ts), apart so
 * they can be tested on their own. Distances are CSS px, times ms.
 */

/** Below this a sub-row offset is rounding noise: the view sits on the row. */
const OFFSET_EPSILON = 0.01;

/**
 * Splits a position `px` back from the bottom into whole rows, which ghostty-web's viewport can
 * show, and the pixels left over, which a CSS transform on its canvas shows.
 */
export function splitScrollOffset(px: number, rowHeight: number): { rows: number; offset: number } {
  if (!(rowHeight > 0) || !(px > 0)) return { rows: 0, offset: 0 };
  const rows = Math.floor((px + OFFSET_EPSILON) / rowHeight);
  const offset = px - rows * rowHeight;
  return { rows, offset: offset < OFFSET_EPSILON ? 0 : offset };
}

/** iOS's normal deceleration (UIScrollView.DecelerationRate.normal): × 0.998 per ms. */
export const DECELERATION_RATE = 0.998;

/** iOS's rubber band constant: past an end the content first moves 0.55 px per finger px. */
const RUBBER_BAND = 0.55;

export interface MoveSample {
  /** performance.now() of the touchmove. */
  t: number;
  /** Total finger travel so far, px (down = positive). */
  y: number;
}

/** Moves closer together than this say nothing about speed (touchmoves come 8-17 ms apart). */
const MIN_SPAN_MS = 5;
/** Moves handled closer together than this came in one burst: the latest says where it was. */
const SAME_TOUCH_MS = 2;
/** The fit looks this far back from the finger's last move. */
const FIT_WINDOW_MS = 100;
/** A pause up to this long between the last move and the lift is only the lift: ignored. */
const LIFT_PAUSE_MS = 30;
/** A pause this long before the lift means the finger had stopped: no fling. */
const STOPPED_MS = 80;

/** Slope of y over t at the end of `points` (t relative to the last one): quadratic fit. */
function slopeAtEnd(points: readonly MoveSample[]): number {
  const last = points[points.length - 1];
  if (points.length >= 4) {
    // Least squares y = a + b·x + c·x² with x = t - last.t; b is the speed at the last move,
    // so an accelerating flick is not averaged down to its middle.
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let y0 = 0;
    let y1 = 0;
    let y2 = 0;
    for (const point of points) {
      const x = point.t - last.t;
      const x2 = x * x;
      s0 += 1;
      s1 += x;
      s2 += x2;
      s3 += x2 * x;
      s4 += x2 * x2;
      y0 += point.y;
      y1 += x * point.y;
      y2 += x2 * point.y;
    }
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
    if (Math.abs(det) > 1e-9 * Math.max(1, s4 * s4)) {
      return (s0 * (y1 * s4 - s3 * y2) - y0 * (s1 * s4 - s3 * s2) + s2 * (s1 * y2 - y1 * s2)) / det;
    }
  }
  // Two or three moves: a straight line through them.
  let meanT = 0;
  let meanY = 0;
  for (const point of points) {
    meanT += point.t / points.length;
    meanY += point.y / points.length;
  }
  let num = 0;
  let den = 0;
  for (const point of points) {
    num += (point.t - meanT) * (point.y - meanY);
    den += (point.t - meanT) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/**
 * The finger's speed (px/ms) as it lifted: a least-squares fit of its last 100 ms of moves,
 * taken at its last move. Moves handled in one burst count once (the latest); a short pause
 * before the lift is only the lift and is ignored; a longer one fades the fling out, and
 * after STOPPED_MS there is none (a placed finger does not fling).
 */
export function releaseVelocity(samples: readonly MoveSample[], releasedAt: number): number {
  const points: MoveSample[] = [];
  for (const sample of samples) {
    const previous = points[points.length - 1];
    if (previous && sample.t - previous.t < SAME_TOUCH_MS) points[points.length - 1] = sample;
    else points.push(sample);
  }
  // The same place reported again at the end is part of the pause, not a move.
  let end = points.length - 1;
  while (end > 0 && points[end].y === points[end - 1].y) end--;
  const last = points[end];
  if (!last) return 0;
  const pause = releasedAt - last.t;
  if (pause >= STOPPED_MS) return 0;
  let first = end;
  while (first > 0 && points[first - 1].t >= last.t - FIT_WINDOW_MS) first--;
  // Only the last move in the window: the one before still counts if not long before.
  if (first === end && end > 0 && last.t - points[end - 1].t <= 2 * FIT_WINDOW_MS) first--;
  const recent = points.slice(first, end + 1);
  if (recent.length < 2 || last.t - recent[0].t < MIN_SPAN_MS) return 0;
  // A fit is a model: never more than half again the fastest stretch actually travelled.
  let fastest = 0;
  for (let i = 1; i < recent.length; i++) {
    const dt = recent[i].t - recent[i - 1].t;
    if (dt > 0) fastest = Math.max(fastest, Math.abs(recent[i].y - recent[i - 1].y) / dt);
  }
  const velocity = slopeAtEnd(recent);
  const bounded = Math.sign(velocity) * Math.min(Math.abs(velocity), fastest * 1.5);
  const fade =
    pause <= LIFT_PAUSE_MS ? 1 : 1 - (pause - LIFT_PAUSE_MS) / (STOPPED_MS - LIFT_PAUSE_MS);
  return bounded * fade;
}

/**
 * A fling slowing down: the distance (px) it covers in `dt` ms from `velocity` (px/ms) and its
 * velocity after, exact for any frame length (iOS's exponential deceleration).
 */
export function decelerate(
  velocity: number,
  dt: number,
  rate = DECELERATION_RATE
): { distance: number; velocity: number } {
  const factor = rate ** dt;
  return { distance: (velocity * (factor - 1)) / Math.log(rate), velocity: velocity * factor };
}

/**
 * How far content shows past an end when the finger went `stretch` px past it (iOS's rubber
 * band): 0.55 of it at first, less and less after, never more than `dimension`.
 */
export function rubberBand(stretch: number, dimension: number): number {
  if (!(dimension > 0)) return 0;
  const distance = Math.abs(stretch);
  return Math.sign(stretch) * (1 - 1 / ((distance * RUBBER_BAND) / dimension + 1)) * dimension;
}

/** The finger stretch that shows `shown` px past an end: rubberBand's inverse. */
export function rubberBandStretch(shown: number, dimension: number): number {
  if (!(dimension > 0)) return 0;
  const fraction = Math.min(Math.abs(shown) / dimension, 0.99);
  return shown / (RUBBER_BAND * (1 - fraction));
}

/**
 * One step of a critically damped spring pulling `x` (px, moving at `v` px/ms) back to 0 over
 * `dt` ms; `omega` sets its speed. Exact for any frame length; never swings past 0 from rest.
 */
export function springStep(
  x: number,
  v: number,
  dt: number,
  omega: number
): { x: number; v: number } {
  const damping = Math.exp(-omega * dt);
  const c = v + omega * x;
  return { x: (x + c * dt) * damping, v: (v - omega * c * dt) * damping };
}
