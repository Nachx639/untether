/**
 * Git information detection utilities
 */

import { execFile as execFileCallback } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);

/**
 * Git repository information
 */
export interface GitInfo {
  gitRepoPath?: string;
  gitBranch?: string;
  gitAheadCount?: number;
  gitBehindCount?: number;
  gitHasChanges?: boolean;
  gitIsWorktree?: boolean;
  gitMainRepoPath?: string;
}

/**
 * Extract repository path from a worktree's .git file
 */
async function getMainRepositoryPath(workingDir: string): Promise<string | undefined> {
  try {
    const gitFile = path.join(workingDir, '.git');
    const gitContent = await fs.promises.readFile(gitFile, 'utf-8');

    // Parse the .git file format: "gitdir: /path/to/main/.git/worktrees/worktree-name"
    const match = gitContent.match(/^gitdir:\s*(.+)$/m);
    if (!match) return undefined;

    const gitDirPath = match[1].trim();

    // Extract the main repository path from the worktree path
    // Format: /path/to/main/.git/worktrees/worktree-name
    const worktreeMatch = gitDirPath.match(/^(.+)\/\.git\/worktrees\/.+$/);
    if (worktreeMatch) {
      return worktreeMatch[1];
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// Cache for Git info to avoid calling git commands too frequently
const gitInfoCache = new Map<string, { info: GitInfo; timestamp: number }>();
const CACHE_TTL = 5000; // 5 seconds
const gitInfoInFlight = new Map<string, Promise<GitInfo>>();

/**
 * Detect Git repository information for a given directory
 */
export async function detectGitInfo(workingDir: string): Promise<GitInfo> {
  // Check cache first
  const cached = gitInfoCache.get(workingDir);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.info;
  }

  // GET /sessions asks for every session without git info at once, and sessions share
  // directories (~, a project): without this, each one spawned its own 2-5 git processes for
  // the same directory every time the cache expired (2026-10-02).
  let pending = gitInfoInFlight.get(workingDir);
  if (!pending) {
    pending = readGitInfo(workingDir).finally(() => gitInfoInFlight.delete(workingDir));
    gitInfoInFlight.set(workingDir, pending);
  }
  return pending;
}

/**
 * The repository folder holding `dir` (git's --show-toplevel: the real path of the nearest
 * folder with a `.git`), or null when there is none or `dir` does not exist.
 */
async function findRepoRoot(dir: string): Promise<string | null> {
  let current: string;
  try {
    current = await fs.promises.realpath(dir);
    if (!(await fs.promises.stat(current)).isDirectory()) return null;
  } catch {
    return null;
  }
  for (;;) {
    if (await fs.promises.stat(path.join(current, '.git')).catch(() => null)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `git status --porcelain=v2 --branch` read into the fields the session list shows. */
export function parseGitStatus(stdout: string): {
  gitBranch: string;
  gitAheadCount?: number;
  gitBehindCount?: number;
  gitHasChanges: boolean;
} {
  let gitBranch = '';
  let gitAheadCount: number | undefined;
  let gitBehindCount: number | undefined;
  let gitHasChanges = false;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      // Detached HEAD: no branch, as `git branch --show-current` says.
      gitBranch = head === '(detached)' ? '' : head;
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
      if (match) {
        gitAheadCount = Number(match[1]);
        gitBehindCount = Number(match[2]);
      }
    } else if (/^[12u] /.test(line)) {
      gitHasChanges = true;
    }
  }
  return { gitBranch, gitAheadCount, gitBehindCount, gitHasChanges };
}

/**
 * 2026-11-02 (CPU measurement): this ran 4 git processes per folder every time the 5 s cache
 * ran out (rev-parse, branch, rev-list, diff-index: 128 a minute with 8 sessions open), even
 * for folders outside any repository. The repository is found on disk now, and one
 * `git status` (tracked files only, no index refresh written) answers the rest.
 */
async function readGitInfo(workingDir: string): Promise<GitInfo> {
  const cache = (info: GitInfo) => {
    gitInfoCache.set(workingDir, { info, timestamp: Date.now() });
    return info;
  };
  const gitRepoPath = await findRepoRoot(workingDir);
  // Not a Git repository: nothing to ask git.
  if (!gitRepoPath) return cache({});

  let stdout: string;
  try {
    ({ stdout } = await execFile(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      {
        cwd: workingDir,
        timeout: 5000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      }
    ));
  } catch {
    // A .git git refuses (not a repository after all, unsafe owner): as before, not one.
    return cache({});
  }

  // .git is a file, not a directory: a worktree.
  const gitFile = await fs.promises.stat(path.join(gitRepoPath, '.git')).catch(() => null);
  const gitIsWorktree = Boolean(gitFile && !gitFile.isDirectory());
  const gitMainRepoPath = gitIsWorktree ? await getMainRepositoryPath(gitRepoPath) : gitRepoPath;
  return cache({ gitRepoPath, ...parseGitStatus(stdout), gitIsWorktree, gitMainRepoPath });
}

/**
 * Clear the Git info cache
 */
export function clearGitInfoCache(): void {
  gitInfoCache.clear();
}

/**
 * Forget what is cached for a folder and everything under it (a folder that just became a
 * repository, project-git-init.ts: its sessions must see it on the next list, not in 5 s).
 */
export function clearGitInfoCacheUnder(dir: string): void {
  const root = dir.replace(/\/+$/, '');
  for (const key of gitInfoCache.keys()) {
    if (key === root || key.startsWith(`${root}/`)) gitInfoCache.delete(key);
  }
}
