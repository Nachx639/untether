/**
 * Every *.test.ts under src runs in `test:client` or `test:server` (2026-11-02: src/test/helpers,
 * src/shared and other src/test folders matched neither mode's include, so CI and the coverage
 * scripts never ran them). The patterns come from test-modes.ts (what vitest.config.ts uses), so this stays right when
 * they change.
 */
import { globSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../../vitest.config';
import { realProcessTests, testModes } from '../test-modes';

const webRoot = fileURLToPath(new URL('../../../', import.meta.url));

type Mode = { include: string[]; exclude: string[] };

function inMode(file: string, mode: Mode): boolean {
  return (
    mode.include.some((pattern) => matchesGlob(file, pattern)) &&
    !mode.exclude.some((pattern) => matchesGlob(file, pattern))
  );
}

function modesOf(file: string): string[] {
  return Object.entries(testModes as Record<string, Mode>)
    .filter(([, mode]) => inMode(file, mode))
    .map(([name]) => name);
}

describe('test modes cover every test file', () => {
  const files = globSync('src/**/*.test.ts', { cwd: webRoot })
    .map((file) => file.split('\\').join('/'))
    .sort();

  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/test/unit/test-modes-cover-all-tests.test.ts');
  });

  it('runs every test file in test:client or test:server', () => {
    const orphans = files.filter((file) => modesOf(file).length === 0);
    expect(orphans, 'move these files or widen testModes in src/test/test-modes.ts').toEqual([]);
  });

  /** vitest.config.ts resolved for `mode`, with `lane` as UNTETHER_TEST_LANE (none: unset). */
  const resolve = (mode: string, lane?: string) => {
    const saved = process.env.UNTETHER_TEST_LANE;
    if (lane === undefined) delete process.env.UNTETHER_TEST_LANE;
    else process.env.UNTETHER_TEST_LANE = lane;
    try {
      return (
        vitestConfig as (env: { mode: string; command: 'serve' }) => {
          test: { include: string[]; exclude: string[]; maxWorkers: number };
        }
      )({ mode, command: 'serve' }).test;
    } finally {
      if (saved === undefined) delete process.env.UNTETHER_TEST_LANE;
      else process.env.UNTETHER_TEST_LANE = saved;
    }
  };

  it('is what vitest.config.ts runs in each mode', () => {
    for (const mode of ['client', 'server'] as const) {
      const resolved = resolve(mode);
      expect(resolved.include).toEqual(testModes[mode].include);
      expect(resolved.exclude).toEqual(expect.arrayContaining(testModes[mode].exclude));
    }
  });

  // 2026-11-02: the real-process files have a lane of their own (test:fast / test:real).
  it('splits a run in two lanes that together run every file once', () => {
    const inConfig = (file: string, test: { include: string[]; exclude: string[] }) =>
      test.include.some((pattern) => matchesGlob(file, pattern)) &&
      !test.exclude.some((pattern) => matchesGlob(file, pattern));
    const all = resolve('test');
    const fast = resolve('test', 'fast');
    const real = resolve('test', 'real');
    for (const file of files) {
      expect(inConfig(file, all), file).toBe(true);
      expect([inConfig(file, fast), inConfig(file, real)].filter(Boolean), file).toHaveLength(1);
    }
    expect(files.filter((file) => inConfig(file, real))).toContain(
      'src/test/e2e/terminal-copy.e2e.test.ts'
    );
    expect(real.maxWorkers).toBeLessThanOrEqual(all.maxWorkers);
  });

  it('tags no real-process pattern that matches no test file', () => {
    const stale = realProcessTests.filter(
      (pattern) => !files.some((file) => matchesGlob(file, pattern))
    );
    expect(stale, 'remove or fix these in realProcessTests (src/test/test-modes.ts)').toEqual([]);
  });

  it('runs no test file in both modes', () => {
    const twice = files.filter((file) => modesOf(file).length > 1);
    expect(twice).toEqual([]);
  });

  it('tells an orphan apart (the helper folder that matched no mode)', () => {
    const before: Mode = {
      include: [
        'src/server/**/*.test.ts',
        'src/test/e2e/**/*.test.ts',
        'src/test/unit/**/*.test.ts',
      ],
      exclude: [],
    };
    expect(inMode('src/test/helpers/run-teardown.test.ts', before)).toBe(false);
    expect(modesOf('src/test/helpers/run-teardown.test.ts')).toEqual(['server']);
    expect(modesOf('src/test/client/components/autocomplete-manager.test.ts')).toEqual(['client']);
  });
});
