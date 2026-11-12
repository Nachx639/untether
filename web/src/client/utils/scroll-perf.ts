/**
 * QA aid: with `?scrollperf` in the page's URL, or `"scrollPerf": true` in the server's
 * config.json (the installed PWA has no address bar to add the flag to), every touch scroll
 * of the terminal logs one line to the server log through the client logger when it ends:
 *
 *   scrollperf: frames N, p50 X ms, p95 Y ms, long(>20ms) Z, max W ms, handler p95 V ms,
 *   mode local|app, rows R, renders K, render p95 U ms, dpr D, crossings C (render max M ms),
 *   max step S px, reversals B, dual D, release V px/ms (F px/frame), first momentum step G px
 *
 * `frames` are the gaps between animation frames while the scroll ran (16.7 ms at 60 Hz,
 * 8.3 ms at 120 Hz; a long one means dropped frames), `handler` the time spent in each
 * touchmove handler, `mode` whether the scroll moved the local scrollback or went to the app
 * as wheel events (Claude Code), `rows` the terminal's rows, `renders` the ghostty-web
 * repaints during the gesture with their cost, `dpr` the screen's pixel ratio, `crossings`
 * the row changes and the most a repaint for one took, `max step` the most the text moved
 * between two frames and `reversals` how often it changed direction (a jump back shows as
 * one), `dual` the frames where both the canvas's pixels and its CSS transform changed (iOS
 * may show the two in different frames: a jump and a jump back; 0 expected), and `release` the finger's speed as it lifted (and per frame at the p50 above) next
 * to the first frame of momentum: equal when the handoff is smooth. 2026-10-03: terminal mode
 * scrolled in fits and starts on the iPhone; this measures it on a device or the simulator,
 * before and after a change. The URL flag lasts for the tab (sessionStorage).
 */
import { createLogger } from './logger.js';

const logger = createLogger('scroll-perf');
const FLAG_KEY = 'ut-scrollperf';
const LONG_FRAME_MS = 20;

export type ScrollPerfMode = 'local' | 'app';

export interface ScrollPerfSample {
  /** Gaps between consecutive animation frames, in ms. */
  frames: number[];
  /** Time spent in each touchmove handler, in ms. */
  handlers: number[];
  /** Time spent in each ghostty-web render that ran, in ms. */
  renders: number[];
  mode: ScrollPerfMode;
  rows: number;
  /** The screen's device pixel ratio. */
  dpr?: number;
  /** The repaint each row crossing took, in ms. */
  crossings?: number[];
  /** Where the text showed at the end of each frame (px back from the bottom). */
  positions?: number[];
  /** The finger's speed as it lifted (px/ms); null when it did not lift while recording. */
  release?: number | null;
  /** The first frame of momentum (px); null without momentum. */
  firstMomentumStep?: number | null;
  /** Frames where both the canvas's pixels and its transform changed. */
  dual?: number;
}

/** Whether `?scrollperf` is (or was, in this tab) in the URL. */
export function scrollPerfRequested(): boolean {
  try {
    if (new URLSearchParams(location.search).has('scrollperf')) {
      sessionStorage.setItem(FLAG_KEY, '1');
    }
    return sessionStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** Nearest-rank percentile of an ascending list (0 when empty). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const ascending = (values: readonly number[]) => [...values].sort((a, b) => a - b);

/** The log line for one gesture (exported for tests). */
export function formatScrollPerf(sample: ScrollPerfSample): string {
  const frames = ascending(sample.frames);
  const handlers = ascending(sample.handlers);
  const renders = ascending(sample.renders);
  const long = frames.filter((gap) => gap > LONG_FRAME_MS).length;
  const max = frames.length > 0 ? frames[frames.length - 1] : 0;
  const framePeriod = percentile(frames, 50);
  const crossings = sample.crossings ?? [];
  const positions = sample.positions ?? [];
  let maxStep = 0;
  let reversals = 0;
  let direction = 0;
  for (let i = 1; i < positions.length; i++) {
    const step = positions[i] - positions[i - 1];
    maxStep = Math.max(maxStep, Math.abs(step));
    if (step === 0) continue;
    if (direction !== 0 && Math.sign(step) !== direction) reversals++;
    direction = Math.sign(step);
  }
  const release = sample.release ?? null;
  const momentum = sample.firstMomentumStep ?? null;
  return (
    `scrollperf: frames ${frames.length}, p50 ${framePeriod.toFixed(1)} ms, ` +
    `p95 ${percentile(frames, 95).toFixed(1)} ms, long(>${LONG_FRAME_MS}ms) ${long}, ` +
    `max ${max.toFixed(1)} ms, handler p95 ${percentile(handlers, 95).toFixed(2)} ms, ` +
    `mode ${sample.mode}, rows ${sample.rows}, renders ${renders.length}, ` +
    `render p95 ${percentile(renders, 95).toFixed(2)} ms, ` +
    `dpr ${Number((sample.dpr ?? 1).toFixed(2))}, crossings ${crossings.length} ` +
    `(render max ${(crossings.length > 0 ? Math.max(...crossings) : 0).toFixed(2)} ms), ` +
    `max step ${maxStep.toFixed(1)} px, reversals ${reversals}, dual ${sample.dual ?? 0}, ` +
    `release ${
      release === null
        ? '-'
        : `${release.toFixed(2)} px/ms (${(release * framePeriod).toFixed(1)} px/frame)`
    }, first momentum step ${momentum === null ? '-' : `${momentum.toFixed(1)} px`}`
  );
}

/** Records one touch scroll at a time: begin() on its first move, end() once it stops. */
export class ScrollPerfRecorder {
  private sample: ScrollPerfSample | null = null;
  private frameId: number | null = null;
  private lastFrameAt: number | null = null;
  /** The frame (its timestamp) the last position belongs to: one position per frame. */
  private positionFrame: number | null = null;
  /** The last frames the canvas was drawn in and its transform changed in. */
  private drawnFrame: number | null = null;
  private transformFrame: number | null = null;
  private dualFrame: number | null = null;

  get recording(): boolean {
    return this.sample !== null;
  }

  begin(mode: ScrollPerfMode, rows: number): void {
    if (this.sample) return;
    this.sample = {
      frames: [],
      handlers: [],
      renders: [],
      mode,
      rows,
      dpr: window.devicePixelRatio || 1,
      crossings: [],
      positions: [],
      release: null,
      firstMomentumStep: null,
      dual: 0,
    };
    this.lastFrameAt = null;
    this.positionFrame = null;
    this.drawnFrame = null;
    this.transformFrame = null;
    this.dualFrame = null;
    this.frameId = requestAnimationFrame(this.onFrame);
  }

  handler(ms: number): void {
    this.sample?.handlers.push(ms);
  }

  render(ms: number): void {
    this.sample?.renders.push(ms);
  }

  /** A row crossing whose repaint took `ms`. */
  crossing(ms: number): void {
    this.sample?.crossings?.push(ms);
  }

  /** Where the text shows now, in the frame stamped `frameTime` (the last call of a frame counts). */
  position(px: number, frameTime: number): void {
    const positions = this.sample?.positions;
    if (!positions) return;
    if (this.positionFrame === frameTime && positions.length > 0) {
      positions[positions.length - 1] = px;
    } else {
      positions.push(px);
      this.positionFrame = frameTime;
    }
  }

  /** The canvas's pixels changed in the frame `frame` (its timestamp). */
  canvasDrawn(frame: number): void {
    this.drawnFrame = frame;
    this.countDual(frame);
  }

  /** The canvas's CSS transform changed in the frame `frame`. */
  transformChanged(frame: number): void {
    this.transformFrame = frame;
    this.countDual(frame);
  }

  private countDual(frame: number): void {
    const sample = this.sample;
    if (!sample || this.dualFrame === frame) return;
    if (this.drawnFrame === frame && this.transformFrame === frame) {
      sample.dual = (sample.dual ?? 0) + 1;
      this.dualFrame = frame;
    }
  }

  /** The finger lifted at `velocity` px/ms. */
  release(velocity: number): void {
    if (this.sample && this.sample.release === null) this.sample.release = velocity;
  }

  /** The first frame of momentum moved `px`. */
  momentumStep(px: number): void {
    if (this.sample && this.sample.firstMomentumStep === null) {
      this.sample.firstMomentumStep = px;
    }
  }

  end(): void {
    const sample = this.sample;
    if (!sample) return;
    this.sample = null;
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    logger.log(formatScrollPerf(sample));
  }

  private onFrame = (time: number) => {
    if (!this.sample) return;
    if (this.lastFrameAt !== null) this.sample.frames.push(time - this.lastFrameAt);
    this.lastFrameAt = time;
    this.frameId = requestAnimationFrame(this.onFrame);
  };
}
