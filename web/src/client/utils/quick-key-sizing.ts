/**
 * Sizing for the rows of terminal quick keys.
 *
 * Keys share their row equally (flex: 1 1 0), but a key is never narrower than its label
 * (min-width in the component CSS): word keys such as "Listo" take what they need and the
 * glyph keys split the rest. A row therefore fits when the sum of those label minimums fits.
 *
 * 2026-10-12 (phone spec 3.9): neutral keycaps with sans captions at ONE size per row, 15 px
 * when there is room, down to 11 px at the tightest (the floor), and never narrower than
 * 32 px. Until then each label got its own size (13 px glyphs, 8 px words, 7 px at worst), so
 * "Inicio" or "Listo" read at a third of the arrows' size.
 *
 * 2026-10-12 (QA, iPhone SE 320 pt): nine 32 px keys with 4 px gaps need 328 px, so → and
 * Listo ran off the right edge. When no caption size fits at the roomy spacing, the row
 * tightens its gap (3, then 2 px) and only then lets keys go down to 30 px.
 *
 * 2026-10-04: on a 375 pt iPhone SE the 12-key second row ("Pegar … Listo" in Spanish) got
 * 29 px per key, so 5- and 6-letter labels spilled out of their keys.
 */

/** SF Pro averages ~0.56 em per character; a little extra covers wide glyphs (W, M, ⇤). */
const SANS_ADVANCE_EM = 0.62;
/** `border` on every key: none (the keycap is a fill with a 1 px bottom shadow). */
const KEY_BORDER_PX = 0;
/** Gap between keys at the roomy spacing (the component sets the row's gap from the sizing). */
export const QUICK_KEY_GAP_PX = 4;
/** Row padding (4 px each side) set in the component CSS. */
export const QUICK_KEY_ROW_INSET_PX = 8;
/** No key is narrower than this (phone spec: ≥ 32 px wide, 42 px tall, 44 px hit). */
export const QUICK_KEY_MIN_WIDTH_PX = 32;
/** Caption sizes, roomiest first; 11 px is the floor. */
export const QUICK_KEY_FONT_SIZES_PX = [15, 14, 13, 12, 11] as const;
/** Horizontal padding per side inside a key, roomiest first. */
const PADDINGS_PX = [6, 4, 2] as const;
/** Gap and narrowest key, roomiest first; the later ones only for rows that overflow otherwise. */
const SPACINGS = [
  { gapPx: QUICK_KEY_GAP_PX, minWidthPx: QUICK_KEY_MIN_WIDTH_PX },
  { gapPx: 3, minWidthPx: QUICK_KEY_MIN_WIDTH_PX },
  { gapPx: 2, minWidthPx: QUICK_KEY_MIN_WIDTH_PX },
  { gapPx: 2, minWidthPx: 30 },
] as const;

export interface QuickKeyRowSizing {
  /** One caption size for every key in the row, in px. */
  fontPx: number;
  /** Horizontal padding per side, in px. */
  paddingPx: number;
  /** Gap between keys, in px. */
  gapPx: number;
  /** Narrowest a key may get, in px. */
  minWidthPx: number;
}

function labelLength(label: string): number {
  return [...label].length;
}

/** Narrowest a key can be without its label spilling out: text + padding, at least 32 px. */
export function quickKeyMinWidth(
  label: string,
  fontPx: number,
  paddingPx = 4,
  minWidthPx: number = QUICK_KEY_MIN_WIDTH_PX
): number {
  const text = Math.ceil(labelLength(label) * fontPx * SANS_ADVANCE_EM);
  return Math.max(minWidthPx, text + 2 * paddingPx + KEY_BORDER_PX);
}

function available(count: number, rowWidth: number, gapPx: number = QUICK_KEY_GAP_PX): number {
  return rowWidth - QUICK_KEY_ROW_INSET_PX - gapPx * Math.max(count - 1, 0);
}

/**
 * Caption size and padding for one row of keys (labels as shown, Done included) in a row
 * `rowWidth` px wide: the largest size, then the roomiest padding, whose label minimums fit.
 */
export function quickKeyRowSizing(labels: readonly string[], rowWidth: number): QuickKeyRowSizing {
  for (const { gapPx, minWidthPx } of SPACINGS) {
    const room = available(labels.length, rowWidth, gapPx);
    for (const fontPx of QUICK_KEY_FONT_SIZES_PX) {
      for (const paddingPx of PADDINGS_PX) {
        const needed = labels.reduce(
          (sum, label) => sum + quickKeyMinWidth(label, fontPx, paddingPx, minWidthPx),
          0
        );
        if (needed <= room) return { fontPx, paddingPx, gapPx, minWidthPx };
      }
    }
  }
  const floor = QUICK_KEY_FONT_SIZES_PX[QUICK_KEY_FONT_SIZES_PX.length - 1];
  const tightest = SPACINGS[SPACINGS.length - 1];
  return { fontPx: floor, paddingPx: PADDINGS_PX[PADDINGS_PX.length - 1], ...tightest };
}

/**
 * Whether a row of these labels fits `rowWidth` px at all: at the floor size and the tightest
 * padding. A phone on its side (or a short visible viewport) puts both rows of keys in one when
 * it does (terminal-quick-keys.ts). Measured at the roomy spacing (4 px gaps, 32 px keys), so a
 * merged row never needs the tighter fallbacks.
 */
export function quickKeyRowFits(labels: readonly string[], rowWidth: number): boolean {
  const floor = QUICK_KEY_FONT_SIZES_PX[QUICK_KEY_FONT_SIZES_PX.length - 1];
  const tightest = PADDINGS_PX[PADDINGS_PX.length - 1];
  const needed = labels.reduce((sum, label) => sum + quickKeyMinWidth(label, floor, tightest), 0);
  return needed <= available(labels.length, rowWidth);
}
