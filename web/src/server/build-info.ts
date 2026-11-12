/**
 * Which build of Untether a CLI or a server is (2026-10-31, real case: the server ran in
 * development from the repo and knew `ut project connector`, but the `ut` in PATH was the
 * app's bundled CLI from 2026-10-24 and answered "unknown command: ut project connector"; the
 * agent that ran it could not tell why). Each side knows its commit, the commit's date and the
 * `ut` commands it knows; the server announces them in its status, so a CLI older than the
 * server hands its command to the server's own CLI instead of running it (2026-11-10: the app's
 * ut took `--reply-to`, which only the server knew, for text), and the doctor can read the
 * installed CLIs (without running them) and warn when they are behind.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GIT_COMMIT } from './version.js';

export interface BuildInfo {
  version?: string;
  /** Short commit hash, or 'unknown'. */
  commit: string;
  /** The commit's date (ISO), which the native build also uses as its BUILD_DATE. */
  date?: string;
  /** Runs from a source checkout (tsx), not a bundle. */
  dev?: boolean;
  /** A CLI of this same build that can be run directly: `<cli> task …` / `<cli> project …`. */
  cli?: string;
  /** The `ut …` commands this build knows (from its help). */
  commands?: string[];
}

const WORD = /^[a-z][a-z-]*$/;

/** `ut task new`, `ut project connector add`, … from a usage text (TASK_CLI_HELP). */
export function commandsFromHelp(help: string): string[] {
  const commands = new Set<string>();
  for (const raw of help.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('ut ')) continue;
    const words: string[] = [];
    for (const word of line.split(/\s+/)) {
      if (!WORD.test(word)) break;
      words.push(word);
    }
    if (words.length >= 3) commands.add(words.join(' '));
  }
  return [...commands];
}

/** Two short hashes of different lengths can name the same commit. */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a === 'unknown' || b === 'unknown') return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Commands `newer` knows and `older` does not. */
export function missingCommands(older: BuildInfo, newer: BuildInfo): string[] {
  if (!older.commands || !newer.commands) return [];
  const known = new Set(older.commands);
  return newer.commands.filter((command) => !known.has(command));
}

/** Whether `a` is an older build than `b`: an earlier commit, or `b` knows commands `a` lacks. */
export function isOlderBuild(a: BuildInfo, b: BuildInfo): boolean {
  if (sameCommit(a.commit, b.commit)) return false;
  const at = a.date ? Date.parse(a.date) : Number.NaN;
  const bt = b.date ? Date.parse(b.date) : Number.NaN;
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at < bt;
  return missingCommands(a, b).length > 0;
}

/** "build e2e429fad, 2026-10-24" (", development" for a checkout). */
export function describeBuild(build: BuildInfo): string {
  const date = build.date ? `, ${build.date.slice(0, 10)}` : '';
  return `build ${build.commit}${date}${build.dev ? ', development' : ''}`;
}

const shellQuote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * What a ut older than the running server says when it refuses a command it could not hand to
 * the server's own CLI (task-cli/run.ts olderThanServer). `argv`: ['project', 'tell', …].
 */
export function olderCliRefusal(cli: BuildInfo, server: BuildInfo, argv: string[]): string[] {
  const lines = [
    `Error: this ut (${describeBuild(cli)}) is older than the running Untether server (${describeBuild(server)}): its commands and options may differ, so it ran nothing.`,
    `Fix: rebuild and reinstall the Untether app${server.dev ? ' from the checkout the server runs from' : ''} so its ut catches up.`,
  ];
  if (server.cli) {
    lines.push(
      "Until then, run the server's own CLI:",
      `  ${[server.cli, ...argv].map(shellQuote).join(' ')}`
    );
  }
  return lines;
}

/** The server answered an op it does not know: it is the older one. */
export function olderServerAdvice(cli: BuildInfo, server: BuildInfo | undefined): string[] {
  if (!server || !isOlderBuild(server, cli)) return [];
  return [
    `The running Untether server (${describeBuild(server)}) is older than this ut (${describeBuild(cli)}): restart Untether, or rebuild the app it runs from.`,
  ];
}

type Git = (cwd: string, args: string[]) => string | undefined;

const runGit: Git = (cwd, args) => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};

/** The repository this source runs from (web/src/server → repo root). */
export const SOURCE_REPO = path.resolve(__dirname, '..', '..', '..');

let devCache: { at: number; commit: string; date?: string } | undefined;

/**
 * This process's build. A bundle carries its commit and date (build-native.js defines them); a
 * checkout reads them from git (cached 30 s: the dev server answers status often).
 */
export function currentBuild(
  options: {
    help?: string;
    version?: string;
    git?: Git;
    repo?: string;
    now?: () => number;
    exists?: (file: string) => boolean;
    execPath?: string;
    commit?: string;
    buildDate?: string;
  } = {}
): BuildInfo {
  const commit = options.commit ?? GIT_COMMIT;
  const commands = options.help ? commandsFromHelp(options.help) : undefined;
  const base = {
    ...(options.version ? { version: options.version } : {}),
    ...(commands ? { commands } : {}),
  };
  if (commit !== 'development') {
    const date = options.buildDate ?? process.env.BUILD_DATE;
    return {
      ...base,
      commit,
      ...(date ? { date } : {}),
      cli: options.execPath ?? process.execPath,
    };
  }
  const repo = options.repo ?? SOURCE_REPO;
  const now = (options.now ?? Date.now)();
  if (!devCache || now - devCache.at > 30_000 || options.git) {
    const out = (options.git ?? runGit)(repo, ['log', '-1', '--format=%h%n%cI']);
    const [hash, date] = (out ?? '').split('\n');
    devCache = { at: now, commit: hash || 'unknown', ...(date ? { date } : {}) };
  }
  const cli = path.join(repo, 'web', 'bin', 'untether-dev');
  return {
    ...base,
    commit: devCache.commit,
    ...(devCache.date ? { date: devCache.date } : {}),
    dev: true,
    ...((options.exists ?? fs.existsSync)(cli) ? { cli } : {}),
  };
}

// Built by concatenation so this file's own bundled code never matches them.
const COMMIT_MARK = Buffer.from(`GIT_${'COMMIT = "'}`);
const DATE_MARK = Buffer.from(`BUILD_${'DATE = "'}`);
const HELP_MARK = Buffer.from(`TASK_CLI_${'HELP = `'}`);
const COMMIT_VALUE = /^[0-9a-f]{4,40}$/;
const DATE_VALUE = /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)$/;
const OVERLAP = 16 * 1024;
const CHUNK = 8 * 1024 * 1024;

/**
 * The build of an installed `untether` binary, read from its bytes (never run: an old binary
 * may take an unknown command as "start a server"). undefined when it carries no build marks
 * (a script, a stripped or minified build).
 */
export async function readBinaryBuild(file: string): Promise<BuildInfo | undefined> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return undefined;
  }
  let commit: string | undefined;
  let date: string | undefined;
  let help: string | undefined;
  try {
    let tail = Buffer.alloc(0);
    let position = 0;
    const chunk = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
      if (!bytesRead) break;
      position += bytesRead;
      const window = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      commit ??= findValue(window, COMMIT_MARK, '"', (v) => COMMIT_VALUE.test(v), 64);
      date ??= findValue(window, DATE_MARK, '"', (v) => DATE_VALUE.test(v), 64);
      help ??= findValue(window, HELP_MARK, '`', (v) => v.startsWith('Usage:\n  ut '), OVERLAP);
      if (commit && date && help) break;
      tail = window.subarray(Math.max(0, window.length - OVERLAP));
    }
  } finally {
    await handle.close();
  }
  if (!commit) return undefined;
  return {
    commit,
    ...(date ? { date } : {}),
    ...(help ? { commands: commandsFromHelp(help) } : {}),
  };
}

function findValue(
  window: Buffer,
  mark: Buffer,
  end: string,
  valid: (value: string) => boolean,
  max: number
): string | undefined {
  let from = 0;
  for (;;) {
    const at = window.indexOf(mark, from);
    if (at < 0) return undefined;
    const start = at + mark.length;
    const stop = window.indexOf(end, start);
    if (stop > start && stop - start <= max) {
      const value = window.subarray(start, stop).toString('utf8');
      if (valid(value)) return value;
    }
    from = at + 1;
  }
}

/**
 * The `untether` binaries a `ut` typed in a shell may run: the one next to each `ut` in PATH
 * (the app's Resources/ut sits beside its binary) and the installed apps' (the `ut` wrapper
 * prefers an installed app). Real paths, without repeats; `via` says how each was found.
 */
export function installedCliBinaries(
  options: {
    pathEnv?: string;
    home?: string;
    exists?: (file: string) => boolean;
    realpath?: (file: string) => string;
  } = {}
): Array<{ path: string; via: string }> {
  const exists = options.exists ?? fs.existsSync;
  const realpath =
    options.realpath ??
    ((file: string) => {
      try {
        return fs.realpathSync(file);
      } catch {
        return file;
      }
    });
  const home = options.home ?? os.homedir();
  const found = new Map<string, string>();
  const add = (binary: string, via: string) => {
    if (!exists(binary)) return;
    const real = realpath(binary);
    if (!found.has(real)) found.set(real, via);
  };
  const dirs = (options.pathEnv ?? process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of [...dirs, '/opt/homebrew/bin', '/usr/local/bin']) {
    const ut = path.join(dir, 'ut');
    if (!exists(ut)) continue;
    add(path.join(path.dirname(realpath(ut)), 'untether'), `the ut in PATH (${ut})`);
  }
  for (const apps of ['/Applications', path.join(home, 'Applications')]) {
    add(
      path.join(apps, 'Untether.app', 'Contents', 'Resources', 'untether'),
      `the app's CLI (${apps}/Untether.app)`
    );
  }
  return [...found].map(([binary, via]) => ({ path: binary, via }));
}
