import { execFile as execFileCb } from 'child_process';
import type { Router } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { isSafeRefName } from '../utils/exec-file.js';
import { createGitError, isGitNotFoundError, isNotGitRepositoryError } from '../utils/git-error.js';
import { createLogger } from '../utils/logger.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';

const logger = createLogger('git-changes');
const execFile = promisify(execFileCb);

/** Diffs bigger than this are cut (at a line boundary) and flagged `truncated`. */
export const MAX_DIFF_BYTES = 200 * 1024;
/** Untracked files bigger than this are not read for line counts. */
const MAX_UNTRACKED_COUNT_BYTES = 2 * 1024 * 1024;
/** Untracked files listed at most (a forgotten node_modules must not flood the phone). */
const MAX_UNTRACKED_FILES = 500;
/** SHA-1 empty tree: the diff base for a repository without any commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'T' | '??';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangesSummary {
  isGitRepo: boolean;
  repoPath?: string;
  files: ChangedFile[];
  totals: { files: number; additions: number; deletions: number };
  untrackedTruncated?: boolean;
}

export interface FileDiff {
  file: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
  untracked: boolean;
}

async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execFile('git', args, {
      cwd,
      timeout: 10000,
      maxBuffer,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (error) {
    throw createGitError(error, 'Git command failed');
  }
}

async function repoRootOf(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
}

/**
 * What the changes are counted from: HEAD (uncommitted work), or with `since` (a task's base
 * branch) where the checked-out branch left it, so a task's own commits show as its changes.
 */
async function diffBase(repoRoot: string, since?: string): Promise<string> {
  if (since) {
    try {
      const mergeBase = (await git(repoRoot, ['merge-base', 'HEAD', since])).trim();
      if (/^[0-9a-f]{7,64}$/.test(mergeBase)) return mergeBase;
    } catch {
      // Unknown ref or unrelated history: count from HEAD as usual.
    }
  }
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return 'HEAD';
  } catch {
    return EMPTY_TREE;
  }
}

function isBinaryBuffer(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8000);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

/**
 * Resolve a repo-relative file path, refusing anything that escapes the repo.
 * Returns the normalized repo-relative path (forward slashes) or null.
 */
export function safeRepoRelative(repoRoot: string, file: string): string | null {
  if (!file || file.includes('\0') || path.isAbsolute(file)) return null;
  const abs = path.resolve(repoRoot, file);
  const rel = path.relative(repoRoot, abs);
  // "..env" is a real file name; only ".." as a whole path segment leaves the repo.
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Parse `git diff --name-status -z -M` output. */
function parseNameStatus(out: string): Map<string, { status: ChangeStatus; oldPath?: string }> {
  const parts = out.split('\0');
  const result = new Map<string, { status: ChangeStatus; oldPath?: string }>();
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    if (!code) {
      i++;
      continue;
    }
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      result.set(newPath, letter === 'R' ? { status: 'R', oldPath } : { status: 'A' });
      i += 3;
    } else {
      const status: ChangeStatus =
        letter === 'A' ? 'A' : letter === 'D' ? 'D' : letter === 'T' ? 'T' : 'M';
      result.set(parts[i + 1], { status });
      i += 2;
    }
  }
  return result;
}

/** Parse `git diff --numstat -z -M` output, keyed by (new) path. */
function parseNumstat(
  out: string
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = out.split('\0');
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry) {
      i++;
      continue;
    }
    const [add, del, p] = entry.split('\t');
    let file = p;
    i++;
    if (p === '' || p === undefined) {
      // Rename: "add\tdel\t" NUL old NUL new
      file = parts[i + 1];
      i += 2;
    }
    const binary = add === '-' && del === '-';
    result.set(file, {
      additions: binary ? 0 : Number.parseInt(add, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(del, 10) || 0,
      binary,
    });
  }
  return result;
}

async function listUntracked(
  repoRoot: string,
  pathspec?: string,
  collapseDirectories = false
): Promise<string[]> {
  const args = ['ls-files', '--others', '--exclude-standard', '-z'];
  // For the summary, an untracked folder (a forgotten node_modules: 100k+ files) is one
  // entry; listing every file overflowed git's output buffer and failed the whole list.
  if (collapseDirectories) args.push('--directory', '--no-empty-directory');
  if (pathspec) args.push('--', `:(literal)${pathspec}`);
  return (await git(repoRoot, args)).split('\0').filter((p) => p.length > 0);
}

async function readUntracked(
  repoRoot: string,
  rel: string,
  limit: number
): Promise<{ buf: Buffer | null; size: number }> {
  const abs = path.join(repoRoot, rel);
  const st = await fs.lstat(abs);
  if (st.isSymbolicLink()) {
    return { buf: Buffer.from(`${await fs.readlink(abs)}\n`), size: st.size };
  }
  if (!st.isFile()) return { buf: null, size: st.size };
  if (st.size > limit) {
    // Too big to count lines anyway: read just enough to tell text from binary.
    const sniff = 8192;
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(sniff);
      const { bytesRead } = await fh.read(buf, 0, sniff, 0);
      return { buf: buf.subarray(0, bytesRead), size: st.size };
    } finally {
      await fh.close();
    }
  }
  return { buf: await fs.readFile(abs), size: st.size };
}

export async function getChanges(dir: string, since?: string): Promise<ChangesSummary> {
  let repoRoot: string;
  try {
    repoRoot = await repoRootOf(dir);
  } catch (error) {
    if (isNotGitRepositoryError(error) || isGitNotFoundError(error)) {
      return { isGitRepo: false, files: [], totals: { files: 0, additions: 0, deletions: 0 } };
    }
    throw error;
  }
  const base = await diffBase(repoRoot, since);
  const common = ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-color', '-M', '-z'];
  const [nameStatusOut, numstatOut, untrackedAll] = await Promise.all([
    git(repoRoot, [...common, '--name-status', base]),
    git(repoRoot, [...common, '--numstat', base]),
    listUntracked(repoRoot, undefined, true),
  ]);
  const statuses = parseNameStatus(nameStatusOut);
  const numstat = parseNumstat(numstatOut);

  const files: ChangedFile[] = [];
  for (const [file, s] of statuses) {
    const n = numstat.get(file) ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      path: file,
      ...(s.oldPath ? { oldPath: s.oldPath } : {}),
      status: s.status,
      ...n,
    });
  }

  const untracked = untrackedAll.slice(0, MAX_UNTRACKED_FILES);
  // A few at a time: 500 files read at once held up to 500 buffers in memory.
  const untrackedFiles: ChangedFile[] = [];
  for (let i = 0; i < untracked.length; i += 16) {
    untrackedFiles.push(
      ...(await Promise.all(
        untracked.slice(i, i + 16).map(async (file): Promise<ChangedFile> => {
          try {
            const { buf, size } = await readUntracked(repoRoot, file, MAX_UNTRACKED_COUNT_BYTES);
            const binary = buf ? isBinaryBuffer(buf) : true;
            const additions =
              buf && !binary && size <= MAX_UNTRACKED_COUNT_BYTES
                ? countLines(buf.toString('utf8'))
                : 0;
            return { path: file, status: '??', additions, deletions: 0, binary };
          } catch {
            return { path: file, status: '??', additions: 0, deletions: 0, binary: false };
          }
        })
      ))
    );
  }
  files.push(...untrackedFiles);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totals = files.reduce(
    (t, f) => ({
      files: t.files + 1,
      additions: t.additions + f.additions,
      deletions: t.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 }
  );
  return {
    isGitRepo: true,
    repoPath: repoRoot,
    files,
    totals,
    ...(untrackedAll.length > untracked.length ? { untrackedTruncated: true } : {}),
  };
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_DIFF_BYTES) return { text, truncated: false };
  let cut = Buffer.from(text, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8');
  // Drop a possibly split final character and the partial last line.
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl + 1);
  return { text: cut, truncated: true };
}

export class InvalidFileError extends Error {}

export async function getFileDiff(
  dir: string,
  file: string,
  oldFile?: string,
  since?: string
): Promise<FileDiff> {
  const repoRoot = await repoRootOf(dir);
  const rel = safeRepoRelative(repoRoot, file);
  const oldRel = oldFile ? safeRepoRelative(repoRoot, oldFile) : undefined;
  if (!rel || oldRel === null) throw new InvalidFileError('File is outside the repository');

  const untracked = (await listUntracked(repoRoot, rel)).includes(rel);
  if (untracked) {
    const { buf, size } = await readUntracked(repoRoot, rel, MAX_DIFF_BYTES + 1);
    if (!buf || isBinaryBuffer(buf)) {
      return { file: rel, diff: '', binary: true, truncated: false, untracked: true };
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    const body = lines.map((l) => `+${l}`).join('\n');
    const header = `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`;
    const { text: diff, truncated } = truncate(`${header}${body}\n`);
    return {
      file: rel,
      diff,
      binary: false,
      truncated: truncated || size > MAX_DIFF_BYTES,
      untracked,
    };
  }

  const base = await diffBase(repoRoot, since);
  const pathspecs = [`:(literal)${rel}`];
  if (oldRel && oldRel !== rel) pathspecs.push(`:(literal)${oldRel}`);
  const raw = await git(
    repoRoot,
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '-M',
      base,
      '--',
      ...pathspecs,
    ],
    32 * 1024 * 1024
  );
  const binary = !/^@@ /m.test(raw) && /^Binary files .* differ$/m.test(raw);
  const { text: diff, truncated } = truncate(raw);
  return { file: rel, diff: binary ? '' : diff, binary, truncated, untracked: false };
}

/** `since` from a query: undefined when absent, null when it is not a safe ref name. */
function sinceParam(value: unknown): string | undefined | null {
  if (value === undefined || value === '') return undefined;
  return isSafeRefName(value) ? value : null;
}

/**
 * GET /api/git/changes?path=<dir>[&since=<ref>]   changed files vs HEAD (+ untracked); with
 *                                                  `since`, vs where HEAD left <ref> (a task)
 * GET /api/git/changes/diff?path=<dir>&file=<repo-relative>[&oldFile=][&since=]  unified diff
 */
export function registerGitChangesRoutes(router: Router): void {
  router.get('/git/changes', async (req, res) => {
    const { path: queryPath } = req.query;
    if (!queryPath || typeof queryPath !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid path parameter' });
    }
    const since = sinceParam(req.query.since);
    if (since === null) return res.status(400).json({ error: 'Invalid since parameter' });
    try {
      return res.json(await getChanges(resolveAbsolutePath(queryPath), since));
    } catch (error) {
      logger.error('Error listing git changes:', error);
      return res.status(500).json({ error: 'Failed to list changes' });
    }
  });

  router.get('/git/changes/diff', async (req, res) => {
    const { path: queryPath, file, oldFile } = req.query;
    if (!queryPath || typeof queryPath !== 'string' || !file || typeof file !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid path/file parameter' });
    }
    if (oldFile !== undefined && typeof oldFile !== 'string') {
      return res.status(400).json({ error: 'Invalid oldFile parameter' });
    }
    const since = sinceParam(req.query.since);
    if (since === null) return res.status(400).json({ error: 'Invalid since parameter' });
    try {
      return res.json(
        await getFileDiff(resolveAbsolutePath(queryPath), file, oldFile || undefined, since)
      );
    } catch (error) {
      if (error instanceof InvalidFileError) {
        return res.status(400).json({ error: error.message });
      }
      if (isNotGitRepositoryError(error)) {
        return res.status(400).json({ error: 'Not a git repository' });
      }
      logger.error('Error getting file diff:', error);
      return res.status(500).json({ error: 'Failed to get diff' });
    }
  });
}
