/**
 * Shared utility for formatting terminal text with style markup
 * Used by both client and server for consistent text representation
 */

/**
 * A cell of the buffer snapshot, the one definition for server and client. `fg` and `bg`
 * are always RGB (0xRRGGBB) and absent when the cell has the terminal's default colour:
 * the server's terminal resolves every colour, a palette index never reaches a snapshot.
 * 2026-11-11: the value decided the kind (<= 255 meant "palette index"), so a pure blue
 * (#0000ff is 255) or a navy (#000080) was sent in one byte and painted as palette colour
 * 255 or 128, a grey, in the thumbnails and in the styled text.
 */
export interface BufferCell {
  char: string;
  width: number;
  fg?: number;
  bg?: number;
  attributes?: number;
}

/** Version byte of the binary snapshot. 2: colours are always three RGB bytes. */
export const SNAPSHOT_VERSION = 0x02;

/**
 * The bits of the type byte that opens every cell of the binary snapshot, the one table the
 * server's encoder and the web decoder share (iOS mirrors it in BufferWebSocketClient.swift).
 * Bits 3 and 2 are unused.
 */
export const CELL_TYPE = {
  /** An attributes byte follows the character, then the colours the next two bits announce. */
  EXTENDED: 0x80,
  /** The character is a length byte and that many UTF-8 bytes (otherwise one ASCII byte). */
  UNICODE: 0x40,
  /** Three bytes of foreground follow: red, green, blue. */
  HAS_FG: 0x20,
  /** Three bytes of background follow: red, green, blue. */
  HAS_BG: 0x10,
  CHAR_MASK: 0x03,
  CHAR_SPACE: 0x00,
  CHAR_ASCII: 0x01,
  CHAR_UNICODE: 0x02,
} as const;

/** The red, green and blue of a cell colour. */
export function cellColorRgb(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/**
 * The bits of BufferCell.attributes, as the server's snapshot sets them (terminal-manager.ts)
 * and the client draws them. One definition: 2026-11-10, the guard of the user's own input
 * took 0x02 for "dim" (it is italic), read Codex's greyed placeholder "Ask Codex to do
 * anything" as a draft of the user's, and no task's brief or follow-up was ever typed into a
 * Codex (5690cffb sat 50 min "working" on an empty prompt; 00d3baa3's message waited 34 min).
 */
export const CELL_ATTR = {
  BOLD: 0x01,
  ITALIC: 0x02,
  UNDERLINE: 0x04,
  DIM: 0x08,
  INVERSE: 0x10,
  INVISIBLE: 0x20,
  STRIKETHROUGH: 0x40,
} as const;

/**
 * Format style attributes for a cell into a string
 */
export function formatCellStyle(cell: BufferCell): string {
  const attrs: string[] = [];

  if (cell.fg !== undefined) attrs.push(`fg="${cellColorRgb(cell.fg).join(',')}"`);
  if (cell.bg !== undefined) attrs.push(`bg="${cellColorRgb(cell.bg).join(',')}"`);

  // Text attributes
  if (cell.attributes) {
    if (cell.attributes & CELL_ATTR.BOLD) attrs.push('bold');
    if (cell.attributes & CELL_ATTR.DIM) attrs.push('dim');
    if (cell.attributes & CELL_ATTR.ITALIC) attrs.push('italic');
    if (cell.attributes & CELL_ATTR.UNDERLINE) attrs.push('underline');
    if (cell.attributes & CELL_ATTR.INVERSE) attrs.push('inverse');
    if (cell.attributes & CELL_ATTR.INVISIBLE) attrs.push('invisible');
    if (cell.attributes & CELL_ATTR.STRIKETHROUGH) attrs.push('strikethrough');
  }

  return attrs.join(' ');
}

/**
 * Convert buffer cells to text with optional style markup
 */
export function cellsToText(cells: BufferCell[][], includeStyles = true): string {
  const lines: string[] = [];

  for (const row of cells) {
    let line = '';

    if (includeStyles) {
      let currentStyle = '';
      let currentText = '';

      const flushStyleGroup = () => {
        if (currentText) {
          if (currentStyle) {
            line += `[style ${currentStyle}]${currentText}[/style]`;
          } else {
            line += currentText;
          }
          currentText = '';
        }
      };

      for (const cell of row) {
        const style = formatCellStyle(cell);

        if (style !== currentStyle) {
          flushStyleGroup();
          currentStyle = style;
        }

        currentText += cell.char;
      }

      flushStyleGroup();
    } else {
      // Plain text without styles
      for (const cell of row) {
        line += cell.char;
      }
    }

    // Trim trailing spaces but preserve empty lines
    lines.push(line.trimEnd());
  }

  return lines.join('\n');
}
