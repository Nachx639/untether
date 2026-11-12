import { describe, expect, it } from 'vitest';
import {
  arrowKeys,
  type PromptRowCells,
  planPromptCaret,
  promptCharacterSteps,
} from './prompt-caret';

const WIDE = /[\u{1F300}-\u{1FAFF}一-鿿]/u;

/** Rows as a terminal holds them: a wide character takes its cell and a '' after it. */
function screen(rows: string[], cols = 40): (row: number) => PromptRowCells | null {
  const grid = rows.map((text) => {
    const cells: PromptRowCells = [];
    for (const ch of text) {
      cells.push(ch);
      if (WIDE.test(ch)) cells.push('');
    }
    while (cells.length < cols) cells.push(' ');
    return cells;
  });
  return (row) => grid[row] ?? null;
}

const RULE = '─'.repeat(40);

// Claude Code 2.1 classic renderer at 40 columns, as captured: the input wraps with a two-space
// indent and the cursor sits on the caret.
const wrapped = screen([
  '⏺ earlier output',
  '',
  RULE,
  '❯ uno dos tres cuatro cinco seis siete',
  '  ocho nueve diez once doce trece',
  '  catorce quince dieciseis diecisiete',
  RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
]);

describe('planPromptCaret', () => {
  it('moves along a one-row prompt', () => {
    const read = screen([RULE, '❯ hola mundo', RULE]);
    const plan = planPromptCaret(read, { row: 1, col: 12 }, { row: 1, col: 7 });
    expect(plan).toEqual({ first: 1, last: 1, target: { row: 1, col: 7 }, rows: 0 });
    expect(promptCharacterSteps(read(1) ?? [], 12, 7)).toBe(-5);
  });

  it('moves up and down the rows of a wrapped prompt, inside its rules only', () => {
    // Caret at the end of the last row, tap on "cinco" in the first.
    const plan = planPromptCaret(wrapped, { row: 5, col: 37 }, { row: 3, col: 22 });
    expect(plan).toEqual({ first: 3, last: 5, target: { row: 3, col: 22 }, rows: -2 });
    expect(planPromptCaret(wrapped, { row: 3, col: 5 }, { row: 4, col: 5 })?.rows).toBe(1);
  });

  it('keeps the caret after the marker and no further than just past the text', () => {
    expect(planPromptCaret(wrapped, { row: 4, col: 10 }, { row: 3, col: 0 })?.target).toEqual({
      row: 3,
      col: 2,
    });
    expect(planPromptCaret(wrapped, { row: 4, col: 10 }, { row: 4, col: 39 })?.target).toEqual({
      row: 4,
      col: 33,
    });
    // An empty prompt (a dim placeholder reads as empty cells).
    const empty = screen([RULE, '❯ ', RULE]);
    expect(planPromptCaret(empty, { row: 1, col: 2 }, { row: 1, col: 20 })?.target.col).toBe(2);
  });

  it('counts characters, not cells, past emoji and CJK', () => {
    const read = screen([RULE, '❯ a😀b漢c', RULE]);
    // Cells: ❯ ' ' a 😀 '' b 漢 '' c → the caret at the end is col 9.
    const plan = planPromptCaret(read, { row: 1, col: 9 }, { row: 1, col: 3 });
    expect(plan?.target.col).toBe(3);
    expect(promptCharacterSteps(read(1) ?? [], 9, 3)).toBe(-4);
    // A tap between a wide character's halves goes before it.
    expect(planPromptCaret(read, { row: 1, col: 9 }, { row: 1, col: 4 })?.target.col).toBe(3);
    expect(promptCharacterSteps(read(1) ?? [], 3, 9)).toBe(4);
  });

  it('leaves taps outside the input rows alone', () => {
    expect(planPromptCaret(wrapped, { row: 5, col: 37 }, { row: 2, col: 5 })).toBeNull();
    expect(planPromptCaret(wrapped, { row: 5, col: 37 }, { row: 0, col: 3 })).toBeNull();
    expect(planPromptCaret(wrapped, { row: 5, col: 37 }, { row: 7, col: 3 })).toBeNull();
  });

  it('does nothing without both rules or the prompt marker (a shell, a menu)', () => {
    const shell = screen(['~/src ❯ ls', 'a b c', '~/src ❯ git st']);
    expect(planPromptCaret(shell, { row: 2, col: 14 }, { row: 2, col: 9 })).toBeNull();
    const noBottom = screen([RULE, '❯ hola', '']);
    expect(planPromptCaret(noBottom, { row: 1, col: 6 }, { row: 1, col: 3 })).toBeNull();
    const menu = screen([
      RULE,
      ' Make auto mode your default?',
      '',
      '   ❯ Yes, set auto mode as my default',
      '     No, keep bypass permissions',
      '',
    ]);
    expect(planPromptCaret(menu, { row: 3, col: 3 }, { row: 4, col: 8 })).toBeNull();
    // Rows between rules that are not the prompt's indented continuation.
    const notPrompt = screen([RULE, '❯ hola', 'Tip: something else', RULE]);
    expect(planPromptCaret(notPrompt, { row: 1, col: 6 }, { row: 1, col: 3 })).toBeNull();
  });

  it('does nothing with the cursor on a rule', () => {
    const read = screen([RULE, '❯ hola', RULE]);
    expect(planPromptCaret(read, { row: 0, col: 0 }, { row: 1, col: 3 })).toBeNull();
  });
});

describe('arrowKeys', () => {
  it('encodes CSI or, with application cursor keys, SS3', () => {
    expect(arrowKeys('up', 2, false)).toBe('\x1b[A\x1b[A');
    expect(arrowKeys('left', 1, true)).toBe('\x1bOD');
    expect(arrowKeys('right', 0, false)).toBe('');
  });
});
