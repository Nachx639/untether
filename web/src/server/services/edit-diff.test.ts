import { describe, expect, it } from 'vitest';
import { DIFF_FILE, DIFF_GAP, diffForToolUse, diffFromPatch } from './edit-diff';

const edit = (old_string: string, new_string: string) =>
  diffForToolUse('Edit', { file_path: '/x.ts', old_string, new_string });

describe('the change an Edit shows in the phone chat', () => {
  it('marks the changed line with two unchanged lines around it', () => {
    expect(edit('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nD\ne\nf\ng')).toEqual({
      lines: [' b', ' c', '-d', '+D', ' e', ' f'],
      more: 0,
    });
  });

  it('shows an insertion alone, and a long unchanged stretch between two changes as a gap', () => {
    expect(edit('x\ny', 'x\nnew\ny')?.lines).toEqual([' x', '+new', ' y']);
    const old = ['one', '1', '2', '3', '4', '5', '6', 'two'].join('\n');
    const changed = ['ONE', '1', '2', '3', '4', '5', '6', 'TWO'].join('\n');
    expect(edit(old, changed)?.lines).toEqual([
      '-one',
      '+ONE',
      ' 1',
      ' 2',
      DIFF_GAP,
      ' 5',
      ' 6',
      '-two',
      '+TWO',
    ]);
  });

  it('has nothing to show when nothing changed, or for tools that edit no file', () => {
    expect(edit('same\n', 'same\n')).toBeUndefined();
    expect(diffForToolUse('Bash', { command: 'ls' })).toBeUndefined();
    expect(diffForToolUse('Edit', { file_path: '/x.ts' })).toBeUndefined();
  });

  it('keeps a long change short: 40 lines, the rest counted, long lines clipped', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const written = diffForToolUse('Write', { file_path: '/new.ts', content });
    expect(written?.lines).toHaveLength(40);
    expect(written?.lines[0]).toBe('+line 0');
    expect(written?.more).toBe(60);
    const long = edit('short', 'y'.repeat(500))?.lines ?? [];
    expect(long[1]).toHaveLength(201);
    expect(long[1].endsWith('…')).toBe(true);
  });

  it('does not compare huge edits line by line, but still shows their start', () => {
    const many = (prefix: string) =>
      Array.from({ length: 400 }, (_, i) => `${prefix}${i}`).join('\n');
    const diff = edit(many('old'), many('new'));
    expect(diff?.lines[0]).toBe('-old0');
    expect(diff?.more).toBe(800 - 40);
  });

  it('joins the edits of a MultiEdit with a gap', () => {
    const diff = diffForToolUse('MultiEdit', {
      file_path: '/x.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'same', new_string: 'same' },
        { old_string: 'b', new_string: 'B' },
      ],
    });
    expect(diff?.lines).toEqual(['-a', '+A', DIFF_GAP, '-b', '+B']);
  });
});

describe('the change a Codex apply_patch shows', () => {
  it('keeps its signed lines, a gap between hunks and no file line for a single file', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/app.ts',
      '@@ function a()',
      ' keep',
      '-old',
      '+new',
      '@@ function b()',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');
    expect(diffFromPatch(patch)).toEqual({
      lines: [' keep', '-old', '+new', DIFF_GAP, '-x', '+y'],
      more: 0,
    });
  });

  it('names each file when the patch touches several', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+# Title',
      '*** Update File: src/app.ts',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    expect(diffFromPatch(patch)?.lines).toEqual([
      `${DIFF_FILE}docs/new.md`,
      '+# Title',
      `${DIFF_FILE}src/app.ts`,
      '-a',
      '+b',
    ]);
  });

  it('has nothing to show for a patch without changed lines', () => {
    expect(
      diffFromPatch('*** Begin Patch\n*** Delete File: old.ts\n*** End Patch')
    ).toBeUndefined();
  });
});
