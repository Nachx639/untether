/**
 * One row of terminal cells, drawn as ghostty-web draws it. A touch scroll draws the text of
 * ghostty's canvas a fraction of a row lower between whole rows, and moves its pixels at a row
 * crossing (terminal.ts, drawMovedText): this draws the rows that come into the strip it
 * uncovers, the row above the first one included. It mirrors ghostty-web 0.4's
 * CanvasRenderer.renderLine for one row, without selection or link hover (a selection or a
 * hover makes ghostty repaint the whole canvas instead).
 */
import type { GhosttyCell } from 'ghostty-web';

// ghostty-web's CellFlags (not imported: unit tests mock the module without it).
const BOLD = 1;
const ITALIC = 2;
const UNDERLINE = 4;
const STRIKETHROUGH = 8;
const INVERSE = 16;
const INVISIBLE = 32;
const FAINT = 128;

export interface CellMetrics {
  width: number;
  height: number;
  baseline: number;
}

export interface RowFont {
  size: number;
  family: string;
}

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

/**
 * Paints one row of cells at the top of `ctx`, as ghostty-web paints a row of its canvas.
 * `grapheme(col)` gives the whole cluster of a cell made of several code points (emoji with
 * ZWJ, combining marks); without it such a cell shows its first code point.
 */
export function paintCellRow(
  ctx: CanvasRenderingContext2D,
  cells: readonly GhosttyCell[],
  cols: number,
  metrics: CellMetrics,
  font: RowFont,
  background: string,
  grapheme?: (col: number) => string
): void {
  const { width, height, baseline } = metrics;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cols * width, height);
  // Backgrounds first: a glyph may reach into the cell to its left.
  cells.forEach((cell, col) => {
    if (cell.width === 0) return;
    const inverse = (cell.flags & INVERSE) !== 0;
    const [r, g, b] = inverse
      ? [cell.fg_r, cell.fg_g, cell.fg_b]
      : [cell.bg_r, cell.bg_g, cell.bg_b];
    // Black is ghostty's "default background": the row's fill already painted it.
    if (r === 0 && g === 0 && b === 0) return;
    ctx.fillStyle = rgb(r, g, b);
    ctx.fillRect(col * width, 0, width * cell.width, height);
  });
  cells.forEach((cell, col) => {
    if (cell.width === 0 || (cell.flags & INVISIBLE) !== 0) return;
    const style = `${cell.flags & ITALIC ? 'italic ' : ''}${cell.flags & BOLD ? 'bold ' : ''}`;
    ctx.font = `${style}${font.size}px ${font.family}`;
    ctx.fillStyle =
      cell.flags & INVERSE
        ? rgb(cell.bg_r, cell.bg_g, cell.bg_b)
        : rgb(cell.fg_r, cell.fg_g, cell.fg_b);
    const faint = (cell.flags & FAINT) !== 0;
    if (faint) ctx.globalAlpha = 0.5;
    const text =
      cell.grapheme_len > 0 && grapheme
        ? grapheme(col)
        : String.fromCodePoint(cell.codepoint || 32);
    ctx.fillText(text, col * width, baseline);
    if (faint) ctx.globalAlpha = 1;
    const line = (y: number) => {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(col * width, y);
      ctx.lineTo((col + cell.width) * width, y);
      ctx.stroke();
    };
    if (cell.flags & UNDERLINE) line(baseline + 2);
    if (cell.flags & STRIKETHROUGH) line(height / 2);
  });
}
