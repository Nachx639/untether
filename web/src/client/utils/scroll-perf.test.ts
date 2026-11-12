// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatScrollPerf, ScrollPerfRecorder, scrollPerfRequested } from './scroll-perf';

describe('scroll-perf', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionStorage.clear();
    history.replaceState(null, '', '/');
  });

  it('summarizes frame gaps, handler and render times in one line', () => {
    const line = formatScrollPerf({
      frames: [16.7, 16.6, 33.4, 16.7, 50.1, 16.6, 16.7, 16.6, 16.7, 16.7],
      handlers: [0.5, 0.25, 2.5, 0.75],
      renders: [4, 6, 12],
      mode: 'local',
      rows: 38,
    });
    expect(line).toBe(
      'scrollperf: frames 10, p50 16.7 ms, p95 50.1 ms, long(>20ms) 2, max 50.1 ms, ' +
        'handler p95 2.50 ms, mode local, rows 38, renders 3, render p95 12.00 ms, ' +
        'dpr 1, crossings 0 (render max 0.00 ms), max step 0.0 px, reversals 0, dual 0, ' +
        'release -, first momentum step -'
    );
  });

  it('tells row crossings, the biggest step, jumps back and the handoff to momentum', () => {
    const line = formatScrollPerf({
      frames: [8.3, 8.4, 8.3, 8.3],
      handlers: [],
      renders: [],
      mode: 'local',
      rows: 40,
      dpr: 3,
      crossings: [4.2, 9.75, 6],
      // 10 px a frame, one frame back by 2 px (a glitch), then on again.
      positions: [0, 10, 20, 18, 30, 40],
      release: 1.2,
      firstMomentumStep: 9.6,
    });
    expect(line).toContain(
      'dpr 3, crossings 3 (render max 9.75 ms), max step 12.0 px, reversals 2, dual 0, ' +
        'release 1.20 px/ms (10.0 px/frame), first momentum step 9.6 px'
    );
  });

  it('reports zeros for a gesture too short to see a frame', () => {
    expect(
      formatScrollPerf({ frames: [], handlers: [0.1], renders: [], mode: 'app', rows: 24 })
    ).toBe(
      'scrollperf: frames 0, p50 0.0 ms, p95 0.0 ms, long(>20ms) 0, max 0.0 ms, ' +
        'handler p95 0.10 ms, mode app, rows 24, renders 0, render p95 0.00 ms, ' +
        'dpr 1, crossings 0 (render max 0.00 ms), max step 0.0 px, reversals 0, dual 0, ' +
        'release -, first momentum step -'
    );
  });

  it('turns on with ?scrollperf and stays on for the tab', () => {
    expect(scrollPerfRequested()).toBe(false);
    history.replaceState(null, '', '/?session=abc&scrollperf');
    expect(scrollPerfRequested()).toBe(true);
    history.replaceState(null, '', '/?session=abc');
    expect(scrollPerfRequested()).toBe(true);
  });

  it('records the gaps between frames from begin() to end() and logs them once', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const recorder = new ScrollPerfRecorder();
    recorder.handler(1); // not recording yet: ignored
    recorder.begin('local', 40);
    recorder.begin('app', 12); // already recording: ignored
    vi.advanceTimersByTime(16 * 4);
    recorder.handler(0.5);
    recorder.render(3);
    // One position per frame: the last one given for a frame counts.
    recorder.position(10, 100);
    recorder.position(12, 100);
    recorder.position(30, 116);
    recorder.crossing(2.5);
    recorder.release(1.5);
    recorder.release(9); // only the first lift counts
    recorder.momentumStep(23.4);
    recorder.momentumStep(20);
    recorder.end();
    recorder.end();
    vi.advanceTimersByTime(100);

    const lines = log.mock.calls
      .map((args) => args.join(' '))
      .filter((l) => l.includes('scrollperf'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'scrollperf: frames 3, p50 16.0 ms, p95 16.0 ms, long(>20ms) 0, max 16.0 ms, ' +
        'handler p95 0.50 ms, mode local, rows 40, renders 1, render p95 3.00 ms, ' +
        'dpr 1, crossings 1 (render max 2.50 ms), max step 18.0 px, reversals 0, dual 0, ' +
        'release 1.50 px/ms (24.0 px/frame), first momentum step 23.4 px'
    );
    expect(recorder.recording).toBe(false);
  });

  it('counts the frames where the canvas was drawn and its transform changed, once each', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const recorder = new ScrollPerfRecorder();
    recorder.begin('local', 40);
    recorder.canvasDrawn(100);
    recorder.transformChanged(116); // another frame: not dual
    recorder.canvasDrawn(133);
    recorder.transformChanged(133); // both in one frame
    recorder.canvasDrawn(133); // the same frame again: still one
    recorder.transformChanged(150);
    recorder.canvasDrawn(150);
    recorder.end();
    const line = log.mock.calls.map((args) => args.join(' ')).find((l) => l.includes('scrollperf'));
    expect(line).toContain('reversals 0, dual 2, ');
  });
});
