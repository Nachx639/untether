/**
 * The folder a new session runs in when the client asks for a git branch (POST /api/sessions
 * `gitBranch`).
 *
 * 2026-10-20: the route ignored `gitBranch`, so a session asked for on `feature-x` started on
 * whatever the folder had checked out. Switching the user's checkout behind their back is not
 * an option (it would carry their uncommitted work to another branch, or fail half way), so:
 *  - the folder already has that branch out: it is the answer;
 *  - another worktree has it out: that worktree (the same subfolder in it, when there is one);
 *  - else a new worktree for it, where the session form puts them: `<main checkout>-<branch>`
 *    (client generateWorktreePath), `-2`, `-3`… when that folder is taken.
 * A branch that exists neither locally nor on a remote is refused, never created.
 *
 * 2026-10-20 (round 3):
 *  - a worktree whose folder was deleted by hand stayed registered, and `worktree add` for its
 *    branch failed (500): `git worktree prune` runs before adding;
 *  - a tag named like a remote-only branch made `worktree add <path> <name>` check out the tag
 *    (detached HEAD): remote branches are named by their full refs/remotes ref;
 *  - a working folder that no longer exists answered 'bad-branch' (git could not even start
 *    there): 'missing-dir' now, and a folder outside git 'not-a-repo';
 *  - two requests whose branches map to the same folder (`a/b`, `a-b`, two taps) raced for it
 *    and one failed: creates for the same folder run one after the other;
 *  - a very long branch name gave a folder name past what the file system takes: the slug is
 *    cut and a hash of the branch keeps it unique.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { run } from '../utils/exec-file.js';

const GIT_TIMEOUT_MS = 30_000;

export type SessionBranchDir =
  | {
      ok: true;
      workingDir: string;
      /** 'current': the folder had it out; 'worktree': an existing worktree; 'created'. */
      how: 'current' | 'worktree' | 'created';
    }
  | {
      ok: false;
      code: 'bad-branch' | 'missing-dir' | 'not-a-repo' | 'branch-not-found' | 'worktree-failed';
      message: string;
    };

const git = (cwd: string, args: string[]) => run('git', args, cwd, GIT_TIMEOUT_MS);

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  const result = await git(cwd, args);
  return result.code === 0 ? result.stdout.trim() : null;
}

function real(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Worktree folder → branch it has out (refs/heads/ stripped), from `git worktree list`. */
async function worktreesByBranch(cwd: string): Promise<Map<string, string>> {
  const out = await gitOut(cwd, ['worktree', 'list', '--porcelain']);
  const byBranch = new Map<string, string>();
  let current: string | null = null;
  for (const line of (out ?? '').split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && current) {
      byBranch.set(line.slice('branch refs/heads/'.length), current);
    } else if (line === '') current = null;
  }
  return byBranch;
}

/** The same subfolder inside `root` when it exists there, else `root`. */
function sameSubfolder(root: string, relative: string): string {
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return root;
  const candidate = path.join(root, relative);
  return fs.existsSync(candidate) ? candidate : root;
}

/** `<main checkout>-<branch slug>`, the session form's convention (generateWorktreePath). */
export function branchWorktreePath(mainRepo: string, branch: string): string {
  const name = branch.trim();
  let slug = name.replace(/[^a-zA-Z0-9-_]/g, '-');
  if (slug.length > MAX_SLUG_LENGTH) {
    const hash = crypto.createHash('sha1').update(name).digest('hex').slice(0, 10);
    slug = `${slug.slice(0, MAX_SLUG_LENGTH - hash.length - 1)}-${hash}`;
  }
  return `${mainRepo}-${slug}`;
}

/** Folder-name budget for the branch part (a name may be 255 bytes; the repo's name comes too). */
const MAX_SLUG_LENGTH = 100;

/** One create at a time per target folder (key: the base worktree path). */
const creating = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = creating.get(key) ?? Promise.resolve();
  const mine = before.then(work, work);
  const settled = mine.catch(() => {});
  creating.set(key, settled);
  try {
    return await mine;
  } finally {
    if (creating.get(key) === settled) creating.delete(key);
  }
}

export async function sessionDirForBranch(dir: string, branch: string): Promise<SessionBranchDir> {
  const name = branch.trim();
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    // Missing.
  }
  if (!isDir) {
    return { ok: false, code: 'missing-dir', message: `The folder does not exist: ${dir}` };
  }
  if (
    !name ||
    name.startsWith('-') ||
    (await git(dir, ['check-ref-format', '--branch', name])).code !== 0
  ) {
    return { ok: false, code: 'bad-branch', message: `Not a valid branch name: ${branch}` };
  }
  const top = await gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return { ok: false, code: 'not-a-repo', message: `Not a git repository: ${dir}` };
  const relative = path.relative(real(top), real(dir));

  // The full ref: `--short` answers `heads/<name>` when a tag has the same name.
  const current = await gitOut(dir, ['symbolic-ref', '--quiet', 'HEAD']);
  if (current === `refs/heads/${name}`) return { ok: true, workingDir: dir, how: 'current' };

  const common = await gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainRepo = common && path.basename(common) === '.git' ? path.dirname(common) : top;
  const base = branchWorktreePath(mainRepo, name);
  return oneAtATime(real(base), () => findOrCreate(dir, name, relative, mainRepo, base));
}

async function findOrCreate(
  dir: string,
  name: string,
  relative: string,
  mainRepo: string,
  base: string
): Promise<SessionBranchDir> {
  const existing = (await worktreesByBranch(dir)).get(name);
  if (existing && fs.existsSync(existing)) {
    return { ok: true, workingDir: sameSubfolder(existing, relative), how: 'worktree' };
  }

  const local =
    (await git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).code === 0;
  // A local branch: `worktree add <path> <name>` checks out refs/heads/<name> first (a tag of
  // the same name does not win there). A remote-only one: named by its full ref, with an
  // explicit tracking branch, so a same-named tag is never what gets checked out.
  let addArgs: (target: string) => string[] = (target) => ['worktree', 'add', target, name];
  if (!local) {
    // refs/remotes/<remote>/<branch>: the branch may hold slashes, a remote name does not.
    const remotes = (
      (await gitOut(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])) ?? ''
    )
      .split('\n')
      .map((ref) => ref.slice('refs/remotes/'.length))
      .filter((ref) => ref.slice(ref.indexOf('/') + 1) === name && ref.indexOf('/') > 0);
    if (remotes.length !== 1) {
      return {
        ok: false,
        code: 'branch-not-found',
        message: `There is no branch ${name} in this repository`,
      };
    }
    const remoteRef = `refs/remotes/${remotes[0]}`;
    addArgs = (target) => ['worktree', 'add', '--track', '-b', name, target, remoteRef];
  }

  // A worktree folder deleted by hand stays registered (its branch "checked out" there) until
  // pruned, and `worktree add` for that branch then fails.
  await git(mainRepo, ['worktree', 'prune']);

  let target = base;
  for (let n = 2; fs.existsSync(target); n++) target = `${base}-${n}`;

  const added = await git(mainRepo, addArgs(target));
  if (added.code !== 0) {
    // Another request (another server, another folder of the repo) made it meanwhile.
    const raced = (await worktreesByBranch(dir)).get(name);
    if (raced && fs.existsSync(raced)) {
      return { ok: true, workingDir: sameSubfolder(raced, relative), how: 'worktree' };
    }
    return {
      ok: false,
      code: 'worktree-failed',
      message: (added.stderr || added.spawnError || 'git worktree add failed').trim(),
    };
  }
  return { ok: true, workingDir: sameSubfolder(target, relative), how: 'created' };
}
