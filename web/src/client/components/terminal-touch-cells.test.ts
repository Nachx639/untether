import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SCROLLBAR_LANE,
  fillCellWidth,
  fillFontSize,
  snappedCellWidth,
  TOUCH_SCROLLBAR_WIDTH,
  touchCellWidth,
  touchColsFor,
  touchScrollbarGap,
  touchTextArea,
  wholeDeviceRow,
} from './terminal-touch-cells';

// A monospace letter 0.6021 of its size wide (12 px: 7.225 px, as measured on an iPhone).
const advanceAt = (size: number) => size * 0.6021;

// User report 2026-10-14: a phone's terminal left 3-4 columns unused on the right and its
// scrollbar sat against the last letters.
describe('touch screen cells', () => {
  it('keeps a letter-wide gap and a 3 px lane for the scrollbar', () => {
    expect(touchScrollbarGap(7.225)).toBe(7);
    expect(touchScrollbarGap(4.5)).toBe(6);
    expect(touchTextArea(428, 7.225)).toBe(428 - 7 - TOUCH_SCROLLBAR_WIDTH);
  });

  it('counts columns at the real letter width, not ghostty’s whole-pixel cell', () => {
    // 440 px phone, 6 px insets: the container is 428 px wide.
    const area = touchTextArea(428, 7.225);
    expect(touchColsFor(area, 7.225)).toBe(57);
    // ghostty's cell of 8 px with FitAddon's 15 px kept: 51.
    expect(Math.floor((428 - 15) / 8)).toBe(51);
    expect(touchColsFor(360, 7.2)).toBe(50);
  });

  it('fills the text area on whole device pixels for every column count and ratio', () => {
    for (const ratio of [1, 2, 2.625, 3]) {
      let close = 0;
      let total = 0;
      for (let cols = 20; cols <= 250; cols++) {
        for (const area of [369, 380.5, 419, 836]) {
          const width = fillCellWidth(area, cols, ratio);
          expect(width, `${cols} cols at ${ratio}x in ${area}`).not.toBeNull();
          // ghostty resizes its canvas on every frame otherwise.
          expect(wholeDeviceRow(cols, width as number, ratio)).toBe(true);
          expect(cols * (width as number)).toBeLessThanOrEqual(area);
          total++;
          if (cols * (width as number) >= area - 1) close++;
        }
      }
      // Float rounding leaves no whole row for a few column counts: a little more gap there.
      expect(close / total, `at ${ratio}x`).toBeGreaterThan(0.9);
    }
  });

  it('fills the area when the columns are as many as fit, never stretches fewer', () => {
    const area = touchTextArea(428, 7.225);
    const full = touchCellWidth(area, 57, 7.225, 3);
    expect(full).toBeGreaterThanOrEqual(7.225 - 1 / 3);
    expect(57 * full).toBeGreaterThan(area - 1);
    expect(57 * full).toBeLessThanOrEqual(area);
    // A tunneled session held at 40 columns: letter-wide cells, the rest unused.
    expect(touchCellWidth(area, 40, 7.225, 3)).toBe(snappedCellWidth(7.225, 3));
    // More columns than fit even at the smallest type (a PTY 200 wide on a phone): letter-wide
    // cells cut off on the right, never letters squeezed on top of each other.
    expect(touchCellWidth(369, 200, 3.612, 3)).toBe(snappedCellWidth(3.612, 3));
  });

  it('shows a wider PTY whole: letters that fit its cells, all columns left of the lane', () => {
    for (const container of [378, 390, 418, 428, 832, 944]) {
      const size = fillFontSize(container, 80, 6, 12, advanceAt);
      const advance = advanceAt(size);
      const area = touchTextArea(container, advance);
      if (size > 6) {
        expect(touchColsFor(area, advance)).toBeGreaterThanOrEqual(80);
        const width = touchCellWidth(area, 80, advance, 3);
        expect(80 * width).toBeLessThanOrEqual(area);
        expect(width).toBeGreaterThanOrEqual(advance - 1 / 3);
      }
      // The largest such size in quarter pixels.
      const next = size + 0.25;
      if (next <= 12) {
        const a = advanceAt(next);
        expect(touchColsFor(touchTextArea(container, a), a) >= 80 && a <= area / 80).toBe(false);
      }
    }
    // Never above the cap, never under the floor.
    expect(fillFontSize(2000, 80, 6, 12, advanceAt)).toBe(12);
    expect(fillFontSize(200, 200, 6, 12, advanceAt)).toBe(6);
  });

  // User report 2026-10-14: a phone 440 px wide showed a Mac window's 80 columns ending about
  // 25 px short of its scrollbar.
  it('grows the type for a PTY narrower than the screen, up to the cap', () => {
    // 440 px phone: a 428 px container, letters 4.8164 px at size 8 (advanceAt 0.60205).
    const at = (size: number) => size * 0.60205;
    const size = fillFontSize(428, 80, 6, 12, at);
    const advance = at(size);
    const area = touchTextArea(428, advance);
    expect(touchColsFor(area, advance)).toBeGreaterThanOrEqual(80);
    const cell = touchCellWidth(area, 80, advance, 3);
    // The text reaches within one cell of the gap: no unused strip.
    expect(80 * cell).toBeGreaterThan(area - cell);
    expect(80 * cell).toBeLessThanOrEqual(area);
    expect(cell / advance - 1).toBeLessThanOrEqual(0.05);
    // A narrow PTY on a wide screen: bigger type, never past the cap.
    expect(fillFontSize(1200, 57, 6, 18, at)).toBe(18);
    expect(fillFontSize(1200, 57, 6, 18, at)).toBeGreaterThan(12);
  });

  it('shrinks the type for a PTY wider than the screen', () => {
    const size = fillFontSize(428, 100, 6, 12, advanceAt);
    expect(size).toBeLessThan(8);
    const advance = advanceAt(size);
    expect(touchColsFor(touchTextArea(428, advance), advance)).toBeGreaterThanOrEqual(100);
  });

  it('on a desktop, fills at whole-pixel cells left of the scrollbar lane', () => {
    const size = fillFontSize(1265, 104, 6, 21, advanceAt, false);
    const cell = Math.ceil(advanceAt(size));
    expect(104 * cell).toBeLessThanOrEqual(1265 - DESKTOP_SCROLLBAR_LANE);
    expect(104 * Math.ceil(advanceAt(size + 0.25))).toBeGreaterThan(1265 - DESKTOP_SCROLLBAR_LANE);
  });
});
