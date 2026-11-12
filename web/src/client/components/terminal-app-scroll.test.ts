import { describe, expect, it } from 'vitest';
import {
  APP_SCROLL_SETTLE_MS,
  AppScrollTracker,
  detectShift,
  HOLD_MS,
} from './terminal-app-scroll';

const HISTORY = Array.from(
  { length: 200 },
  (_, i) => `line ${i + 1} of the output ${'x'.repeat(i % 7)}`
);
const ROWS = 30;
const BAR = ['─'.repeat(20), '> prompt', '  status'];

/** A full-screen app's screen `back` rows up from the bottom, its bar pinned below. */
function screen(back: number, status = '  status'): string[] {
  const view = ROWS - BAR.length;
  const end = HISTORY.length - back;
  return [...HISTORY.slice(end - view, end), BAR[0], BAR[1], status];
}

describe('detectShift', () => {
  it('finds rows moved into the history past a pinned bar', () => {
    expect(detectShift(screen(0), screen(3))).toBe(3);
    expect(detectShift(screen(3), screen(1))).toBe(-2);
  });

  it('is not misled by a pinned row that changes with the scroll', () => {
    expect(detectShift(screen(0, 'off=0'), screen(5, 'off=5'))).toBe(5);
  });

  it('reports no move when nothing changed, and no shift for a repaint', () => {
    expect(detectShift(screen(4), screen(4))).toBe(0);
    expect(detectShift(screen(0), screen(80))).toBeNull();
    expect(detectShift(screen(0), screen(0).slice(1))).toBeNull();
  });
});

describe('AppScrollTracker', () => {
  function scrolled(steps: number[], perStep = 3) {
    const tracker = new AppScrollTracker();
    let back = 0;
    let now = 0;
    tracker.observe(screen(back), 80);
    for (const step of steps) {
      tracker.wheel(step, now);
      back = Math.max(0, Math.min(HISTORY.length - (ROWS - BAR.length), back + step * perStep));
      now += 16;
      tracker.frame(screen(back), 80, now);
    }
    return { tracker, back, now };
  }

  it('measures how far back the app is, whatever its rows per step', () => {
    const { tracker, back } = scrolled([1, 1, 2, 1], 4);
    expect(tracker.offset).toBe(back);
    expect(tracker.rowsPerStep).toBe(4);
    expect(tracker.total).toBeGreaterThan(back);
  });

  it('knows the length of the history once steps up go unanswered at the top', () => {
    const { tracker, now } = scrolled(Array.from({ length: 80 }, () => 1));
    const top = HISTORY.length - (ROWS - BAR.length);
    expect(tracker.offset).toBe(top);
    // The last steps moved nothing: once they settle, that is the top.
    expect(tracker.settle(now)).toBe(false);
    expect(tracker.settle(now + APP_SCROLL_SETTLE_MS)).toBe(true);
    expect(tracker.total).toBe(top);
  });

  it('counts a repaint no shift explains at the measured rows per step', () => {
    const tracker = new AppScrollTracker();
    tracker.observe(screen(0), 80);
    tracker.wheel(1, 0);
    tracker.frame(screen(3), 80, 10);
    tracker.wheel(30, 20);
    // It may be a frame half drawn: it waits for the rest first.
    expect(tracker.frame(screen(93), 80, 30)).toBe(false);
    expect(tracker.holding).toBe(true);
    expect(tracker.frame(screen(93), 80, 30 + HOLD_MS)).toBe(true);
    expect(tracker.offset).toBe(93);
  });

  it('waits for the rest of a frame drawn in two writes', () => {
    const tracker = new AppScrollTracker();
    tracker.observe(screen(0), 80);
    tracker.wheel(2, 0);
    // Cleared, then only the first rows written.
    const half = screen(6).map((row, i) => (i < 5 ? row : ''));
    expect(tracker.frame(half, 80, 10)).toBe(false);
    expect(tracker.frame(screen(6), 80, 20)).toBe(true);
    expect(tracker.offset).toBe(6);
    expect(tracker.holding).toBe(false);
  });

  it('counts a screen held as half drawn once the next one follows from it', () => {
    const tracker = new AppScrollTracker();
    tracker.observe(screen(0), 80);
    tracker.wheel(1, 0);
    tracker.frame(screen(3), 80, 10);
    // Thirty steps at once: past what a screen can show, held.
    tracker.wheel(30, 20);
    expect(tracker.frame(screen(93), 80, 30)).toBe(false);
    // The next frame moved on from it: it was whole, a repaint, and then a shift.
    tracker.wheel(1, 40);
    expect(tracker.frame(screen(96), 80, 50)).toBe(true);
    expect(tracker.offset).toBe(96);
    expect(tracker.holding).toBe(false);
  });

  it('ignores a status line changing while scrolled', () => {
    const { tracker, back, now } = scrolled([1, 1]);
    expect(tracker.frame(screen(back, '  thinking'), 80, now + 5000)).toBe(false);
    expect(tracker.offset).toBe(back);
  });

  it('comes back to the bottom on steps down past it, or a prompt sent', () => {
    const { tracker, now } = scrolled([1, 1, -1, -1, -1]);
    expect(tracker.offset).toBe(0);
    tracker.settle(now + APP_SCROLL_SETTLE_MS);
    expect(tracker.offset).toBe(0);
    const again = scrolled([1, 1]).tracker;
    again.submitted();
    expect(again.offset).toBe(0);
  });

  it('starts over when the screen changes size', () => {
    const { tracker, back, now } = scrolled([1, 1]);
    expect(tracker.active).toBe(true);
    tracker.frame(screen(back), 100, now + 16);
    expect(tracker.active).toBe(false);
    expect(tracker.offset).toBe(0);
  });

  it('follows a jump to the bottom the app makes by itself', () => {
    const { tracker, now } = scrolled(Array.from({ length: 20 }, () => 1));
    expect(tracker.offset).toBe(60);
    // A tap on its "Jump to bottom": the whole screen replaced, no scroll on its way.
    const later = now + 2000;
    expect(tracker.frame(screen(0), 80, later)).toBe(false);
    expect(tracker.frame(screen(0), 80, later + HOLD_MS)).toBe(true);
    expect(tracker.offset).toBe(0);
    // From a little way up, it is a shift down.
    const near = scrolled([1, 1, 1]);
    expect(near.tracker.frame(screen(0), 80, near.now + 2000)).toBe(true);
    expect(near.tracker.offset).toBe(0);
  });

  it('counts a repaint while a spinner keeps turning', () => {
    const tracker = new AppScrollTracker();
    tracker.observe(screen(0), 80);
    tracker.wheel(1, 0);
    tracker.frame(screen(3), 80, 10);
    tracker.wheel(30, 20);
    expect(tracker.frame(screen(93, '  ⠋'), 80, 30)).toBe(false);
    expect(tracker.frame(screen(93, '  ⠙'), 80, 30 + HOLD_MS / 2)).toBe(false);
    expect(tracker.frame(screen(93, '  ⠹'), 80, 30 + HOLD_MS)).toBe(true);
    expect(tracker.offset).toBe(93);
  });
});
