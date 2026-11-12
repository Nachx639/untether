/**
 * Git worktree helpers shared by the worktree routes and task worktrees: list, parse,
 * default branch, branch stats and dirty checks.
 */
import { promisify } from 'util';
import { createGitError } from './git-error.js';
import { createLogger } from './logger.js';

const logger = createLogger('worktree-git');
const execFile = promisify(require('child_process').execFile);

export interface Worktree {
  path: string;
  branch: string;
  HEAD: string;
  detached: boolean;
  prunable?: boolean;
  locked?: boolean;
  lockedReason?: string;
  // Extended stats
  commitsAhead?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  hasUncommittedChanges?: boolean;
}

export interface WorktreeStats {
  commitsAhead: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * Execute a git command with proper error handling and security
 * @param args Git command arguments
 * @param options Execution options
 * @returns Command output
 */
export async function execGit(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      cwd: options.cwd || process.cwd(),
      timeout: options.timeout || 10000, // 10s for potentially slow operations
      maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // Disable git prompts
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    // Re-throw with more context
    throw createGitError(error, 'Git command failed');
  }
}

/**
 * Detect the repository's default branch
 * @param repoPath Repository path
 * @returns Default branch name
 */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    // Try to get the default branch from origin
    const { stdout } = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
    });
    // Output format: refs/remotes/origin/main
    const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (match) {
      return match[1];
    }
  } catch (_error) {
    logger.debug('Could not detect default branch from origin');
  }

  // Fallback: check if main exists
  try {
    await execGit(['rev-parse', '--verify', 'main'], { cwd: repoPath });
    return 'main';
  } catch {
    // Fallback to master
    return 'master';
  }
}

/**
 * Parse git worktree list --porcelain output
 * @param output Git command output
 * @returns Parsed worktrees
 */
export function parseWorktreePorcelain(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  const lines = output.trim().split('\n');

  let current: Partial<Worktree> | null = null;

  for (const line of lines) {
    if (line === '') {
      if (current?.path && current.HEAD) {
        worktrees.push({
          path: current.path,
          branch: current.branch || 'HEAD',
          HEAD: current.HEAD,
          detached: current.detached || false,
          prunable: current.prunable,
          locked: current.locked,
          lockedReason: current.lockedReason,
        });
      }
      current = null;
      continue;
    }

    const [key, ...valueParts] = line.split(' ');
    const value = valueParts.join(' ');

    if (key === 'worktree') {
      current = { path: value };
    } else if (current) {
      switch (key) {
        case 'HEAD':
          current.HEAD = value;
          break;
        case 'branch':
          current.branch = value;
          break;
        case 'detached':
          current.detached = true;
          break;
        case 'prunable':
          current.prunable = true;
          break;
        case 'locked':
          current.locked = true;
          if (value) {
            current.lockedReason = value;
          }
          break;
      }
    }
  }

  // Handle last worktree if no trailing newline
  if (current?.path && current.HEAD) {
    worktrees.push({
      path: current.path,
      branch: current.branch || 'HEAD',
      HEAD: current.HEAD,
      detached: current.detached || false,
      prunable: current.prunable,
      locked: current.locked,
      lockedReason: current.lockedReason,
    });
  }

  return worktrees;
}

/**
 * Get commit and diff stats for a branch
 * @param repoPath Repository path
 * @param branch Branch name
 * @param baseBranch Base branch to compare against
 * @returns Stats
 */
export async function getBranchStats(
  repoPath: string,
  branch: string,
  baseBranch: string
): Promise<WorktreeStats> {
  const stats: WorktreeStats = {
    commitsAhead: 0,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  };

  try {
    // Commits the branch has that the base lacks. Two dots (2026-11-10): three count both
    // sides, so a branch with nothing of its own but 20 commits behind showed "20 ahead".
    const { stdout: commitCount } = await execGit(
      ['rev-list', '--count', `${baseBranch}..${branch}`],
      { cwd: repoPath }
    );
    stats.commitsAhead = Number.parseInt(commitCount.trim(), 10) || 0;
  } catch (error) {
    logger.debug(`Could not get commit count for ${branch}: ${error}`);
  }

  try {
    // Get diff stats
    const { stdout: diffStat } = await execGit(
      ['diff', '--shortstat', `${baseBranch}...${branch}`],
      { cwd: repoPath }
    );

    // Parse output like: "3 files changed, 10 insertions(+), 5 deletions(-)"
    const match = diffStat.match(
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
    );
    if (match) {
      stats.filesChanged = Number.parseInt(match[1], 10) || 0;
      stats.insertions = Number.parseInt(match[2] ?? '0', 10) || 0;
      stats.deletions = Number.parseInt(match[3] ?? '0', 10) || 0;
    }
  } catch (error) {
    logger.debug(`Could not get diff stats for ${branch}: ${error}`);
  }

  return stats;
}

/**
 * Check if a worktree has uncommitted changes
 * @param worktreePath Worktree path
 * @returns True if there are uncommitted changes
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(['status', '--porcelain'], { cwd: worktreePath });
    return stdout.trim().length > 0;
  } catch (error) {
    logger.debug(`Could not check uncommitted changes for ${worktreePath}: ${error}`);
    return false;
  }
}
