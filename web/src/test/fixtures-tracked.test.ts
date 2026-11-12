/**
 * Guard, 2026-11-11: a task created a fixture under src/test/fixtures/, web/.gitignore ignored it
 * (`*.cast`), the check passed in its worktree, the merge left the file behind and the base went
 * red with ENOENT. A file under any `fixtures/` folder that git ignores exists only here.
 * Fix it with an exception in .gitignore (`!path/to/fixtures/**`) and `git add`, or delete it.
 */
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

describe('fixtures travel with the repository', () => {
  it('no file under a fixtures/ folder is ignored by git', () => {
    const top = git(__dirname, 'rev-parse', '--show-toplevel').trim();
    const ignored = git(
      top,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z'
    )
      .split('\0')
      .filter(Boolean)
      .filter((file) => !file.split('/').includes('node_modules'))
      .filter((file) => file.split('/').includes('fixtures'));
    expect(
      ignored,
      'These fixtures exist on disk but git ignores them, so they never reach the merge: ' +
        'add an exception to .gitignore and `git add` them, or delete them'
    ).toEqual([]);
  });
});
