import {
  type BufferCell,
  CELL_ATTR,
  CELL_TYPE,
  cellColorRgb,
  SNAPSHOT_VERSION,
} from '../../shared/terminal-text-formatter.js';

export type { BufferCell };

// Attribute bit flags
const {
  BOLD: ATTR_BOLD,
  ITALIC: ATTR_ITALIC,
  UNDERLINE: ATTR_UNDERLINE,
  DIM: ATTR_DIM,
  INVERSE: ATTR_INVERSE,
  INVISIBLE: ATTR_INVISIBLE,
  STRIKETHROUGH: ATTR_STRIKETHROUGH,
} = CELL_ATTR;

// Helper function for escaping HTML
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a line from BufferCell array (from JSON/binary buffer)
 */
export function renderLineFromCells(cells: BufferCell[], cursorCol: number = -1): string {
  let html = '';
  let currentChars = '';
  let currentClasses = '';
  let currentStyle = '';

  const flushGroup = () => {
    if (currentChars) {
      const escapedChars = escapeHtml(currentChars);
      html += `<span class="${currentClasses}"${currentStyle ? ` style="${currentStyle}"` : ''}>${escapedChars}</span>`;
      currentChars = '';
    }
  };

  // Process each cell
  let col = 0;
  for (const cell of cells) {
    // Skip zero-width cells
    if (cell.width === 0) continue;

    // Get styling
    const { classes, style } = getCellStylingFromBuffer(cell, col === cursorCol);

    // Check if styling changed
    if (classes !== currentClasses || style !== currentStyle) {
      flushGroup();
      currentClasses = classes;
      currentStyle = style;
    }

    currentChars += cell.char;
    col += cell.width;
  }

  // Flush remaining chars
  flushGroup();

  // If the line is empty or has no visible content, add a non-breaking space
  // to ensure the line maintains its height
  if (!html) {
    html = '<span class="terminal-char">&nbsp;</span>';
  }

  return html;
}

function getCellStylingFromBuffer(
  cell: BufferCell,
  isCursor: boolean
): { classes: string; style: string } {
  let classes = 'terminal-char';
  let style = '';

  if (isCursor) {
    classes += ' cursor';
  }

  // A cell's colour is always RGB (BufferCell); without one, the default foreground.
  if (cell.fg !== undefined) {
    style += `color: rgb(${cellColorRgb(cell.fg).join(', ')});`;
  } else {
    style += `color: #d4d4d4;`;
  }

  if (cell.bg !== undefined) {
    style += `background-color: rgb(${cellColorRgb(cell.bg).join(', ')});`;
  }

  // Don't set background color for cursor - let CSS animation handle it

  // Get text attributes from bit flags
  const attrs = cell.attributes || 0;
  if (attrs & ATTR_BOLD) classes += ' bold';
  if (attrs & ATTR_ITALIC) classes += ' italic';
  if (attrs & ATTR_UNDERLINE) classes += ' underline';
  if (attrs & ATTR_DIM) classes += ' dim';
  if (attrs & ATTR_STRIKETHROUGH) classes += ' strikethrough';

  // Handle inverse colors
  if (attrs & ATTR_INVERSE) {
    const tempFg = style.match(/color: ([^;]+);/)?.[1];
    const tempBg = style.match(/background-color: ([^;]+);/)?.[1];
    if (tempFg && tempBg) {
      style = style.replace(/color: [^;]+;/, `color: ${tempBg};`);
      style = style.replace(/background-color: [^;]+;/, `background-color: ${tempFg};`);
    } else if (tempFg) {
      style = style.replace(/color: [^;]+;/, 'color: #1e1e1e;');
      style += `background-color: ${tempFg};`;
    } else {
      style += 'color: #1e1e1e; background-color: #d4d4d4;';
    }
  }

  // Handle invisible text
  if (attrs & ATTR_INVISIBLE) {
    style += 'opacity: 0;';
  }

  return { classes, style };
}

/**
 * Decode binary buffer format
 */
export function decodeBinaryBuffer(buffer: ArrayBuffer): {
  cols: number;
  rows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  cells: BufferCell[][];
} {
  const view = new DataView(buffer);
  let offset = 0;

  // Read header
  const magic = view.getUint16(offset, true);
  offset += 2;
  if (magic !== 0x5654) {
    throw new Error('Invalid buffer format');
  }

  const version = view.getUint8(offset++);
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported buffer version: ${version}`);
  }

  const _flags = view.getUint8(offset++);
  const cols = view.getUint32(offset, true);
  offset += 4;
  const rows = view.getUint32(offset, true);
  offset += 4;
  const viewportY = view.getInt32(offset, true); // Signed
  offset += 4;
  const cursorX = view.getInt32(offset, true); // Signed
  offset += 4;
  const cursorY = view.getInt32(offset, true); // Signed
  offset += 4;
  offset += 4; // Skip reserved

  // Decode cells
  const cells: BufferCell[][] = [];
  const uint8 = new Uint8Array(buffer);

  // Optimized format
  while (offset < uint8.length) {
    const marker = uint8[offset++];

    if (marker === 0xfe) {
      // Empty row(s)
      const count = uint8[offset++];
      for (let i = 0; i < count; i++) {
        cells.push([{ char: ' ', width: 1 }]);
      }
    } else if (marker === 0xfd) {
      // Row with content
      const cellCount = view.getUint16(offset, true);
      offset += 2;

      const rowCells: BufferCell[] = [];
      for (let i = 0; i < cellCount; i++) {
        const result = decodeCell(uint8, offset);
        offset = result.offset;
        rowCells.push(result.cell);
      }
      cells.push(rowCells);
    }
  }

  return { cols, rows, viewportY, cursorX, cursorY, cells };
}

function readRgb(uint8: Uint8Array, offset: number): number {
  return (uint8[offset] << 16) | (uint8[offset + 1] << 8) | uint8[offset + 2];
}

/** One cell as the server's encodeCell writes it: type byte (CELL_TYPE), character, extras. */
function decodeCell(uint8: Uint8Array, offset: number): { cell: BufferCell; offset: number } {
  const typeByte = uint8[offset++];

  // Simple space
  if (typeByte === CELL_TYPE.CHAR_SPACE) {
    return { cell: { char: ' ', width: 1 }, offset };
  }

  let char: string;
  if ((typeByte & CELL_TYPE.CHAR_MASK) === CELL_TYPE.CHAR_SPACE) {
    char = ' ';
  } else if (typeByte & CELL_TYPE.UNICODE) {
    const charLen = uint8[offset++];
    char = new TextDecoder().decode(uint8.slice(offset, offset + charLen));
    offset += charLen;
  } else {
    char = String.fromCharCode(uint8[offset++]);
  }

  const cell: BufferCell = { char, width: 1 };

  if (typeByte & CELL_TYPE.EXTENDED) {
    const attributes = uint8[offset++];
    if (attributes !== 0) cell.attributes = attributes;

    if (typeByte & CELL_TYPE.HAS_FG) {
      cell.fg = readRgb(uint8, offset);
      offset += 3;
    }
    if (typeByte & CELL_TYPE.HAS_BG) {
      cell.bg = readRgb(uint8, offset);
      offset += 3;
    }
  }

  return { cell, offset };
}

// Re-export as object for backwards compatibility
export const TerminalRenderer = {
  renderLineFromCells,
  decodeBinaryBuffer,
};
