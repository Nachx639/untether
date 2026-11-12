/**
 * «Nuevo proyecto» (2026-10-24: making a project took a folder made by hand on the Mac, a
 * session in it, «Control de versiones» and then «Orquestar»). In the parent folder the user
 * picked (never a default one): a folder named after the project (shared/new-project.ts), plain
 * `git init` (so the branch is the user's init.defaultBranch), a README.md with the name and the
 * goal, and one first commit by the user's own git identity (a repo-local
 * "Untether <untether@localhost>" only when git has none, as git-init does: nothing personal in
 * here, Untether is public). Registering the project and starting its orchestrator are
 * task-commands.ts' `project-new`.
 *
 * Refused, in words the app translates (NewProjectErrorCode): a name that is a path or leaves no
 * folder name, a parent that is not an existing absolute folder or is inside a repository, a
 * folder that exists already. A failure after the folder was made removes it again: it held
 * only what this made. Every git call is execFile with an argument array.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { type NewProjectErrorCode, projectFolderName } from '../../shared/new-project.js';
import { clearGitInfoCacheUnder } from '../utils/git-info.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { GIT_INIT_FALLBACK_EMAIL, GIT_INIT_FALLBACK_NAME } from './project-git-init.js';

export const NEW_PROJECT_COMMIT_MESSAGE = 'Untether: nuevo proyecto';
const GIT_TIMEOUT_MS = 30_000;

export class NewProjectError extends Error {
  constructor(
    readonly code: NewProjectErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface NewProjectPlan {
  name: string;
  /** The parent folder, absolute and real. */
  parent: string;
  repoPath: string;
}

export interface CreatedProject extends NewProjectPlan {
  branch: string;
  commit: string;
}

export interface ProjectCreator {
  /** Checks the name and the parent and says where it would go; makes nothing. */
  plan(name: string, parent: string): Promise<NewProjectPlan>;
  create(name: string, parent: string, goal?: string): Promise<CreatedProject>;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  missing?: boolean;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', env },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const err = error as NodeJS.ErrnoException & { code?: string | number };
        resolve({
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: stdout ?? '',
          stderr: stderr || err.message,
          ...(err.code === 'ENOENT' ? { missing: true } : {}),
        });
      }
    );
  });
}

function must(result: GitResult, what: string): string {
  if (result.missing) throw new NewProjectError('git-missing', 'git is not installed');
  if (result.code !== 0) throw new NewProjectError('failed', `${what}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The README of the first commit: the name, and the goal when there is one. */
export function newProjectReadme(name: string, goal?: string): string {
  const lines = [`# ${name.trim()}`, ''];
  if (goal?.trim()) lines.push(goal.trim(), '');
  return lines.join('\n');
}

export function createProjectCreator(options: { env?: NodeJS.ProcessEnv } = {}): ProjectCreator {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
  };

  const plan = async (name: string, parentInput: string): Promise<NewProjectPlan> => {
    const folder = projectFolderName(name);
    if (!folder) {
      throw new NewProjectError('bad-name', `"${name}" cannot be a folder name`);
    }
    const given = parentInput.trim();
    if (!given) throw new NewProjectError('bad-parent', 'Where to create it is required');
    // Relative would mean the server's own folder: only absolute paths (or ~/…).
    if (!path.isAbsolute(given) && given !== '~' && !given.startsWith('~/')) {
      throw new NewProjectError('bad-parent', `${given} is not an absolute folder`);
    }
    const absolute = resolveAbsolutePath(given);
    let parent: string;
    try {
      parent = fs.realpathSync(absolute);
      if (!fs.statSync(parent).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new NewProjectError('parent-missing', `${absolute} does not exist or is not a folder`);
    }
    const inside = await git(parent, ['rev-parse', '--show-toplevel'], env);
    if (inside.missing) throw new NewProjectError('git-missing', 'git is not installed');
    if (inside.code === 0) {
      throw new NewProjectError(
        'inside-repo',
        `${parent} is inside the repository ${inside.stdout.trim()}`
      );
    }
    const repoPath = path.join(parent, folder);
    if (path.dirname(repoPath) !== parent) {
      throw new NewProjectError('bad-name', `"${name}" cannot be a folder name`);
    }
    if (fs.existsSync(repoPath)) {
      throw new NewProjectError('exists', `${repoPath} exists already`);
    }
    return { name: name.trim(), parent, repoPath };
  };

  return {
    plan,
    async create(name, parentInput, goal) {
      const planned = await plan(name, parentInput);
      const { repoPath } = planned;
      try {
        fs.mkdirSync(repoPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new NewProjectError('exists', `${repoPath} exists already`);
        if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
          throw new NewProjectError('no-permission', `No permission to write in ${planned.parent}`);
        }
        throw new NewProjectError('failed', error instanceof Error ? error.message : String(error));
      }
      try {
        must(await git(repoPath, ['init', '-q'], env), 'git init');
        fs.writeFileSync(path.join(repoPath, 'README.md'), newProjectReadme(planned.name, goal));
        const userName = await git(repoPath, ['config', 'user.name'], env);
        const userEmail = await git(repoPath, ['config', 'user.email'], env);
        if (!userName.stdout.trim() || !userEmail.stdout.trim()) {
          must(await git(repoPath, ['config', 'user.name', GIT_INIT_FALLBACK_NAME], env), 'git');
          must(await git(repoPath, ['config', 'user.email', GIT_INIT_FALLBACK_EMAIL], env), 'git');
        }
        must(await git(repoPath, ['add', '--', 'README.md'], env), 'git add');
        must(
          await git(
            repoPath,
            ['commit', '-q', '--no-verify', '-m', NEW_PROJECT_COMMIT_MESSAGE],
            env
          ),
          'git commit'
        );
        const branch = must(await git(repoPath, ['symbolic-ref', '--short', 'HEAD'], env), 'git');
        const commit = must(await git(repoPath, ['rev-parse', 'HEAD'], env), 'git');
        clearGitInfoCacheUnder(planned.parent);
        return { ...planned, branch, commit };
      } catch (error) {
        // Only what was just made is in it.
        fs.rmSync(repoPath, { recursive: true, force: true });
        if (error instanceof NewProjectError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          throw new NewProjectError('no-permission', `No permission to write in ${repoPath}`);
        }
        throw new NewProjectError('failed', error instanceof Error ? error.message : String(error));
      }
    },
  };
}
