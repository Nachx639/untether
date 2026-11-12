import { describe, expect, it } from 'vitest';
import {
  orderPoints,
  type SelectionRow,
  screenShift,
  selectionText,
  wordRange,
} from './terminal-touch-select.js';

const cells = (text: string) => Array.from(text);
const row = (text: string, isWrapped = false): SelectionRow => ({ cells: cells(text), isWrapped });

describe('wordRange', () => {
  it('takes paths and URLs whole, without a closing full stop', () => {
    const line = cells('see ~/Projects/app/src/main.ts.');
    expect(wordRange(line, 10)).toEqual({ start: 4, end: 29 });
    const url = cells('open (https://example.com/a?b=1) now');
    expect(wordRange(url, 12)).toEqual({ start: 6, end: 30 });
  });

  it('stops at blanks, quotes and box drawing; a blank cell is just itself', () => {
    const line = cells('│ "hola" mundo │');
    expect(wordRange(line, 4)).toEqual({ start: 3, end: 6 });
    expect(wordRange(line, 1)).toEqual({ start: 1, end: 1 });
    expect(wordRange(line, 40)).toEqual({ start: 40, end: 40 });
  });

  it('keeps a wide character with its second cell', () => {
    // "日本" takes four cells; the second of each is '' in the buffer.
    expect(wordRange(['a', ' ', '日', '', '本', '', ' '], 3)).toEqual({ start: 2, end: 5 });
  });
});

describe('selectionText', () => {
  it('joins soft-wrapped rows and keeps the printed line breaks', () => {
    const rows = [row('linea uno de prueba par'), row('a el arranque   ', true), row('dos   ')];
    expect(selectionText(rows, { col: 6, row: 10 }, { col: 2, row: 12 })).toBe(
      'uno de prueba para el arranque\ndos'
    );
  });

  it('cuts the first and last rows at the selected columns', () => {
    const rows = [row('abcdef'), row('ghijkl')];
    expect(selectionText(rows, { col: 2, row: 0 }, { col: 1, row: 1 })).toBe('cdef\ngh');
    expect(selectionText([row('abcdef')], { col: 1, row: 0 }, { col: 3, row: 0 })).toBe('bcd');
  });

  it('drops the empty second cell of wide characters', () => {
    expect(
      selectionText(
        [{ cells: ['日', '', '本', ''], isWrapped: false }],
        { col: 0, row: 0 },
        { col: 3, row: 0 }
      )
    ).toBe('日本');
  });
});

describe('orderPoints', () => {
  it('puts the earlier point first, whichever end was dragged', () => {
    const a = { col: 5, row: 3 };
    const b = { col: 1, row: 3 };
    expect(orderPoints(a, b)).toEqual([b, a]);
    expect(orderPoints({ col: 0, row: 4 }, a)).toEqual([a, { col: 0, row: 4 }]);
  });
});

describe('screenShift', () => {
  const screen = (...rows: string[]) => rows;

  it('finds how far the text moved when the app scrolls, with a fixed prompt box', () => {
    const before = screen('a uno', 'b dos', 'c tres', 'd cuatro', '────', '❯ ', '────');
    const up2 = screen('c tres', 'd cuatro', 'e cinco', 'f seis', '────', '❯ ', '────');
    expect(screenShift(before, up2)).toBe(2);
    const down1 = screen('z cero', 'a uno', 'b dos', 'c tres', '────', '❯ ', '────');
    expect(screenShift(before, down1)).toBe(-1);
  });

  it('says 0 for the same screen or a new one', () => {
    const before = screen('a uno', 'b dos', 'c tres');
    expect(screenShift(before, before)).toBe(0);
    expect(screenShift(before, screen('x', 'y', 'z'))).toBe(0);
    expect(screenShift(before, screen('', '', ''))).toBe(0);
  });
});
