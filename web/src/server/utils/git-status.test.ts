import { execFile } from 'child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  clearGitStatusCache,
  getDetailedGitStatus,
  getDetailedGitStatusCached,
} from './git-status.js';

const execFileAsync = promisify(execFile);

describe('getDetailedGitStatus', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, RM_TEST_DIR)));
    tempDirs.length = 0;
  });

  async function createTempDir() {
    const dir = await mkdtemp(join(tmpdir(), 'untether-git-status-'));
    tempDirs.push(dir);
    return dir;
  }

  async function git(cwd: string, args: string[]) {
    await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  // 2026-11-02: the two starting repos (just `git init`; init + identity + an empty first
  // commit) are built once per file and copied into each test's folder, instead of 2-4 git
  // processes per test. A repo without worktrees or remotes holds no absolute paths, so the
  // copy is the same state.
  let unbornTemplate: string;
  let initialTemplate: string;

  beforeAll(async () => {
    unbornTemplate = await mkdtemp(join(tmpdir(), 'untether-git-status-tpl-'));
    initialTemplate = await mkdtemp(join(tmpdir(), 'untether-git-status-tpl-'));
    await Promise.all([
      git(unbornTemplate, ['init']),
      (async () => {
        await git(initialTemplate, ['init']);
        await git(initialTemplate, ['config', 'user.email', 'test@example.com']);
        await git(initialTemplate, ['config', 'user.name', 'Test User']);
        await git(initialTemplate, ['commit', '--allow-empty', '-m', 'initial']);
      })(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([unbornTemplate, initialTemplate].map((dir) => rm(dir, RM_TEST_DIR)));
  });

  async function copyOf(template: string) {
    const dir = await createTempDir();
    await cp(template, dir, { recursive: true });
    return dir;
  }

  it('includes line insertion and deletion counts', async () => {
    const repoDir = await copyOf(unbornTemplate);

    const filePath = join(repoDir, 'example.txt');
    await writeFile(filePath, 'alpha\nbeta\ngamma\n');
    await git(repoDir, ['add', 'example.txt']);
    await git(repoDir, [
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test User',
      'commit',
      '-m',
      'initial',
    ]);

    await writeFile(filePath, 'alpha\ngamma\ndelta\nepsilon\n');

    const status = await getDetailedGitStatus(repoDir);

    expect(status.modified).toBe(1);
    expect(status.insertions).toBe(2);
    expect(status.deletions).toBe(1);
  });

  it('includes lines from untracked files', async () => {
    const repoDir = await copyOf(initialTemplate);

    await writeFile(join(repoDir, 'untracked.txt'), 'alpha\nbeta');
    await writeFile(join(repoDir, 'binary.dat'), Buffer.from([0, 1, 2, 3]));

    const status = await getDetailedGitStatus(repoDir);

    expect(status.added).toBe(2);
    expect(status.insertions).toBe(2);
    expect(status.deletions).toBe(0);
  });

  it('bounds line counting for large untracked files', async () => {
    const repoDir = await copyOf(initialTemplate);

    await writeFile(join(repoDir, 'large.txt'), Buffer.alloc(2 * 1024 * 1024, 0x61));
    await writeFile(join(repoDir, 'small.txt'), 'counted\n');

    const status = await getDetailedGitStatus(repoDir);

    expect(status.added).toBe(2);
    expect(status.insertions).toBe(1);
    expect(status.deletions).toBe(0);
  });

  it('includes tracked and untracked lines before the first commit', async () => {
    const repoDir = await copyOf(unbornTemplate);

    await writeFile(join(repoDir, 'first.txt'), 'first\nsecond\n');
    await git(repoDir, ['add', 'first.txt']);
    await writeFile(join(repoDir, 'second.txt'), 'third\n');

    const status = await getDetailedGitStatus(repoDir);

    expect(status.added).toBe(1);
    expect(status.staged).toBe(1);
    expect(status.insertions).toBe(3);
    expect(status.deletions).toBe(0);
  });

  it('includes repository-wide untracked lines from a subdirectory', async () => {
    const repoDir = await copyOf(initialTemplate);
    const subdirectory = join(repoDir, 'nested');

    await mkdir(subdirectory);
    await writeFile(join(repoDir, 'root.txt'), 'root\nlines\n');
    await writeFile(join(subdirectory, 'nested.txt'), 'nested\n');

    const status = await getDetailedGitStatus(subdirectory);

    expect(status.added).toBe(2);
    expect(status.insertions).toBe(3);
    expect(status.deletions).toBe(0);
  });

  it('returns zero line counts outside a git repository', async () => {
    const dir = await createTempDir();

    const status = await getDetailedGitStatus(dir);

    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
  });

  describe('getDetailedGitStatusCached', () => {
    afterEach(() => clearGitStatusCache());

    async function repoWithOneFile() {
      const repoDir = await copyOf(initialTemplate);
      await writeFile(join(repoDir, 'a.txt'), 'one\n');
      return repoDir;
    }

    it('dedupes concurrent callers and reuses a fresh result', async () => {
      const repoDir = await repoWithOneFile();
      const first = getDetailedGitStatusCached(repoDir);
      const second = getDetailedGitStatusCached(repoDir);
      expect(second).toBe(first);
      expect(getDetailedGitStatusCached(`${repoDir}/`)).toBe(first);
      expect((await first).added).toBe(1);

      // Within the TTL a new untracked file is not visible yet...
      await writeFile(join(repoDir, 'b.txt'), 'two\n');
      expect((await getDetailedGitStatusCached(repoDir, 60_000)).added).toBe(1);
      // ...but maxAgeMs 0 forces a fresh run, which also refreshes the cache.
      expect((await getDetailedGitStatusCached(repoDir, 0)).added).toBe(2);
      expect((await getDetailedGitStatusCached(repoDir, 60_000)).added).toBe(2);
    });

    it('recomputes once the TTL has passed', async () => {
      const repoDir = await repoWithOneFile();
      expect((await getDetailedGitStatusCached(repoDir, 50)).added).toBe(1);
      await writeFile(join(repoDir, 'b.txt'), 'two\n');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await getDetailedGitStatusCached(repoDir, 50)).added).toBe(2);
    });
  });
});
