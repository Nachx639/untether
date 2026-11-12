import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { getChanges, getFileDiff, MAX_DIFF_BYTES, safeRepoRelative } from './git-changes';

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

describe('git changes', () => {
  let repo: string;
  // 2026-11-02: the committed repo is built once per file and copied into each test's folder
  // (3 git processes per test became 0). A repo without worktrees or remotes holds no absolute
  // paths, so the copy is the same state.
  let template: string;

  beforeAll(() => {
    template = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-changes-template-')));
    git(template, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(template, 'keep.txt'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(template, 'gone.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(template, 'old-name.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    fs.mkdirSync(path.join(template, 'src'));
    fs.writeFileSync(path.join(template, 'src', 'unchanged.ts'), 'export {};\n');
    git(template, 'add', '.');
    git(template, 'commit', '-q', '-m', 'init');
  });

  afterAll(() => {
    fs.rmSync(template, RM_TEST_DIR);
  });

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-changes-')));
    fs.cpSync(template, repo, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, RM_TEST_DIR);
  });

  it('lists modified, deleted, renamed, staged-added and untracked files with counts', async () => {
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nB\nc\nd\n');
    fs.rmSync(path.join(repo, 'gone.txt'));
    git(repo, 'mv', 'old-name.txt', 'new-name.txt');
    fs.writeFileSync(path.join(repo, 'staged.txt'), '1\n2\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'src', 'new file.ts'), 'l1\nl2\nl3');
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0]));

    const result = await getChanges(path.join(repo, 'src'));
    expect(result.isGitRepo).toBe(true);
    expect(result.repoPath).toBe(repo);
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    expect(byPath['keep.txt']).toMatchObject({ status: 'M', additions: 2, deletions: 1 });
    expect(byPath['gone.txt']).toMatchObject({ status: 'D', additions: 0, deletions: 2 });
    expect(byPath['new-name.txt']).toMatchObject({ status: 'R', oldPath: 'old-name.txt' });
    expect(byPath['staged.txt']).toMatchObject({ status: 'A', additions: 2 });
    expect(byPath['src/new file.ts']).toMatchObject({ status: '??', additions: 3, binary: false });
    expect(byPath['blob.bin']).toMatchObject({ status: '??', binary: true, additions: 0 });
    expect(result.totals).toEqual({ files: 6, additions: 7, deletions: 3 });
  });

  it('lists a wholly untracked folder (a stray node_modules) as one entry', async () => {
    const deps = path.join(repo, 'node_modules', 'pkg');
    fs.mkdirSync(deps, { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(deps, `f${i}.js`), 'x\n');

    const result = await getChanges(repo);
    const untracked = result.files.filter((f) => f.status === '??').map((f) => f.path);
    expect(untracked).toEqual(['node_modules/']);
  });

  it('counts a task branch from where it left its base (since), commits included', async () => {
    git(repo, 'checkout', '-q', '-b', 'ut/task');
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nb\nc\nd\n');
    git(repo, 'commit', '-q', '-am', 'task work');
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'w\n');
    // The base moved on meanwhile: its commit is not the task's change.
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'base.txt'), 'b\n');
    git(repo, 'add', 'base.txt');
    git(repo, 'commit', '-q', '-m', 'base moved');
    git(repo, 'checkout', '-q', 'ut/task');

    expect((await getChanges(repo)).files.map((f) => f.path)).toEqual(['wip.txt']);
    const result = await getChanges(repo, 'main');
    expect(result.files.map((f) => f.path)).toEqual(['keep.txt', 'wip.txt']);
    expect((await getFileDiff(repo, 'keep.txt', undefined, 'main')).diff).toContain('+d');
    // An unknown ref counts from HEAD as before.
    expect((await getChanges(repo, 'no-such-branch')).files.map((f) => f.path)).toEqual([
      'wip.txt',
    ]);
  });

  it('accepts real files whose names start with two dots', () => {
    expect(safeRepoRelative(repo, '..env')).toBe('..env');
    expect(safeRepoRelative(repo, '../outside')).toBeNull();
  });

  it('reports a clean repo and a non-repo', async () => {
    expect((await getChanges(repo)).totals.files).toBe(0);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-plain-'));
    try {
      expect((await getChanges(plain)).isGitRepo).toBe(false);
    } finally {
      fs.rmSync(plain, RM_TEST_DIR);
    }
  });

  it('returns a unified diff for a tracked file', async () => {
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'a\nB\nc\n');
    const d = await getFileDiff(repo, 'keep.txt');
    expect(d).toMatchObject({
      file: 'keep.txt',
      binary: false,
      truncated: false,
      untracked: false,
    });
    expect(d.diff).toContain('@@ -1,3 +1,3 @@');
    expect(d.diff).toContain('-b\n+B\n');
  });

  it('shows an untracked file as all added and flags binaries', async () => {
    fs.writeFileSync(path.join(repo, 'fresh.txt'), 'x\n<script>y</script>\n');
    const d = await getFileDiff(repo, 'fresh.txt');
    expect(d.untracked).toBe(true);
    expect(d.diff).toContain('@@ -0,0 +1,2 @@\n+x\n+<script>y</script>\n');

    fs.writeFileSync(path.join(repo, 'img.bin'), Buffer.from([137, 0, 0, 1]));
    expect(await getFileDiff(repo, 'img.bin')).toMatchObject({ binary: true, diff: '' });
    fs.writeFileSync(path.join(repo, 'keep.txt'), Buffer.from([0, 1, 2]));
    expect(await getFileDiff(repo, 'keep.txt')).toMatchObject({ binary: true, diff: '' });
  });

  it('caps large diffs at a line boundary', async () => {
    const line = `${'z'.repeat(99)}\n`;
    fs.writeFileSync(path.join(repo, 'big.txt'), line.repeat(5000));
    const d = await getFileDiff(repo, 'big.txt');
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.diff)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(d.diff.endsWith('\n')).toBe(true);
  });

  it('refuses paths outside the repository', async () => {
    await expect(getFileDiff(repo, '../etc/passwd')).rejects.toThrow(/outside/);
    await expect(getFileDiff(repo, '/etc/passwd')).rejects.toThrow(/outside/);
    expect(safeRepoRelative(repo, 'src/../keep.txt')).toBe('keep.txt');
    expect(safeRepoRelative(repo, '')).toBeNull();
  });
});
