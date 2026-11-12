/**
 * Per-project task-engine settings in `~/.untether/projects.json`, keyed by the normalized path
 * of the repository's main checkout. Not in config.json: the Mac app rewrites that file and
 * drops keys it does not know. Not in the repository: an agent must not edit its own check.
 *
 * The file is re-read when it changed on disk (hand edits apply without a restart) and written
 * atomically (temp file + rename). A write with a bad value is refused as a whole.
 *
 * Nothing on disk is lost to a record that does not validate (2026-10-20: one invalid or
 * unknown key dropped the whole record on load, and the next write saved the loss): fields
 * that do not validate and keys it does not know are kept as they are and written back, and
 * the file is copied aside once. A file that cannot be read at all is copied aside and never
 * overwritten until it is fixed or removed.
 *
 * Projects follow their folder (2026-10-20: ~/Projects/skylark renamed to ~/Projects/inkwell
 * left a dead "SKYLARK" project, pinned and orchestrated, on the home): each record keeps the
 * repository's root commit and its folder's name, and followMoves() moves a record whose
 * folder is gone to the one folder among its old siblings and the live sessions' and tasks'
 * folders with the same root commit, or marks it missing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  DEFAULT_PROJECT_SETTINGS,
  MAX_ACTIVE_TASKS_MAX,
  MEMORY_DIR_AUTO,
  PROJECT_INTERNAL_KEYS,
  type ProjectSettings,
  VERIFY_TIMEOUT_MAX_SEC,
} from '../../shared/projects.js';
import {
  type ConnectorProvider,
  SECURITY_CONNECTORS,
  SECURITY_EFFORTS,
  SECURITY_SECTIONS_MAX,
  type SecurityEffort,
} from '../../shared/security.js';
import { isBudgetSpec, TASK_BUDGET_SPEC_MAX } from '../../shared/task-budget.js';
import { parseZoneRule } from '../../shared/task-serial.js';
import { isSafeRefName, run } from '../utils/exec-file.js';
import { every } from '../utils/periodic-loop.js';
import { GUARD_RULES } from './task-guard.js';

const STORE_VERSION = 1;
/** Old folders a project keeps (a name it had resolves to it; stores keyed by one are healed). */
const FORMER_PATHS_MAX = 20;

const relativeDir = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (dir) => !path.isAbsolute(dir) && !path.normalize(dir).startsWith('..'),
    'must be a folder inside the repository'
  );

const absoluteDir = z
  .string()
  .trim()
  .min(2)
  .max(4096)
  .refine((dir) => path.isAbsolute(dir), 'must be an absolute path');

/** A guard pattern: a regular expression that compiles. */
const guardPattern = z
  .string()
  .min(1)
  .max(500)
  .refine((pattern) => {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }, 'not a valid regular expression');

/** Every field a project may hold; all optional (unset = default). */
export const ProjectSettingsSchema = z
  .object({
    mergePolicy: z.enum(['auto', 'ask']),
    checkCommand: z.string().trim().min(1).max(4000),
    setupCommand: z.string().trim().min(1).max(4000),
    fastCheckCommand: z.string().trim().min(1).max(4000),
    relatedTestCommand: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine((command) => command.includes('{files}'), 'must hold {files}'),
    relatedTestFiles: guardPattern,
    relatedFullPaths: guardPattern,
    relatedMaxFiles: z.number().int().min(1).max(1000),
    cloneDirs: z.array(relativeDir).max(20),
    artifactPaths: z.array(z.string().trim().min(1).max(200)).max(100),
    baseBranch: z.string().refine(isSafeRefName, 'invalid branch name'),
    worktreeRoot: z
      .string()
      .trim()
      .min(2)
      .max(1024)
      .refine((dir) => path.isAbsolute(dir), 'must be an absolute path'),
    riskIgnore: z.array(z.string().trim().min(1).max(200)).max(100),
    allowMergeWithoutCheck: z.boolean(),
    verifyTimeoutSec: z.number().int().min(10).max(VERIFY_TIMEOUT_MAX_SEC),
    aiReview: z.boolean(),
    crossReview: z.boolean(),
    autoMergePausedUntil: z.string().datetime(),
    autoMergePausedReason: z.string().trim().min(1).max(500),
    autoMergePausedCode: z.enum(['reverts', 'failures']),
    autoMergePausedCount: z.number().int().min(0).max(100_000),
    autoMergeResumedAt: z.string().datetime(),
    defaultAgent: z.enum(['claude', 'codex']),
    maxActiveTasks: z.number().int().min(1).max(MAX_ACTIVE_TASKS_MAX),
    modelRouting: z.boolean(),
    agentFallback: z.enum(['off', 'offer', 'auto']),
    taskBudget: z
      .string()
      .trim()
      .min(1)
      .max(TASK_BUDGET_SPEC_MAX)
      .refine(isBudgetSpec, 'not a budget: wall=3h,agent=2h,rounds=6,tokens=100M,warn=75'),
    stallMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    failureLoopNudge: z.boolean(),
    baseSync: z.boolean(),
    zones: z
      .array(
        z
          .string()
          .trim()
          .min(3)
          .max(300)
          .refine((rule) => !!parseZoneRule(rule), 'not a zone rule: <path pattern>=<zone name>')
      )
      .max(50),
    digestMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    guardOff: z.array(z.enum(GUARD_RULES)).max(GUARD_RULES.length),
    toolPruning: z.boolean(),
    toolPruningWindow: z.number().int().min(1).max(200),
    toolKeep: z.array(z.string().trim().min(1).max(200)).max(200),
    guardDeny: z.array(guardPattern).max(50),
    savingHoldoutPct: z.number().int().min(0).max(100),
    savingAutoOff: z
      .array(
        z
          .object({
            feature: z.string().min(1).max(100),
            version: z.number().int().min(1),
            at: z.string().datetime(),
            reason: z.string().min(1).max(2000),
            rule: z.number().int().min(1).optional(),
          })
          .strict()
      )
      .max(50),
    guardAllow: z.array(guardPattern).max(50),
    summarizeOutput: z.boolean(),
    summarizeCommands: z.array(guardPattern).max(50),
    memoryDir: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(
        (dir) => dir === MEMORY_DIR_AUTO || path.isAbsolute(dir),
        `must be an absolute folder or "${MEMORY_DIR_AUTO}"`
      ),
    orchestratorSessionId: z.string().min(1).max(200),
    orchestratorAdopted: z.boolean(),
    pinnedAt: z.string().datetime(),
    icon: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (file) => !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'),
        'must be a path inside the project'
      ),
    gitRoot: z.string().regex(/^[0-9a-f]{40,64}$/),
    folderName: z.string().min(1).max(255),
    movedFrom: absoluteDir,
    movedAt: z.string().datetime(),
    formerPaths: z.array(absoluteDir).max(FORMER_PATHS_MAX),
    missingSince: z.string().datetime(),
    // The security sweep (shared/security.ts): one switch, the rest advanced.
    securitySweep: z.boolean(),
    securitySweepPaused: z.boolean(),
    securitySweepHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
    securitySections: z.array(z.string().trim().min(1).max(200)).min(1).max(SECURITY_SECTIONS_MAX),
    securitySupplyChain: z.boolean(),
    securitySupplyHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 7),
    securityDepsEvery: z.number().int().min(0).max(100),
    securitySearchEffort: z.enum(SECURITY_EFFORTS as [SecurityEffort, ...SecurityEffort[]]),
    securityReviewEffort: z.enum(SECURITY_EFFORTS as [SecurityEffort, ...SecurityEffort[]]),
    securityAutoMergeBumps: z.boolean(),
    securityAutoMerge: z.boolean(),
    securityAutoMergeDelayMin: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    // Provider connectors (2026-10-26, shared/security.ts SecurityConnector): none by default.
    securityConnectors: z
      .array(
        z
          .object({
            provider: z.enum(
              SECURITY_CONNECTORS.map((spec) => spec.provider) as [
                ConnectorProvider,
                ...ConnectorProvider[],
              ]
            ),
            credential: z
              .object({
                from: z.enum(['env', 'keychain']),
                name: z.string().trim().min(1).max(200).refine(credentialName, 'invalid name'),
                account: z
                  .string()
                  .trim()
                  .min(1)
                  .max(200)
                  .refine(credentialName, 'invalid account')
                  .optional(),
              })
              .strict()
              .refine(
                (credential) =>
                  credential.from !== 'env' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(credential.name),
                'not an environment variable name'
              ),
            options: z
              .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), z.string().max(500))
              .optional(),
          })
          .strict()
      )
      .max(10),
  })
  .partial()
  .strict();

export type StoredProjectSettings = z.infer<typeof ProjectSettingsSchema>;

type InternalKey = (typeof PROJECT_INTERNAL_KEYS)[number];

/** A change: a value sets the field, null clears it back to its default. */
export type ProjectSettingsPatch = {
  [K in Exclude<keyof StoredProjectSettings, InternalKey>]?: StoredProjectSettings[K] | null;
};

/** What a change may hold: everything but the server's own identity and move fields. */
export const ProjectSettingsPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(ProjectSettingsSchema.shape)
        .filter(([key]) => !(PROJECT_INTERNAL_KEYS as readonly string[]).includes(key))
        .map(([key, schema]) => [key, (schema as z.ZodType).nullable().optional()])
    )
  )
  .strict();

const FIELDS = ProjectSettingsSchema.shape as Record<string, z.ZodType>;

/**
 * `ut project set key=123`: whether the setting takes the digits as a number (it does not
 * take them as text). Read from the schema, so a new numeric setting needs no list of its own
 * (2026-11-01: maxActiveTasks=2 went to the server as "2", the CLI's hand-kept list of number
 * keys did not know it).
 */
export function settingTakesNumber(key: string, digits: string): boolean {
  // A Map: a key like "constructor" is no field.
  const field = new Map(Object.entries(FIELDS)).get(key);
  return !!field && !field.safeParse(digits).success;
}

/** A credential's name: never read as an option, no control characters. */
function credentialName(name: string): boolean {
  return !name.startsWith('-') && [...name].every((char) => char >= ' ' && char !== '\x7f');
}

/** The key a repository is stored under: absolute, symlinks resolved, no trailing slash. */
export function normalizeRepoPath(repoPath: string): string {
  const absolute = path.resolve(repoPath);
  let real = absolute;
  try {
    real = fs.realpathSync.native(absolute);
  } catch {
    // Gone or not made yet: keep the resolved path.
  }
  return real.length > 1 ? real.replace(/\/+$/, '') : real;
}

export class ProjectSettingsError extends Error {}

/** A store that follows project folders' moves; resolves to how many entries it changed. */
export type MoveFollower = (
  moved: ReadonlyArray<{ from: string; to: string }>
) => number | undefined | Promise<number | undefined>;

export interface ProjectMoves {
  moved: Array<{ from: string; to: string }>;
  missing: string[];
}

/** The first root commit of the repository at `dir`, null outside one. */
export async function gitRootCommit(dir: string): Promise<string | null> {
  const result = await run('git', ['rev-list', '--max-parents=0', 'HEAD'], dir, 10_000);
  const first = result.code === 0 ? result.stdout.split('\n')[0]?.trim() : '';
  return first && /^[0-9a-f]{40,64}$/.test(first) ? first : null;
}

/** The main checkout of the repository (or worktree) `dir` is in, null outside one. */
async function mainCheckoutOf(dir: string): Promise<string | null> {
  const result = await run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    dir,
    10_000
  );
  const common = result.code === 0 ? result.stdout.trim() : '';
  return common && path.basename(common) === '.git'
    ? normalizeRepoPath(path.dirname(common))
    : null;
}

/** Folders of the old parent that hold a repository (a `.git` folder or file). */
function siblingRepos(parent: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .slice(0, 1000)
    .map((entry) => path.join(parent, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, '.git')));
}

const MOVES_MIN_GAP_MS = 30_000;

export class ProjectSettingsStore {
  private projects = new Map<string, StoredProjectSettings>();
  /** Per project: fields that did not validate and keys it does not know, as on disk. */
  private extras = new Map<string, Record<string, unknown>>();
  /** Records that are not records at all (a relative key, not an object), as on disk. */
  private raw = new Map<string, unknown>();
  /** The file could not be read: it is never overwritten until fixed. */
  private unreadable = false;
  private loadedMtime = -1;
  private liveDirs: () => string[] = () => [];
  private moving: Promise<ProjectMoves> | null = null;
  private movesAt = 0;
  private lastMoves: ProjectMoves = { moved: [], missing: [] };
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private followers: Array<{ name: string; follow: MoveFollower }> = [];

  constructor(
    private readonly filePath: string,
    private readonly onError?: (message: string, error?: unknown) => void
  ) {}

  /** The project's settings with defaults filled in. */
  get(repoPath: string): ProjectSettings {
    return { ...DEFAULT_PROJECT_SETTINGS, ...this.getStored(repoPath) };
  }

  /** Only what the project set itself. */
  getStored(repoPath: string): StoredProjectSettings {
    this.refresh();
    return structuredClone(this.projects.get(normalizeRepoPath(repoPath)) ?? {});
  }

  /** Every project with settings of its own. */
  list(): Array<{ repoPath: string; settings: ProjectSettings }> {
    this.refresh();
    return [...this.projects.entries()].map(([repoPath, stored]) => ({
      repoPath,
      settings: { ...DEFAULT_PROJECT_SETTINGS, ...structuredClone(stored) },
    }));
  }

  /** The pinned projects' keys, the first pinned first. */
  pinned(): string[] {
    return this.list()
      .filter(({ settings }) => settings.pinnedAt)
      .sort((a, b) => (a.settings.pinnedAt ?? '').localeCompare(b.settings.pinnedAt ?? ''))
      .map(({ repoPath }) => repoPath);
  }

  /** Apply a change (null clears a field); throws ProjectSettingsError on a bad value. */
  update(repoPath: string, patch: ProjectSettingsPatch): ProjectSettings {
    const parsed = ProjectSettingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new ProjectSettingsError(describe(parsed.error));
    this.refresh();
    this.refuseUnreadable();
    const key = normalizeRepoPath(repoPath);
    const next: Record<string, unknown> = { ...(this.projects.get(key) ?? {}) };
    const extras = this.extras.get(key);
    for (const [field, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      // A field set again replaces the value on disk that did not validate.
      if (extras) delete extras[field];
      if (value === null) delete next[field];
      else next[field] = value;
    }
    const checked = ProjectSettingsSchema.safeParse(next);
    if (!checked.success) throw new ProjectSettingsError(describe(checked.error));
    this.put(key, checked.data);
    this.save();
    return this.get(key);
  }

  /**
   * The one place every store keyed by a project's folder follows its moves: `follower`
   * hears, at once, every move the records already know (a store left on an old folder is
   * healed) and then each new move (followMoves). It returns how many things it changed.
   * 2026-10-20: open tasks kept the old repoPath of a renamed folder. 2026-10-25: toolshed
   * renamed to bakery left orchestrators.json on toolshed, so `ut project tell bakery`
   * found no orchestrator: only the scheduler listened, each store had to remember to.
   */
  followedBy(name: string, follower: MoveFollower): void {
    this.followers.push({ name, follow: follower });
    void this.tell({ name, follow: follower }, this.knownMoves());
  }

  /**
   * Every known move told again to every follower (the doctor's check): resolves to the
   * followers that still held an old folder, and what they changed.
   */
  async replayMoves(): Promise<Array<{ name: string; changed: number }>> {
    const moved = this.knownMoves();
    const out: Array<{ name: string; changed: number }> = [];
    for (const follower of this.followers) {
      const changed = await this.tell(follower, moved);
      if (changed) out.push({ name: follower.name, changed });
    }
    return out;
  }

  /**
   * Old folder → the project's folder now, for each folder a record was in before and that
   * no record nor folder holds today (every old one maps straight to the current one).
   */
  knownMoves(): Array<{ from: string; to: string }> {
    this.refresh();
    const moves: Array<{ from: string; to: string }> = [];
    for (const [to, stored] of this.projects) {
      const former = [
        ...(stored.formerPaths ?? []),
        ...(stored.movedFrom ? [stored.movedFrom] : []),
      ];
      for (const from of new Set(former)) {
        if (from === to || this.projects.has(from) || fs.existsSync(from)) continue;
        moves.push({ from, to });
      }
    }
    return moves;
  }

  /**
   * Where `dir` is now when it is (or is inside) a folder a project moved away from; null
   * otherwise. An old path given to `ut task --repo` or `ut project tell` finds the project.
   */
  currentPath(dir: string): string | null {
    const wanted = normalizeRepoPath(dir);
    for (const { from, to } of this.knownMoves()) {
      if (wanted === from) return to;
      if (wanted.startsWith(`${from}/`)) return `${to}${wanted.slice(from.length)}`;
    }
    return null;
  }

  private async tell(
    follower: { name: string; follow: MoveFollower },
    moved: Array<{ from: string; to: string }>
  ): Promise<number> {
    if (!moved.length) return 0;
    try {
      return (await follower.follow(moved)) || 0;
    } catch (error) {
      this.onError?.(`projects.json: ${follower.name} could not follow moved projects`, error);
      return 0;
    }
  }

  /**
   * Forget a project: its record goes (pin, orchestrator mapping, settings, the server's
   * identity fields), its folder is never touched. False when it had none.
   */
  remove(repoPath: string): boolean {
    this.refresh();
    this.refuseUnreadable();
    const key = normalizeRepoPath(repoPath);
    const had = this.projects.has(key) || this.extras.has(key) || this.raw.has(repoPath);
    if (!had) return false;
    this.projects.delete(key);
    this.extras.delete(key);
    this.raw.delete(repoPath);
    this.save();
    return true;
  }

  /** Where followMoves() also looks: the folders of live sessions and tasks. */
  setLiveDirs(dirs: () => string[]): void {
    this.liveDirs = dirs;
  }

  /** followMoves() every `intervalMs` (and right away), until stopWatchingMoves(). */
  watchMoves(intervalMs = 10 * 60_000): void {
    if (this.watchTimer) return;
    void this.followMoves();
    this.watchTimer = every('project moves', () => this.followMoves(), intervalMs);
    this.watchTimer.unref?.();
  }

  stopWatchingMoves(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * Keep the records with their folders: identity filled in for those that have none yet,
   * a record whose folder is gone moved to the one candidate with the same root commit (all
   * its fields kept, `movedFrom` noted), else marked missing. At most once per 30 s; calls
   * meanwhile share the run (the home's board may call it on every build).
   */
  followMoves(): Promise<ProjectMoves> {
    if (this.moving) return this.moving;
    if (Date.now() - this.movesAt < MOVES_MIN_GAP_MS) return Promise.resolve(this.lastMoves);
    this.moving = this.runMoves()
      .catch((error) => {
        this.onError?.('projects.json: following moved projects failed', error);
        return { moved: [], missing: [] };
      })
      .then((result) => {
        this.lastMoves = result;
        this.movesAt = Date.now();
        this.moving = null;
        if (result.moved.length) {
          for (const follower of this.followers) void this.tell(follower, result.moved);
        }
        return result;
      });
    return this.moving;
  }

  private async runMoves(): Promise<ProjectMoves> {
    this.refresh();
    if (this.unreadable) return { moved: [], missing: [] };
    const result: ProjectMoves = { moved: [], missing: [] };
    const roots = new Map<string, Promise<string | null>>();
    const rootOf = (dir: string) => {
      let pending = roots.get(dir);
      if (!pending) {
        pending = gitRootCommit(dir).catch(() => null);
        roots.set(dir, pending);
      }
      return pending;
    };
    const changes: Array<(projects: Map<string, StoredProjectSettings>) => boolean> = [];
    const now = new Date().toISOString();
    let live: string[] | null = null;
    for (const [key, stored] of Array.from(this.projects.entries())) {
      if (fs.existsSync(key)) {
        // Asked again each time: another repository may have taken the folder since.
        const gitRoot = (await rootOf(key)) ?? stored.gitRoot;
        const folderName = path.basename(key);
        if (
          stored.missingSince ||
          stored.gitRoot !== (gitRoot ?? undefined) ||
          stored.folderName !== folderName
        ) {
          changes.push((projects) => {
            const current = projects.get(key);
            if (!current) return false;
            const next = { ...current, folderName };
            if (gitRoot) next.gitRoot = gitRoot;
            delete next.missingSince;
            projects.set(key, next);
            return true;
          });
        }
        continue;
      }
      let target: string | null = null;
      if (stored.gitRoot) {
        if (!live) live = await this.liveCheckouts();
        const candidates = new Set<string>();
        for (const dir of [...siblingRepos(path.dirname(key)), ...live]) {
          const normalized = normalizeRepoPath(dir);
          if (normalized !== key && !this.holdsSettings(normalized)) candidates.add(normalized);
        }
        const matches: string[] = [];
        for (const dir of candidates) {
          if ((await rootOf(dir)) === stored.gitRoot) matches.push(dir);
        }
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          this.onError?.(
            `projects.json: ${key} is gone and ${matches.length} folders hold its repository (${matches.join(', ')}); not moved`
          );
        }
      }
      if (target) {
        const to = target;
        result.moved.push({ from: key, to });
        changes.push((projects) => {
          const current = projects.get(key);
          if (!current) return false;
          const next: StoredProjectSettings = {
            ...(projects.get(to) ?? {}),
            ...current,
            folderName: path.basename(to),
            movedFrom: key,
            movedAt: now,
            formerPaths: [...(current.formerPaths ?? []), key]
              .filter((dir, index, all) => dir !== to && all.lastIndexOf(dir) === index)
              .slice(-FORMER_PATHS_MAX),
          };
          delete next.missingSince;
          projects.delete(key);
          projects.set(to, next);
          const extras = this.extras.get(key);
          this.extras.delete(key);
          if (extras) this.extras.set(to, extras);
          this.onError?.(`projects.json: ${key} moved to ${to}; its settings follow it`);
          return true;
        });
      } else {
        result.missing.push(key);
        if (!stored.missingSince) {
          changes.push((projects) => {
            const current = projects.get(key);
            if (!current || current.missingSince) return false;
            projects.set(key, { ...current, missingSince: now });
            return true;
          });
        }
      }
    }
    if (!changes.length) return result;
    // The file may have changed while git ran: apply to what is there now.
    this.refresh();
    if (this.unreadable) return result;
    let changed = false;
    for (const change of changes) changed = change(this.projects) || changed;
    if (changed) this.save();
    return result;
  }

  /** The main checkouts of the live sessions' and tasks' folders. */
  private async liveCheckouts(): Promise<string[]> {
    let dirs: string[] = [];
    try {
      dirs = this.liveDirs();
    } catch {
      dirs = [];
    }
    const unique = [...new Set(dirs.filter((dir) => dir && path.isAbsolute(dir)))].slice(0, 200);
    const out = new Set<string>();
    for (const dir of unique) {
      if (!fs.existsSync(dir)) continue;
      const main = await mainCheckoutOf(dir).catch(() => null);
      if (main) out.add(main);
    }
    return [...out];
  }

  /** A record with settings of the user's (more than the server's identity fields). */
  private holdsSettings(key: string): boolean {
    const stored = this.projects.get(key);
    return (
      !!stored &&
      Object.keys(stored).some(
        (field) => !(PROJECT_INTERNAL_KEYS as readonly string[]).includes(field)
      )
    );
  }

  private put(key: string, stored: StoredProjectSettings): void {
    if (Object.keys(stored).length || this.extras.has(key)) this.projects.set(key, stored);
    else this.projects.delete(key);
  }

  private refuseUnreadable(): void {
    if (this.unreadable) {
      throw new ProjectSettingsError(
        `${this.filePath} could not be read (a copy is next to it): fix or remove it first`
      );
    }
  }

  private refresh(): void {
    let mtime: number;
    try {
      mtime = fs.statSync(this.filePath).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime === this.loadedMtime) return;
    this.loadedMtime = mtime;
    this.projects = new Map();
    this.extras = new Map();
    this.raw = new Map();
    this.unreadable = false;
    if (mtime) this.load(mtime);
  }

  private load(mtime: number): void {
    let data: { version?: unknown; projects?: unknown };
    try {
      data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.unreadable = true;
      this.onError?.('could not read projects.json; it is kept as it is', error);
      this.backup(mtime);
      return;
    }
    if (
      data?.version !== STORE_VERSION ||
      !data.projects ||
      typeof data.projects !== 'object' ||
      Array.isArray(data.projects)
    ) {
      this.unreadable = true;
      this.onError?.('projects.json has an unknown format; it is kept as it is');
      this.backup(mtime);
      return;
    }
    let partial = false;
    for (const [repoPath, value] of Object.entries(data.projects as Record<string, unknown>)) {
      if (
        !path.isAbsolute(repoPath) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        this.raw.set(repoPath, value);
        partial = true;
        this.onError?.(`projects.json: kept the record ${repoPath} as it is (not a project)`);
        continue;
      }
      const stored: Record<string, unknown> = {};
      const extras: Record<string, unknown> = {};
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        const schema = FIELDS[field];
        const parsed = schema?.safeParse(fieldValue);
        if (parsed?.success) stored[field] = parsed.data;
        else extras[field] = fieldValue;
      }
      if (Object.keys(extras).length) {
        partial = true;
        this.extras.set(repoPath, extras);
        this.onError?.(
          `projects.json: ${repoPath}: kept ${Object.keys(extras).join(', ')} as they are (unknown or invalid)`
        );
      }
      this.projects.set(repoPath, stored as StoredProjectSettings);
    }
    if (partial) this.backup(mtime);
  }

  /** A copy of the file as it was, once per version of it. */
  private backup(mtime: number): void {
    const copy = `${this.filePath}.bad-${Math.round(mtime)}`;
    try {
      if (!fs.existsSync(copy)) fs.copyFileSync(this.filePath, copy);
    } catch (error) {
      this.onError?.('could not copy projects.json aside', error);
    }
  }

  private save(): void {
    this.refuseUnreadable();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const projects: Record<string, unknown> = Object.fromEntries(this.raw);
    for (const [key, stored] of this.projects) {
      projects[key] = { ...(this.extras.get(key) ?? {}), ...stored };
    }
    const data = { version: STORE_VERSION, projects };
    // 0600 (2026-10-20): it names the user's projects, checks and orchestrator sessions.
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
    try {
      this.loadedMtime = fs.statSync(this.filePath).mtimeMs;
    } catch {
      this.loadedMtime = -1;
    }
  }
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'settings'}: ${issue.message}`)
    .join(', ');
}
