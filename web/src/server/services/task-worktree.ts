/**
 * A worktree task's own folder and branch: made from the base branch next to the repository
 * (never inside it), with its dependencies cloned from the main checkout, and removed again
 * once the task is merged or thrown away.
 *
 * Every git and install command goes through exec-file's run() (argument arrays, never a
 * shell); only the project's own setupCommand runs in a login shell, as the user wrote it.
 * The user never has to know a worktree exists: names come from the task's title.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeForMatch } from '../../shared/name-match.js';
import { isSafeRefName, type RunResult, run } from '../utils/exec-file.js';
import { detectDefaultBranch, parseWorktreePorcelain } from '../utils/worktree-git.js';

const GIT_TIMEOUT_MS = 30_000;
/** Commits run the repository's hooks (lint, tests). */
const COMMIT_TIMEOUT_MS = 180_000;
const SETUP_TIMEOUT_MS = 15 * 60_000;
const SLUG_MAX = 40;
/** Branches the engine makes, and the only ones it ever deletes. */
export const TASK_BRANCH_PREFIX = 'ut/';

/** Lockfiles whose folder gets its node_modules cloned, and how to install without one. */
const LOCKFILES: Array<{ file: string; install: string[] }> = [
  { file: 'pnpm-lock.yaml', install: ['pnpm', 'install', '--prefer-offline'] },
  { file: 'bun.lockb', install: ['bun', 'install'] },
  { file: 'bun.lock', install: ['bun', 'install'] },
  { file: 'yarn.lock', install: ['yarn', 'install'] },
  { file: 'package-lock.json', install: ['npm', 'ci'] },
];

export class TaskWorktreeError extends Error {
  constructor(
    message: string,
    /** The failing command's last lines, for the task's blocker. */
    readonly detail: string[] = []
  ) {
    super(message);
  }
}

const output = (r: RunResult) => `${r.stdout}\n${r.stderr}`.trim();
const tail = (text: string, lines = 20) => text.split('\n').filter(Boolean).slice(-lines);

function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<RunResult> {
  return run('git', args, cwd, timeout);
}

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  const r = await git(cwd, args);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * A task name as a folder and branch name: lower case, no accents, words joined by dashes,
 * at most 40 characters ("Arregla el login de Google" → "arregla-el-login-de-google").
 */
export function slugifyTaskName(name: string): string {
  const slug = normalizeForMatch(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'task';
}

/** The main checkout of the repository `dir` is in (also from inside a worktree), or null. */
export async function resolveMainRepo(dir: string): Promise<string | null> {
  const common = await gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  // A bare repository has no checkout to merge into.
  if (path.basename(common) !== '.git') return null;
  return path.dirname(common);
}

/** The folder, next to a repository, holding its task worktrees by repository name. */
const WORKTREE_DIR = '.untether-worktrees';

/** Where the engine puts a repository's task worktrees: next to it, never inside it. */
export function defaultWorktreeRoot(repoPath: string): string {
  return path.join(path.dirname(repoPath), WORKTREE_DIR, path.basename(repoPath));
}

export interface CreateTaskWorktreeOptions {
  /** Any folder inside the repository. */
  dir: string;
  /** The task's title: its slug names the folder and the branch. */
  name: string;
  /** "a", "b"… for the tasks of a parallel group. */
  suffix?: string;
  /** Defaults to the branch the main checkout has out (else the repository default). */
  baseBranch?: string;
  worktreeRoot?: string;
  /** Folders cloned from the main checkout (APFS clone); default node_modules next to lockfiles. */
  cloneDirs?: string[];
  /** Runs in the new worktree instead of the detected install (zsh -lc). */
  setupCommand?: string;
  /** Setup output goes here as well. */
  logPath?: string;
  /**
   * Called with the branch and folder chosen, right before they are made, so the caller can
   * record them (2026-10-20: a server stop mid-setup left both behind, named by nothing).
   */
  onPlanned?: (plan: { repoPath: string; branch: string; worktreePath: string }) => void;
}

export interface TaskWorktree {
  repoPath: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
  /** The folders cloned in, relative to the worktree (left out of auto-commits). */
  clonedDirs: string[];
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

/** The repository's lockfiles (top level and one folder down), tracked ones only. */
async function trackedLockfiles(repo: string): Promise<string[]> {
  const specs = LOCKFILES.flatMap(({ file }) => [`:(glob)${file}`, `:(glob)*/${file}`]);
  const out = await gitOut(repo, ['ls-files', '--', ...specs]);
  return out ? out.split('\n').filter(Boolean) : [];
}

function appendLog(logPath: string | undefined, text: string): void {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, text.endsWith('\n') ? text : `${text}\n`);
  } catch {
    // A log that can't be written never stops the task.
  }
}

/**
 * Make the task's worktree on a new branch ut/<slug> from the base branch's current commit,
 * clone its dependencies and run its setup. Throws TaskWorktreeError (the task then fails
 * with blocker "setup"); a worktree made before the failure is removed again.
 */
export async function createTaskWorktree(
  options: CreateTaskWorktreeOptions
): Promise<TaskWorktree> {
  const repoPath = await resolveMainRepo(options.dir);
  if (!repoPath) throw new TaskWorktreeError(`Not inside a git repository: ${options.dir}`);

  let baseBranch = options.baseBranch;
  if (baseBranch === undefined) {
    // The branch of the folder the task was started from, which may be a linked worktree of
    // the repository (2026-10-18: ~/Projects/untether is a worktree on `untether` of a main
    // checkout on another branch; taking the main checkout's branch would have merged there).
    // A task's own ut/ worktree hands over to the main checkout's branch.
    const fromDir = await gitOut(options.dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const current =
      fromDir && !fromDir.startsWith('ut/')
        ? fromDir
        : await gitOut(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    baseBranch = current || (await detectDefaultBranch(repoPath));
  }
  if (!isSafeRefName(baseBranch)) throw new TaskWorktreeError(`Invalid base branch: ${baseBranch}`);
  const baseSha = await gitOut(repoPath, ['rev-parse', '--verify', `${baseBranch}^{commit}`]);
  if (!baseSha) throw new TaskWorktreeError(`Base branch not found: ${baseBranch}`);

  const root = options.worktreeRoot ?? defaultWorktreeRoot(repoPath);
  const base = slugifyTaskName(options.name);
  const stem = options.suffix ? `${base}-${options.suffix}` : base;
  let slug = stem;
  for (let n = 2; ; n++) {
    const taken =
      fs.existsSync(path.join(root, slug)) ||
      (await branchExists(repoPath, `${TASK_BRANCH_PREFIX}${slug}`));
    if (!taken) break;
    if (n > 99) throw new TaskWorktreeError(`No free name for ${stem}`);
    slug = `${stem}-${n}`;
  }
  const branch = `${TASK_BRANCH_PREFIX}${slug}`;
  const worktreePath = path.join(root, slug);
  fs.mkdirSync(root, { recursive: true });
  options.onPlanned?.({ repoPath, branch, worktreePath });

  const added = await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
  if (added.code !== 0) {
    throw new TaskWorktreeError('Could not create the worktree', tail(output(added)));
  }
  appendLog(options.logPath, `worktree ${worktreePath} on ${branch} from ${baseBranch} ${baseSha}`);

  try {
    const clonedDirs = await setUp(repoPath, worktreePath, options);
    return { repoPath, baseBranch, baseSha, branch, worktreePath, clonedDirs };
  } catch (error) {
    await removeTaskWorktree({ repoPath, worktreePath, branch, deleteUnmerged: true });
    throw error;
  }
}

async function setUp(
  repoPath: string,
  worktreePath: string,
  options: CreateTaskWorktreeOptions
): Promise<string[]> {
  const lockfiles = await trackedLockfiles(repoPath);
  const cloneDirs =
    options.cloneDirs ??
    lockfiles.map((file) => path.join(path.dirname(file), 'node_modules').replace(/^\.\//, ''));
  const cloned: string[] = [];
  for (const dir of new Set(cloneDirs)) {
    const relative = path.normalize(dir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const from = path.join(repoPath, relative);
    const to = path.join(worktreePath, relative);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // -c: an APFS clone, instant and taking no space until a file changes. Elsewhere it fails
    // and the install below fills the folder instead.
    const copy = await run('cp', ['-cR', from, to], worktreePath, SETUP_TIMEOUT_MS);
    appendLog(options.logPath, `clone ${relative}: ${copy.code === 0 ? 'ok' : output(copy)}`);
    if (copy.code === 0) cloned.push(relative);
    else fs.rmSync(to, { recursive: true, force: true });
  }

  if (options.setupCommand) {
    const setup = await run(
      '/bin/zsh',
      ['-lc', options.setupCommand],
      worktreePath,
      SETUP_TIMEOUT_MS
    );
    appendLog(options.logPath, `$ ${options.setupCommand}\n${output(setup)}`);
    if (setup.code !== 0) {
      throw new TaskWorktreeError(`Setup failed: ${options.setupCommand}`, tail(output(setup)));
    }
    await undoSetupChanges(worktreePath, options.logPath);
    return cloned;
  }
  // No setup of its own: install where a lockfile's node_modules could not be cloned.
  for (const file of lockfiles) {
    const folder = path.dirname(file);
    const modules = path.join(folder, 'node_modules').replace(/^\.\//, '');
    if (cloned.includes(modules)) continue;
    const install = LOCKFILES.find((entry) => entry.file === path.basename(file))?.install;
    if (!install) continue;
    const cwd = path.join(worktreePath, folder);
    const r = await run(install[0], install.slice(1), cwd, SETUP_TIMEOUT_MS);
    appendLog(options.logPath, `$ ${install.join(' ')} (in ${folder})\n${output(r)}`);
    if (r.code !== 0) {
      throw new TaskWorktreeError(`Install failed: ${install.join(' ')}`, tail(output(r)));
    }
  }
  await undoSetupChanges(worktreePath, options.logPath);
  return cloned;
}

/**
 * Setting up never changes the task's tracked files: whatever an install or the setup command
 * changed or deleted is put back, logged. 2026-10-24: `bun install` in mac/ (no dependencies)
 * printed "Deleted empty lockfile" and removed the tracked mac/bun.lock; the task's leftovers
 * commit took the deletion along, into at least three tasks' merges.
 */
async function undoSetupChanges(worktreePath: string, logPath: string | undefined): Promise<void> {
  const changed = (await gitOut(worktreePath, ['diff', '--name-only', 'HEAD', '--']))
    ?.split('\n')
    .filter(Boolean);
  if (!changed?.length) return;
  const restored = await git(worktreePath, ['checkout', 'HEAD', '--', ...changed]);
  appendLog(
    logPath,
    restored.code === 0
      ? `setup changed tracked files, put back: ${changed.join(', ')}`
      : `setup changed tracked files (${changed.join(', ')}), not put back: ${output(restored)}`
  );
}

export interface RemoveTaskWorktreeOptions {
  repoPath: string;
  worktreePath?: string;
  branch?: string;
  /** Delete the branch even with commits not merged anywhere (the user confirmed). */
  deleteUnmerged?: boolean;
}

export interface RemoveTaskWorktreeResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  /** Why the branch stayed (unmerged commits without deleteUnmerged). */
  error?: string;
}

/**
 * Remove a task's worktree (with whatever it holds: its work is in its branch) and its
 * branch. Only ut/ branches are ever deleted, and an unmerged one only when confirmed.
 */
export async function removeTaskWorktree(
  options: RemoveTaskWorktreeOptions
): Promise<RemoveTaskWorktreeResult> {
  const { repoPath, worktreePath, branch } = options;
  let worktreeRemoved = !worktreePath;
  if (worktreePath) {
    const r = await git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
    worktreeRemoved = r.code === 0 || !fs.existsSync(worktreePath);
    // The .untether-worktrees/<repo> folders left empty go too (2026-10-18: one stayed in the
    // project after its only task was discarded). rmdir only ever removes an empty folder.
    const repoFolder = path.dirname(worktreePath);
    const root = path.dirname(repoFolder);
    if (path.basename(root) === WORKTREE_DIR) {
      for (const dir of [repoFolder, root]) await fs.promises.rmdir(dir).catch(() => undefined);
    }
  }
  await git(repoPath, ['worktree', 'prune']);
  if (!branch?.startsWith(TASK_BRANCH_PREFIX) || !isSafeRefName(branch)) {
    return { worktreeRemoved, branchDeleted: false };
  }
  if (!(await branchExists(repoPath, branch))) return { worktreeRemoved, branchDeleted: true };
  const r = await git(repoPath, ['branch', options.deleteUnmerged ? '-D' : '-d', branch]);
  if (r.code === 0) return { worktreeRemoved, branchDeleted: true };
  return { worktreeRemoved, branchDeleted: false, error: tail(output(r), 3).join('\n') };
}

/** Uncommitted changes in the worktree (ignored files aside). */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const status = await gitRead(worktreePath, ['status', '--porcelain']);
  return status.code === 0 && status.stdout.trim() !== '';
}

/** Commits on the task's branch that are not in `baseSha`. */
export async function commitsAhead(worktreePath: string, baseSha: string): Promise<number> {
  const out = await gitOut(worktreePath, ['rev-list', '--count', `${baseSha}..HEAD`]);
  return Number.parseInt(out ?? '0', 10) || 0;
}

/** Dependency folders an auto-commit never adds, even where .gitignore misses them. */
export const NEVER_COMMITTED = ['**/node_modules/**'];

/**
 * What an auto-commit leaves out: dependency folders, plus the project's own cloneDirs.
 * 2026-10-20: only node_modules was left out, so a project cloning `vendor` or `.venv` into
 * its worktrees got them committed as the agent's work.
 */
export function leftoverExcludes(cloneDirs: readonly string[] = []): string[] {
  const extra = cloneDirs
    .map((dir) => path.normalize(dir).replace(/\/+$/, ''))
    .filter((dir) => dir && dir !== '.' && !dir.startsWith('..') && !path.isAbsolute(dir))
    .map((dir) => `${dir}/**`);
  return [...new Set([...NEVER_COMMITTED, ...extra])];
}

/** The blocker message when committing the agent's leftovers fails (hooks, a merge underway). */
export const LEFTOVERS_FAILED = 'Committing what the agent left failed';

/** Deleted files from which a worktree missing half its tracked files is "half deleted". */
const HALF_DELETED_MIN = 20;

/** A merge (or cherry-pick, revert) the agent started and did not finish in the worktree. */
async function operationInProgress(worktreePath: string): Promise<string | null> {
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if ((await git(worktreePath, ['rev-parse', '-q', '--verify', ref])).code === 0) return ref;
  }
  return null;
}

/**
 * Commit what the agent left uncommitted (the hooks run), leaving out `exclude` (glob
 * pathspecs). Resolves to whether a commit was made; throws when the commit fails.
 */
export async function commitLeftovers(
  worktreePath: string,
  message: string,
  exclude: string[] = []
): Promise<boolean> {
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (status.code !== 0 || !status.stdout.trim()) return false;
  // 2026-10-20: an agent left `git merge` half done; `add -A` + commit would have recorded
  // its conflict markers as a finished merge. The agent (or the user) finishes it instead.
  const inProgress = await operationInProgress(worktreePath);
  if (inProgress) {
    throw new TaskWorktreeError(
      `A ${inProgress === 'MERGE_HEAD' ? 'merge' : inProgress === 'CHERRY_PICK_HEAD' ? 'cherry-pick' : 'revert'} is under way in the worktree: its leftovers were not committed`,
      ['Resolve the conflicts and commit (or abort it), then finish again']
    );
  }
  // 2026-10-18: a server restart cut a merge's cleanup halfway through removing the worktree;
  // the merge, run again, committed the half-deleted folder (94 files gone). A worktree that
  // lost most of its files is not an agent's work: never committed.
  const deleted = status.stdout.split('\n').filter((line) => /^( D|D )/.test(line)).length;
  if (deleted >= HALF_DELETED_MIN) {
    const tracked = ((await gitOut(worktreePath, ['ls-files'])) ?? '')
      .split('\n')
      .filter(Boolean).length;
    if (deleted * 2 >= tracked) {
      throw new TaskWorktreeError(
        'The worktree looks half deleted: its leftovers were not committed',
        [`${deleted} of ${tracked} tracked files are missing`]
      );
    }
  }
  const excludes = exclude.map((pattern) => `:(exclude,glob)${pattern}`);
  const add = await git(worktreePath, ['add', '-A', '--', '.', ...excludes]);
  if (add.code !== 0) throw new TaskWorktreeError('Could not stage the changes', tail(output(add)));
  const staged = await git(worktreePath, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return false;
  const commit = await git(worktreePath, ['commit', '-m', message], COMMIT_TIMEOUT_MS);
  if (commit.code !== 0) {
    throw new TaskWorktreeError('Committing the changes failed', tail(output(commit)));
  }
  return true;
}

/**
 * Work in the worktree that exists nowhere else: modified or new files (`exclude` aside).
 * Deleted tracked files are not counted: their content is in the branch, and a `worktree
 * remove` cut short leaves exactly those behind.
 */
export async function unsavedChanges(
  worktreePath: string,
  exclude: string[] = []
): Promise<{ tracked: string[]; untracked: string[] } | null> {
  const excludes = exclude.map((pattern) => `:(exclude,glob)${pattern}`);
  const r = await gitRead(worktreePath, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
    ...excludes,
  ]);
  if (r.code !== 0) return null;
  const tracked: string[] = [];
  const untracked: string[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    // A rename or copy is followed by its old path.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (xy === '??') untracked.push(file);
    else if (/^[ D][ D]$/.test(xy)) continue;
    else tracked.push(file);
  }
  return { tracked, untracked };
}

/** A file with uncommitted changes in a checkout, and how it looked (TaskRecord.startDirty). */
export interface DirtyFile {
  file: string;
  /** Status, size and modification time: a different one means it was changed again. */
  sig: string;
}

/**
 * Every modified, deleted or new file in a checkout (ignored files and NEVER_COMMITTED aside),
 * with a signature of how it looks now; null when `dir` is not in a git repository.
 */
export async function dirtyFiles(dir: string): Promise<DirtyFile[] | null> {
  const excludes = NEVER_COMMITTED.map((pattern) => `:(exclude,glob)${pattern}`);
  const top = await gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const r = await gitRead(top, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
    ...excludes,
  ]);
  if (r.code !== 0) return null;
  const files: DirtyFile[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    let stat = 'gone';
    try {
      const info = fs.statSync(path.join(top, file));
      stat = `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {}
    files.push({ file, sig: `${xy}:${stat}` });
  }
  return files;
}

/**
 * When the work in a checkout last moved (2026-11-02, a task's progress): its newest commit
 * (committer time) or the newest change to a file with uncommitted changes, whichever is later.
 * Ignored files (build output, coverage, a test run's logs) do not count. Undefined outside git.
 */
export async function worktreeActivity(
  dir: string
): Promise<{ at: number; by: 'files' | 'commit' } | undefined> {
  const [commit, files] = await Promise.all([
    gitOut(dir, ['log', '-1', '--format=%ct']),
    dirtyFiles(dir),
  ]);
  let best: { at: number; by: 'files' | 'commit' } | undefined;
  const seconds = Number(commit?.trim());
  if (Number.isFinite(seconds) && seconds > 0) best = { at: seconds * 1000, by: 'commit' };
  for (const { sig } of files ?? []) {
    const mtime = Number(sig.split(':')[2]);
    if (Number.isFinite(mtime) && mtime > (best?.at ?? 0)) best = { at: mtime, by: 'files' };
  }
  return best;
}

/**
 * What keeps a fast-forward of the checkout at `dir` from going in without touching the user's
 * work (2026-11-04: tasks waited «ready · dirty-base» for hours over unrelated edits in the main
 * checkout, mdns-service.ts): the files the merge changes (`git diff <diffArgs>`, renames on both
 * sides) that have uncommitted changes there, staged or not, and the files it adds that something
 * not tracked already occupies (an untracked file or folder, or a file where it needs a folder;
 * ignored files aside, which git replaces anyway). `local` counts the uncommitted tracked files.
 * Null when git cannot read the checkout or the range. Git's own refusal stays the last guard.
 */
export async function checkoutInTheWay(
  dir: string,
  diffArgs: [string] | [string, string]
): Promise<{ overlap: string[]; local: number } | null> {
  const [status, diff] = await Promise.all([
    gitRead(dir, ['status', '--porcelain', '-z', '--untracked-files=no']),
    git(dir, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', ...diffArgs, '--']),
  ]);
  if (status.code !== 0 || diff.code !== 0) return null;
  const local = new Set<string>();
  // -z: "XY path\0", a rename or copy as "XY to\0from\0".
  const entries = status.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    local.add(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') local.add(entries[++i] ?? '');
  }
  const touched = new Set<string>();
  const added = new Set<string>();
  // -z: "<status>\0path\0", a rename or copy as "R100\0from\0to\0".
  const parts = diff.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const kind = parts[i];
    if (!kind) continue;
    if (kind[0] === 'R' || kind[0] === 'C') {
      const from = parts[++i] ?? '';
      const to = parts[++i] ?? '';
      if (kind[0] === 'R') touched.add(from);
      touched.add(to);
      added.add(to);
    } else {
      const file = parts[++i] ?? '';
      touched.add(file);
      if (kind[0] === 'A' || kind[0] === 'T') added.add(file);
    }
  }
  const overlap = new Set([...touched].filter((file) => file && local.has(file)));
  // Added paths something untracked already holds: the path itself, or a parent that is a file.
  const occupied = new Set<string>();
  for (const file of added) {
    const segments = file.split('/');
    for (let depth = 1; depth <= segments.length; depth++) {
      const sub = segments.slice(0, depth).join('/');
      if (touched.has(sub) && sub !== file) continue;
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(path.join(dir, sub));
      } catch {
        break;
      }
      if (depth === segments.length || !stat.isDirectory()) {
        occupied.add(sub);
        break;
      }
    }
  }
  if (occupied.size) {
    // A folder where the merge adds a file is in the way only with untracked, not ignored files
    // in it: tracked ones the merge deletes (their local edits are in `overlap` already).
    // 2026-11-04 review: ls-files on the folder listed docs/a.txt, never "docs", so a clean
    // checkout waited forever. A file: unless tracked (a type change) or ignored.
    const folders: string[] = [];
    const files: string[] = [];
    for (const sub of occupied) {
      let isFolder = false;
      try {
        isFolder = fs.lstatSync(path.join(dir, sub)).isDirectory();
      } catch {}
      (isFolder ? folders : files).push(sub);
    }
    const [tracked, ignored, ...inside] = await Promise.all([
      files.length
        ? git(dir, ['ls-files', '-z', '--', ...files.map((file) => `:(literal)${file}`)])
        : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      // One path per line, unquoted (-z needs --stdin): a name with a newline is never skipped.
      files.length
        ? git(dir, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...files])
        : Promise.resolve({ code: 1, stdout: '', stderr: '' }),
      ...folders.map((folder) =>
        git(dir, ['ls-files', '-z', '--others', '--exclude-standard', '--', `:(literal)${folder}/`])
      ),
    ]);
    if (tracked.code !== 0 || ignored.code > 1 || inside.some((r) => r.code !== 0)) return null;
    const skip = new Set([...tracked.stdout.split('\0'), ...ignored.stdout.split('\n')]);
    for (const file of files) if (!skip.has(file)) overlap.add(file);
    folders.forEach((folder, i) => {
      if (inside[i].stdout.split('\0').some(Boolean)) overlap.add(folder);
    });
  }
  return { overlap: [...overlap].sort(), local: local.size };
}

/**
 * The checkout of `base` in `repoPath` holds uncommitted work the merge of `branch` would
 * touch (checkoutInTheWay over the branch's own changes, `base...branch`): what stops the
 * merge's fast-forward (task-merge-base.ts moveBase). False when the base is checked out nowhere
 * (the merge moves it without touching a folder) or its changes are in other files.
 */
export async function baseCheckoutDirty(
  repoPath: string,
  base: string,
  branch: string
): Promise<boolean> {
  const list = await gitOut(repoPath, ['worktree', 'list', '--porcelain']);
  if (list === null) throw new Error(`Could not list the worktrees of ${repoPath}`);
  const checkedOut = parseWorktreePorcelain(`${list}\n`).find(
    (entry) => entry.branch === `refs/heads/${base}` && !entry.prunable
  );
  if (!checkedOut) return false;
  const inTheWay = await checkoutInTheWay(checkedOut.path, [
    `refs/heads/${base}...refs/heads/${branch}`,
  ]);
  if (!inTheWay) throw new Error(`Could not read ${checkedOut.path}`);
  return inTheWay.overlap.length > 0;
}

/** A ref's commit as seen from `worktreePath` (a base branch's tip), null when it does not resolve. */
export async function refCommit(worktreePath: string, ref: string): Promise<string | null> {
  return gitOut(worktreePath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** What the task's branch changed since `baseSha`: files and counts, from their merge-base. */
export async function branchChanges(
  worktreePath: string,
  baseSha: string
): Promise<{
  files: string[];
  stats: { commits: number; files: number; insertions: number; deletions: number };
  /** Renamed files, the path each had before (`files` holds the new one). */
  renamed: { from: string; to: string }[];
}> {
  const commits = await commitsAhead(worktreePath, baseSha);
  const numstat = await gitOut(worktreePath, ['diff', '--numstat', '-z', `${baseSha}...HEAD`]);
  const files: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  let insertions = 0;
  let deletions = 0;
  if (numstat) {
    // -z: "<added>\t<deleted>\t<path>\0", a rename as "<a>\t<d>\t\0<from>\0<to>\0".
    const parts = numstat.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const match = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
      if (!match) continue;
      insertions += Number.parseInt(match[1], 10) || 0;
      deletions += Number.parseInt(match[2], 10) || 0;
      if (match[3]) files.push(match[3]);
      else {
        const from = parts[i + 1] ?? '';
        const to = parts[i + 2] ?? from;
        files.push(to);
        if (from && to && from !== to) renamed.push({ from, to });
        i += 2;
      }
    }
  }
  return {
    files: files.filter(Boolean),
    stats: { commits, files: files.length, insertions, deletions },
    renamed,
  };
}

export type RevertResult =
  | { ok: true; commits: number }
  | { ok: false; conflict: boolean; message: string; files: string[] };

/** The command that undoes what a merge changed in its base (the revert task's agent too). */
export function undoMergeCommand(range: { from: string; to: string }): string {
  return `git diff --binary --full-index ${range.from} ${range.to} | git apply --3way --index -R`;
}

/**
 * Undo a merged task's change in `worktreePath` ("Deshacer"). 2026-10-20: it reverted the
 * task's non-merge commits only (rev-list --no-merges), so what an agent changed in a "merge
 * base into branch" commit (conflict resolutions, files added there) stayed in the base after
 * the undo. Now the exact change the merge made to the base, the diff mergedOnto..mergedSha
 * (`range`), is applied in reverse with a 3-way merge and committed as one commit. A conflict
 * (or a file later removed) is reset at once and reported with its files, for an agent to
 * resolve; the worktree is left as it was. `commits` is how many commits of the task it undid.
 */
export async function revertRange(
  worktreePath: string,
  range: { from: string; to: string },
  message: string
): Promise<RevertResult> {
  // Written by git itself to a private file: the patch never goes through a JS string (a
  // non-UTF-8 file would be mangled) or a shell.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untether-undo-'));
  const patch = path.join(dir, 'undo.patch');
  try {
    const diff = await git(
      worktreePath,
      ['diff', '--binary', '--full-index', `--output=${patch}`, range.from, range.to],
      COMMIT_TIMEOUT_MS
    );
    if (diff.code !== 0) {
      return {
        ok: false,
        conflict: false,
        message: 'Could not read the change to undo',
        files: tail(output(diff), 10),
      };
    }
    if (!fs.statSync(patch).size) {
      return {
        ok: false,
        conflict: false,
        message: 'The task changed nothing in its base: there is nothing to undo',
        files: [],
      };
    }
    return await applyUndo(worktreePath, range, patch, message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function applyUndo(
  worktreePath: string,
  range: { from: string; to: string },
  patch: string,
  message: string
): Promise<RevertResult> {
  const counted = await gitOut(worktreePath, ['rev-list', '--count', `${range.from}..${range.to}`]);
  const commits = Number.parseInt(counted ?? '0', 10) || 0;
  const applied = await git(
    worktreePath,
    ['apply', '--3way', '--index', '-R', patch],
    COMMIT_TIMEOUT_MS
  );
  if (applied.code !== 0) {
    const conflicted = await gitOut(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
    // Back to the commit it was made from: nothing of the half-applied undo stays.
    await git(worktreePath, ['reset', '-q', '--hard', 'HEAD']);
    const unmerged = conflicted ? conflicted.split('\n').filter(Boolean) : [];
    // A file that is gone or changed beyond a 3-way merge: "error: <path>: …".
    const failed = `${applied.stderr}\n${applied.stdout}`
      .split('\n')
      .map(
        (line) =>
          /^error: patch failed: (.+):\d+$/.exec(line)?.[1] ??
          /^error: (.+?): (?:does not exist in index|does not match index|already exists in (?:index|working directory)|patch does not apply|No such file or directory)/.exec(
            line
          )?.[1]
      )
      .filter((file): file is string => !!file);
    const files = [...new Set([...unmerged, ...failed])];
    return {
      ok: false,
      conflict: files.length > 0,
      message: files.length ? 'Undoing it conflicts with later changes' : 'git apply failed',
      files: files.length
        ? files
        : `${applied.stdout}\n${applied.stderr}`.trim().split('\n').slice(-10),
    };
  }
  const committed = await git(
    worktreePath,
    ['commit', '--no-edit', '-m', message],
    COMMIT_TIMEOUT_MS
  );
  if (committed.code !== 0) {
    await git(worktreePath, ['reset', '-q', '--hard', 'HEAD']);
    return {
      ok: false,
      conflict: false,
      message: 'Committing the undo failed',
      files: `${committed.stdout}\n${committed.stderr}`.trim().split('\n').slice(-10),
    };
  }
  return { ok: true, commits };
}

/**
 * A git command that only reads, run in a folder whose agent is at work (2026-11-11): with
 * --no-optional-locks it never takes index.lock to refresh the index, so it cannot make the
 * agent's own `git add` or `git commit` fail on "index.lock: File exists", nor leave a stale
 * lock behind if it is killed (this very task's merge stopped on one, 4 minutes old and held
 * by no process).
 */
function gitRead(cwd: string, args: string[]): Promise<RunResult> {
  return git(cwd, ['--no-optional-locks', ...args]);
}

/**
 * Every file the work in a task's worktree touches against `baseRef` (2026-11-11, overlap
 * between tasks): committed since their merge-base, changed and not committed, and new files
 * not tracked yet (ignored ones aside). A rename counts as both its paths. Two git commands,
 * nothing written, not even the index; null when git cannot answer (no worktree, no such base).
 */
export async function worktreeTouched(dir: string, baseRef: string): Promise<string[] | null> {
  // Neither writes the index: a diff between commits never reads it, and `status` without
  // optional locks compares in memory (a `git diff` against the folder would refresh it on
  // disk, and with that refresh off it calls a file changed for a new timestamp alone).
  const [committed, pending] = await Promise.all([
    gitRead(dir, ['diff', '--name-only', '--no-renames', '-z', `${baseRef}...HEAD`]),
    gitRead(dir, ['status', '--porcelain', '-z', '--untracked-files=all']),
  ]);
  if (committed.code !== 0 || pending.code !== 0) return null;
  const files = new Set<string>(trackedChanges(pending.stdout));
  for (const file of committed.stdout.split('\0')) if (file) files.add(file);
  return [...files].sort();
}

/** The merge of the base into a working task's branch: inside the hold of its agent's tools. */
const SYNC_MERGE_TIMEOUT_MS = 5_000;

/**
 * The files with changes in `git status --porcelain -z` output (untracked ones too when it was
 * asked for them). A rename or copy
 * ("R  new\0old\0") names two paths, the second without a status in front: both count.
 */
function trackedChanges(porcelainZ: string): string[] {
  const files: string[] = [];
  const parts = porcelainZ.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if ((entry[0] === 'R' || entry[0] === 'C') && parts[i + 1]) files.push(parts[++i]);
  }
  return files;
}

/** What bringing a task's branch up to date with its base came to (syncWithBase). */
export type BaseSyncResult =
  /** The base's tip is in the branch already (the agent merged it, or nothing moved). */
  | { kind: 'current'; base: string }
  /** Merged cleanly: `files` are the ones that changed in the worktree. */
  | { kind: 'merged'; base: string; head: string; files: string[] }
  /** It does not merge cleanly: nothing was touched. */
  | { kind: 'conflict'; base: string; files: string[] }
  /** Tracked files with uncommitted changes: nothing was touched. */
  | { kind: 'dirty'; files: string[] }
  /** A merge, cherry-pick or revert of the agent's is under way, or it took up a tool again. */
  | { kind: 'busy'; why: string }
  | { kind: 'error'; message: string };

/**
 * Brings the branch checked out in `worktreePath` up to date with `baseBranch` while its agent
 * still works (2026-11-11), without ever touching work that is not committed:
 *
 * - tracked files with uncommitted changes (staged or not), or a merge of the agent's own
 *   under way: nothing is done ('dirty', 'busy'); the caller tries again at a later gap;
 * - the merge is first computed without the worktree (`git merge-tree`): a conflict changes
 *   nothing and comes back with its files, for the agent to resolve;
 * - only a clean merge is made, and only while the agent's tool calls are held back (`hold`:
 *   each new call waits in its PreToolUse hook until the merge is over): with the hold on,
 *   `stillFree()` must say once more that the agent runs no tool, and the folder must be as
 *   it was looked at (nothing uncommitted, the same commit). No hold to be had: no merge. Git
 *   itself still refuses to overwrite a changed or untracked file, and a merge that stops
 *   halfway is aborted, which puts the worktree back as it was.
 */
export async function syncWithBase(
  worktreePath: string,
  baseBranch: string,
  options: {
    stillFree?: () => boolean;
    /**
     * Holds the agent's tool calls back until the returned function is called (task-guard-setup.ts
     * holdTools); null when they cannot be held: then nothing is merged.
     */
    hold?: () => (() => void) | null | Promise<(() => void) | null>;
    /** The pause after the hold before the gap is asked again (400 ms; tests: 0). */
    settleMs?: number;
  } = {}
): Promise<BaseSyncResult> {
  const base = await refCommit(worktreePath, `refs/heads/${baseBranch}`);
  if (!base) return { kind: 'error', message: `No branch ${baseBranch} seen from the worktree` };
  const head = await gitOut(worktreePath, ['rev-parse', 'HEAD']);
  if (!head) return { kind: 'error', message: 'The worktree has no commit' };
  if ((await git(worktreePath, ['merge-base', '--is-ancestor', base, head])).code === 0) {
    return { kind: 'current', base };
  }
  const inProgress = await operationInProgress(worktreePath);
  if (inProgress) return { kind: 'busy', why: `${inProgress} in the worktree` };
  const status = await gitRead(worktreePath, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=no',
  ]);
  if (status.code !== 0) return { kind: 'error', message: tail(output(status), 3).join('\n') };
  const dirty = trackedChanges(status.stdout);
  if (dirty.length) return { kind: 'dirty', files: dirty.slice(0, 50) };
  const tree = await gitRead(worktreePath, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    head,
    base,
  ]);
  if (tree.code === 1) {
    // "<tree>\0<file>\0<file>\0": the files in conflict, each once.
    const files = [...new Set(tree.stdout.split('\0').slice(1).filter(Boolean))];
    return { kind: 'conflict', base, files: files.slice(0, 50) };
  }
  if (tree.code !== 0) return { kind: 'error', message: tail(output(tree), 3).join('\n') };
  const branch = (await gitOut(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'the task';
  // From here to the end of the merge no tool call of the agent starts: the hold makes each
  // new call wait in its PreToolUse hook. A call whose hook had passed just before shows in
  // the agent's events within the settle, and one already at work left the folder as the
  // looks below find it.
  const release = options.hold ? await options.hold() : undefined;
  if (options.hold && !release) {
    return { kind: 'busy', why: "its agent's tool calls cannot be held (no guard hook)" };
  }
  let merged: RunResult;
  try {
    if (release) await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 400));
    if (options.stillFree && !options.stillFree()) {
      return { kind: 'busy', why: 'its agent took up a tool again' };
    }
    const again = await gitRead(worktreePath, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=no',
    ]);
    if (again.code !== 0 || trackedChanges(again.stdout).length) {
      return { kind: 'dirty', files: trackedChanges(again.stdout).slice(0, 50) };
    }
    if ((await gitOut(worktreePath, ['rev-parse', 'HEAD'])) !== head) {
      return { kind: 'busy', why: 'its agent committed meanwhile' };
    }
    merged = await git(
      worktreePath,
      ['merge', '--no-edit', '-m', `Merge ${baseBranch} into ${branch}`, base],
      // Inside the hold (task-guard.ts TOOL_HOLD_MAX_MS): a merge slower than this is stopped
      // and undone rather than left running once the agent's calls go on.
      SYNC_MERGE_TIMEOUT_MS
    );
    if (merged.code !== 0) {
      if (await operationInProgress(worktreePath)) await git(worktreePath, ['merge', '--abort']);
      // Git refused over a file changed since the look above: the agent's work stays as it is.
      return { kind: 'busy', why: tail(output(merged), 3).join(' ').slice(0, 300) };
    }
  } finally {
    release?.();
  }
  const now = (await gitOut(worktreePath, ['rev-parse', 'HEAD'])) ?? base;
  const changed = await gitOut(worktreePath, ['diff', '--name-only', '--no-renames', head, now]);
  return { kind: 'merged', base, head: now, files: changed ? changed.split('\n') : [] };
}
