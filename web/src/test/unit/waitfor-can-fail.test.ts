import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const SELF = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(SELF), '../..');
const WAIT_FOR = /\bvi\.waitFor\(\s*(?:async\s*)?\(\)\s*=>\s*/g;

function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    // Not this file: its own examples are the pattern it looks for.
    return entry.name.endsWith('.test.ts') && full !== SELF ? [full] : [];
  });
}

/** The vi.waitFor callbacks of `text` that answer with a value instead of throwing. */
function waitsThatCannotFail(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(WAIT_FOR)) {
    const start = match.index + match[0].length;
    const lineOf = () => text.slice(0, match.index).split('\n').length;
    if (text[start] === '{') {
      let depth = 1;
      let at = start + 1;
      while (at < text.length && depth > 0) {
        if (text[at] === '{') depth++;
        else if (text[at] === '}') depth--;
        at++;
      }
      const body = text.slice(start + 1, at - 1);
      if (/\breturn\b/.test(body) && !/\bexpect\(|\bthrow\b/.test(body)) lines.push(lineOf());
    } else {
      const expression = text.slice(start).split('\n')[0];
      if (/^[^(]*(?:>=|<=|===|!==|>|<)/.test(expression) && !/\bexpect\(/.test(expression)) {
        lines.push(lineOf());
      }
    }
  }
  return lines;
}

/**
 * vi.waitFor retries only when its callback throws: one that returns false counts as done at
 * once (2026-11-09: logger.test.ts failed under load, its waits for fetches never waited).
 */
describe('vi.waitFor callbacks', () => {
  it('can fail: they use expect or throw', () => {
    const found = testFiles(SRC).flatMap((file) =>
      waitsThatCannotFail(fs.readFileSync(file, 'utf8')).map(
        (line) => `${path.relative(SRC, file)}:${line}`
      )
    );
    expect(found).toEqual([]);
  });

  it('tells a wait that cannot fail from one that can', () => {
    const cannot = 'await vi.waitFor(\n  () => {\n    return calls.length >= 1;\n  },\n);';
    const can = 'await vi.waitFor(() => {\n  expect(calls.length).toBe(1);\n});';
    const compare = 'await vi.waitFor(() => calls.length >= 1);';
    expect(waitsThatCannotFail(cannot)).toEqual([1]);
    expect(waitsThatCannotFail(compare)).toEqual([1]);
    expect(waitsThatCannotFail(can)).toEqual([]);
  });
});
