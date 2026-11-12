/**
 * Files a check can read that never travel with the merge: on disk in the worktree, ignored by
 * git (2026-11-11: task e9d0a7f3 created a test fixture `*.cast`, web/.gitignore ignored it, the
 * check passed in its worktree, the merge left the file behind and the base went red with ENOENT).
 *
 * Untracked files that are not ignored are committed with the agent's leftovers, so they do
 * travel. Ignored ones do not. But a project is full of legitimate ignored files (.env, caches,
 * Docker data, development databases, IDE folders, build output), so a check is only refused on
 * proof that one matters: the file was CREATED OR MODIFIED DURING THE TASK (mtime after the
 * worktree was made) and sits in a folder that holds versioned files (code or tests, never a
 * whole ignored root), is not executable (build output), and is not a known artifact, one of
 * the project's cloneDirs or its own `artifactPaths`. Everything else ignored is only reported as a note.
 */
import * as fs from 'fs';
import * as path from 'path';
import { run } from '../utils/exec-file.js';
import { globToRegExp } from './task-risk.js';

/** Folders whose ignored contents are build output, dependencies or caches, at any depth. */
const ARTIFACT_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-npm',
  'build',
  '.build',
  'target',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  'DerivedData',
  'Pods',
  'output',
  'logs',
  'temp-spawn-helper',
  '.vite',
  '.eslintcache',
]);

/** Ignored files that are generated or local by nature (logs, secrets, OS and tool litter). */
const ARTIFACT_FILES: RegExp[] = [
  /\.log$/,
  /\.pid(\.lock)?$/,
  /\.seed$/,
  /\.tsbuildinfo$/,
  /\.(pyc|pyo|o|a|dylib|so|exe|tgz)$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)spawn-helper[^/]*$/,
  // The stamp build-fwd-rust.js writes beside a forwarder binary (fwd-source-hash.js).
  // 2026-11-12: a task whose test preparation rebuilt the forwarder could not merge over it.
  /(^|\/)untether-fwd(\.source-hash)?$/,
  /(^|\/)public\/bundle(\/|$)/,
];

/** Whether an ignored path is a known artifact rather than something a check may read. */
export function isKnownArtifact(file: string, extraDirs: readonly string[] = []): boolean {
  const clean = file.replace(/\/+$/, '');
  const segments = clean.split('/');
  if (segments.some((segment) => ARTIFACT_DIRS.has(segment))) return true;
  if (extraDirs.some((dir) => clean === dir || clean.startsWith(`${dir}/`))) return true;
  return ARTIFACT_FILES.some((pattern) => pattern.test(clean));
}

export interface IgnoredInputs {
  /** Created or modified during the task, in a folder with versioned files: they matter. */
  blocking: string[];
  /** Ignored and not an artifact, but with no proof they matter: only reported. */
  note: string[];
}

export interface IgnoredInputsOptions {
  cloneDirs?: readonly string[];
  /** The project's own artifact paths (globs, or a folder: `data/` or `data`). */
  artifactPaths?: readonly string[];
  /** ms: the worktree's creation; files not touched since are pre-existing. */
  since: number;
}

/** When the worktree was made (its `.git` file); null when it can't be read. */
export function worktreeCreatedAt(dir: string): number | null {
  try {
    return fs.statSync(path.join(dir, '.git')).birthtimeMs;
  } catch {
    return null;
  }
}

/** Every folder that holds a versioned file, ancestors included ('' is the root). */
async function versionedDirs(dir: string): Promise<Set<string> | null> {
  const r = await run('git', ['ls-files', '-z'], dir, 30_000);
  if (r.code !== 0) return null;
  const dirs = new Set<string>(['']);
  for (const file of r.stdout.split('\0').filter(Boolean)) {
    let parent = path.posix.dirname(file);
    while (parent !== '.' && !dirs.has(parent)) {
      dirs.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return dirs;
}

/**
 * The ignored files in `dir` that are not known artifacts, split into those that block a check
 * and a note. Whole ignored folders (reported by git as `folder/`) never block. null when git
 * could not say: the guard then stays out of the way.
 */
export async function ignoredInputs(
  dir: string,
  options: IgnoredInputsOptions
): Promise<IgnoredInputs | null> {
  const r = await run(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    dir,
    30_000
  );
  if (r.code !== 0) return null;
  const extra = (options.cloneDirs ?? []).map((d) => d.replace(/\/+$/, ''));
  const declared = (options.artifactPaths ?? [])
    .map((glob) => glob.trim())
    .filter(Boolean)
    .map((glob) => globToRegExp(glob.endsWith('/') ? `${glob}**` : glob));
  const all = r.stdout.split('\0').filter(Boolean);
  // `--directory` also names the untracked folders that merely hold ignored files: only the
  // deepest entries are the ignored ones.
  const entries = all
    .filter((file) => !(file.endsWith('/') && all.some((o) => o !== file && o.startsWith(file))))
    .filter((file) => !isKnownArtifact(file, extra))
    .filter((file) => !declared.some((pattern) => pattern.test(file.replace(/\/+$/, ''))))
    .sort();
  const files = entries.filter((file) => !file.endsWith('/'));
  const dirs = files.length ? await versionedDirs(dir) : new Set<string>();
  if (!dirs) return null;
  const blocking: string[] = [];
  const note: string[] = [];
  for (const file of entries) {
    if (file.endsWith('/')) {
      note.push(file);
      continue;
    }
    let touched = false;
    try {
      const stat = fs.lstatSync(path.join(dir, file));
      // An executable is a build output (2026-11-11: web/bin/untether-fwd, compiled by a task's
      // own check), never a fixture or source.
      touched = stat.mtimeMs >= options.since && (stat.mode & 0o111) === 0;
    } catch {
      // Gone meanwhile: nothing to read.
    }
    const parent = path.posix.dirname(file);
    (touched && dirs.has(parent === '.' ? '' : parent) ? blocking : note).push(file);
  }
  return { blocking, note };
}

/** What the agent reads when its check is refused because of such files. */
export function ignoredInputsMessage(files: readonly string[]): string {
  const shown = files.slice(0, 20);
  return [
    'These files were created or changed during the task, sit among versioned files and git ignores them, so they exist here but do not travel with the merge:',
    ...shown.map((file) => `  ${file}`),
    ...(files.length > shown.length ? [`  … and ${files.length - shown.length} more`] : []),
    'A check that passes with them says nothing about the merged tree. Do one of these, then finish again:',
    '  - version them: add an exception to .gitignore (e.g. `!path/to/file`) and `git add` the file;',
    '  - delete them if the code does not need them;',
    "  - declare them an artifact if they are local by nature: add their path to the project's `artifactPaths` setting.",
  ].join('\n');
}
