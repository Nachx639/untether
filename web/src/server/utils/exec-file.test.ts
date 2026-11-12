import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { isSafeRefName, run } from './exec-file.js';

/** What git itself says about a branch name. */
function gitAllows(name: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('isSafeRefName', () => {
  it('takes what git takes (2026-10-20: non-ASCII, + and @ were refused)', () => {
    for (const name of [
      'main',
      'feature/añadir-login',
      'fix+1',
      'user@x',
      'release/1.2',
      'ut/arregla-los-tests-b',
      '日本語',
    ]) {
      expect(isSafeRefName(name), name).toBe(true);
      expect(gitAllows(name), name).toBe(true);
    }
  });

  it('refuses what git refuses, and a leading dash', () => {
    for (const name of [
      '',
      '-main',
      '--upload-pack=x',
      'a..b',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[b',
      'a\\b',
      'a@{1}',
      '@',
      '/a',
      'a/',
      'a//b',
      'a.',
      'a.lock',
      'a/.hidden',
      'a/b.lock/c',
      'tab\there',
      'main;rm',
      'a$(x)',
      'a`x`',
      "a'b",
      'a|b',
      'a&b',
      'x'.repeat(201),
    ]) {
      expect(isSafeRefName(name), JSON.stringify(name)).toBe(false);
    }
    for (const name of ['a..b', 'a b', 'a~1', 'a@{1}', 'a.lock', 'a/.hidden', 'a.']) {
      expect(gitAllows(name), name).toBe(false);
    }
    expect(isSafeRefName(undefined)).toBe(false);
  });
});

describe('run', () => {
  it('output past the limit comes back as its start, marked truncated (2026-11-10)', async () => {
    const result = await run(
      process.execPath,
      [
        '-e',
        "const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 20 * 1024; i++) process.stdout.write(line);",
      ],
      process.cwd(),
      30_000
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(8 * 1024 * 1024);
    expect(result.stdout.startsWith('xxx')).toBe(true);
  });
});
