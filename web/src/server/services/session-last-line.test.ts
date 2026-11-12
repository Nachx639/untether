import { describe, expect, it, vi } from 'vitest';
import {
  createLastLineReader,
  extractLastLine,
  LAST_LINE_MAX_LENGTH,
} from './session-last-line.js';

describe('extractLastLine', () => {
  it.each([
    ['bash', 'alice@mac:~/src$ ls\nREADME.md  src\nalice@mac:~/src$ '],
    ['zsh', 'mac% ls\nREADME.md  src\nalice@mac ~/src % '],
    ['root', '# ls\nREADME.md  src\nroot@box:/# '],
    ['fish', '~/src> ls\nREADME.md  src\n~/src> '],
    ['powerline', ' ~/src  main ❯ ls\nREADME.md  src\n ~/src  main ❯ █'],
    ['codex-style', '› ls\nREADME.md  src\n›'],
  ])('skips a trailing %s prompt', (_shell, screen) => {
    expect(extractLastLine(screen)).toBe('README.md src');
  });

  it('keeps output that is still streaming', () => {
    expect(extractLastLine('$ npm test\n✓ 12 passed\nRunning suite 3')).toBe('Running suite 3');
  });

  it('does not take progress percentages for a prompt', () => {
    expect(extractLastLine('$ curl -O file\nDownloading 42%\n')).toBe('Downloading 42%');
  });

  it('strips ANSI escapes and collapses spaces', () => {
    expect(extractLastLine('\u001b[32mok\u001b[0m    done\t\there\u001b]0;title\u0007\n$ ')).toBe(
      'ok done here'
    );
  });

  it('returns undefined for empty screens and screens with only prompts', () => {
    expect(extractLastLine('')).toBeUndefined();
    expect(extractLastLine('\n   \n\n')).toBeUndefined();
    expect(extractLastLine('$ \n\n$ \n')).toBeUndefined();
  });

  it('caps long lines with an ellipsis', () => {
    const line = extractLastLine(`${'x'.repeat(300)}\n$ `);
    expect(line).toHaveLength(LAST_LINE_MAX_LENGTH);
    expect(line?.endsWith('…')).toBe(true);
  });
});

describe('createLastLineReader', () => {
  function setup(screen = 'hello\n$ ') {
    let time = 0;
    const state = { count: undefined as number | undefined, cheap: true, screen };
    const readScreenText = vi.fn(async () => {
      state.count ??= 0;
      return state.screen;
    });
    const reader = createLastLineReader(
      {
        canSnapshotCheaply: () => state.cheap,
        getChangeCount: () => state.count,
        readScreenText,
      },
      { now: () => time }
    );
    return { reader, state, readScreenText, advance: (ms: number) => (time += ms) };
  }

  it('does not re-read an unchanged screen', async () => {
    const { reader, readScreenText, advance } = setup();
    expect(await reader.get('s1')).toBe('hello');
    advance(60_000);
    expect(await reader.get('s1')).toBe('hello');
    expect(readScreenText).toHaveBeenCalledTimes(1);
  });

  it('re-reads a changed screen at most every 2 s', async () => {
    const { reader, state, readScreenText, advance } = setup();
    await reader.get('s1');
    state.screen = 'world\n$ ';
    state.count = 1;
    advance(1000);
    expect(await reader.get('s1')).toBe('hello');
    advance(1000);
    expect(await reader.get('s1')).toBe('world');
    expect(readScreenText).toHaveBeenCalledTimes(2);
  });

  it("doesn't rebuild a closed idle terminal while its output file hasn't changed", async () => {
    let time = 0;
    let count: number | undefined = 0;
    let modified = 0;
    const readScreenText = vi.fn(async () => 'hello\n$ ');
    const reader = createLastLineReader(
      {
        canSnapshotCheaply: () => true,
        getChangeCount: () => count,
        outputModifiedAt: () => modified,
        readScreenText,
      },
      { now: () => time }
    );
    await reader.get('s1');
    count = undefined; // the idle terminal was closed by the 5-minute cleanup
    time += 600_000;
    await reader.get('s1');
    expect(readScreenText).toHaveBeenCalledTimes(1);
    modified = time + 1; // new output arrived
    time += 10;
    await reader.get('s1');
    expect(readScreenText).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent polls', async () => {
    const { reader, readScreenText } = setup();
    const results = await Promise.all([reader.get('s1'), reader.get('s1'), reader.get('s1')]);
    expect(results).toEqual(['hello', 'hello', 'hello']);
    expect(readScreenText).toHaveBeenCalledTimes(1);
  });

  it('never reads a screen that is costly to replay', async () => {
    const { reader, state, readScreenText } = setup();
    state.cheap = false;
    expect(await reader.get('s1')).toBeUndefined();
    expect(readScreenText).not.toHaveBeenCalled();
  });

  it('keeps the previous line when a read fails', async () => {
    const { reader, state, readScreenText, advance } = setup();
    await reader.get('s1');
    state.count = 5;
    advance(3000);
    readScreenText.mockRejectedValueOnce(new Error('gone'));
    expect(await reader.get('s1')).toBe('hello');
  });
});
