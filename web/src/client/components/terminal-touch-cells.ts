/**
 * Cell widths on touch screens (user report 2026-10-14). ghostty-web 0.4 measures a cell as
 * `Math.ceil(measureText('M').width)`: at 12 px the letter is 7.225 px wide and the cell 8, so
 * a 440 px phone lost about 5 columns to the rounding, and a wider PTY shown in smaller type
 * could only be drawn 80 × a whole number of px wide (cut off at 390 px, a strip of up to 34 px
 * unused at 440). On a touch screen the columns are counted at the letter's real width and the
 * cells fill the text area exactly; right of it, a gap about a letter wide, our scrollbar in a
 * lane of its own, and the terminal area's right inset (as wide as its left one).
 *
 * ghostty's render() resizes its canvas whenever `cols × width × ratio` is not the canvas's
 * whole number of device pixels, so a cell width is only ever one whose row is a whole number
 * of device pixels (fillCellWidth).
 */

/** Width of our scrollbar's lane on a touch screen (CSS px). */
export const TOUCH_SCROLLBAR_WIDTH = 3;
/** Least gap between the last column and the scrollbar's lane (CSS px). */
const TOUCH_SCROLLBAR_MIN_GAP = 6;

/** The gap between the text and the scrollbar: about one letter, never under 6 px. */
export function touchScrollbarGap(advance: number): number {
  return Math.max(TOUCH_SCROLLBAR_MIN_GAP, Math.round(advance));
}

/** The width left for text in a container `width` px wide (gap and scrollbar lane taken). */
export function touchTextArea(width: number, advance: number): number {
  return Math.max(0, width - touchScrollbarGap(advance) - TOUCH_SCROLLBAR_WIDTH);
}

/** Columns that fit `textArea` at letters `advance` px wide. */
export function touchColsFor(textArea: number, advance: number): number {
  if (!(advance > 0)) return 1;
  // A hair of slack: 7.2 × 50 must count as 50 columns in 360 px, whatever the float says.
  return Math.max(1, Math.floor(textArea / advance + 1e-6));
}

/** Whether `cols` cells `width` px wide make a row of whole device pixels, as ghostty checks. */
export function wholeDeviceRow(cols: number, width: number, ratio: number): boolean {
  return Number.isInteger(cols * width * ratio);
}

/**
 * The widest cell, at most `textArea / cols`, whose row of `cols` cells is a whole number of
 * device pixels in ghostty's own arithmetic (`cols * width * ratio`). Null when there is none
 * close by (it is found within a few device pixels in practice).
 */
export function fillCellWidth(textArea: number, cols: number, ratio: number): number | null {
  if (!(textArea > 0) || !(cols > 0) || !(ratio > 0)) return null;
  let pixels = Math.floor(textArea * ratio + 1e-6);
  for (let tries = 0; tries < 64 && pixels > 0; tries++, pixels--) {
    const width = pixels / (cols * ratio);
    // The float division rarely gives back exactly `pixels`: the widths a few units in the
    // last place below it are as good (all well under a device pixel short).
    const ulp = 2 ** (Math.floor(Math.log2(width)) - 52);
    for (let ulps = 0; ulps <= 8; ulps++) {
      const nudged = width - ulps * ulp;
      if (cols * nudged <= textArea && wholeDeviceRow(cols, nudged, ratio)) return nudged;
    }
  }
  return null;
}

/**
 * A cell a letter `advance` px wide fits, on whole device pixels (any number of columns of
 * it is a whole number of device pixels too, at a whole ratio).
 */
export function snappedCellWidth(advance: number, ratio: number): number {
  const width = Math.ceil(advance * ratio - 1e-6) / ratio;
  return width > 0 ? width : 1;
}

/** Most a cell is stretched past its letter to fill the text area (fewer columns than fit). */
const MAX_FILL_STRETCH = 0.05;

/**
 * The cell width for `cols` columns in `textArea`: filling it exactly when that stretches the
 * letters by at most 5% (as many columns as fit, or a wider PTY whose letters were made small
 * enough), otherwise the letter's own width snapped to device pixels (a grid held at fewer
 * columns than fit: no spaced-out letters; or more columns than fit even at the smallest type,
 * a PTY 200 wide on a phone: cut off on the right as before, never letters squeezed on top of
 * each other).
 */
export function touchCellWidth(
  textArea: number,
  cols: number,
  advance: number,
  ratio: number
): number {
  const snapped = snappedCellWidth(advance, ratio);
  const stretch = textArea / (cols * advance) - 1;
  const fitCols = touchColsFor(textArea, advance);
  if (cols > fitCols) return snapped;
  const fill = cols === fitCols || stretch <= MAX_FILL_STRETCH ? textArea : cols * snapped + 1e-6;
  if (fill === textArea || !wholeDeviceRow(cols, snapped, ratio)) {
    const width = fillCellWidth(fill, cols, ratio);
    if (width !== null) return width;
  }
  return snapped;
}

/** What FitAddon keeps right of the text for a scrollbar on a mouse/trackpad screen (CSS px). */
export const DESKTOP_SCROLLBAR_LANE = 15;

/**
 * The largest type size, in quarter px between `minSize` and `maxSize`, at which a PTY `cols`
 * wide fills a container `width` px wide without being cut off: smaller type for a PTY wider
 * than this screen, bigger for a narrower one (user report 2026-10-14: a phone showing a Mac
 * window's 80 columns left a strip unused, a desktop page showed a phone's columns in a quarter
 * of its width). On a touch screen its columns fit left of the gap and the scrollbar's lane at
 * the letter's real width (the cells then stretch to fill, touchCellWidth); on a mouse/trackpad
 * screen at ghostty's whole-pixel cells, left of FitAddon's scrollbar lane. `advanceAt(size)`
 * measures a letter at a size.
 */
export function fillFontSize(
  width: number,
  cols: number,
  minSize: number,
  maxSize: number,
  advanceAt: (size: number) => number,
  touch = true
): number {
  const fits = (size: number) => {
    const advance = advanceAt(size);
    if (!(advance > 0)) return false;
    if (touch) return touchColsFor(touchTextArea(width, advance), advance) >= cols;
    return cols * Math.ceil(advance - 1e-6) <= width - DESKTOP_SCROLLBAR_LANE;
  };
  for (let size = Math.floor(maxSize * 4) / 4; size > minSize; size -= 0.25) {
    if (fits(size)) return size;
  }
  return minSize;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
const advances = new Map<string, number>();

/**
 * The real width of a letter ("M") at `size` px in `family`, unrounded; null where the page
 * has no canvas to measure with.
 */
export function measureAdvance(size: number, family: string): number | null {
  const font = `${size}px ${family}`;
  const known = advances.get(font);
  if (known !== undefined) return known;
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return null;
  measureContext.font = font;
  const width = measureContext.measureText('M').width;
  if (!(width > 0)) return null;
  advances.set(font, width);
  return width;
}

/** Letters measured before the terminal's font arrived are measured again. */
export function forgetMeasuredAdvances(): void {
  advances.clear();
}
