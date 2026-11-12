import { describe, expect, it } from 'vitest';
import { generateCommitMessage } from './commit-message.js';

describe('generateCommitMessage', () => {
  it('names a single file with a verb from its status and a scope from its folder', () => {
    expect(generateCommitMessage([{ path: 'web/src/server/routes/git.ts', status: 'M' }])).toBe(
      'fix(routes): update git.ts'
    );
    expect(generateCommitMessage([{ path: 'src/new-thing.ts', status: '??' }])).toBe(
      'feat: add new-thing.ts'
    );
    expect(generateCommitMessage([{ path: 'old.ts', status: 'D' }])).toBe('chore: remove old.ts');
    expect(generateCommitMessage([{ path: 'b.ts', oldPath: 'a.ts', status: 'R' }])).toBe(
      'refactor: rename a.ts to b.ts'
    );
  });

  it('guesses docs, test, ci and build from paths', () => {
    expect(generateCommitMessage([{ path: 'README.md', status: 'M' }])).toMatch(/^docs: /);
    expect(
      generateCommitMessage([
        { path: 'web/src/a.test.ts', status: 'M' },
        { path: 'web/src/b.test.ts', status: 'A' },
      ])
    ).toMatch(/^test\(web\): /);
    expect(generateCommitMessage([{ path: '.github/workflows/ci.yml', status: 'M' }])).toBe(
      'ci(workflows): update ci.yml'
    );
    expect(
      generateCommitMessage([
        { path: 'package.json', status: 'M' },
        { path: 'pnpm-lock.yaml', status: 'M' },
      ])
    ).toMatch(/^build: update package\.json, pnpm-lock\.yaml/);
  });

  it('lists the files in the body when there are several', () => {
    expect(
      generateCommitMessage([
        { path: 'app/x/a.ts', status: 'M' },
        { path: 'app/x/b.ts', status: 'A' },
        { path: 'app/x/c.ts', status: 'M' },
        { path: 'app/x/d.ts', status: 'D' },
      ])
    ).toBe(
      'feat(x): update 4 files\n\n- app/x/a.ts (modified)\n- app/x/b.ts (added)\n- app/x/c.ts (modified)\n- app/x/d.ts (deleted)'
    );
    expect(generateCommitMessage([])).toBe('');
  });
});
