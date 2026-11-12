import { describe, expect, it } from 'vitest';
import {
  DECELERATION_RATE,
  decelerate,
  releaseVelocity,
  rubberBand,
  rubberBandStretch,
  splitScrollOffset,
  springStep,
} from './scroll-physics';

describe('scroll physics', () => {
  describe('splitScrollOffset', () => {
    it('splits a position into whole rows and the pixels left over', () => {
      expect(splitScrollOffset(0, 18)).toEqual({ rows: 0, offset: 0 });
      expect(splitScrollOffset(12, 18)).toEqual({ rows: 0, offset: 12 });
      expect(splitScrollOffset(30, 18)).toEqual({ rows: 1, offset: 12 });
      expect(splitScrollOffset(36, 18)).toEqual({ rows: 2, offset: 0 });
    });

    it('lands on the row when floating point leaves a hair either side of it', () => {
      expect(splitScrollOffset(3 * 16.8, 16.8)).toEqual({ rows: 3, offset: 0 });
      expect(splitScrollOffset(3 * 16.8 - 0.001, 16.8)).toEqual({ rows: 3, offset: 0 });
      expect(splitScrollOffset(3 * 16.8 + 0.001, 16.8)).toEqual({ rows: 3, offset: 0 });
    });

    it('treats nothing scrolled, or no row height, as the bottom', () => {
      expect(splitScrollOffset(-5, 18)).toEqual({ rows: 0, offset: 0 });
      expect(splitScrollOffset(40, 0)).toEqual({ rows: 0, offset: 0 });
    });
  });

  describe('releaseVelocity', () => {
    // A flick speeding up: 10, 20, ... 80 px in successive 16 ms (y is quadratic in t).
    const flick = [
      { t: 0, y: 0 },
      { t: 16, y: 10 },
      { t: 32, y: 30 },
      { t: 48, y: 60 },
      { t: 64, y: 100 },
      { t: 80, y: 150 },
      { t: 96, y: 210 },
      { t: 112, y: 280 },
      { t: 128, y: 360 },
    ];

    it('takes the speed at the last move, not the average of the last 100 ms', () => {
      // 80 px in the last 16 ms and still speeding up: 5.31 px/ms there (the average of the
      // last 100 ms, 3.44, made flings start at about half the finger's speed).
      expect(releaseVelocity(flick, 130)).toBeCloseTo(5.3125, 6);
      const upwards = flick.map(({ t, y }) => ({ t, y: -y }));
      expect(releaseVelocity(upwards, 130)).toBeCloseTo(-5.3125, 6);
      // At a steady speed, that speed.
      const steady = Array.from({ length: 12 }, (_, i) => ({ t: i * 8, y: i * 8 * 1.2 }));
      expect(releaseVelocity(steady, 90)).toBeCloseTo(1.2, 9);
    });

    it('ignores a pause of up to 30 ms before the lift, fades the fling after, none from 80', () => {
      const speed = releaseVelocity(flick, 128);
      expect(releaseVelocity(flick, 128 + 30)).toBeCloseTo(speed, 9);
      expect(releaseVelocity(flick, 128 + 55)).toBeCloseTo(speed / 2, 9);
      expect(releaseVelocity(flick, 128 + 80)).toBe(0);
      // The same place reported again at the end is part of that pause.
      const repeated = [...flick, { t: 140, y: 360 }, { t: 152, y: 360 }];
      expect(releaseVelocity(repeated, 158)).toBeCloseTo(speed, 9);
      expect(releaseVelocity(repeated, 128 + 80)).toBe(0);
    });

    it('is 0 with a single move, or none', () => {
      expect(releaseVelocity([{ t: 0, y: 40 }], 5)).toBe(0);
      expect(releaseVelocity([], 5)).toBe(0);
    });

    it('uses the move before the window when the last one is all it has', () => {
      expect(
        releaseVelocity(
          [
            { t: 0, y: 0 },
            { t: 150, y: 30 },
          ],
          160
        )
      ).toBeCloseTo(0.2, 5);
      // ... but not one from long before.
      expect(
        releaseVelocity(
          [
            { t: 0, y: 0 },
            { t: 250, y: 30 },
          ],
          260
        )
      ).toBe(0);
    });

    it('ignores moves too close together to tell a speed', () => {
      expect(
        releaseVelocity(
          [
            { t: 10, y: 0 },
            { t: 12, y: 30 },
          ],
          13
        )
      ).toBe(0);
    });

    it('counts moves handled in one burst once, at the latest', () => {
      // A busy page handles a frame's touchmoves back to back: 1.2 px/ms, delivered in bursts.
      const bursts: Array<{ t: number; y: number }> = [];
      for (let frame = 0; frame < 6; frame++) {
        for (let i = 0; i < 3; i++) {
          bursts.push({ t: frame * 16 + i * 0.3, y: (frame * 16 + ((i + 1) * 16) / 3) * 1.2 });
        }
      }
      expect(releaseVelocity(bursts, 90)).toBeGreaterThan(1.1);
      expect(releaseVelocity(bursts, 90)).toBeLessThan(1.3);
    });

    it('never claims more than half again the fastest stretch travelled', () => {
      // A jittery last report: the fit alone would overshoot.
      const jitter = [
        { t: 0, y: 0 },
        { t: 16, y: 16 },
        { t: 32, y: 32 },
        { t: 48, y: 48 },
        { t: 64, y: 80 },
      ];
      expect(releaseVelocity(jitter, 66)).toBeLessThanOrEqual(1.5 * 2 + 1e-9);
    });
  });

  describe('decelerate', () => {
    it('slows down by iOS rate, the same whatever the frame length', () => {
      const once = decelerate(2, 32);
      expect(once.velocity).toBeCloseTo(2 * DECELERATION_RATE ** 32, 10);
      let step = { distance: 0, velocity: 2 };
      let distance = 0;
      for (let i = 0; i < 4; i++) {
        step = decelerate(step.velocity, 8);
        distance += step.distance;
      }
      expect(distance).toBeCloseTo(once.distance, 8);
      expect(step.velocity).toBeCloseTo(once.velocity, 10);
    });

    it('covers about velocity × 500 ms in all', () => {
      const { distance } = decelerate(2, 60_000);
      expect(distance).toBeCloseTo(2 / -Math.log(DECELERATION_RATE), 3);
      expect(distance).toBeGreaterThan(990);
      expect(distance).toBeLessThan(1010);
      expect(decelerate(-2, 60_000).distance).toBeCloseTo(-distance, 3);
    });
  });

  describe('rubberBand', () => {
    it('follows the finger at 0.55 at first, then less and less, never past the view', () => {
      expect(rubberBand(1, 600)).toBeCloseTo(0.55, 2);
      expect(rubberBand(100, 600)).toBeGreaterThan(40);
      expect(rubberBand(100, 600)).toBeLessThan(55);
      expect(rubberBand(200, 600) - rubberBand(100, 600)).toBeLessThan(rubberBand(100, 600));
      expect(rubberBand(1e7, 600)).toBeLessThan(600);
      expect(rubberBand(-100, 600)).toBeCloseTo(-rubberBand(100, 600), 10);
      expect(rubberBand(0, 600)).toBe(0);
      expect(rubberBand(100, 0)).toBe(0);
    });

    it('can be undone: the stretch that shows a given distance', () => {
      for (const stretch of [5, 80, 400, -120]) {
        expect(rubberBandStretch(rubberBand(stretch, 600), 600)).toBeCloseTo(stretch, 6);
      }
    });
  });

  describe('springStep', () => {
    it('brings a stretch back to rest without swinging past it', () => {
      let state = { x: 60, v: 0 };
      const path: number[] = [];
      for (let i = 0; i < 30; i++) {
        state = springStep(state.x, state.v, 16, 0.016);
        path.push(state.x);
      }
      expect(path.every((x) => x >= 0)).toBe(true);
      expect(path.slice(1).every((x, i) => x <= path[i])).toBe(true);
      expect(Math.abs(state.x)).toBeLessThan(0.5);
    });

    it('throws a fling that hits an end past it, then back', () => {
      let state = { x: 0, v: 2.5 };
      let peak = 0;
      for (let i = 0; i < 40; i++) {
        state = springStep(state.x, state.v, 16, 0.016);
        peak = Math.max(peak, state.x);
      }
      expect(peak).toBeGreaterThan(40);
      expect(peak).toBeLessThan(65);
      expect(Math.abs(state.x)).toBeLessThan(0.5);
    });

    it('is the same whatever the frame length', () => {
      const once = springStep(30, 1, 32, 0.016);
      const half = springStep(30, 1, 16, 0.016);
      const twice = springStep(half.x, half.v, 16, 0.016);
      expect(twice.x).toBeCloseTo(once.x, 8);
      expect(twice.v).toBeCloseTo(once.v, 8);
    });
  });
});
