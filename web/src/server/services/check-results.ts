/**
 * A check's passed result, kept by what it checked (2026-11-11).
 *
 * The same code was checked several times: the agent ran the whole check while it worked,
 * Untether ran it again to verify, and again after each round (a review, a conflict, its turn
 * in the merge queue) even when nothing had changed. With several tasks at once that alone
 * kept the Mac over its load threshold.
 *
 * A run that PASSES is kept under: the git tree it ran on (the worktree's files as they were,
 * uncommitted and new ones included: `worktreeTree`; for a commit, its tree), the exact command,
 * the folder it ran in (from the repository's root), the dependency lockfiles on disk
 * (`lockHash`) and who ran it. Before a run starts, a kept pass for the same five is the
 * answer: the run is not made, and that is said ("check: reused, same tree as …").
 *
 *  - Only a pass is kept, and only when the tree was the same before and after the run (an
 *    agent that edited meanwhile, a check that rewrote files: not kept). A failure is never
 *    kept, so it is never reused, neither as a failure nor as a pass.
 *  - The tree is content: one byte of difference in any tracked or new file is another tree,
 *    and the check runs. What is merged is checked on the exact tree that enters the base:
 *    when the base moved and the merged result differs, nothing kept matches it.
 *  - Who ran it (`runner`): 'untether' for the verification runs of the merge pipeline (CI=1,
 *    the project's Node, a login shell), 'shell' for a run an agent or a script made in its own
 *    shell through `ut check-slot`. A verification never takes a 'shell' pass: it was not made
 *    in the conditions a merge is decided on, and it is the checked party's own word. A shell
 *    run does take Untether's.
 *  - A pass is kept RESULT_MAX_AGE_MS at most (tools and the Mac change under the same tree).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { run } from '../utils/exec-file.js';

/** A kept pass older than this is not used. */
export const RESULT_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** How many passes are kept (the oldest go). */
export const RESULTS_MAX = 500;

const GIT_TIMEOUT_MS = 60_000;

export type CheckRunner = 'untether' | 'shell';

/** What a check ran on. */
export interface CheckIdentity {
  /** The git tree of the files it ran on. */
  tree: string;
  /** The dependency lockfiles on disk, hashed ('' when there is none). */
  lock: string;
  /** The folder it ran in, from the repository's root ('' for the root). */
  dir: string;
}

export interface CheckPass extends CheckIdentity {
  command: string;
  runner: CheckRunner;
  /** When it passed (ms) and how long the run took. */
  at: number;
  ms: number;
  /** The task whose run it was. */
  taskId?: string;
}

/** Lockfiles whose content says which dependencies a check ran with. */
export const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'Podfile.lock',
  'Package.resolved',
  'composer.lock',
];
const MAX_LOCKFILES = 60;

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  run('git', ['--no-optional-locks', ...args], cwd, GIT_TIMEOUT_MS, env);

async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  const r = await git(cwd, args);
  const line = r.code === 0 ? r.stdout.trim() : '';
  return line || null;
}

/**
 * The git tree of a folder's files as they are now: HEAD's when nothing is changed, else what
 * `git add -A` would stage (changed, deleted and new files; ignored ones and `exclude` globs
 * aside), written through an index of its own. The folder's index, HEAD and files are not
 * touched and no index.lock is taken; only objects are added to the repository. Null when git
 * cannot answer.
 */
export async function worktreeTree(dir: string, exclude: string[] = []): Promise<string | null> {
  const top = await gitLine(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const excludes = exclude.map((pattern) => `:(exclude,glob)${pattern}`);
  const status = await git(top, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
    ...excludes,
  ]);
  if (status.code !== 0) return null;
  if (!status.stdout) return gitLine(top, ['rev-parse', 'HEAD^{tree}']);
  // An index of its own beside the real one (a split index names files in that folder).
  const gitDir = await gitLine(top, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return null;
  const index = path.join(
    gitDir,
    `untether-check-index.${process.pid}.${crypto.randomBytes(6).toString('hex')}`
  );
  try {
    try {
      const real = path.join(gitDir, 'index');
      fs.copyFileSync(real, index);
      // The copy keeps the time of the real one (to the second below): git takes an index's
      // time for when it last looked, and trusts the size and time of any file older than
      // that. A copy "written now" made it trust a file edited since to the same size
      // (2026-11-11: a pass was kept on files that had changed under the check).
      const written = Math.floor(fs.statSync(real).mtimeMs / 1000);
      fs.utimesSync(index, written, written);
    } catch {
      // No index yet (nothing ever staged): `add` makes one.
    }
    const env = { GIT_INDEX_FILE: index };
    const add = await git(top, ['add', '-A', '--', '.', ...excludes], env);
    if (add.code !== 0) return null;
    const tree = await git(top, ['write-tree'], env);
    return tree.code === 0 ? tree.stdout.trim() || null : null;
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}

/** The tree of a commit; null when there is no such commit. */
export function commitTree(dir: string, commit: string): Promise<string | null> {
  return gitLine(dir, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
}

/**
 * The dependency lockfiles on disk, hashed: the tracked ones wherever they are, and any at the
 * repository's root or in `dir` (an ignored lockfile is in no tree). '' when there is none.
 */
export async function lockHash(dir: string): Promise<string> {
  const top = (await gitLine(dir, ['rev-parse', '--show-toplevel'])) ?? dir;
  const files = new Set<string>();
  const listed = await git(top, [
    'ls-files',
    '-z',
    '--',
    ...LOCKFILE_NAMES.flatMap((name) => [`:(glob)${name}`, `:(glob)**/${name}`]),
  ]);
  if (listed.code === 0) {
    for (const file of listed.stdout.split('\0')) {
      if (file && !file.split('/').includes('node_modules')) files.add(file);
    }
  }
  const here = path.relative(top, path.resolve(dir));
  for (const folder of new Set(['', here.startsWith('..') ? '' : here])) {
    for (const name of LOCKFILE_NAMES) files.add(path.join(folder, name));
  }
  const hash = crypto.createHash('sha256');
  let found = 0;
  for (const file of [...files].sort().slice(0, MAX_LOCKFILES * LOCKFILE_NAMES.length)) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(top, file));
    } catch {
      continue;
    }
    if (++found > MAX_LOCKFILES) break;
    hash.update(`${file}\0${content.length}\0`);
    hash.update(content);
  }
  return found ? hash.digest('hex').slice(0, 32) : '';
}

/**
 * What a check started in `cwd` now would run on. `commit`: the tree of that commit (what a
 * merge takes) instead of the folder's files. Null when git cannot answer.
 */
export async function checkIdentity(
  cwd: string,
  options: { commit?: string; exclude?: string[] } = {}
): Promise<CheckIdentity | null> {
  try {
    const top = await gitLine(cwd, ['rev-parse', '--show-toplevel']);
    if (!top) return null;
    const [tree, lock] = await Promise.all([
      options.commit ? commitTree(top, options.commit) : worktreeTree(top, options.exclude),
      lockHash(cwd),
    ]);
    if (!tree) return null;
    const dir = path.relative(fs.realpathSync(top), fs.realpathSync(cwd));
    return { tree, lock, dir: dir.startsWith('..') ? cwd : dir };
  } catch {
    return null;
  }
}

/** A command as it is compared: as written, without the space around it. */
const sameCommand = (command: string) => command.trim();

function keyOf(pass: Pick<CheckPass, 'tree' | 'lock' | 'dir' | 'command' | 'runner'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([pass.tree, pass.lock, pass.dir, sameCommand(pass.command), pass.runner])
    )
    .digest('hex');
}

const valid = (entry: unknown): entry is CheckPass => {
  const e = entry as Partial<CheckPass> | null;
  return (
    !!e &&
    typeof e.tree === 'string' &&
    typeof e.lock === 'string' &&
    typeof e.dir === 'string' &&
    typeof e.command === 'string' &&
    (e.runner === 'untether' || e.runner === 'shell') &&
    typeof e.at === 'number' &&
    typeof e.ms === 'number'
  );
};

export interface CheckResultsOptions {
  /** Where the passes are kept across a restart. */
  file?: string;
  now?: () => number;
  log?: (message: string) => void;
}

/** The kept passes (the server's: one file; tests: in memory). */
export class CheckResults {
  private readonly passes = new Map<string, CheckPass>();
  private readonly now: () => number;

  constructor(private readonly options: CheckResultsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.load();
  }

  /**
   * A kept pass of `command` on this identity. A 'shell' run takes Untether's own pass too;
   * a verification ('untether') only Untether's.
   */
  find(identity: CheckIdentity, command: string, runner: CheckRunner): CheckPass | undefined {
    const runners: CheckRunner[] = runner === 'shell' ? ['shell', 'untether'] : ['untether'];
    let best: CheckPass | undefined;
    for (const by of runners) {
      const pass = this.passes.get(keyOf({ ...identity, command, runner: by }));
      if (!pass || this.now() - pass.at > RESULT_MAX_AGE_MS) continue;
      if (!best || pass.at > best.at) best = pass;
    }
    return best;
  }

  /** Keeps a pass (a newer one of the same check replaces the older). */
  record(pass: Omit<CheckPass, 'at' | 'command'> & { command: string; at?: number }): CheckPass {
    const kept: CheckPass = {
      ...pass,
      command: sameCommand(pass.command),
      at: pass.at ?? this.now(),
      ms: Math.max(0, Math.round(pass.ms)),
    };
    const key = keyOf(kept);
    this.passes.delete(key);
    this.passes.set(key, kept);
    this.prune();
    this.save();
    return kept;
  }

  get size(): number {
    return this.passes.size;
  }

  private prune(): void {
    const at = this.now();
    for (const [key, pass] of this.passes) {
      if (at - pass.at > RESULT_MAX_AGE_MS) this.passes.delete(key);
    }
    // In the order they were kept: the oldest first.
    while (this.passes.size > RESULTS_MAX) {
      const oldest = this.passes.keys().next().value;
      if (oldest === undefined) break;
      this.passes.delete(oldest);
    }
  }

  private load(): void {
    const file = this.options.file;
    if (!file) return;
    let saved: unknown;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    const list = (saved as { passes?: unknown } | null)?.passes;
    if (!Array.isArray(list)) return;
    for (const entry of list) if (valid(entry)) this.passes.set(keyOf(entry), entry);
    this.prune();
  }

  private save(): void {
    const file = this.options.file;
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        `${JSON.stringify({ version: 1, passes: [...this.passes.values()] })}\n`,
        {
          mode: 0o600,
        }
      );
      fs.renameSync(tmp, file);
    } catch (error) {
      this.options.log?.(`[check-results] could not save the kept passes: ${error}`);
    }
  }
}

let shared: CheckResults | undefined;

/** The server hands in its store; without one nothing is kept nor reused. */
export function setCheckResults(results: CheckResults | undefined): void {
  shared = results;
}

/** The server's store (the merge pipeline's default). */
export function sharedCheckResults(): CheckResults | undefined {
  return shared;
}

/** "5 min ago" / "2 h ago" / "3 d ago". */
export function agoText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** "check: reused, same tree as 2026-11-11T03:10:00.000Z (5 min ago, …)". */
export function reusedLine(pass: Pick<CheckPass, 'at' | 'ms' | 'tree'>, now: number): string {
  const sec = Math.round(pass.ms / 1000);
  const took = sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`;
  return `check: reused, same tree as ${new Date(pass.at).toISOString()} (${agoText(now - pass.at)}; tree ${pass.tree.slice(0, 12)}, it passed in ${took}): not run again`;
}
