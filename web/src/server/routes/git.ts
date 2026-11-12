import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { SessionManager } from '../pty/session-manager.js';
import { createGitError, isGitNotFoundError, isNotGitRepositoryError } from '../utils/git-error.js';
import { isWorktree } from '../utils/git-utils.js';
import { createLogger } from '../utils/logger.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { registerGitChangesRoutes } from './git-changes.js';

const logger = createLogger('git-routes');
const execFile = promisify(require('child_process').execFile);

interface GitRepoInfo {
  isGitRepo: boolean;
  repoPath?: string;
}

interface GitEventRequest {
  repoPath: string;
  branch?: string;
  event?: 'checkout' | 'pull' | 'merge' | 'rebase' | 'commit' | 'push';
}

// In-memory lock to prevent race conditions
interface RepoLock {
  isLocked: boolean;
  queue: Array<() => void>;
}

const repoLocks = new Map<string, RepoLock>();

/**
 * Acquire a lock for a repository path
 * @param repoPath The repository path to lock
 * @returns A promise that resolves when the lock is acquired
 */
async function acquireRepoLock(repoPath: string): Promise<void> {
  return new Promise((resolve) => {
    let lock = repoLocks.get(repoPath);

    if (!lock) {
      lock = { isLocked: false, queue: [] };
      repoLocks.set(repoPath, lock);
    }

    if (!lock.isLocked) {
      lock.isLocked = true;
      resolve();
    } else {
      lock.queue.push(resolve);
    }
  });
}

/**
 * Release a lock for a repository path
 * @param repoPath The repository path to unlock
 */
function releaseRepoLock(repoPath: string): void {
  const lock = repoLocks.get(repoPath);

  if (!lock) {
    return;
  }

  if (lock.queue.length > 0) {
    const next = lock.queue.shift();
    if (next) {
      next();
    }
  } else {
    repoLocks.delete(repoPath);
  }
}

/**
 * Execute a git command with proper error handling and security
 * @param args Git command arguments
 * @param options Execution options
 * @returns Command output
 */
async function execGit(
  args: string[],
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      cwd: options.cwd || process.cwd(),
      timeout: options.timeout || 5000,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // Disable git prompts
    });
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    // A missing cwd makes Node fail with "spawn git ENOENT", as if git were not installed.
    // 2026-10-18: the app kept polling a merged task's removed worktree every 5 s, ~7700
    // errors in four hours. A folder that is gone is just not a repository.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' && options.cwd && !fs.existsSync(options.cwd)) {
      throw Object.assign(createGitError(new Error(`${options.cwd} does not exist`)), {
        stderr: `fatal: not a git repository (${options.cwd} does not exist)`,
      });
    }
    // Re-throw with more context
    throw createGitError(error, 'Git command failed');
  }
}

/**
 * Handle a Git repository change event (POST /api/git/event, and `ut git-event` through the
 * API socket, which calls it in-process), with a per-repo lock against races.
 */
export async function processGitEvent(
  request: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  let lockAcquired = false;
  let repoPath: string | undefined;

  try {
    const { repoPath: requestedRepoPath, branch, event } = (request ?? {}) as GitEventRequest;

    if (!requestedRepoPath || typeof requestedRepoPath !== 'string') {
      return { status: 400, body: { error: 'Missing or invalid repoPath parameter' } };
    }

    // Normalize the repository path
    repoPath = path.resolve(requestedRepoPath);
    logger.debug(`Processing git event for repo: ${repoPath}, branch: ${branch}, event: ${event}`);

    // Acquire lock for this repository
    await acquireRepoLock(repoPath);
    lockAcquired = true;

    // Get all sessions and find those within the repository path
    const sessionManager = new SessionManager();
    const allSessions = sessionManager.listSessions();
    const sessionsInRepo = allSessions.filter((session) => {
      if (!session.workingDir || !repoPath) return false;
      const sessionPath = path.resolve(session.workingDir);
      return sessionPath.startsWith(repoPath);
    });

    logger.debug(`Found ${sessionsInRepo.length} sessions in repository ${repoPath}`);

    const updatedSessionIds: string[] = [];

    // Check follow mode status
    let followWorktree: string | undefined;
    let currentBranch: string | undefined;
    let followMode = false;
    let isMainRepo = false;
    let isWorktreeRepo = false;
    let mainRepoPath = repoPath;

    try {
      // Check if this is a worktree
      const { stdout: gitDirOutput } = await execGit(['rev-parse', '--git-dir'], {
        cwd: repoPath,
      });
      const gitDir = gitDirOutput.trim();
      isWorktreeRepo = gitDir.includes('/.git/worktrees/');

      // If this is a worktree, find the main repo
      if (isWorktreeRepo) {
        // Extract main repo from git dir (e.g., /path/to/main/.git/worktrees/branch)
        mainRepoPath = gitDir.replace(/\/\.git\/worktrees\/.*$/, '');
        logger.debug(`Worktree detected, main repo: ${mainRepoPath}`);
      } else {
        isMainRepo = true;
      }
    } catch (error) {
      logger.debug('Could not determine repository worktree state:', error);
    }

    try {
      // Get follow worktree setting from main repo
      const { stdout: followWorktreeOutput } = await execGit(
        ['config', 'untether.followWorktree'],
        {
          cwd: mainRepoPath,
        }
      );
      followWorktree = followWorktreeOutput.trim();
      followMode = !!followWorktree;
    } catch (error) {
      logger.debug('Follow worktree is not configured:', error);
    }

    try {
      // Get current branch
      const { stdout: branchOutput } = await execGit(['branch', '--show-current'], {
        cwd: repoPath,
      });
      currentBranch = branchOutput.trim();
    } catch (error) {
      logger.debug('Could not determine current branch:', error);
    }

    // Extract repository name from path
    const _repoName = path.basename(repoPath);

    // Update session titles for all sessions in the repository
    for (const session of sessionsInRepo) {
      try {
        // Get the branch for this specific session's working directory
        let _sessionBranch = currentBranch;
        try {
          const { stdout: sessionBranchOutput } = await execGit(['branch', '--show-current'], {
            cwd: session.workingDir,
          });
          if (sessionBranchOutput.trim()) {
            _sessionBranch = sessionBranchOutput.trim();
          }
        } catch (_error) {
          // Use current branch as fallback
          logger.debug(`Could not get branch for session ${session.id}, using repo branch`);
        }

        // Extract base session name (remove any existing git info in square brackets at the end)
        // Use a more specific regex to only match git-related content in brackets
        const baseSessionName =
          session.name?.replace(
            /\s*\[(checkout|branch|merge|rebase|commit|push|pull|fetch|stash|reset|cherry-pick):[^\]]+\]\s*$/,
            ''
          ) || 'Terminal';

        // Construct new title with format: baseSessionName [event: branch]
        let newTitle = baseSessionName;
        const sessionBranch = branch || _sessionBranch;
        if (event && sessionBranch) {
          newTitle = `${baseSessionName} [${event}: ${sessionBranch}]`;
        }

        // Update the session name
        sessionManager.updateSessionName(session.id, newTitle);
        updatedSessionIds.push(session.id);

        logger.debug(`Updated session ${session.id} title to: ${newTitle}`);
      } catch (error) {
        logger.error(`Failed to update session ${session.id}:`, error);
      }
    }

    // Handle follow mode sync logic
    if (followMode && followWorktree) {
      logger.info(`Follow mode active: processing event from ${repoPath}`);

      // Determine which repo we're in and which direction to sync
      if (repoPath === followWorktree && isWorktreeRepo) {
        // Event from worktree - sync to main repo
        logger.info(`Syncing from worktree to main repo`);

        try {
          // Find the main repo path
          const { stdout: gitDirOutput } = await execGit(['rev-parse', '--git-dir'], {
            cwd: repoPath,
          });
          const gitDir = gitDirOutput.trim();
          const mainRepoPath = gitDir.replace(/\/\.git\/worktrees\/.*$/, '');

          // Get the current branch in worktree
          const { stdout: worktreeBranchOutput } = await execGit(['branch', '--show-current'], {
            cwd: repoPath,
          });
          const worktreeBranch = worktreeBranchOutput.trim();

          if (worktreeBranch) {
            // Sync main repo to worktree's branch
            logger.info(`Syncing main repo to branch: ${worktreeBranch}`);
            await execGit(['checkout', worktreeBranch], { cwd: mainRepoPath });

            // Pull latest changes in main repo
            await execGit(['pull', '--ff-only'], { cwd: mainRepoPath });
          }
        } catch (error) {
          logger.error('Failed to sync from worktree to main:', error);
        }
      } else if (isMainRepo && event === 'commit') {
        // Event from main repo (commit only) - sync to worktree
        logger.info(`Syncing commit from main repo to worktree`);

        try {
          // Pull latest changes in worktree
          await execGit(['pull', '--ff-only'], { cwd: followWorktree });
        } catch (error) {
          logger.error('Failed to sync commit to worktree:', error);
        }
      } else if (isMainRepo && event === 'checkout') {
        // Branch switch in main repo - disable follow mode
        logger.info('Branch switched in main repo, disabling follow mode');

        try {
          await execGit(['config', '--local', '--unset', 'untether.followWorktree'], {
            cwd: repoPath,
          });

          followMode = false;
          followWorktree = undefined;
        } catch (error) {
          logger.error('Failed to disable follow mode:', error);
        }
      }
    }

    // Return success response
    return {
      status: 200,
      body: {
        success: true,
        repoPath,
        branch: branch || currentBranch,
        sessionsUpdated: updatedSessionIds.length,
        followMode,
      },
    };
  } catch (error) {
    logger.error('Error handling git event:', error);
    return {
      status: 500,
      body: {
        error: 'Failed to process git event',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    // Always release the lock
    if (lockAcquired && repoPath) {
      releaseRepoLock(repoPath);
    }
  }
}

/**
 * Create Git-related routes
 */
export function createGitRoutes(): Router {
  const router = Router();

  registerGitChangesRoutes(router);

  /**
   * GET /api/git/repo-info
   * Check if a path is within a Git repository
   */
  router.get('/git/repo-info', async (req, res) => {
    try {
      const { path: queryPath } = req.query;
      logger.info(`🔍 [git/repo-info] Received request for path: ${queryPath}`);

      if (!queryPath || typeof queryPath !== 'string') {
        logger.warn('❌ Missing or invalid path parameter');
        return res.status(400).json({
          error: 'Missing or invalid path parameter',
        });
      }

      // Resolve the path to absolute, expanding tilde if present
      const absolutePath = resolveAbsolutePath(queryPath);
      logger.info(`🔍 [git/repo-info] Resolved ${queryPath} to absolute path: ${absolutePath}`);

      try {
        // Use git rev-parse to find the repository root
        const { stdout } = await execGit(['rev-parse', '--show-toplevel'], {
          cwd: absolutePath,
        });

        const repoPath = stdout.trim();

        const response: GitRepoInfo = {
          isGitRepo: true,
          repoPath,
        };

        logger.info(`✅ [git/repo-info] Path is in git repo: ${repoPath}`);
        return res.json(response);
      } catch (error) {
        // If git command fails, it's not a git repo
        if (isGitNotFoundError(error)) {
          logger.debug('Git command not found');
          return res.json({ isGitRepo: false });
        }

        // Git returns exit code 128 when not in a git repo
        if (isNotGitRepositoryError(error)) {
          logger.info(`❌ [git/repo-info] Path is not in a git repository: ${absolutePath}`);
          return res.json({ isGitRepo: false });
        }

        // Unexpected error
        throw error;
      }
    } catch (error) {
      logger.error('Error checking git repo info:', error);
      return res.status(500).json({
        error: 'Failed to check git repository info',
      });
    }
  });

  /**
   * POST /api/git/event
   */
  router.post('/git/event', async (req, res) => {
    const result = await processGitEvent(req.body);
    res.status(result.status).json(result.body);
  });

  /**
   * GET /api/git/remote
   * Get remote URL for a repository
   */
  router.get('/git/remote', async (req, res) => {
    try {
      const { path: queryPath } = req.query;

      if (!queryPath || typeof queryPath !== 'string') {
        return res.status(400).json({
          error: 'Missing or invalid path parameter',
        });
      }

      // Resolve the path to absolute
      const absolutePath = resolveAbsolutePath(queryPath);
      logger.debug(`Getting git remote for path: ${absolutePath}`);

      try {
        // Get repository root
        const { stdout: repoPathOutput } = await execGit(['rev-parse', '--show-toplevel'], {
          cwd: absolutePath,
        });
        const repoPath = repoPathOutput.trim();

        // Get remote URL
        const { stdout: remoteOutput } = await execGit(['remote', 'get-url', 'origin'], {
          cwd: repoPath,
        });
        const remoteUrl = remoteOutput.trim();

        // Parse GitHub URL from remote URL
        let githubUrl: string | null = null;
        if (remoteUrl) {
          // Handle HTTPS URLs: https://github.com/user/repo.git
          if (remoteUrl.startsWith('https://github.com/')) {
            githubUrl = remoteUrl.endsWith('.git') ? remoteUrl.slice(0, -4) : remoteUrl;
          }
          // Handle SSH URLs: git@github.com:user/repo.git
          else if (remoteUrl.startsWith('git@github.com:')) {
            const pathPart = remoteUrl.substring('git@github.com:'.length);
            const cleanPath = pathPart.endsWith('.git') ? pathPart.slice(0, -4) : pathPart;
            githubUrl = `https://github.com/${cleanPath}`;
          }
        }

        return res.json({
          isGitRepo: true,
          repoPath,
          remoteUrl,
          githubUrl,
        });
      } catch (error) {
        if (isNotGitRepositoryError(error)) {
          return res.json({
            isGitRepo: false,
          });
        }

        // Check if it's just missing remote
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('No such remote')) {
          return res.json({
            isGitRepo: true,
            remoteUrl: null,
            githubUrl: null,
          });
        }

        throw error;
      }
    } catch (error) {
      logger.error('Error getting git remote:', error);
      return res.status(500).json({
        error: 'Failed to get git remote',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * GET /api/git/repository-info
   * Get comprehensive repository information (combines multiple git commands)
   */
  router.get('/git/repository-info', async (req, res) => {
    try {
      const { path: queryPath } = req.query;

      if (!queryPath || typeof queryPath !== 'string') {
        return res.status(400).json({
          error: 'Missing or invalid path parameter',
        });
      }

      // Resolve the path to absolute
      const absolutePath = resolveAbsolutePath(queryPath);
      logger.debug(`Getting comprehensive git info for path: ${absolutePath}`);

      try {
        // Get repository root
        const { stdout: repoPathOutput } = await execGit(['rev-parse', '--show-toplevel'], {
          cwd: absolutePath,
        });
        const repoPath = repoPathOutput.trim();

        // Check if this is a worktree
        const worktreeStatus = await isWorktree(repoPath);

        // Gather all information in parallel
        const [branchResult, statusResult, remoteResult, aheadBehindResult] =
          await Promise.allSettled([
            // Current branch
            execGit(['branch', '--show-current'], { cwd: repoPath }),
            // Status
            execGit(['status', '--porcelain=v1'], { cwd: repoPath }),
            // Remote URL
            execGit(['remote', 'get-url', 'origin'], { cwd: repoPath }),
            // Ahead/behind counts
            execGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { cwd: repoPath }),
          ]);

        // Process results
        const currentBranch =
          branchResult.status === 'fulfilled' ? branchResult.value.stdout.trim() : null;

        // Parse status
        let modifiedCount = 0;
        let untrackedCount = 0;
        let stagedCount = 0;
        let addedCount = 0;
        let deletedCount = 0;
        let hasChanges = false;

        if (statusResult.status === 'fulfilled') {
          const lines = statusResult.value.stdout
            .trim()
            .split('\n')
            .filter((line) => line.length > 0);
          hasChanges = lines.length > 0;

          for (const line of lines) {
            if (line.length < 2) continue;

            const indexStatus = line[0];
            const workTreeStatus = line[1];

            if (indexStatus !== ' ' && indexStatus !== '?') {
              stagedCount++;

              if (indexStatus === 'A') {
                addedCount++;
              } else if (indexStatus === 'D') {
                deletedCount++;
              }
            }

            if (workTreeStatus === 'M') {
              modifiedCount++;
            } else if (workTreeStatus === 'D' && indexStatus === ' ') {
              deletedCount++;
            }

            if (indexStatus === '?' && workTreeStatus === '?') {
              untrackedCount++;
            }
          }
        }

        // Remote URL
        const remoteUrl =
          remoteResult.status === 'fulfilled' ? remoteResult.value.stdout.trim() : null;

        // Parse GitHub URL from remote URL
        let githubUrl: string | null = null;
        if (remoteUrl) {
          // Handle HTTPS URLs: https://github.com/user/repo.git
          if (remoteUrl.startsWith('https://github.com/')) {
            githubUrl = remoteUrl.endsWith('.git') ? remoteUrl.slice(0, -4) : remoteUrl;
          }
          // Handle SSH URLs: git@github.com:user/repo.git
          else if (remoteUrl.startsWith('git@github.com:')) {
            const pathPart = remoteUrl.substring('git@github.com:'.length);
            const cleanPath = pathPart.endsWith('.git') ? pathPart.slice(0, -4) : pathPart;
            githubUrl = `https://github.com/${cleanPath}`;
          }
        }

        // Ahead/behind counts
        let aheadCount = 0;
        let behindCount = 0;
        let hasUpstream = false;

        if (aheadBehindResult.status === 'fulfilled') {
          hasUpstream = true;
          const [ahead, behind] = aheadBehindResult.value.stdout
            .trim()
            .split('\t')
            .map((n) => Number.parseInt(n, 10));
          aheadCount = ahead || 0;
          behindCount = behind || 0;
        }

        return res.json({
          isGitRepo: true,
          repoPath,
          currentBranch,
          remoteUrl,
          githubUrl,
          hasChanges,
          modifiedCount,
          untrackedCount,
          stagedCount,
          addedCount,
          deletedCount,
          aheadCount,
          behindCount,
          hasUpstream,
          isWorktree: worktreeStatus,
        });
      } catch (error) {
        if (isNotGitRepositoryError(error)) {
          return res.json({
            isGitRepo: false,
          });
        }
        throw error;
      }
    } catch (error) {
      logger.error('Error getting repository info:', error);
      return res.status(500).json({
        error: 'Failed to get repository info',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
