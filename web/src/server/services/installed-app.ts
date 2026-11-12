/**
 * The Mac app a development server runs under, and whether it is behind its own sources
 * (2026-11-11: the app in /Applications stayed on its build of 2026-11-02 for nine days while
 * the development server it started reloaded with every merge; its `ut` took new options for
 * text, its ConfigManager was about to reset config.json, and nobody was told).
 *
 * The app is "behind" when the checkout the server runs from has changed, since the commit the
 * app was built from, anything the app is made of: mac/ and what it packs for a shell (the
 * `ut` wrapper and the CLI behind it, the forwarder, the embedded Node). The rest of web/ does
 * not count: with the development server on, the app's own copy of the server is not used.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { type BuildInfo, describeBuild, sameCommit } from '../build-info.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

const execFileAsync = promisify(execFile);

/** What the app is made of, from the repository root (git pathspecs). */
export const APP_SOURCE_PATHS = [
  'mac',
  // What it packs for a shell: the wrapper, the CLI the wrapper runs, the forwarder.
  'web/bin/ut',
  'web/src/cli.ts',
  'web/src/server/task-cli.ts',
  'web/src/server/task-cli',
  'web/src/server/check-slot-cli.ts',
  'web/src/server/diag-cli.ts',
  'web/src/server/events-cli.ts',
  'web/src/server/socket-api-client.ts',
  'native/ut-fwd',
  // The Node it embeds and how the bundle is put together.
  'web/build-native.js',
  'web/build-custom-node.js',
  'web/scripts/build-fwd-rust.js',
] as const;

/** Inside them, what is not part of the app: its tests and its documents. */
export const APP_SOURCE_EXCLUDES = ['mac/UntetherTests', 'mac/docs', 'mac/*.md'] as const;

const APP_PATHSPEC = [
  ...APP_SOURCE_PATHS,
  ...APP_SOURCE_EXCLUDES.map((entry) => `:(exclude,glob)${entry}`),
];

export interface RunningApp {
  /** The bundle: /Applications/Untether.app. */
  appPath: string;
  pid: number;
}

type ProcessOf = (pid: number) => Promise<{ ppid: number; command: string } | undefined>;

const psProcess: ProcessOf = async (pid) => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
      timeout: 5000,
    });
    const match = stdout.match(/^\s*(\d+)\s+(.*)$/m);
    return match ? { ppid: Number(match[1]), command: match[2].trim() } : undefined;
  } catch {
    return undefined;
  }
};

const APP_EXECUTABLE = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/;

/**
 * The app bundle among `pid`'s ancestors: the Mac app that started this server (it runs
 * `pnpm run dev` under a shell, so the app is a few parents up). None for a server started
 * from a terminal.
 */
export async function appAbove(
  pid: number,
  processOf: ProcessOf = psProcess
): Promise<RunningApp | undefined> {
  let current = pid;
  for (let depth = 0; depth < 12 && current > 1; depth++) {
    const info = await processOf(current);
    if (!info) return undefined;
    // An app's own command line is its executable, with no arguments worth a space.
    const match = APP_EXECUTABLE.exec(info.command.split(' -')[0].trim());
    if (match && current !== pid) return { appPath: match[1], pid: current };
    current = info.ppid;
  }
  return undefined;
}

/** A build someone installed, not one Xcode left among its products. */
export function isInstalledApp(appPath: string, home: string): boolean {
  const dir = path.dirname(appPath);
  return dir === '/Applications' || dir === path.join(home, 'Applications');
}

/** The file a build leaves in the bundle saying what it was built from (mac/scripts/build.sh). */
export const APP_BUILD_STAMP = path.join('Contents', 'Resources', 'untether-build.json');

/**
 * The commit an app bundle was built from: its stamp, else the marks of the CLI it packs (an
 * app built before the stamp, or by Xcode alone; that CLI is not rebuilt when only mac/
 * changed, so it can only make the app look older than it is, never newer).
 */
export async function readAppBuild(
  appPath: string,
  readBinary: (file: string) => Promise<BuildInfo | undefined>
): Promise<BuildInfo | undefined> {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(appPath, APP_BUILD_STAMP), 'utf8'));
    if (typeof stamp?.commit === 'string' && /^[0-9a-f]{7,40}$/.test(stamp.commit)) {
      return {
        commit: stamp.commit,
        ...(typeof stamp.date === 'string' ? { date: stamp.date } : {}),
      };
    }
  } catch {
    // No stamp: the packed CLI says.
  }
  return readBinary(path.join(appPath, 'Contents', 'Resources', 'untether'));
}

export type Git = (args: string[]) => Promise<string | undefined>;

export function gitIn(repo: string): Git {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: repo,
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      return undefined;
    }
  };
}

export interface AppLag {
  /** The checkout's head (short) and its date. */
  head: string;
  headDate?: string;
  /** Files of the app's sources changed since its build; empty = the app is up to date. */
  files: string[];
  /** Commits that changed them. */
  commits: number;
  /** The app's commit is not in the checkout's history: nothing can be said. */
  unknown?: true;
}

/** What changed in the app's sources between the commit it was built from and the head. */
export async function appLag(appCommit: string, git: Git): Promise<AppLag | undefined> {
  const headLine = await git(['log', '-1', '--format=%h%n%cI']);
  if (!headLine) return undefined;
  const [head, headDate] = headLine.split('\n');
  const base = { head, ...(headDate ? { headDate } : {}) };
  if (sameCommit(appCommit, head)) return { ...base, files: [], commits: 0 };
  // Built from a commit this checkout does not have (another branch, a rewritten history).
  if ((await git(['merge-base', '--is-ancestor', appCommit, 'HEAD'])) === undefined) {
    return { ...base, files: [], commits: 0, unknown: true };
  }
  const range = `${appCommit}..HEAD`;
  const files = await git(['diff', '--name-only', range, '--', ...APP_PATHSPEC]);
  if (files === undefined) return { ...base, files: [], commits: 0, unknown: true };
  const list = files.split('\n').filter(Boolean);
  if (!list.length) return { ...base, files: [], commits: 0 };
  const commits = await git(['rev-list', '--count', range, '--', ...APP_PATHSPEC]);
  return { ...base, files: list, commits: Number(commits) || 1 };
}

/** "mac/ (12 files), web/bin/ut": where the changes are, shortest first. */
export function describeLag(files: readonly string[]): string {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const source = APP_SOURCE_PATHS.find((entry) => file === entry || file.startsWith(`${entry}/`));
    const key = source ?? file;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return [...groups]
    .map(([key, list]) => (list.length > 1 ? `${key}/ (${list.length} files)` : list[0]))
    .join(', ');
}

/**
 * The doctor's app-build: the installed app this development server runs under is older than
 * its sources. With the autoUpdateInstalledApp setting on it is only a note in the history
 * (the updater rebuilds and swaps it, and tells the phone); off, a warning that says how.
 */
export function appBuildCheck(deps: {
  /** The installed app this server runs under; none: the check stays quiet. */
  app: () => Promise<RunningApp | undefined> | RunningApp | undefined;
  build: (appPath: string) => Promise<BuildInfo | undefined>;
  lag: (commit: string) => Promise<AppLag | undefined>;
  autoUpdate: () => boolean;
  /** Why the automatic update is not going ahead, when it is on and something holds it. */
  held?: () => string | undefined;
  /** The updater's schedule: on its way, last attempt failed, its interval. */
  schedule?: () => { scheduled: boolean; lastFailed: boolean; everyHours: number } | undefined;
  now?: () => number;
}): DoctorCheck {
  return {
    id: 'app-build',
    async run() {
      const app = await deps.app();
      if (!app) return [];
      const build = await deps.build(app.appPath);
      if (!build) {
        return [
          {
            key: `app-build-unknown:${app.appPath}`,
            check: 'app-build',
            severity: 'info',
            problem: `${app.appPath} does not say which commit it was built from (no ${APP_BUILD_STAMP}, no build marks in its CLI): it cannot be compared with its sources`,
          },
        ];
      }
      const lag = await deps.lag(build.commit);
      if (!lag || lag.unknown || !lag.files.length) return [];
      const auto = deps.autoUpdate();
      const held = auto ? deps.held?.() : undefined;
      // Behind, but the update is scheduled, the last attempt did not fail and the lag is
      // within one and a half intervals: nothing for anyone to do, so only a note
      // (2026-11-11: it warned the orchestrator after every merge into the watched folders).
      // Past that plazo the mechanism is not working: warning again.
      const plan = auto ? deps.schedule?.() : undefined;
      const lagMs = lag.headDate
        ? (deps.now?.() ?? Date.now()) - Date.parse(lag.headDate)
        : Number.POSITIVE_INFINITY;
      const onTrack =
        !!plan &&
        plan.scheduled &&
        !plan.lastFailed &&
        Number.isFinite(lagMs) &&
        lagMs <= plan.everyHours * 1.5 * 3_600_000;
      const finding: DoctorFinding = {
        key: `app-build:${app.appPath}:${build.commit}`,
        check: 'app-build',
        severity: (auto && !held) || onTrack ? 'info' : 'warning',
        problem:
          `the installed app ${app.appPath} is ${describeBuild(build)}, older than its sources at ${lag.head}: ${lag.commits} commit(s) changed ${describeLag(lag.files)}. ` +
          (auto
            ? held
              ? `Its automatic update (autoUpdateInstalledApp) is held: ${held}`
              : 'Untether rebuilds and replaces it by itself at a quiet moment (autoUpdateInstalledApp)'
            : 'Not a code bug: turn on autoUpdateInstalledApp (Settings, or config.json) and Untether rebuilds and replaces it by itself, or run mac/scripts/build.sh in a worktree of its own and install the result'),
      };
      return [finding];
    },
  };
}

/**
 * The native addons of the checkout the server runs from load with the Node the server runs on
 * (2026-11-11: mac/scripts/build.sh, run in that checkout, rebuilt authenticate-pam for the
 * embedded Node 24; the server, on Node 26, could not load it after its next restart and
 * password login was gone, with only "native module not found" in the log). Each is opened in a
 * child of this same Node (a module of another ABI must not be opened here); one that does not
 * load is rebuilt with node-gyp under this Node and opened again.
 */
export function nativeModulesLoadCheck(deps: {
  /** The addons: a name and where its .node file is (none when the package is not there). */
  modules: () => Array<{ name: string; file: string | null }>;
  /** Opens the file in a child of this Node; the error text when it does not load. */
  load: (file: string) => Promise<string | undefined>;
  rebuild: (name: string) => Promise<void>;
  fingerprint?: (file: string) => string | undefined;
  /** An app build at work in this checkout: nothing is opened or rebuilt until it ends. */
  building?: () => unknown;
}): DoctorCheck {
  const fingerprint =
    deps.fingerprint ??
    ((file: string) => {
      try {
        const stat = fs.statSync(file);
        return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
      } catch {
        return undefined;
      }
    });
  /** Files that loaded as they are now: not opened again until they change. */
  const loaded = new Map<string, string>();
  /** A rebuild that did not help is not repeated on the same file. */
  const failed = new Map<string, string>();
  return {
    id: 'native-modules-load',
    async run() {
      const findings: DoctorFinding[] = [];
      // 2026-11-12: a module rebuilt here during a release would have raced its build.
      if (deps.building?.()) return findings;
      for (const { name, file } of deps.modules()) {
        if (!file) continue;
        const print = fingerprint(file);
        // Not built at all is native-pty's (spawn-helper) and the build's business.
        if (!print || loaded.get(file) === print) continue;
        const error = await deps.load(file);
        if (!error) {
          loaded.set(file, print);
          failed.delete(file);
          continue;
        }
        const finding: DoctorFinding = {
          key: `native-modules-load:${name}`,
          check: 'native-modules-load',
          severity: 'critical',
          problem: `the native module ${name} (${file}) does not load with the Node the server runs on (${process.version}): ${error.split('\n')[0].slice(0, 200)}. Something built it for another Node (the app's build run in this checkout?)`,
        };
        if (failed.get(file) === print) {
          findings.push({
            ...finding,
            problem: `${finding.problem}; rebuilding it did not help`,
          });
          continue;
        }
        try {
          await deps.rebuild(name);
        } catch (rebuildError) {
          failed.set(file, fingerprint(file) ?? print);
          findings.push({
            ...finding,
            problem: `${finding.problem}; rebuilding it failed: ${rebuildError instanceof Error ? rebuildError.message.slice(0, 200) : String(rebuildError)}`,
          });
          continue;
        }
        const after = fingerprint(file);
        const still = after ? await deps.load(file) : 'the rebuild left no file';
        if (still) {
          if (after) failed.set(file, after);
          findings.push({ ...finding, problem: `${finding.problem}; rebuilding it did not help` });
        } else {
          if (after) loaded.set(file, after);
          findings.push({
            ...finding,
            healed: `rebuilt ${name} with node-gyp under ${process.version}; the server loads it at the next login`,
          });
        }
      }
      return findings;
    },
  };
}

/** Opens a native addon in a child of this Node; undefined when it loads. */
export async function loadsInChild(file: string): Promise<string | undefined> {
  try {
    await execFileAsync(
      process.execPath,
      ['-e', 'process.dlopen({ exports: {} }, process.argv[1])', file],
      { timeout: 20_000, env: { ...process.env, NODE_OPTIONS: '' } }
    );
    return undefined;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const line = stderr.split('\n').find((candidate) => /Error/.test(candidate));
    return (line ?? stderr.trim() ?? String(error)).trim() || String(error);
  }
}
