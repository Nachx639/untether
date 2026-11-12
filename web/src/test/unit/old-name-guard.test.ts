import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Untether is a fork of VibeTunnel, and its name lived on in the code long after the rename: the
 * terminal elements were <vibe-terminal> and <vibe-terminal-buffer> until 2026-11-11 (now
 * <ut-terminal> and <ut-terminal-buffer>), with some 170 mentions across components, styles,
 * tests, scripts and docs. No tracked text file says "vibe" again, whatever the spelling, except
 * the lines below: history, credits and words that only happen to contain it. An entry that no
 * longer matches anything fails too, so the list can only shrink.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const SELF = 'web/src/test/unit/old-name-guard.test.ts';

const ALLOWED: { file: string; match: RegExp; why: string }[] = [
  {
    file: 'README.md',
    match:
      /fork of \[VibeTunnel\]\(https:\/\/github\.com\/amantus-ai\/vibetunnel\) \(MIT License\)/,
    why: 'credit to the project Untether was forked from',
  },
  {
    file: 'web/README.md',
    match: /you can vibe-code anywhere/,
    why: 'the English verb, not the name',
  },
  {
    file: 'web/src/client/utils/terminal-themes.ts',
    match: /soho vibes/,
    why: "Rosé Pine's own description of its palette",
  },
  {
    file: 'web/src/test/helpers/system-sound-guard.test.ts',
    match: /customVibeDataProvided/,
    why: "a line of macOS's systemsoundserverd log, as it prints it",
  },
];

/** Every tracked line of text that says "vibe": `file`, 1-based `line` and its `text`. */
function mentions(): { file: string; line: number; text: string }[] {
  let output: string;
  try {
    output = execFileSync('git', ['grep', '-I', '-n', '-i', '-e', 'vibe', '--', '.'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
  return output
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [, file, line, text] = row.match(/^([^:]+):(\d+):(.*)$/) ?? [];
      return { file, line: Number(line), text };
    })
    .filter(({ file }) => file !== SELF);
}

describe('the old name', () => {
  it('is in no tracked file or file name, except history and credits', () => {
    const found = mentions();
    const stray = found
      .filter(
        ({ file, text }) => !ALLOWED.some((entry) => entry.file === file && entry.match.test(text))
      )
      .map(({ file, line, text }) => `${file}:${line}: ${text.trim()}`);
    expect(stray).toEqual([]);

    const unused = ALLOWED.filter(
      (entry) => !found.some(({ file, text }) => entry.file === file && entry.match.test(text))
    ).map((entry) => `${entry.file}: ${entry.match}`);
    expect(unused).toEqual([]);

    const names = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => /vibe/i.test(file));
    expect(names).toEqual([]);
  });
});
