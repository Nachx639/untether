/**
 * Untether's disposable folders out of Time Machine (2026-11-02). That day backupd ran 14 h at
 * ~100% CPU copying 339 GB / 5.5 M files, the load reached 28 on 12 cores and task admission
 * held tasks over an hour: the backup included the task worktrees (each with node_modules and
 * build output), ~/.untether/control (session recordings, GBs that rotate) and ~/.untether/tasks
 * (task logs). Every such folder Untether makes is marked with `tmutil addexclusion <dir>`:
 * sticky (an xattr on the folder, follows it when moved), no admin, never sudo. A Mac without
 * tmutil, or a call that fails, changes nothing and says nothing. config.json
 * excludeFromBackups: false turns it off.
 *
 * Only folders that hold nothing but what Untether can make again qualify: a project's
 * `.untether-worktrees` folder (else, for a custom worktreeRoot, each task worktree on its own),
 * the control dir, the task logs and the downloaded voice models. Never ~/.untether itself
 * (config.json, projects.json, keys), never a repository, never a file.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** The folder next to a repository that holds its task worktrees (task-worktree.ts). */
export const WORKTREES_DIR_NAME = '.untether-worktrees';

/** Files that are the user's own: a folder holding one of them is never excluded. */
const USER_FILES = ['config.json', 'projects.json'];

export type TmutilRunner = (args: string[]) => Promise<{ code: number; stdout: string }>;

const TMUTIL = '/usr/bin/tmutil';

/** tmutil, never through a shell; a missing binary reads as code 127, a timeout as 124. */
export const runTmutil: TmutilRunner = (args) =>
  new Promise((resolve) => {
    execFile(TMUTIL, args, { timeout: 15_000 }, (error, stdout) => {
      // 127 only for a missing binary: it turns the exclusion off for good. A timeout (code
      // null, killed: backupd busy, the very case this is for) or a signal is a failure of
      // this one call (2026-11-10: it read as 127 too, and nothing was excluded any more
      // until the server restarted).
      const failure = error as NodeJS.ErrnoException | null;
      const code = !failure
        ? 0
        : typeof failure.code === 'number'
          ? (failure.code as unknown as number)
          : failure.code === 'ENOENT'
            ? 127
            : 124;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/**
 * What to exclude for a task worktree: its `.untether-worktrees` ancestor when it has one (all
 * of a project's worktrees, those to come too), else the worktree folder itself.
 */
export function worktreeExclusionTarget(worktreePath: string): string {
  const resolved = path.resolve(worktreePath);
  for (let dir = resolved; ; ) {
    if (path.basename(dir) === WORKTREES_DIR_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return resolved;
    dir = parent;
  }
}

/** Why a folder must not be excluded, or null when it may. */
export function exclusionRefusal(
  dir: string,
  protectedDirs: string[],
  fsImpl: Pick<typeof fs, 'statSync' | 'existsSync'> = fs
): string | null {
  if (!path.isAbsolute(dir)) return 'not an absolute path';
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return 'the disk root';
  for (const guarded of protectedDirs) {
    const own = path.resolve(guarded);
    // The guarded folder itself, or one holding it (e.g. the home folder).
    if (own === resolved || own.startsWith(resolved + path.sep)) return `holds ${own}`;
  }
  let stat: fs.Stats;
  try {
    stat = fsImpl.statSync(resolved);
  } catch {
    return 'missing';
  }
  if (!stat.isDirectory()) return 'not a folder';
  for (const name of USER_FILES) {
    if (fsImpl.existsSync(path.join(resolved, name))) return `holds ${name}`;
  }
  // A repository's own checkout (.git folder); a worktree has a .git file and is Untether's.
  try {
    if (fsImpl.statSync(path.join(resolved, '.git')).isDirectory()) return 'a repository';
  } catch {
    // no .git
  }
  return null;
}

export interface BackupExclusionDeps {
  /** config.json excludeFromBackups (default on). */
  enabled: () => boolean;
  /** Never excluded nor anything holding them: ~/.untether (config.json, projects.json, keys). */
  protectedDirs: string[];
  tmutil?: TmutilRunner;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

export class BackupExclusion {
  /** Folders marked (or found marked) in this run: one tmutil call each. */
  private readonly done = new Set<string>();
  private readonly tmutil: TmutilRunner;
  private readonly platform: NodeJS.Platform;
  /** Set once tmutil turned out missing: no further calls. */
  private unavailable = false;

  constructor(private readonly deps: BackupExclusionDeps) {
    this.tmutil = deps.tmutil ?? runTmutil;
    this.platform = deps.platform ?? process.platform;
  }

  enabled(): boolean {
    return this.deps.enabled();
  }

  available(): boolean {
    return this.platform === 'darwin' && !this.unavailable;
  }

  /** May this folder be excluded (it exists, is a folder, is nothing of the user's)? */
  allowed(dir: string): boolean {
    return exclusionRefusal(dir, this.deps.protectedDirs) === null;
  }

  /**
   * Marks a disposable folder excluded; quiet when off, without tmutil or when it fails. True
   * when tmutil took it now (or earlier in this run).
   */
  async exclude(dir: string): Promise<boolean> {
    if (!this.deps.enabled() || !this.available()) return false;
    const resolved = path.resolve(dir);
    if (this.done.has(resolved)) return true;
    const refusal = exclusionRefusal(resolved, this.deps.protectedDirs);
    if (refusal) {
      this.deps.log?.(`not excluding ${resolved} from backups: ${refusal}`);
      return false;
    }
    const result = await this.tmutil(['addexclusion', resolved]).catch(() => ({
      code: 127,
      stdout: '',
    }));
    if (result.code === 127) {
      this.unavailable = true;
      return false;
    }
    if (result.code !== 0) return false;
    this.done.add(resolved);
    return true;
  }

  /** Several at once; the ones tmutil took. */
  async excludeAll(dirs: string[]): Promise<string[]> {
    const taken: string[] = [];
    for (const dir of new Set(dirs.map((d) => path.resolve(d)))) {
      if (await this.exclude(dir)) taken.push(dir);
    }
    return taken;
  }

  /** true/false from `tmutil isexcluded`, undefined when it can't tell. */
  async isExcluded(dir: string): Promise<boolean | undefined> {
    if (!this.available()) return undefined;
    const result = await this.tmutil(['isexcluded', path.resolve(dir)]).catch(() => ({
      code: 127,
      stdout: '',
    }));
    if (result.code === 127) {
      this.unavailable = true;
      return undefined;
    }
    if (result.code !== 0) return undefined;
    if (/\[Excluded\]/.test(result.stdout)) return true;
    if (/\[Included\]/.test(result.stdout)) return false;
    return undefined;
  }

  /** A folder unmarked by hand: the next exclude() asks tmutil again. */
  forget(dir: string): void {
    this.done.delete(path.resolve(dir));
  }
}

/**
 * Untether's disposable folders that exist now: the control dir, the task logs, the voice
 * models and every project's worktrees folder (from the known projects and the open tasks).
 */
export function untetherOwnedDirs(input: {
  controlDir: string;
  taskLogDir: string;
  ttsDir?: string;
  repoPaths: string[];
  worktreePaths: string[];
  exists?: (dir: string) => boolean;
}): string[] {
  const exists =
    input.exists ??
    ((dir: string) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  const dirs = [input.controlDir, input.taskLogDir];
  if (input.ttsDir) dirs.push(input.ttsDir);
  for (const repo of input.repoPaths) {
    dirs.push(path.join(path.dirname(path.resolve(repo)), WORKTREES_DIR_NAME));
  }
  for (const worktree of input.worktreePaths) dirs.push(worktreeExclusionTarget(worktree));
  return [...new Set(dirs.map((dir) => path.resolve(dir)))].filter(exists);
}

/** CPU seconds from ps's TIME column ([[dd-]hh:]mm:ss[.cc]). */
export function parseCpuTime(text: string): number | undefined {
  const match = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

/** backupd's CPU seconds so far (summed over its processes), undefined when none runs. */
export function backupdCpuFromPs(psOutput: string): number | undefined {
  let total: number | undefined;
  for (const line of psOutput.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    if (path.basename(match[2].trim()) !== 'backupd') continue;
    const seconds = parseCpuTime(match[1]);
    if (seconds !== undefined) total = (total ?? 0) + seconds;
  }
  return total;
}

export const readBackupdCpu = (): Promise<number | undefined> =>
  new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'time=,comm='], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? undefined : backupdCpuFromPs(String(stdout)))
    );
  });

/** CPU share (1 = one full core) from which backupd counts as busy. */
export const BACKUPD_BUSY_SHARE = 0.5;

/**
 * Time Machine's backupd over time: from its CPU seconds between two samples, how long it has
 * kept at least half a core busy without a break.
 */
export class BackupdWatch {
  private last?: { at: number; cpu: number };
  private busySince?: number;
  private share = 0;

  constructor(
    private readonly read: () => Promise<number | undefined> = readBackupdCpu,
    private readonly now: () => number = Date.now
  ) {}

  async sample(): Promise<void> {
    const cpu = await this.read().catch(() => undefined);
    const at = this.now();
    if (cpu === undefined) {
      this.last = undefined;
      this.busySince = undefined;
      this.share = 0;
      return;
    }
    const last = this.last;
    this.last = { at, cpu };
    // A new backupd (fewer CPU seconds than before) starts over.
    if (!last || cpu < last.cpu || at <= last.at) {
      this.busySince = undefined;
      this.share = 0;
      return;
    }
    this.share = (cpu - last.cpu) / ((at - last.at) / 1000);
    if (this.share >= BACKUPD_BUSY_SHARE) this.busySince ??= last.at;
    else this.busySince = undefined;
  }

  /** How long backupd has been busy, with its CPU share in the last interval; null if not. */
  busy(): { forMs: number; share: number } | null {
    if (this.busySince === undefined) return null;
    return { forMs: this.now() - this.busySince, share: this.share };
  }
}

/** "~95% CPU for 3.5 h" */
export function describeBackupd(busy: { forMs: number; share: number }): string {
  const hours = Math.round((busy.forMs / 3_600_000) * 10) / 10;
  return `Time Machine (backupd) has kept ~${Math.round(busy.share * 100)}% CPU for ${hours} h`;
}
