import { describe, expect, it } from 'vitest';
import {
  fitResultLines,
  resultMismatch,
  saysNoChangeButChanged,
  type TaskResult,
  taskResultErrorMessage,
  taskResultLines,
  validateTaskResult,
  verifiedFromResult,
} from './task-result.js';

const good = {
  outcome: 'done',
  files: [{ path: 'web/src/a.ts', why: 'fix the off-by-one' }],
  tests: [{ command: 'pnpm test', result: 'passed', detail: '212 passed' }],
  risks: [],
  followUps: [],
  measurements: [{ name: 'p95', value: 120, unit: 'ms', before: 180 }],
};

describe('validateTaskResult', () => {
  it('takes a memory note and shows what it is about among the result lines', () => {
    const note = {
      name: 'flaky-check',
      description: ' the check flakes under load ',
      body: '# Why\nload',
    };
    const checked = validateTaskResult({ ...good, memoryNote: note });
    expect(checked).toEqual({
      ok: true,
      result: { ...good, memoryNote: { ...note, description: 'the check flakes under load' } },
    });
    if (!checked.ok) return;
    expect(taskResultLines(checked.result)).toContain(
      'memory note flaky-check: the check flakes under load'
    );
  });

  it('refuses a memory note whose name is no slug, a description of many lines or unknown keys', () => {
    const checked = validateTaskResult({
      ...good,
      memoryNote: { name: '../MEMORY', description: 'a\nb', body: 'x', type: 'project' },
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^result\.memoryNote\.name: a kebab-case slug/),
        'result.memoryNote.description: one line',
        expect.stringMatching(/^result\.memoryNote\.type: unknown key/),
      ])
    );
    expect(validateTaskResult({ ...good, memoryNote: 'remember this' })).toMatchObject({
      ok: false,
      errors: ['result.memoryNote: must be {name, description, body}'],
    });
    expect(
      validateTaskResult({ ...good, memoryNote: { name: 'a', description: 'b' } })
    ).toMatchObject({
      ok: false,
      errors: ['result.memoryNote.body: required'],
    });
  });

  it('takes a complete result, trimmed', () => {
    const checked = validateTaskResult({
      ...good,
      files: [{ path: ' web/src/a.ts ', why: ' fix it ' }],
    });
    expect(checked).toEqual({
      ok: true,
      result: { ...good, files: [{ path: 'web/src/a.ts', why: 'fix it' }] },
    });
  });

  it('names every missing or malformed field by its path', () => {
    const checked = validateTaskResult({
      outcome: 'finished',
      files: [{ path: 'a.ts' }],
      tests: [{ command: 'pnpm test', result: 'ok' }],
      risks: 'none',
      followup: [],
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.errors).toEqual(
      expect.arrayContaining([
        'result.followup: unknown key (allowed: outcome, files, tests, risks, followUps, measurements, memoryNote)',
        'result.outcome: invalid; one of done, partial, blocked, no-change',
        'result.files[0].why: required',
        'result.tests[0].result: invalid; one of passed, failed, skipped',
        'result.risks: must be an array',
        'result.followUps: required (an array, [] when there is none)',
      ])
    );
    const message = taskResultErrorMessage(checked.errors);
    expect(message).toContain("run 'ut task done' again");
    expect(message).toContain('- result.files[0].why: required');
    expect(message).toContain('Example: {"outcome":"done"');
  });

  it('done and partial need files and tests; partial and blocked need a follow-up', () => {
    const errors = (input: object) => {
      const checked = validateTaskResult(input);
      return checked.ok ? [] : checked.errors;
    };
    expect(errors({ ...good, files: [], tests: [] })).toEqual([
      expect.stringContaining('result.files: list every file you changed'),
      expect.stringContaining('result.tests: name the commands you ran'),
    ]);
    expect(errors({ ...good, outcome: 'partial' })).toEqual([
      'result.followUps: outcome partial needs at least one: what is left to do',
    ]);
    // Partial work with nothing changed yet (half an investigation) goes through `ut task done`.
    expect(
      errors({ outcome: 'partial', files: [], tests: [], risks: [], followUps: ['falta medir'] })
    ).toEqual([]);
    expect(
      errors({
        outcome: 'blocked',
        files: [],
        tests: [],
        risks: [],
        followUps: ['need the API key'],
      })
    ).toEqual([]);
    expect(
      errors({ outcome: 'no-change', files: [], tests: [], risks: [], followUps: [] })
    ).toEqual([]);
    expect(errors({ ...good, outcome: 'no-change' })).toEqual([
      'result.files: outcome no-change lists no files (you changed some: outcome done or partial)',
    ]);
    expect(errors({ ...good, measurements: [{ name: 'p95' }] })).toEqual([
      'result.measurements[0].value: required',
    ]);
    expect(errors([])).toEqual(['result: must be a JSON object']);
  });
});

describe('fitResultLines (2026-11-01 review: a cut lost the follow-ups and measurements)', () => {
  it('keeps the follow-ups and measurements of a big result and drops whole file lines, said', () => {
    const big: TaskResult = {
      outcome: 'partial',
      files: Array.from({ length: 200 }, (_, i) => ({
        path: `src/f${i}.ts`,
        why: 'x'.repeat(400),
      })),
      tests: [
        { command: 'pnpm test', result: 'passed' },
        { command: 'pnpm e2e', result: 'failed' },
      ],
      risks: ['r'],
      followUps: ['falta la doc'],
      measurements: [{ name: 'p95', value: 120, unit: 'ms' }],
    };
    const text = fitResultLines(taskResultLines(big), 4000);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('follow-up: falta la doc');
    expect(text).toContain('measurement p95: 120 ms');
    expect(text.split('\n')[4]).toBe('test pnpm e2e: failed');
    expect(text).toMatch(/… and \d+ more lines \(ut task status\)$/);
    expect(fitResultLines(['a', 'b'], 100)).toBe('a\nb');
  });
});

describe('the result against the branch', () => {
  const result = (over: Partial<TaskResult>): TaskResult => ({
    outcome: 'done',
    files: [{ path: 'src/a.ts', why: 'x' }],
    tests: [{ command: 'pnpm test', result: 'passed' }],
    risks: [],
    followUps: [],
    ...over,
  });

  it('says no-change but there is a diff', () => {
    const noChange = result({ outcome: 'no-change', files: [] });
    expect(saysNoChangeButChanged(noChange, true)).toBe(true);
    expect(saysNoChangeButChanged(noChange, false)).toBe(false);
    expect(resultMismatch(noChange, true, ['web/x.ts'])).toBe(
      "The agent's result says no-change, but its branch has changes (web/x.ts)"
    );
    expect(resultMismatch(noChange, false)).toBeUndefined();
  });

  it('lists files but there is no diff, or names other files than the diff', () => {
    expect(resultMismatch(result({}), false)).toBe(
      "The agent's result lists changed files (src/a.ts), but its branch has no change"
    );
    // Named from a subfolder: the same file.
    expect(resultMismatch(result({}), true, ['web/src/a.ts'])).toBeUndefined();
    expect(resultMismatch(result({}), true, ['web/src/a.ts', 'web/src/b.ts'])).toBe(
      "The diff changes files the agent's result does not name: web/src/b.ts"
    );
    expect(resultMismatch(result({}), true, ['web/src/c.ts'])).toBe(
      "The agent's result names files its diff does not change: src/a.ts"
    );
  });

  it('reads glob patterns as patterns over the changed files (2026-11-02, a7e6e180)', () => {
    const diff = ['web/src/a.test.ts', 'web/src/x/b.test.ts', 'web/src/test/helper.ts'];
    const codemod = result({
      files: [{ path: 'web/src/**/*.test.ts and web/src/test/** (146 more files)', why: 'x' }],
    });
    expect(resultMismatch(codemod, true, diff)).toBeUndefined();
    // Each pattern on its own, from the repository root or from web/.
    const split = result({
      files: [
        { path: 'web/src/**/*.test.ts', why: 'x' },
        { path: 'src/test/*', why: 'x' },
      ],
    });
    expect(resultMismatch(split, true, diff)).toBeUndefined();
    expect(
      resultMismatch(result({ files: [{ path: 'web/src/{a,x/b}.test.ts', why: 'x' }] }), true, [
        'web/src/a.test.ts',
        'web/src/x/b.test.ts',
      ])
    ).toBeUndefined();
    expect(
      resultMismatch(result({ files: [{ path: 'web/src/?.test.ts', why: 'x' }] }), true, [
        'web/src/a.test.ts',
      ])
    ).toBeUndefined();
    // A pattern matching no changed file is still a mismatch.
    const wrong = result({ files: [{ path: 'mac/**/*.swift', why: 'x' }] });
    expect(resultMismatch(wrong, true, diff)).toBe(
      "The agent's result names files its diff does not change: mac/**/*.swift"
    );
    // So is one of two patterns in one entry, and a changed file no pattern covers.
    expect(
      resultMismatch(
        result({ files: [{ path: 'web/src/**/*.test.ts and ios/**', why: 'x' }] }),
        true,
        diff
      )
    ).toBe(
      "The agent's result names files its diff does not change: web/src/**/*.test.ts and ios/**"
    );
    expect(
      resultMismatch(result({ files: [{ path: 'web/src/**/*.test.ts', why: 'x' }] }), true, diff)
    ).toBe("The diff changes files the agent's result does not name: web/src/test/helper.ts");
  });

  it('ignores notes and takes a count of files left out of the list', () => {
    const diff = ['web/src/a.ts', 'web/src/b.ts', 'web/src/c.ts'];
    const noted = result({
      files: [
        { path: 'web/src/a.ts (renamed the helper)', why: 'x' },
        { path: 'web/src/b.ts and 1 more', why: 'x' },
      ],
    });
    expect(resultMismatch(noted, true, diff)).toBeUndefined();
    // "(1 more file)" does not cover two unnamed files.
    const short = result({
      files: [
        { path: 'web/src/a.ts', why: 'x' },
        { path: '… (1 more file)', why: 'x' },
      ],
    });
    expect(resultMismatch(short, true, diff)).toBe(
      "The diff changes files the agent's result does not name: web/src/b.ts, web/src/c.ts"
    );
  });

  it('reads ./, ../, absolute, quoted and folder paths as the changed file', () => {
    const diff = ['web/src/a.ts', 'mac/App.swift', 'docs/x/y.md'];
    const forms = result({
      files: [
        { path: './web/src/a.ts', why: 'x' },
        { path: '../mac/App.swift', why: 'x' },
        { path: '`docs/x/`', why: 'x' },
      ],
    });
    expect(resultMismatch(forms, true, diff)).toBeUndefined();
    expect(
      resultMismatch(result({ files: [{ path: '/Users/me/repo/web/src/a.ts', why: 'x' }] }), true, [
        'web/src/a.ts',
      ])
    ).toBeUndefined();
    expect(
      resultMismatch(result({ files: [{ path: './src/a.ts', why: 'x' }] }), true, ['web/src/a.ts'])
    ).toBeUndefined();
    // A path only sharing a suffix with a changed file is not it.
    expect(
      resultMismatch(result({ files: [{ path: 'b/a.ts', why: 'x' }] }), true, ['web/src/a.ts'])
    ).toBe("The agent's result names files its diff does not change: b/a.ts");
  });

  it('keeps paths with spaces whole and every part of a compound entry (review, 2026-11-02)', () => {
    expect(
      resultMismatch(result({ files: [{ path: 'docs/setup guide.md', why: 'x' }] }), true, [
        'docs/setup guide.md',
      ])
    ).toBeUndefined();
    // Dockerfile has no dot or slash, yet it is named and must be in the diff.
    const both = result({ files: [{ path: 'src/a.ts and Dockerfile', why: 'x' }] });
    expect(resultMismatch(both, true, ['web/src/a.ts'])).toBe(
      "The agent's result names files its diff does not change: src/a.ts and Dockerfile"
    );
    expect(resultMismatch(both, true, ['web/src/a.ts', 'Dockerfile'])).toBeUndefined();
    // A file whose name holds " and " is still one file.
    expect(
      resultMismatch(result({ files: [{ path: 'docs/q and a.md', why: 'x' }] }), true, [
        'docs/q and a.md',
      ])
    ).toBeUndefined();
  });

  it('matches bracketed paths literally and never throws on a bad pattern', () => {
    expect(
      resultMismatch(result({ files: [{ path: 'web/app/[slug]/page.tsx', why: 'x' }] }), true, [
        'web/app/[slug]/page.tsx',
      ])
    ).toBeUndefined();
    const bad = result({ files: [{ path: 'src/[z-a].ts', why: 'x' }] });
    expect(resultMismatch(bad, true, ['src/[z-a].ts'])).toBeUndefined();
    expect(resultMismatch(bad, true, ['src/b.ts'])).toBe(
      "The agent's result names files its diff does not change: src/[z-a].ts"
    );
    // A valid class still works as a glob.
    expect(
      resultMismatch(result({ files: [{ path: 'src/[ab].ts', why: 'x' }] }), true, ['src/a.ts'])
    ).toBeUndefined();
  });

  it('takes a renamed file by its old path or as old -> new', () => {
    const renamed = [{ from: 'web/src/old.ts', to: 'web/src/new.ts' }];
    for (const path of [
      'web/src/old.ts',
      'web/src/old.ts -> web/src/new.ts',
      'src/old.ts → src/new.ts',
    ]) {
      expect(
        resultMismatch(result({ files: [{ path, why: 'x' }] }), true, ['web/src/new.ts'], renamed)
      ).toBeUndefined();
    }
    // Without the rename the old path is not in the diff.
    expect(
      resultMismatch(result({ files: [{ path: 'web/src/old.ts', why: 'x' }] }), true, [
        'web/src/new.ts',
      ])
    ).toBe("The agent's result names files its diff does not change: web/src/old.ts");
  });

  it('reads as lines and as the verified text', () => {
    const r = result({
      risks: ['slow on big repos'],
      followUps: ['docs'],
      measurements: [{ name: 'p95', value: 120, unit: 'ms', before: 180 }],
      tests: [{ command: 'pnpm test', result: 'passed', detail: '212 passed' }],
    });
    expect(taskResultLines(r)).toEqual([
      'outcome: done',
      'follow-up: docs',
      'risk: slow on big repos',
      'measurement p95: 180 → 120 ms',
      'test pnpm test: passed (212 passed)',
      'file src/a.ts: x',
    ]);
    expect(verifiedFromResult(r)).toBe('pnpm test: passed (212 passed)');
  });
});
