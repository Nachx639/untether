/**
 * Builds the signed Mac app of a commit in a worktree of its own (installed-app-updater.ts).
 *
 * 2026-11-11: mac/scripts/build.sh was run in the checkout the development server runs from.
 * Its web build wipes web/native and web/dist and installs and rebuilds node_modules for the
 * Node the app embeds (24): the server, on Node 26, could not load authenticate-pam after its
 * next restart. The build therefore never happens in that checkout: it has a worktree, kept
 * between builds (its node_modules, Xcode's products for its path), put on the commit to build.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** The folder of the app builds' worktree, inside a repository's task worktrees folder. */
export const APP_BUILD_WORKTREE = '.app-build';

/** Files of the checkout git ignores that the build needs, from the repository root. */
export const LOCAL_BUILD_FILES = ['mac/Untether/Local.xcconfig'] as const;

export interface AppBuildOptions {
  /** The checkout the server runs from. */
  repo: string;
  /** Where the build's worktree lives (made when missing). */
  worktree: string;
  commit: string;
  /** Runs the build in `cwd` (mac/ of the worktree), all output to `logPath`. */
  run: (cwd: string, logPath: string) => Promise<{ exitCode: number | null; tail: string }>;
  logPath: string;
  git?: (cwd: string, args: string[]) => Promise<string>;
}

const realGit = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', args, { cwd, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 }))
    .stdout;

/** The worktree on `commit`, with nothing of a previous build's edits to tracked files. */
export async function prepareBuildWorktree(
  options: Pick<AppBuildOptions, 'repo' | 'worktree' | 'commit' | 'git'>
): Promise<void> {
  const git = options.git ?? realGit;
  const same = (a: string, b: string) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return false;
    }
  };
  // Never the checkout the server runs from, whatever a caller hands in.
  if (same(options.worktree, options.repo)) {
    throw new Error('the app is never built in the checkout the server runs from');
  }
  if (!fs.existsSync(path.join(options.worktree, '.git'))) {
    fs.mkdirSync(path.dirname(options.worktree), { recursive: true });
    await git(options.repo, ['worktree', 'prune']);
    await git(options.repo, ['worktree', 'add', '--detach', options.worktree, options.commit]);
  } else {
    await git(options.worktree, ['checkout', '--force', '--detach', options.commit]);
  }
  // What the checkout has and git does not: the signing team (mac/Untether/Local.xcconfig,
  // ignored by git). Without it the build stops at "requires a development team". Copied each
  // time, so a change of it is followed.
  for (const local of LOCAL_BUILD_FILES) {
    const from = path.join(options.repo, local);
    const to = path.join(options.worktree, local);
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
    else fs.rmSync(to, { force: true });
  }
  // The custom Node the app embeds takes very long to compile: the one the checkout already
  // has is used (web/.node-builds, a cache of builds by version), never built again here.
  const cache = path.join(options.repo, 'web', '.node-builds');
  const link = path.join(options.worktree, 'web', '.node-builds');
  if (fs.existsSync(cache) && !fs.existsSync(link)) {
    try {
      fs.symlinkSync(cache, link, 'dir');
    } catch {
      // Without it the build prepares its own: slower, not wrong.
    }
  }
}

/** The bundle a build made, from what mac/scripts/build.sh prints last. */
export function builtAppPath(log: string): string | undefined {
  const lines = log.split('\n').filter((line) => line.startsWith('Build complete: '));
  const last = lines[lines.length - 1];
  return last ? last.slice('Build complete: '.length).trim() : undefined;
}

/**
 * Builds `commit`; the bundle it made. Throws with the end of the build's output when it
 * fails (the updater reads signing and keychain trouble from it).
 */
export async function buildInstalledApp(options: AppBuildOptions): Promise<{ appPath: string }> {
  await prepareBuildWorktree(options);
  fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
  const { exitCode, tail } = await options.run(path.join(options.worktree, 'mac'), options.logPath);
  let log = '';
  try {
    log = fs.readFileSync(options.logPath, 'utf8');
  } catch {
    // The tail is all there is.
  }
  if (exitCode !== 0) {
    throw new Error(`build.sh ended with ${exitCode ?? 'a signal'}\n${tail || log.slice(-4000)}`);
  }
  const appPath = builtAppPath(log) ?? builtAppPath(tail);
  if (!appPath || !fs.existsSync(path.join(appPath, 'Contents'))) {
    throw new Error(
      `build.sh ended well but its app was not found (${appPath ?? 'no path in its output'})`
    );
  }
  return { appPath };
}
