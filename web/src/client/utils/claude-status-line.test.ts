import { describe, expect, it } from 'vitest';
import { compactStatusSegments, parseClaudeStatusLine } from './claude-status-line.js';

const box = (below: string[]) =>
  [
    '⏺ Done. The file is in the folder.',
    '',
    '✻ Baked for 4s · done 1:07 PM',
    '────────────────────────────── my-project ─',
    '❯ ',
    '────────────────────────────────────────────',
    ...below,
    '',
  ].join('\n');

describe('parseClaudeStatusLine', () => {
  it('reads the lines under the prompt box: a status line command and the mode line', () => {
    expect(
      parseClaudeStatusLine(
        box([
          '  Opus 5.5  ·  5h 5% (resets 22:30)  ·  week 16% …',
          '  ⏵⏵ bypass permissions on · 1 shell',
        ])
      )
    ).toEqual([
      'Opus 5.5  ·  5h 5% (resets 22:30)  ·  week 16% …',
      '⏵⏵ bypass permissions on · 1 shell',
    ]);
  });

  it('takes just the mode line when there is no status line command', () => {
    expect(parseClaudeStatusLine(box(['  ⏸ plan mode on (shift+tab to cycle)']))).toEqual([
      '⏸ plan mode on (shift+tab to cycle)',
    ]);
  });

  it('sees a prompt with text in it, over several lines', () => {
    const screen = [
      '─────────────────────────────',
      '❯ add a pricing section after',
      '  the features',
      '─────────────────────────────',
      '  Sonnet · ctx 40%',
    ].join('\n');
    expect(parseClaudeStatusLine(screen)).toEqual(['Sonnet · ctx 40%']);
  });

  it('finds nothing without a prompt box (a permission dialog, a plain shell)', () => {
    expect(
      parseClaudeStatusLine(
        [
          '──────────────────────────────',
          ' Do you want to proceed?',
          ' ❯ 1. Yes',
          '   2. No',
          ' Esc to cancel',
        ].join('\n')
      )
    ).toEqual([]);
    expect(parseClaudeStatusLine('ada@studio ~/nebula ❯ ls\nREADME.md\n')).toEqual([]);
    expect(parseClaudeStatusLine('')).toEqual([]);
  });

  it('keeps at most four lines', () => {
    expect(parseClaudeStatusLine(box(['a', 'b', 'c', 'd', 'e', 'f']))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('compactStatusSegments', () => {
  it('splits a usage status line into chips and drops what the mode chip already shows', () => {
    expect(
      compactStatusSegments([
        'Opus 5.5 · 5h 7% (reinicia 22:30) · semana 17% (reinicia vie…',
        '►► bypass permissions on · 1 shell',
      ])
    ).toEqual([
      { text: 'Opus 5.5', reset: undefined },
      { text: '5h', percent: 7, reset: '22:30' },
      { text: 'semana', percent: 17, reset: undefined },
      { text: '1 shell', reset: undefined },
    ]);
  });

  it('drops pieces the terminal cut off and key hints', () => {
    expect(
      compactStatusSegments([
        'Opus 5.5 · week 16% (resets Fri 12:00) · cont…',
        '⏸ manual mode on · ← for agents',
      ])
    ).toEqual([
      { text: 'Opus 5.5', reset: undefined },
      { text: 'week', percent: 16, reset: 'Fri 12:00' },
    ]);
    expect(compactStatusSegments(['⏸ plan mode on (shift+tab to cycle)'])).toEqual([]);
  });
});

describe('status lines wrapped by a narrow terminal', () => {
  // 40 columns (an iPhone SE in portrait): Claude Code's status line goes over two rows.
  const narrow = [
    '⏺ Done.',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  Opus 5.5 · 5h 17% (resets 22:30) · wee',
    'k 16% (resets Fri 12:00)',
    '  ⏵⏵ bypass permissions on · 1 shell',
    '',
  ];

  it('joins the soft-wrapped rows back with the terminal flags', () => {
    const wrappedRows = narrow.map((_, i) => i === 5);
    expect(parseClaudeStatusLine(narrow.join('\n'), { cols: 40, wrappedRows })).toEqual([
      'Opus 5.5 · 5h 17% (resets 22:30) · week 16% (resets Fri 12:00)',
      '⏵⏵ bypass permissions on · 1 shell',
    ]);
  });

  it('joins them by their look without the flags (a row at the left edge goes on)', () => {
    const lines = parseClaudeStatusLine(narrow.join('\n'));
    expect(lines).toEqual([
      'Opus 5.5 · 5h 17% (resets 22:30) · week 16% (resets Fri 12:00)',
      '⏵⏵ bypass permissions on · 1 shell',
    ]);
    expect(compactStatusSegments(lines)).toEqual([
      { text: 'Opus 5.5', reset: undefined },
      { text: '5h', percent: 17, reset: '22:30' },
      { text: 'week', percent: 16, reset: 'Fri 12:00' },
      { text: '1 shell', reset: undefined },
    ]);
  });

  it('keeps "(resets …)" with its percentage when the wrap falls inside it', () => {
    const screen = [
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  Opus 5.5 · 5h 7% (rese',
      'ts 22:30) · week 16%',
    ].join('\n');
    const lines = parseClaudeStatusLine(screen);
    expect(lines).toEqual(['Opus 5.5 · 5h 7% (resets 22:30) · week 16%']);
    expect(compactStatusSegments(lines).map((s) => s.reset)).toEqual([
      undefined,
      '22:30',
      undefined,
    ]);
  });

  it('a row starting with ")" goes on from the one above, never an orphan chip', () => {
    const screen = [
      '──────────────────────────────',
      '❯ ',
      '──────────────────────────────',
      'Opus 5.5 · 5h 7% (resets 22:30',
      ') · week 16%',
    ].join('\n');
    const lines = parseClaudeStatusLine(screen);
    expect(lines).toEqual(['Opus 5.5 · 5h 7% (resets 22:30) · week 16%']);
    expect(compactStatusSegments(lines).some((s) => s.text.includes(')'))).toBe(false);
  });

  it('drops a wrapped border: rows that are only box-drawing characters', () => {
    const screen = [
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '──',
      '  Sonnet · ctx 40%',
      '╯',
    ].join('\n');
    expect(parseClaudeStatusLine(screen)).toEqual(['Sonnet · ctx 40%']);
    const wrappedRows = [false, false, false, true, false, false];
    expect(parseClaudeStatusLine(screen, { cols: 40, wrappedRows })).toEqual(['Sonnet · ctx 40%']);
  });

  it('never makes a chip of a border or a lone bracket', () => {
    expect(compactStatusSegments(['———— · Opus 5.5 · ) · 22:30) · ctx 40%'])).toEqual([
      { text: 'Opus 5.5', reset: undefined },
      { text: 'ctx', percent: 40, reset: undefined },
    ]);
  });
});
