/**
 * Touch scrolling of the terminal's local scrollback, one step per animation frame.
 *
 * ghostty-web shows whole rows (its viewport is a count of rows back from the bottom), and the
 * old touch handler moved it a full row each time the finger crossed a row's height, so the
 * text jumped in steps behind the finger (2026-10-03, iPhone: "in fits and starts"). The
 * position is now kept in pixels: the whole rows go to ghostty's viewport and the rest is drawn
 * that many pixels lower on its canvas (the host's show()), so the text stays under the finger.
 * Only the rubber band past an end moves the canvas itself. Finger
 * moves only add up; they are applied once per frame, in our own requestAnimationFrame callback
 * and with that frame's timestamp as the one clock, so however many touchmoves arrive the
 * viewport changes (and ghostty repaints) at most once per frame. The host paints a row change
 * there and then, so the frame never depends on ghostty's own loop running before or after.
 *
 * As on iOS, the view keeps going after the finger lifts and slows down (× 0.998 per ms, from
 * the finger's speed as it lifted: a fit of its last 100 ms of moves), and a touch stops it.
 * The fling takes over from the frame that showed the finger's last position, so the frame of
 * the lift neither stops nor jumps. Past either end the content
 * stretches with iOS's rubber band and springs back on release; a fling that reaches an end
 * bounces. With "reduce motion" nothing stretches or bounces, the ends just stop the view (the
 * momentum stays, as on iOS).
 *
 * Programs that report the mouse (Claude Code's full screen, vim with mouse=a) scroll their own
 * content: the same drag and momentum go to them as wheel steps, one per row of travel, sent
 * once per frame in one report and at most a few at a time, so a fling scrolls the app with
 * inertia without flooding the PTY (each step makes the app redraw). Before, every touchmove
 * that crossed a row sent its steps at once, and nothing followed the lift.
 */
import { createLogger } from '../utils/logger.js';
import {
  decelerate,
  type MoveSample,
  releaseVelocity,
  rubberBand,
  rubberBandStretch,
  splitScrollOffset,
  springStep,
} from '../utils/scroll-physics.js';

const logger = createLogger('terminal-touch-scroll');

export interface TouchScrollHost {
  /** Height of one terminal row, in CSS px. */
  rowHeight(): number;
  /** Rows of history above the live screen. */
  maxRows(): number;
  /** Rows the view is scrolled back from the bottom (ghostty's viewport). */
  scrolledRows(): number;
  /** Height of the terminal on screen: how far the rubber band can stretch. */
  viewHeight(): number;
  /** The user asked for less motion: no rubber band or bounce. */
  reducedMotion(): boolean;
  /**
   * Shows the view `rows` rows back from the bottom, its text a further `offset` px down
   * ([0, rowHeight)), and the whole view `overscroll` px down past an end (rubber band).
   */
  show(rows: number, offset: number, overscroll: number): void;
  /** Sends the app `steps` wheel steps: + up (back into its history), − down. */
  wheel(steps: number): void;
  /** Nothing moves any more: the finger lifted and the momentum and springs are done. */
  settled(): void;
  /** QA (?scrollperf): the first frame of momentum after a lift moved `px`. */
  flung?(px: number): void;
}

/** A frame longer than this (a stalled tab) moves the momentum as if it took this long. */
const MAX_FRAME_MS = 50;
/** Slower than this (px/ms, under 2 px a frame) as the finger lifts places, it does not fling. */
const MIN_FLING_VELOCITY = 0.1;
/** Noisy last samples can claim absurd speeds. */
const MAX_FLING_VELOCITY = 8;
/** A fling stops below this (px/ms, a quarter pixel a frame). */
const STOP_VELOCITY = 0.015;
/** At this speed a fling still visibly moves: a touch that stops it is no tap. */
const MOVING_VELOCITY = 0.05;
/** The spring's speed (1/ms): back from a 60 px stretch in about 450 ms, as on iOS. */
const SPRING_OMEGA = 0.016;
/** A fling hits an end at most this fast (px/ms), so its bounce stays under about 60 px. */
const MAX_BOUNCE_VELOCITY = 2.5;
/** Wheel steps sent to an app in one frame, at most. */
const MAX_WHEEL_STEPS_PER_FRAME = 3;
/** Steps owed beyond this many frames' worth are dropped: the app stops soon after the finger. */
const WHEEL_BACKLOG_FRAMES = 2;

type Phase = 'idle' | 'drag' | 'fling' | 'spring';

export class TouchScroller {
  /** Pixels the view sits further back than `scrolledRows()` whole rows: [0, rowHeight). */
  offset = 0;
  /** Pixels shown past an end (rubber band): + past the oldest line, − past the bottom. */
  private overscroll = 0;
  /** How far the finger went past an end; the rubber band turns it into `overscroll`. */
  private stretch = 0;
  /** The view's height when the touch began: the rubber band's scale (read once, not per frame). */
  private viewHeight = 0;
  private phase: Phase = 'idle';
  /** px/ms; + goes back into the history. In a spring, the overscroll's velocity. */
  private velocity = 0;
  /** The finger lifted: decide on the next frame (after its last move) how the view goes on. */
  private released = false;
  private pendingPx = 0;
  /** The scroll goes to the app as wheel steps instead of moving the history. */
  private toApp = false;
  /** Travel the app is owed as wheel steps (a step per row), px; + is back into its history. */
  private wheelPx = 0;
  /** The rows scrollBy() chose for the next show(); null keeps ghostty's. */
  private rows: number | null = null;
  private travel = 0;
  private samples: MoveSample[] = [];
  private frame: number | null = null;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  /** The frame that showed the finger's last move: where a fling takes over. */
  private lastDragFrameAt = Number.NEGATIVE_INFINITY;
  /** The next fling step is the first after a lift (reported to the host). */
  private firstFlingStep = false;

  constructor(private readonly host: TouchScrollHost) {}

  /** The timestamp of the frame the last step was taken in: the scroll's one clock. */
  get frameTime(): number {
    return this.lastTickAt;
  }

  /** Something visibly moves: a touch now stops it, and that touch is not a tap. */
  get moving(): boolean {
    return (
      (this.phase === 'fling' && Math.abs(this.velocity) >= MOVING_VELOCITY) ||
      (this.phase === 'spring' && Math.abs(this.overscroll) >= 1)
    );
  }

  /** A scroll starts moving: `toApp` sends it to the app as wheel steps (mouse reporting). */
  start(toApp: boolean): void {
    this.toApp = toApp;
    this.wheelPx = 0;
  }

  /** A finger came down: what was moving stops under it. Returns whether something was. */
  grab(): boolean {
    const caught = this.moving;
    this.wheelPx = 0;
    this.viewHeight = this.host.viewHeight();
    if (this.phase === 'fling' || this.phase === 'spring') {
      this.phase = 'drag';
      this.velocity = 0;
      // A stretched view stays where the finger caught it.
      this.stretch = rubberBandStretch(this.overscroll, this.viewHeight);
    }
    this.released = false;
    this.samples = [];
    this.travel = 0;
    return caught;
  }

  /** The finger moved `dy` px at `at` (ms); down (positive) goes back into the history. */
  drag(dy: number, at = performance.now()): void {
    this.phase = 'drag';
    this.released = false;
    this.pendingPx += dy;
    this.travel += dy;
    this.samples.push({ t: at, y: this.travel });
    if (this.samples.length > 32) this.samples.splice(0, this.samples.length - 32);
    this.requestFrame();
  }

  /**
   * The finger lifted at `at` (ms): fling, spring back from a stretch, or stop. Returns the
   * finger's speed (px/ms), or null when no scroll was being dragged.
   */
  release(at = performance.now()): number | null {
    if (this.phase !== 'drag') return null;
    const velocity = releaseVelocity(this.samples, at);
    this.velocity = Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, velocity));
    this.samples = [];
    this.released = true;
    this.requestFrame();
    return this.velocity;
  }

  /** iOS or a pinch took the gesture: no fling; a stretch still springs back. */
  cancel(): void {
    this.pendingPx = 0;
    this.wheelPx = 0;
    this.samples = [];
    this.released = false;
    if (this.overscroll !== 0) {
      this.startSpring(0);
      return;
    }
    if (this.phase !== 'idle') this.settle();
  }

  /** Back on a whole row and still: the view was moved some other way (wheel, resize, button). */
  reset(): void {
    const active = this.phase !== 'idle';
    this.pendingPx = 0;
    this.wheelPx = 0;
    this.samples = [];
    this.released = false;
    this.velocity = 0;
    this.offset = 0;
    this.overscroll = 0;
    this.stretch = 0;
    this.phase = 'idle';
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (active) this.host.settled();
  }

  private requestFrame(): void {
    if (this.frame === null) this.frame = requestAnimationFrame(this.onFrame);
  }

  private onFrame = (time: number) => {
    this.frame = null;
    this.tick(time);
    if (
      this.phase === 'fling' ||
      this.phase === 'spring' ||
      this.released ||
      Math.abs(this.wheelPx) >= this.host.rowHeight()
    ) {
      this.requestFrame();
    }
  };

  private tick(now: number): void {
    const dt = Math.max(0, Math.min(MAX_FRAME_MS, now - this.lastTickAt));
    this.lastTickAt = now;
    try {
      if (this.pendingPx !== 0) {
        const delta = this.pendingPx;
        this.pendingPx = 0;
        this.dragBy(delta);
        this.lastDragFrameAt = now;
      }
      if (this.released) {
        this.released = false;
        this.afterRelease(now);
      } else if (this.phase === 'fling') {
        this.flingFor(dt);
      } else if (this.phase === 'spring') {
        this.springFor(dt);
      }
      if (this.toApp) this.sendWheelSteps();
    } catch (error) {
      // This runs inside ghostty's render loop: a throw there would stop it painting for good.
      logger.error('touch scroll step failed', error);
      this.reset();
    }
  }

  private afterRelease(now: number): void {
    if (this.overscroll !== 0) {
      this.startSpring(0);
    } else if (Math.abs(this.velocity) >= MIN_FLING_VELOCITY) {
      this.phase = 'fling';
      this.firstFlingStep = true;
      // The fling starts where the finger's last move was shown. In that same frame it adds
      // nothing (it used to add a whole frame's step on top: one double step at every lift);
      // frames shown since (the lift came later) it makes up, so the view never stops either.
      const since = Math.min(MAX_FRAME_MS, now - this.lastDragFrameAt);
      if (since > 0) this.flingFor(since);
    } else {
      this.settle();
    }
  }

  private dragBy(delta: number): void {
    if (this.toApp) {
      this.wheelBy(delta);
      return;
    }
    let move = delta;
    // Past an end the finger first undoes its stretch.
    if (this.stretch !== 0) {
      const next = this.stretch + move;
      if (Math.sign(next) === Math.sign(this.stretch)) {
        this.stretch = next;
        move = 0;
      } else {
        this.stretch = 0;
        move = next;
      }
    }
    const beyond = this.scrollBy(move);
    this.stretch = this.host.reducedMotion() ? 0 : this.stretch + beyond;
    this.overscroll = rubberBand(this.stretch, this.viewHeight || this.host.viewHeight());
    this.show();
  }

  private flingFor(dt: number): void {
    const { distance, velocity } = decelerate(this.velocity, dt);
    this.velocity = velocity;
    if (this.firstFlingStep) {
      this.firstFlingStep = false;
      this.host.flung?.(distance);
    }
    if (this.toApp) {
      // The app keeps its own ends: no bounds, no bounce.
      this.wheelBy(distance);
      if (Math.abs(this.velocity) < STOP_VELOCITY) this.settle();
      return;
    }
    const beyond = this.scrollBy(distance);
    if (beyond !== 0) {
      if (this.host.reducedMotion()) {
        this.show();
        this.settle();
        return;
      }
      // An end: the content bounces past it and springs back.
      this.startSpring(Math.max(-MAX_BOUNCE_VELOCITY, Math.min(MAX_BOUNCE_VELOCITY, velocity)));
      return;
    }
    this.show();
    if (Math.abs(this.velocity) < STOP_VELOCITY) this.settle();
  }

  private startSpring(velocity: number): void {
    this.phase = 'spring';
    this.stretch = 0;
    this.velocity = velocity;
    this.show();
    this.requestFrame();
  }

  private springFor(dt: number): void {
    const { x, v } = springStep(this.overscroll, this.velocity, dt, SPRING_OMEGA);
    this.overscroll = x;
    this.velocity = v;
    if (Math.abs(x) < 0.5 && Math.abs(v) < 0.02) {
      this.overscroll = 0;
      this.show();
      this.settle();
      return;
    }
    this.show();
  }

  private wheelBy(px: number): void {
    const cap = MAX_WHEEL_STEPS_PER_FRAME * WHEEL_BACKLOG_FRAMES * this.host.rowHeight();
    this.wheelPx = Math.max(-cap, Math.min(cap, this.wheelPx + px));
  }

  /** The wheel steps owed, a few at most, in one report per frame. */
  private sendWheelSteps(): void {
    const owed = Math.trunc(this.wheelPx / this.host.rowHeight());
    const steps = Math.max(-MAX_WHEEL_STEPS_PER_FRAME, Math.min(MAX_WHEEL_STEPS_PER_FRAME, owed));
    if (steps === 0) return;
    this.wheelPx -= steps * this.host.rowHeight();
    this.host.wheel(steps);
  }

  /** Moves the view `delta` px within the history; returns how far past an end it would go. */
  private scrollBy(delta: number): number {
    if (delta === 0) return 0;
    const rowHeight = this.host.rowHeight();
    const max = this.host.maxRows() * rowHeight;
    const from = this.host.scrolledRows() * rowHeight + this.offset;
    const target = from + delta;
    const to = Math.max(0, Math.min(max, target));
    const { rows, offset } = splitScrollOffset(to, rowHeight);
    this.offset = offset;
    this.rows = rows;
    return target - to;
  }

  private show(): void {
    const rows = this.rows ?? this.host.scrolledRows();
    this.rows = null;
    this.host.show(rows, this.offset, this.overscroll);
  }

  private settle(): void {
    this.phase = 'idle';
    this.velocity = 0;
    this.host.settled();
  }
}
