import { describe, expect, it } from 'vitest';
import {
  isKnownClaudeMode,
  ModeDebouncer,
  parseClaudeMode,
  readClaudeMode,
} from './claude-mode.js';

describe('parseClaudeMode on torn footer redraws (user report)', () => {
  const footer = (row: string) =>
    ['❯ ', '────────', row, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join(
      '\n'
    );

  it.each([
    '  ◯⏵file-browser-search on (shi▱▱▱▱',
    '  ⏵⏵obypassrpermissions on',
    '  fbypassopermissions on',
  ])('ignores the hybrid row %j and reads the real mode line', (row) => {
    expect(parseClaudeMode(footer(row))).toBe('Bypass permissions');
  });

  it('never reads a workflow name from a hybrid row alone', () => {
    expect(parseClaudeMode('  ◯⏵file-browser-search on (shi▱▱▱▱')).toBeNull();
    expect(parseClaudeMode(' ⏵ file-browser-search on (shi▱▱')).toBeNull();
    expect(parseClaudeMode('  ⏵⏵obypassrpermissions on')).toBeNull();
  });

  it('takes the bottom-most mode line', () => {
    expect(parseClaudeMode('  ⏸ plan mode on\nsome output\n  ⏵⏵ accept edits on')).toBe(
      'Accept edits'
    );
  });

  it('accepts an unknown mode only on a whole mode line', () => {
    expect(parseClaudeMode('  ⏵⏵ dont ask on (shift+tab to cycle)')).toBe('Dont ask');
    expect(parseClaudeMode('  ⏵⏵ dont ask on')).toBeNull();
  });
});

describe('readClaudeMode on torn rows seen in a replay of the session (user report)', () => {
  it.each([
    's ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents9036 · ↓ 6170k3tok',
    '──⏵⏵─bypass─permissions─on (shift+tab─to─cycle)─·─←─for─agents──────',
  ])('still reads the known mode in %j', (row) => {
    expect(readClaudeMode(`❯ \n${row}`)).toBe('Bypass permissions');
  });

  it('says "unreadable", not "no mode", when only a torn mode row is left', () => {
    expect(readClaudeMode('❯ \n  ◯⏵terminal-scroll-flicker(shift▱▱▱▱ 4m39s')).toBeUndefined();
    expect(parseClaudeMode('❯ \n  ◯⏵terminal-scroll-flicker(shift▱▱▱▱ 4m39s')).toBeNull();
  });

  it('says "unreadable" for a screen blanked at the bottom mid-redraw', () => {
    expect(readClaudeMode('⏺ Bash(ls)\n  ⎿  Waiting…\n\n\n\n')).toBeUndefined();
  });

  it('says "no mode" for a screen without any mode line', () => {
    expect(readClaudeMode('$ ls\nfile.txt\n$ ')).toBeNull();
  });
});

describe('isKnownClaudeMode', () => {
  it('knows the shipped modes and not a workflow name', () => {
    expect(isKnownClaudeMode('Bypass permissions')).toBe(true);
    expect(isKnownClaudeMode('Default mode')).toBe(true);
    expect(isKnownClaudeMode('File-browser-search')).toBe(false);
  });
});

describe('ModeDebouncer', () => {
  it('keeps the shown mode on an unreadable read, and a pending change still needs a second', () => {
    const d = new ModeDebouncer('Bypass permissions');
    expect(d.read(undefined)).toBe('Bypass permissions');
    expect(d.read(undefined)).toBe('Bypass permissions');
    expect(d.read('Plan mode')).toBe('Bypass permissions');
    expect(d.read(undefined)).toBe('Bypass permissions');
    expect(d.read('Plan mode')).toBe('Plan mode');
  });

  it('shows the first read at once', () => {
    const d = new ModeDebouncer();
    expect(d.read('Bypass permissions')).toBe('Bypass permissions');
  });

  it('needs two reads in a row to change or hide the mode', () => {
    const d = new ModeDebouncer('Bypass permissions');
    expect(d.read('File-browser-search')).toBe('Bypass permissions');
    expect(d.read('Bypass permissions')).toBe('Bypass permissions');
    expect(d.read(null)).toBe('Bypass permissions');
    expect(d.read('Bypass permissions')).toBe('Bypass permissions');
    expect(d.read('Plan mode')).toBe('Bypass permissions');
    expect(d.read('Plan mode')).toBe('Plan mode');
    expect(d.read(null)).toBe('Plan mode');
    expect(d.read(null)).toBeNull();
  });

  it('takes a value set for sure at once', () => {
    const d = new ModeDebouncer('Bypass permissions');
    d.set('Plan mode');
    expect(d.value).toBe('Plan mode');
  });
});
