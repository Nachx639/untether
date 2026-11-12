import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBinaryBuffer, renderLineFromCells } from '../../client/utils/terminal-renderer.js';
import {
  type BufferCell,
  CELL_ATTR,
  CELL_TYPE,
  cellsToText,
  SNAPSHOT_VERSION,
} from '../../shared/terminal-text-formatter.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { TerminalManager } from './terminal-manager.js';

// The real ghostty-web and its WASM: the test setup mocks the module for unit tests.
vi.unmock('ghostty-web');

/**
 * 2026-11-11: a colour whose value was <= 255 (pure blue #0000ff, navy #000080, black) left
 * the server as a one-byte "palette index" and the thumbnails and the styled text painted
 * palette colour 255 or 128, a grey. A snapshot's colours are always RGB now, from the
 * server's terminal to the page, and the bits of the format are one shared table.
 */
describe('snapshot colours from the terminal to the page', () => {
  let controlDir: string | undefined;
  let manager: TerminalManager | undefined;

  afterEach(async () => {
    manager?.destroy();
    manager = undefined;
    if (controlDir) {
      await rm(controlDir, RM_TEST_DIR);
      controlDir = undefined;
    }
  });

  async function snapshotOf(output: string) {
    controlDir = await mkdtemp(path.join(tmpdir(), 'untether-colors-'));
    await mkdir(path.join(controlDir, 's'), { recursive: true });
    const header = JSON.stringify({ version: 2, width: 40, height: 5 });
    await writeFile(
      path.join(controlDir, 's', 'stdout'),
      `${header}\n${JSON.stringify([0.1, 'o', output])}\n`
    );
    manager = new TerminalManager(controlDir);
    const snapshot = await manager.getBufferSnapshot('s');
    const encoded = manager.encodeSnapshot(snapshot);
    const bytes = new Uint8Array(encoded).buffer;
    return { snapshot, encoded, decoded: decodeBinaryBuffer(bytes) };
  }

  const cellOf = (cells: BufferCell[][], char: string): BufferCell => {
    const cell = cells.flat().find((candidate) => candidate.char === char);
    if (!cell) throw new Error(`no cell "${char}"`);
    return cell;
  };

  it('pure blue text and pure blue background reach the page as blue', async () => {
    const { snapshot, decoded } = await snapshotOf(
      '\x1b[38;2;0;0;255mF\x1b[0m \x1b[48;2;0;0;255mB\x1b[0m'
    );

    expect(cellOf(snapshot.cells, 'F').fg).toBe(0x0000ff);
    expect(cellOf(snapshot.cells, 'B').bg).toBe(0x0000ff);
    // What the page decodes is what the server had
    expect(decoded.cells).toEqual(
      snapshot.cells.map((row) => row.map((c) => ({ ...c, width: 1 })))
    );

    const html = renderLineFromCells(decoded.cells[0]);
    expect(html).toContain('color: rgb(0, 0, 255);');
    expect(html).toContain('background-color: rgb(0, 0, 255);');
    expect(html).not.toContain('terminal-color');

    const text = cellsToText(decoded.cells, true);
    expect(text).toContain('[style fg="0,0,255"]F[/style]');
    expect(text).toContain('bg="0,0,255"]B[/style]');
  });

  it('navy, a dark green and a low red are not palette colours either', async () => {
    const { decoded } = await snapshotOf(
      '\x1b[38;2;0;0;128mN\x1b[0m\x1b[48;2;0;0;1mO\x1b[0m\x1b[38;2;0;1;0mG\x1b[0m\x1b[48;2;1;0;0mR\x1b[0m'
    );
    expect(cellOf(decoded.cells, 'N').fg).toBe(0x000080);
    expect(cellOf(decoded.cells, 'O').bg).toBe(0x000001);
    expect(cellOf(decoded.cells, 'G').fg).toBe(0x000100);
    expect(cellOf(decoded.cells, 'R').bg).toBe(0x010000);
  });

  it('black is a colour: a row with only a black background is not an empty row', async () => {
    const { decoded } = await snapshotOf('\x1b[38;2;0;0;0mK');
    expect(cellOf(decoded.cells, 'K').fg).toBe(0);

    // The server's terminal has a black default background, so a black background cell is
    // built by hand: value 0 was "no colour" for the encoder and the row went out as empty.
    const row: BufferCell[] = [{ char: ' ', width: 1, bg: 0 }];
    const encoded = (manager as TerminalManager).encodeSnapshot({
      cols: 40,
      rows: 1,
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      cells: [row],
    });
    const cells = decodeBinaryBuffer(new Uint8Array(encoded).buffer).cells;
    expect(cells).toEqual([row]);
    expect(renderLineFromCells(cells[0])).toContain('background-color: rgb(0, 0, 0);');
  });

  it('writes the version, the type bits and three bytes per colour', async () => {
    const { encoded } = await snapshotOf('\x1b[1;3;38;2;0;0;255;48;2;0;0;128mx');
    expect(encoded[2]).toBe(SNAPSHOT_VERSION);
    // 28 bytes of header, row marker 0xfd, a 16-bit cell count, then the cell
    expect([...encoded.subarray(28)]).toEqual([
      0xfd,
      1,
      0,
      CELL_TYPE.EXTENDED | CELL_TYPE.HAS_FG | CELL_TYPE.HAS_BG | CELL_TYPE.CHAR_ASCII,
      'x'.charCodeAt(0),
      CELL_ATTR.BOLD | CELL_ATTR.ITALIC,
      0,
      0,
      255,
      0,
      0,
      128,
    ]);
  });

  it('names every attribute bit the same on both sides', async () => {
    const sgr: [number, keyof typeof CELL_ATTR, string][] = [
      [1, 'BOLD', 'bold'],
      [2, 'DIM', 'dim'],
      [3, 'ITALIC', 'italic'],
      [4, 'UNDERLINE', 'underline'],
      [7, 'INVERSE', 'inverse'],
      [8, 'INVISIBLE', 'invisible'],
      [9, 'STRIKETHROUGH', 'strikethrough'],
    ];
    const output = sgr.map(([code], i) => `\x1b[${code}m${String.fromCharCode(97 + i)}\x1b[0m`);
    const { decoded } = await snapshotOf(output.join(''));
    sgr.forEach(([, bit, name], i) => {
      const cell = cellOf(decoded.cells, String.fromCharCode(97 + i));
      expect(cell.attributes, name).toBe(CELL_ATTR[bit]);
      expect(cellsToText([[cell]], true), name).toBe(`[style ${name}]${cell.char}[/style]`);
    });
  });

  it('refuses a snapshot of another version', async () => {
    const { encoded } = await snapshotOf('x');
    const old = new Uint8Array(encoded);
    old[2] = 0x01;
    expect(() => decodeBinaryBuffer(old.buffer)).toThrow(/version/i);
  });
});
