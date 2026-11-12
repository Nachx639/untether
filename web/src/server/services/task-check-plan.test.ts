import { describe, expect, it } from 'vitest';
import { planTaskCheck } from './task-verify.js';

/**
 * 2026-11-02: every task ran Untether's whole check (pnpm run check and ~6900 tests): the main
 * cost per task and the main source of load flakes. A two-level project runs the fast check and
 * only the related tests per task, and the whole one when the related set can't be computed.
 */
describe('planTaskCheck (two-level checks)', () => {
  const wt = '/wt/untether';
  const settings = {
    fastCheckCommand: 'cd web && pnpm run check',
    relatedTestCommand: 'cd web && pnpm exec vitest related {files} --run --passWithNoTests',
    relatedTestFiles: '^web/.*\\.(ts|tsx|js|mjs)$',
  };
  const all = () => true;

  it('is off without relatedTestCommand', () => {
    expect(planTaskCheck({}, wt, ['web/src/a.ts'], { exists: all })).toBeNull();
  });

  it('runs the fast check, then the related tests of the changed files (absolute, quoted)', () => {
    const plan = planTaskCheck(settings, wt, ['web/src/a.ts', "web/src/it's.ts", 'docs/x.md'], {
      exists: all,
    });
    expect(plan).toEqual({
      level: 'related',
      files: ['web/src/a.ts', "web/src/it's.ts"],
      command:
        "(cd web && pnpm run check) && (cd web && pnpm exec vitest related /wt/untether/web/src/a.ts '/wt/untether/web/src/it'\\''s.ts' --run --passWithNoTests)",
    });
  });

  it('without a fast check runs only the related tests', () => {
    const plan = planTaskCheck(
      { relatedTestCommand: 'vitest related {files} --run' },
      wt,
      ['a.ts'],
      {
        exists: all,
      }
    );
    expect(plan).toMatchObject({
      level: 'related',
      command: 'vitest related /wt/untether/a.ts --run',
    });
  });

  it.each([
    ['web/package.json', 'reaches tests'],
    ['web/pnpm-lock.yaml', 'reaches tests'],
    ['web/vitest.config.ts', 'reaches tests'],
    ['web/tsconfig.server.json', 'reaches tests'],
    ['web/src/test/setup.ts', 'reaches tests'],
    ['web/src/test/helpers/rm-test-dir.ts', 'reaches tests'],
    ['web/src/test/loopback-servers.ts', 'reaches tests'],
    ['web/src/types/globals.d.ts', 'reaches tests'],
    ['mac/Untether/App.swift', 'not a file the related tests judge'],
    ['web/scripts/check-all.sh', 'not a file the related tests judge'],
  ])('falls back to the whole check for %s', (file, reason) => {
    const plan = planTaskCheck(settings, wt, ['web/src/a.ts', file], { exists: all });
    expect(plan?.level).toBe('full');
    expect(plan && 'reason' in plan ? plan.reason : '').toContain(reason);
  });

  it('a test file itself is related, not a helper', () => {
    for (const file of [
      'web/src/test/unit/foo.test.ts',
      'web/src/server/services/task-guard-setup.ts',
    ]) {
      expect(planTaskCheck(settings, wt, [file], { exists: all })?.level).toBe('related');
    }
  });

  it('falls back on a deleted or renamed file, too many files, or no code at all', () => {
    expect(planTaskCheck(settings, wt, ['web/src/a.ts'], { exists: () => false })).toMatchObject({
      level: 'full',
      reason: 'web/src/a.ts was deleted',
    });
    expect(
      planTaskCheck(settings, wt, ['web/src/a.ts'], { exists: all, renamed: 1 })
    ).toMatchObject({ level: 'full', reason: 'a file was renamed' });
    const many = Array.from({ length: 41 }, (_, i) => `web/src/f${i}.ts`);
    expect(planTaskCheck(settings, wt, many, { exists: all })).toMatchObject({
      level: 'full',
      reason: '41 files changed (over 40)',
    });
    expect(
      planTaskCheck({ ...settings, relatedMaxFiles: 50 }, wt, many, { exists: all })?.level
    ).toBe('related');
    expect(planTaskCheck(settings, wt, ['README.md'], { exists: all })).toMatchObject({
      level: 'full',
      reason: 'no code file changed',
    });
  });

  it('the project can name its own whole-check paths', () => {
    const plan = planTaskCheck(
      { ...settings, relatedFullPaths: '^web/src/server/server\\.ts$' },
      wt,
      ['web/src/server/server.ts'],
      { exists: all }
    );
    expect(plan?.level).toBe('full');
    // Its own list replaces the default one.
    expect(
      planTaskCheck({ ...settings, relatedFullPaths: '^nothing$' }, wt, ['web/src/test/setup.ts'], {
        exists: all,
      })?.level
    ).toBe('related');
  });
});
