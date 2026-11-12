/**
 * The local check a task must pass before it merges on its own.
 *
 * `detectCheck` picks a command per affected package: from each changed file it walks up to the
 * nearest folder (inside the repo) that yields a command, and dedupes by folder.
 *  - package.json: package manager from the lockfile (searched up to the repo root, then the
 *    `packageManager` field, else npm); the `check` script, else `lint` and `typecheck`; then
 *    `test` (runs with CI=1; a vitest script without `run` gets `run` appended).
 *  - Makefile with a `check:` target (else `test:`) → make check / make test.
 *  - Cargo.toml → cargo test --quiet; go.mod → go test ./...; pytest config → pytest -q.
 *  - Xcode projects get no default (too slow and signing-dependent); the user sets one.
 * A folder whose manifests yield nothing does not stop the walk (a package without scripts
 * falls back to the workspace root's check).
 *
 * `runCheck` runs one command through `/bin/zsh -lc` (the user's PATH: pnpm, cargo, …) with CI=1,
 * writes the whole output to a log file and returns the last 40 lines. On timeout the process
 * group gets SIGTERM, then SIGKILL 5 s later; a timed-out check never passes. It ends when the
 * shell exits (not when every background child lets go of its output).
 *
 * `checkLimiter` caps concurrent checks per Mac (checkLoad.maxConcurrent, default one per 6 cores:
 * a check can pin half the cores) and starts none while
 * the 1-minute load is over checkLoad.maxLoadPerCore × cores (default 2), or memory or swap is
 * short by config.json's taskAdmission (resource-monitor.ts) (up to maxWaitSec,
 * default 600, then anyway) nor while the disk of its repo or worktree is low (checkDisk,
 * default under 5 GB or 2 % free, until it recovers); the merge pipeline shows «comprobando (en
 * cola)» or «esperando disco» until `onStart` fires. A failure while the disk was low, or with
 * ENOSPC in its output, is the environment's (`watchDisk`, `diskFullOutput`). `watchLoad` samples
 * the load during a run (a failure under load runs again once it drops) and `failedTestNames`
 * names the tests a run failed (kept as flaky under load when the rerun passed).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectSettings } from '../../shared/projects.js';
import type { TaskCheckLoad } from '../../shared/tasks.js';
import { describeNodeRuntime, type NodeRuntime, pathPrependLine } from '../utils/node-runtime.js';
import { every } from '../utils/periodic-loop.js';
import { withoutServerRuntime } from '../utils/session-env.js';
import { CHECK_SLOT_ENV } from './check-slot-wrap.js';

export interface DetectedCheck {
  /** Absolute folder to run the command in. */
  cwd: string;
  command: string;
  /** Short, technical: which manifest and scripts produced the command. */
  reason: string;
}

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function exists(file: string): boolean {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function isInside(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function packageManagerFor(
  root: string,
  dir: string,
  pkg: { packageManager?: unknown }
): PackageManager {
  for (let d = dir; isInside(root, d); d = path.dirname(d)) {
    for (const [lock, pm] of LOCKFILES) if (exists(path.join(d, lock))) return pm;
    if (d === root) break;
  }
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return declared;
  return 'npm';
}

function runScript(pm: PackageManager, script: string, extra?: string): string {
  if (!extra) return `${pm} run ${script}`;
  return pm === 'npm' ? `npm run ${script} -- ${extra}` : `${pm} run ${script} ${extra}`;
}

function fromPackageJson(root: string, dir: string): DetectedCheck | null {
  const text = readText(path.join(dir, 'package.json'));
  if (text === null) return null;
  let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    pkg = JSON.parse(text);
  } catch {
    return null;
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const has = (name: string) => typeof scripts[name] === 'string' && scripts[name] !== '';
  const pm = packageManagerFor(root, dir, pkg);
  const steps: string[] = [];
  const used: string[] = [];
  if (has('check')) {
    steps.push(runScript(pm, 'check'));
    used.push('check');
  } else {
    for (const name of ['lint', 'typecheck']) {
      if (has(name)) {
        steps.push(runScript(pm, name));
        used.push(name);
      }
    }
  }
  if (has('test')) {
    const test = String(scripts.test);
    // Placeholder from `npm init`: no tests.
    if (!/no test specified/.test(test)) {
      const vitestWatch = /\bvitest\b/.test(test) && !/\bvitest\s+(run|--run)\b|--run\b/.test(test);
      steps.push(runScript(pm, 'test', vitestWatch ? 'run' : undefined));
      used.push('test');
    }
  }
  if (!steps.length) return null;
  return {
    cwd: dir,
    command: steps.join(' && '),
    reason: `package.json (${pm}): ${used.join(', ')}`,
  };
}

function fromMakefile(dir: string): DetectedCheck | null {
  const text = readText(path.join(dir, 'Makefile')) ?? readText(path.join(dir, 'makefile'));
  if (text === null) return null;
  for (const target of ['check', 'test']) {
    if (new RegExp(`^${target}\\s*:`, 'm').test(text)) {
      return { cwd: dir, command: `make ${target}`, reason: `Makefile: ${target}` };
    }
  }
  return null;
}

function fromPython(root: string, dir: string): DetectedCheck | null {
  const pyproject = readText(path.join(dir, 'pyproject.toml'));
  const setupCfg = readText(path.join(dir, 'setup.cfg'));
  const toxIni = readText(path.join(dir, 'tox.ini'));
  const usesPytest =
    exists(path.join(dir, 'pytest.ini')) ||
    exists(path.join(dir, 'conftest.py')) ||
    (pyproject !== null && /pytest/.test(pyproject)) ||
    (setupCfg !== null && /\[tool:pytest\]/.test(setupCfg)) ||
    (toxIni !== null && /\[pytest\]/.test(toxIni));
  if (!usesPytest) return null;
  // 2026-10-18: atlas's server/tests (a conftest.py) ran the system python3, which has no
  // pytest; its uv.lock and .venv are one folder up, in server/. Look up to the repo root.
  let command = 'python3 -m pytest -q';
  for (let at = dir; isInside(root, at); at = path.dirname(at)) {
    if (exists(path.join(at, 'uv.lock'))) {
      command = 'uv run pytest -q';
      break;
    }
    if (exists(path.join(at, '.venv/bin/python'))) {
      const python = path.relative(dir, path.join(at, '.venv/bin/python'));
      command = `${python} -m pytest -q`;
      break;
    }
    if (at === root) break;
  }
  return { cwd: dir, command, reason: 'pytest' };
}

/** The check a single folder yields, by manifest precedence; null when it yields nothing. */
function checkForDir(root: string, dir: string): DetectedCheck | null {
  return (
    fromPackageJson(root, dir) ??
    fromMakefile(dir) ??
    (exists(path.join(dir, 'Cargo.toml'))
      ? { cwd: dir, command: 'cargo test --quiet', reason: 'Cargo.toml' }
      : null) ??
    (exists(path.join(dir, 'go.mod'))
      ? { cwd: dir, command: 'go test ./...', reason: 'go.mod' }
      : null) ??
    fromPython(root, dir)
  );
}

/**
 * Prose and pictures: nothing a check could test. (2026-10-20: an atlas task that only wrote
 * docs/IDEAS_INKWELL.md stopped at "no-check", and its orchestrator told the user the
 * project's check setting had been deleted.)
 */
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|png|jpe?g|gif|webp|heic|pdf)$/i;
/**
 * A .txt counts as prose only in a docs folder or under a prose name. 2026-10-20: every .txt
 * was docs, so a task that only changed requirements.txt or CMakeLists.txt merged unchecked.
 */
const DOC_TXT =
  /(^|\/)(docs?|documentation|notes)\/[^/]+\.txt$|(^|\/)(readme|license|licence|copying|notice|authors|contributors|changelog|changes|history|news|todo|notes?)([._-][^/]*)?\.txt$/i;
/** Text files that configure a build or its dependencies, wherever they are. */
const MANIFEST_TXT =
  /(^|\/)(requirements[^/]*|constraints[^/]*|CMakeLists|robots|runtime|Pipfile|dependencies)\.txt$/i;

function isDocFile(file: string): boolean {
  if (MANIFEST_TXT.test(file)) return false;
  if (/\.txt$/i.test(file)) return DOC_TXT.test(file);
  return DOC_FILE.test(file);
}

/** True when every changed file is documentation: such a task merges without a check. */
export function onlyDocs(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(isDocFile);
}

/**
 * One check per affected package. `changedFiles` are repo-relative (as git prints them);
 * files that escape the repo or live in node_modules are ignored. Order: first appearance.
 */
export function detectCheck(repoRoot: string, changedFiles: readonly string[]): DetectedCheck[] {
  const root = path.resolve(repoRoot);
  const byDir = new Map<string, DetectedCheck | null>();
  const result = new Map<string, DetectedCheck>();
  for (const file of changedFiles) {
    const abs = path.resolve(root, file);
    if (!isInside(root, abs) || abs === root) continue;
    if (abs.split(path.sep).includes('node_modules')) continue;
    for (let dir = path.dirname(abs); isInside(root, dir); dir = path.dirname(dir)) {
      let check = byDir.get(dir);
      if (check === undefined) {
        check = checkForDir(root, dir);
        byDir.set(dir, check);
      }
      if (check) {
        if (!result.has(check.cwd)) result.set(check.cwd, check);
        break;
      }
      if (dir === root) break;
    }
  }
  return [...result.values()];
}

/** Manifests a check can come from; each names its package's folder. */
const MANIFEST_SPECS = [
  'package.json',
  'Makefile',
  'makefile',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pytest.ini',
  'setup.cfg',
  'tox.ini',
].flatMap((file) => [`:(glob)${file}`, `:(glob)**/${file}`]);
const MAX_MANIFESTS = 200;
const MAX_CHECKS = 20;

/**
 * Every check the repository's packages would get (the phone's settings sheet, `ut project
 * show`): the tracked manifests' folders, as detectCheck finds them for a change there.
 */
export async function detectProjectChecks(
  repoPath: string,
  list: (args: string[]) => Promise<{ code: number | null; stdout: string }>
): Promise<Array<DetectedCheck & { dir: string }>> {
  const listed = await list(['ls-files', '-z', '--', ...MANIFEST_SPECS]);
  const manifests = (listed.code === 0 ? listed.stdout.split('\0') : [])
    .filter((file) => file && !file.split('/').includes('node_modules'))
    .slice(0, MAX_MANIFESTS);
  return detectCheck(repoPath, manifests)
    .slice(0, MAX_CHECKS)
    .map((check) => ({ ...check, dir: path.relative(repoPath, check.cwd) || '.' }));
}

// ---------------------------------------------------------------------------------------------
// Two levels (2026-11-02): the task's own check runs only the tests related to its files
// ---------------------------------------------------------------------------------------------

/**
 * Files a related-tests command can judge by default: code a test imports. Anything else (a
 * shell script, a Swift file, an asset a test reads by path) gets the whole check.
 */
export const RELATED_TEST_FILES_DEFAULT = String.raw`\.(c|m)?[jt]sx?$`;
/**
 * Files whose change reaches tests no import graph shows: manifests and lockfiles, tool and
 * test-runner configs, test setup, helpers, fixtures and mocks, type declarations.
 */
export const RELATED_FULL_PATHS_DEFAULT = [
  String.raw`(^|/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|\.npmrc|\.nvmrc|\.node-version)$`,
  String.raw`(^|/)tsconfig[^/]*\.json$`,
  String.raw`(^|/)(vitest|vite|jest|playwright|biome|eslint|babel|webpack|rollup|esbuild|tsup|postcss|tailwind)[^/]*\.(config|workspace)[^/]*$`,
  String.raw`(^|/)(biome\.jsonc?|\.eslintrc[^/]*|\.babelrc[^/]*|\.prettierrc[^/]*)$`,
  // In a test folder, anything but a test file: setup, helpers, fixtures, servers it starts.
  String.raw`(^|/)(test|tests|__tests__|spec)/(?!(.*/)?[^/]+\.(test|spec)\.[cm]?[jt]sx?$)`,
  String.raw`(^|/)(__mocks__|__fixtures__|fixtures)/`,
  String.raw`(^|/)(setup|global-setup|test-setup|setup-tests|vitest\.setup|jest\.setup)\.[cm]?[jt]sx?$`,
  String.raw`\.d\.[cm]?ts$`,
].join('|');
export const RELATED_MAX_FILES_DEFAULT = 40;

export type TaskCheckPlan =
  | {
      level: 'related';
      /** Runs from the worktree's root: the fast check, then the related tests. */
      command: string;
      files: string[];
    }
  | { level: 'full'; reason: string };

function regexOr(source: string | undefined, fallback: string): RegExp {
  try {
    return new RegExp(source || fallback);
  } catch {
    return new RegExp(fallback);
  }
}

/** Single-quote a word for zsh. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The task's own check in a two-level project (relatedTestCommand set), or why it is the whole
 * one. `files` are the branch's changed files (repo-relative); `exists` says whether one is
 * still there (a deleted file's importers are not found by its path); `renamed` counts renames.
 * Documentation does not count (onlyDocs): it is neither related nor a reason for the whole.
 */
export function planTaskCheck(
  settings: Pick<
    ProjectSettings,
    | 'fastCheckCommand'
    | 'relatedTestCommand'
    | 'relatedTestFiles'
    | 'relatedFullPaths'
    | 'relatedMaxFiles'
  >,
  worktreePath: string,
  files: readonly string[],
  options: { exists?: (file: string) => boolean; renamed?: number } = {}
): TaskCheckPlan | null {
  const template = settings.relatedTestCommand;
  if (!template) return null;
  const exists = options.exists ?? ((file: string) => fs.existsSync(path.join(worktreePath, file)));
  const code = files.filter((file) => !isDocFile(file));
  const max = settings.relatedMaxFiles ?? RELATED_MAX_FILES_DEFAULT;
  if (!code.length) return { level: 'full', reason: 'no code file changed' };
  if (code.length > max)
    return { level: 'full', reason: `${code.length} files changed (over ${max})` };
  if (options.renamed) return { level: 'full', reason: 'a file was renamed' };
  const full = regexOr(settings.relatedFullPaths, RELATED_FULL_PATHS_DEFAULT);
  const judged = regexOr(settings.relatedTestFiles, RELATED_TEST_FILES_DEFAULT);
  for (const file of code) {
    if (full.test(file)) return { level: 'full', reason: `${file} reaches tests no import shows` };
    if (!judged.test(file))
      return { level: 'full', reason: `${file} is not a file the related tests judge` };
    if (!exists(file)) return { level: 'full', reason: `${file} was deleted` };
  }
  const list = code.map((file) => shellWord(path.join(worktreePath, file))).join(' ');
  const related = template.split('{files}').join(list);
  const fast = settings.fastCheckCommand?.trim();
  return {
    level: 'related',
    command: fast ? `(${fast}) && (${related})` : related,
    files: code,
  };
}

// ---------------------------------------------------------------------------------------------
// Running a check
// ---------------------------------------------------------------------------------------------

export interface RunCheckOptions {
  command: string;
  cwd: string;
  timeoutSec: number;
  /** Full output goes here (folder created when missing; file truncated). */
  logPath: string;
  env?: Record<string, string>;
  /**
   * Stops it (its whole process group) when aborted: the AI review found problems first, so
   * its result is not waited for (2026-10-31). It then ends as a failure with `cancelled`.
   */
  signal?: AbortSignal;
  /**
   * The Node the project asks for (utils/node-runtime.ts, 2026-11-02): a fitting installed one
   * goes first on PATH inside the shell, after its login profile; when none fits the log says
   * so, at its start and in the tail of a failure.
   */
  node?: NodeRuntime;
}

export interface RunCheckResult {
  /** null when the process ended by a signal (timeout included). */
  exitCode: number | null;
  /** Last 40 lines of output, ANSI escapes stripped. */
  tail: string;
  timedOut: boolean;
  /** Stopped through its signal before it finished. */
  cancelled?: boolean;
}

/** How much a check yields the CPU to the user's own work (nice level). */
export const CHECK_NICE = 10;
const TAIL_LINES = 40;
const TAIL_BUFFER_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;
/** After the check's shell exits, how long its pipes may still bring output. */
const DRAIN_MS = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function tailLines(text: string, count = TAIL_LINES): string {
  const lines = text.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.slice(-count).join('\n');
}

/** Where toolchain installers put their binaries, relative to HOME. */
const TOOL_DIRS = ['.cargo/bin', '.local/bin', '.bun/bin', '.deno/bin', 'go/bin'];

/**
 * PATH plus the toolchain directories that exist and are missing from it. 2026-10-22: a task's
 * check failed with "command not found: cargo": rustup had put ~/.cargo/bin on PATH in
 * ~/.profile, which `zsh -lc` never reads, and the agent was handed a failure it could not fix.
 */
export function withToolDirs(
  pathValue: string | undefined,
  home: string | undefined,
  exists: (dir: string) => boolean
): string | undefined {
  if (!home) return pathValue;
  const entries = (pathValue ?? '').split(':').filter(Boolean);
  for (const rel of TOOL_DIRS) {
    const dir = path.join(home, rel);
    if (!entries.includes(dir) && exists(dir)) entries.push(dir);
  }
  return entries.length > 0 ? entries.join(':') : pathValue;
}

/**
 * The environment a project's check runs in: the server's, without what the server's own
 * runtime set for itself. 2026-10-18: NODE_ENV=development from Untether's dev server made a
 * task's `pnpm test` bundle its CLI the development way, and the check failed in the worktree.
 */
export function checkEnv(
  env: NodeJS.ProcessEnv,
  exists: (dir: string) => boolean = fs.existsSync
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, PATH: withToolDirs(env.PATH, env.HOME, exists) };
  // Nor is a check a session: an agent's UNTETHER_SESSION_ID would make `ut` act as it.
  delete clean.UNTETHER_SESSION_ID;
  return withoutServerRuntime(clean);
}

/** The process group of every check this server runs, by its log (doctor: checkAlive). */
const liveChecks = new Map<string, number>();

/**
 * Whether the check writing `logPath` still has a live process (its process group), for the
 * doctor's stuck-tasks: a check silent for a while under load is not stuck while it lives
 * (2026-11-08). Undefined when no check of this server writes that log.
 */
export function checkAlive(logPath: string): boolean | undefined {
  const pgid = liveChecks.get(logPath);
  if (pgid === undefined) return undefined;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runCheck(options: RunCheckOptions): Promise<RunCheckResult> {
  const { command, cwd, timeoutSec, logPath, env = {}, signal, node } = options;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: 'w' });
  const nodeLine = node && describeNodeRuntime(node);
  log.write(
    `$ ${command}\n# cwd: ${cwd}\n${nodeLine ? `# node: ${nodeLine}\n` : ''}# started: ${new Date().toISOString()}\n\n`
  );
  const shellCommand =
    node?.kind === 'switch' ? `${pathPrependLine(node.node.bin)}\n${command}` : command;

  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer | string) => {
      if (settled) return;
      const text = chunk.toString();
      log.write(text);
      tail += text;
      if (tail.length > TAIL_BUFFER_BYTES) tail = tail.slice(-TAIL_BUFFER_BYTES);
    };
    const finish = (exitCode: number | null, note: string) => {
      if (settled) return;
      settled = true;
      if (child.pid && liveChecks.get(logPath) === child.pid) liveChecks.delete(logPath);
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      // A check that timed out or was stopped failed, whatever its exit code says.
      const code = (timedOut || cancelled) && exitCode === 0 ? null : exitCode;
      // Its failure says, last, that no fitting Node was there (not an obscure engine error).
      if (code !== 0 && node?.kind === 'missing' && nodeLine) {
        const said = `\n# ${nodeLine}\n`;
        log.write(said);
        tail += said;
      }
      log.end(`\n# ${note}\n`, () =>
        resolve({
          exitCode: code,
          tail: tailLines(tail),
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
        })
      );
    };
    const cancel = () => {
      if (settled || cancelled) return;
      cancelled = true;
      append('\n# stopped: not needed any more\n');
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };

    // At low priority (2026-10-23: two checks running the whole suite on every core pushed the
    // Mac to a load of ~270; the user's sessions and the simulator crawled and timing tests
    // failed). The user's own work always comes first.
    // To level CHECK_NICE, not CHECK_NICE more: a check of Untether itself runs these tests
    // already niced, and at 20 zsh's `&` failed with "nice(5) failed" in their output.
    const raise = Math.max(0, CHECK_NICE - os.getPriority());
    const child = spawn('/usr/bin/nice', ['-n', String(raise), '/bin/zsh', '-lc', shellCommand], {
      cwd,
      // The check runs in a slot already: a `ut check-slot run` inside it must not wait for
      // a second one (check-slots.ts).
      env: { ...checkEnv(process.env), ...env, CI: '1', [CHECK_SLOT_ENV]: 'verify' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout kills the whole tree (pnpm → vitest → workers).
      detached: true,
    });
    if (child.pid) liveChecks.set(logPath, child.pid);
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      append(`\n# timed out after ${timeoutSec}s\n`);
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, timeoutSec * 1000);

    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => {
      append(`\n${error.message}\n`);
      finish(null, `failed to start: ${error.message}`);
    });
    // 2026-10-20: settled on 'close', which waits for every holder of the pipes: a check that
    // left a background process (`server & exit 0`) hung until the timeout and then passed with
    // exit code 0. The shell's own exit is the result; the pipes get a moment to drain, then
    // they and whatever the check left behind in its process group go.
    child.on('exit', (code, signal) => {
      const drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        killGroup('SIGTERM');
        finish(code, signal ? `killed by ${signal}` : `exit ${code}`);
      }, DRAIN_MS);
      child.once('close', () => {
        clearTimeout(drain);
        killGroup('SIGTERM');
        finish(code, signal ? `killed by ${signal}` : `exit ${code}`);
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Machine load
// ---------------------------------------------------------------------------------------------

/** config.json `checkLoad`: when the Mac is too busy for another check to start. */
export interface CheckLoadSettings {
  /** The 1-minute load average a check may start at, per core; 0 = no limit. */
  maxLoadPerCore: number;
  /** How long a check waits for the load to drop before it starts anyway. */
  maxWaitSec: number;
  /**
   * How many checks (of any task, any project) run at once on this Mac; 0 = from the cores
   * (checksFromCores). 2026-11-02: two full checks at once (each vitest on half the cores)
   * plus agents and Time Machine took the 12-core Mac to a load of 35-177, and both failed by
   * time (sessions-api e2e, shielded-tmux, css-watch…), each passing alone. Those failures now
   * rerun once the load drops, so the default keeps 2 on 12 cores for the merge queue.
   */
  maxConcurrent: number;
  /**
   * How long a run a task's agent or a script starts through `ut check-slot` waits for its
   * slot before it runs without one (check-slots.ts, 2026-11-10); 0 = it never waits.
   */
  maxSlotWaitSec: number;
}

export const DEFAULT_CHECK_LOAD: CheckLoadSettings = {
  maxLoadPerCore: 2,
  maxWaitSec: 600,
  maxConcurrent: 0,
  maxSlotWaitSec: 1800,
};

/**
 * One check per 6 cores, at least one (2 on a 12-core Mac): a full check runs its test workers
 * on about half the cores (vitest.config.ts maxWorkers). One at a time slowed the merge queue,
 * and a failure under load already reruns once the load drops (task-merge.ts).
 */
export function checksFromCores(cores: number): number {
  return Math.max(1, Math.floor(cores / 6));
}

/** After a check starts, no slot is added this long: the 1-minute load has yet to show it. */
export const CHECK_RAMP_MS = 60_000;

/** How often the full check limiter looks whether the margin gives one more slot. */
export const CHECK_RECHECK_MS = 15_000;

/** What the Mac is doing now, for the slots past the fixed ones (checkConcurrency). */
export interface CheckMargin {
  /** Checks running now, and how long ago the last one started. */
  active: number;
  sinceStartMs: number;
  /** The 1-minute load and the gate's threshold (checkLoad.maxLoadPerCore × cores; 0: none). */
  load: number;
  threshold: number;
  /** The Mac has room for one more task (resource-monitor.ts: memory, swap, pressure). */
  room: boolean;
}

/**
 * How many checks may run at once now. checkLoad.maxConcurrent when set; else one per 6 cores,
 * plus (2026-11-11) more while the ones running leave real margin: every base slot taken, none
 * started in the last CHECK_RAMP_MS, the Mac with room for a task, and the load a check's worth
 * (half the cores) under the gate's threshold even after one more. Never past one per 3 cores.
 */
export function checkConcurrency(
  settings: CheckLoadSettings,
  cores: number = os.availableParallelism(),
  margin?: CheckMargin
): number {
  if (settings.maxConcurrent > 0) return Math.floor(settings.maxConcurrent);
  const base = checksFromCores(cores);
  if (!margin?.room || margin.threshold <= 0 || margin.active < base) return base;
  if (margin.sinceStartMs < CHECK_RAMP_MS) return Math.max(base, margin.active);
  const perCheck = Math.max(1, cores / 2);
  const spare = Math.floor((margin.threshold - margin.load) / perCheck) - 1;
  const most = Math.max(base, Math.ceil(cores / 3));
  return Math.min(most, Math.max(base, margin.active + Math.max(0, spare)));
}

export interface LoadGate {
  /**
   * The 1-minute load average now, and whether the Mac is too busy: the load is over the
   * threshold, or memory/swap is short (`memory` says how, from the resource sampler).
   */
  sample(): { load: number; threshold: number; high: boolean; memory?: string };
  /** How long a check waits at most (ms) and how often it looks again. */
  readonly maxWaitMs: number;
  readonly pollMs: number;
  /** Resolves once the load is not high, or after maxWaitMs; true when the load dropped. */
  waitForLow(signal?: AbortSignal): Promise<boolean>;
}

export interface LoadGateOptions {
  settings?: () => CheckLoadSettings;
  loadavg?: () => number;
  cores?: () => number;
  /** What memory or swap is short of now (resource-monitor.ts); undefined: there is room. */
  memoryShort?: () => string | undefined;
  pollMs?: number;
  now?: () => number;
}

/**
 * 2026-10-24: two Untether checks plus five tasks of another project with Chrome and agents
 * took the 12-core Mac to a load of 94-120; real PTY tests (forwarder-kill, foreground-pgids,
 * shielded-tmux) failed by time and the tasks spent their fix attempts on failures not theirs.
 * A check does not start while the load is over maxLoadPerCore × cores.
 */
export function createLoadGate(options: LoadGateOptions = {}): LoadGate {
  const settings = () => options.settings?.() ?? DEFAULT_CHECK_LOAD;
  const loadavg = options.loadavg ?? (() => os.loadavg()[0]);
  const cores = options.cores ?? (() => os.availableParallelism());
  const pollMs = options.pollMs ?? 5_000;
  const now = options.now ?? Date.now;
  const sample = () => {
    const { maxLoadPerCore } = settings();
    const threshold = maxLoadPerCore * cores();
    const load = loadavg();
    let memory: string | undefined;
    try {
      memory = options.memoryShort?.();
    } catch {
      memory = undefined;
    }
    return {
      load,
      threshold,
      high: (maxLoadPerCore > 0 && load > threshold) || !!memory,
      ...(memory ? { memory } : {}),
    };
  };
  return {
    sample,
    get maxWaitMs() {
      return settings().maxWaitSec * 1000;
    },
    pollMs,
    waitForLow(signal) {
      const deadline = now() + settings().maxWaitSec * 1000;
      return new Promise<boolean>((resolve) => {
        const look = () => {
          // A stopped check stops waiting (2026-11-10): it held its place in the check
          // limiter for up to maxWaitSec, a check nobody was going to run.
          if (signal?.aborted) return resolve(false);
          if (!sample().high) return resolve(true);
          if (now() >= deadline) return resolve(false);
          setTimeout(look, pollMs).unref?.();
        };
        look();
      });
    },
  };
}

/** config.json's `checkLoad`, each field defaulted on its own. */
export function checkLoadFrom(value?: Partial<CheckLoadSettings>): CheckLoadSettings {
  return {
    maxLoadPerCore: value?.maxLoadPerCore ?? DEFAULT_CHECK_LOAD.maxLoadPerCore,
    maxWaitSec: value?.maxWaitSec ?? DEFAULT_CHECK_LOAD.maxWaitSec,
    maxConcurrent: value?.maxConcurrent ?? DEFAULT_CHECK_LOAD.maxConcurrent,
    maxSlotWaitSec: value?.maxSlotWaitSec ?? DEFAULT_CHECK_LOAD.maxSlotWaitSec,
  };
}

let checkLoadSettings: () => CheckLoadSettings = () => DEFAULT_CHECK_LOAD;

/** The server hands in config.json's `checkLoad` (read each time it matters). */
export function setCheckLoadSettings(get: () => CheckLoadSettings): void {
  checkLoadSettings = get;
}

/** config.json's `checkLoad` as the server reads it now. */
export function currentCheckLoad(): CheckLoadSettings {
  return checkLoadSettings();
}

let checkMemoryShort: () => string | undefined = () => undefined;

/**
 * The server hands in the resource sampler's word on memory and swap (2026-11-01): a check
 * does not start while the Mac swaps hard either (up to the same maxWaitSec).
 */
export function setCheckMemoryShort(get: () => string | undefined): void {
  checkMemoryShort = get;
}

let checkRoom: () => boolean = () => false;

/**
 * The server hands in whether the Mac has room for one more task (2026-11-11): only then may
 * checks take slots past the fixed ones (checkConcurrency). Not handed in: the fixed ones.
 */
export function setCheckRoom(get: () => boolean): void {
  checkRoom = get;
}

/** The gate the shared checkLimiter and the merge pipeline's load rerun use. */
export const checkLoadGate = createLoadGate({
  settings: () => checkLoadSettings(),
  memoryShort: () => checkMemoryShort(),
});

/**
 * The Mac's load sampled all along one check run (2026-11-02): a run that failed while the Mac
 * was over its threshold at any point is run again once the load is back down before it counts
 * as the task's, and one on a quiet Mac counts at once. A sample at the start, every
 * `intervalMs` and one at the end (the 1-minute average lags, so the end one sees the run).
 */
export function watchLoad(
  gate: Pick<LoadGate, 'sample'>,
  intervalMs = 10_000
): { stop(): TaskCheckLoad } {
  let peak = 0;
  let sum = 0;
  let samples = 0;
  let threshold = 0;
  let high = false;
  let memory: string | undefined;
  const look = () => {
    let now: ReturnType<LoadGate['sample']>;
    try {
      now = gate.sample();
    } catch {
      return;
    }
    samples++;
    sum += now.load;
    peak = Math.max(peak, now.load);
    threshold = now.threshold;
    if (now.high) high = true;
    if (now.memory) memory = now.memory;
  };
  look();
  const timer = every('task verify look', look, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      look();
      const round = (n: number) => Math.round(n * 10) / 10;
      return {
        peak: round(peak),
        mean: round(samples ? sum / samples : 0),
        threshold: round(threshold),
        samples,
        ...(high ? { high: true } : {}),
        ...(memory ? { memory } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Free disk
// ---------------------------------------------------------------------------------------------

/** config.json `checkDisk`: how little free disk stops new checks from starting. */
export interface CheckDiskSettings {
  /** Low under this many GB free on the volume of the repo or of the worktrees; 0 = off. */
  minFreeGB: number;
  /** Low under this share (%) of the volume free; 0 = off. Either one makes it low. */
  minFreePercent: number;
}

export const DEFAULT_CHECK_DISK: CheckDiskSettings = { minFreeGB: 5, minFreePercent: 2 };

/** The emptiest volume among the paths looked at. */
export interface DiskSample {
  path: string;
  freeBytes: number;
  totalBytes: number;
  low: boolean;
}

export interface DiskGate {
  /** The volume with the least free space among `paths` (undefined: none could be read). */
  sample(paths: readonly string[]): DiskSample | undefined;
  readonly pollMs: number;
  /** Resolves once no volume of `paths` is low, or when `signal` aborts. Never gives up. */
  waitForSpace(paths: readonly string[], signal?: AbortSignal): Promise<void>;
}

export interface DiskGateOptions {
  settings?: () => CheckDiskSettings;
  /** fs.statfsSync's free (bavail × bsize) and total (blocks × bsize) bytes. */
  statfs?: (dir: string) => { freeBytes: number; totalBytes: number };
  pollMs?: number;
}

const GB = 1024 * 1024 * 1024;

function statfsBytes(dir: string): { freeBytes: number; totalBytes: number } {
  const stat = fs.statfsSync(dir);
  return { freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
}

/** The nearest folder up from `dir` that exists (a worktree may not be made yet). */
function existingAncestor(dir: string): string {
  let current = path.resolve(dir);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function formatGB(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/**
 * 2026-11-01 22:22: claude-mem's Chroma index grew to 81 GB and left the Mac ~1 GB free while
 * bakery's checks ran; task 751b4753's check failed by the environment ("the turn never
 * reached the runner" in 7 tests, nothing to do with its change) and was handed back to its
 * agent. No check starts while the volume of its repo or of its worktree is low (under
 * minFreeGB, or under minFreePercent of the volume): it waits, shown as «esperando disco», and
 * starts by itself once space is back. Unlike the load, there is no "start anyway": a check on
 * a full disk only fails in ways that are not the task's.
 */
export function createDiskGate(options: DiskGateOptions = {}): DiskGate {
  const settings = () => options.settings?.() ?? DEFAULT_CHECK_DISK;
  const statfs = options.statfs ?? statfsBytes;
  const pollMs = options.pollMs ?? 15_000;
  const sample = (paths: readonly string[]): DiskSample | undefined => {
    const { minFreeGB, minFreePercent } = settings();
    let worst: DiskSample | undefined;
    for (const dir of new Set(paths.map(existingAncestor))) {
      let stat: { freeBytes: number; totalBytes: number };
      try {
        stat = statfs(dir);
      } catch {
        continue;
      }
      const low =
        (minFreeGB > 0 && stat.freeBytes < minFreeGB * GB) ||
        (minFreePercent > 0 &&
          stat.totalBytes > 0 &&
          (stat.freeBytes / stat.totalBytes) * 100 < minFreePercent);
      const entry = { path: dir, ...stat, low };
      if (
        !worst ||
        (entry.low && !worst.low) ||
        (entry.low === worst.low && entry.freeBytes < worst.freeBytes)
      ) {
        worst = entry;
      }
    }
    return worst;
  };
  return {
    sample,
    pollMs,
    waitForSpace(paths, signal) {
      return new Promise<void>((resolve) => {
        const look = () => {
          if (signal?.aborted || !sample(paths)?.low) return resolve();
          setTimeout(look, pollMs).unref?.();
        };
        look();
      });
    },
  };
}

/** config.json's `checkDisk`, each field defaulted on its own. */
export function checkDiskFrom(value?: Partial<CheckDiskSettings>): CheckDiskSettings {
  return {
    minFreeGB: value?.minFreeGB ?? DEFAULT_CHECK_DISK.minFreeGB,
    minFreePercent: value?.minFreePercent ?? DEFAULT_CHECK_DISK.minFreePercent,
  };
}

let checkDiskSettings: () => CheckDiskSettings = () => DEFAULT_CHECK_DISK;

/** The server hands in config.json's `checkDisk` (read each time it matters). */
export function setCheckDiskSettings(get: () => CheckDiskSettings): void {
  checkDiskSettings = get;
}

/** The gate the shared checkLimiter and the merge pipeline's disk rerun use. */
export const checkDiskGate = createDiskGate({ settings: () => checkDiskSettings() });

/**
 * Samples the disk while a check runs (at its start, every pollMs, at its end): a failure
 * while the disk was low at any moment is the environment's, even if space came back before
 * the check ended (a cache cleaned, a temp file gone).
 */
export function watchDisk(
  gate: DiskGate,
  paths: readonly string[]
): { stop(): DiskSample | undefined } {
  let lowest: DiskSample | undefined;
  const look = () => {
    const now = gate.sample(paths);
    if (now?.low && (!lowest || now.freeBytes < lowest.freeBytes)) lowest = now;
  };
  look();
  const timer = every('task verify gate', look, gate.pollMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      look();
      return lowest;
    },
  };
}

/** What a tool prints when the disk is full (ENOSPC and its wordings). */
const DISK_FULL =
  /\bENOSPC\b|No space left on device|\bdisk (?:is )?full\b|not enough (?:free )?(?:disk )?space|out of disk space/i;

/** The check's output says the disk filled up, whatever the free space is now. */
export function diskFullOutput(output: string): boolean {
  return DISK_FULL.test(output.replace(ANSI, ''));
}

const FAIL_HEADER = /^\s*FAIL\s+(\S.*?)\s*$/;
/** bun test `(fail) name [12.00ms]`, Playwright `✘ 1 [chromium] › a.spec.ts:3:1 › name (5s)`. */
const OTHER_FAIL = /^\s*(?:\(fail\)|✘\s+\d+)\s+(\S.*?)\s*$/;
/** A trailing duration (`12ms`, `[12.00ms]`, `(5.1s)`) that differs from one run to the next. */
const DURATION = /\s*(?:\[\s*[\d.]+\s*m?s\s*\]|\(\s*[\d.]+\s*m?s\s*\)|\b[\d.]+\s*m?s)$/;

/**
 * The tests a check's output names as failed: vitest's `FAIL  file > suite > test` lines (its
 * failure list and, for a file that failed to load, the file), bun's `(fail)` and Playwright's
 * `✘` lines. Each once, durations dropped, at most `max`. Empty: none named (a lint or type
 * error, another runner).
 */
export function failedTestNames(output: string, max = 30): string[] {
  const names: string[] = [];
  for (const raw of output.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n')) {
    const match = FAIL_HEADER.exec(raw) ?? OTHER_FAIL.exec(raw);
    if (!match) continue;
    const name = match[1].replace(DURATION, '').trim();
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------------

/** Where a queued check will write, and who hears that it waits for disk. */
export interface LimiterDisk {
  /** The repo and the worktree: each one's volume must have room. */
  paths: readonly string[];
  /** The disk is low (the sample) and the check waits; undefined once it is not any more. */
  onWait?: (low: DiskSample | undefined) => void;
}

export interface Limiter {
  /**
   * Runs `task` when a slot is free; `onStart` fires right before it starts. Aborting `signal`
   * while it still waits takes it out of the line: it then rejects with an AbortError.
   * `urgent` (asked each time a slot frees, so a mark made while it waits counts): it goes
   * before every waiting one that is not (first come, first served among the urgent).
   * `since`: when it first joined the line (ms), kept across server restarts by the caller:
   * its place in line and its "start anyway" deadline count from then (default: now).
   */
  run<T>(
    task: () => Promise<T>,
    onStart?: () => void,
    signal?: AbortSignal,
    urgent?: () => boolean,
    disk?: LimiterDisk,
    since?: number
  ): Promise<T>;
  readonly active: number;
  readonly queued: number;
  /** How many wait in line in front of one that joined at `since`. */
  ahead(since: number): number;
  /** How many run at once at most now. */
  readonly limit: number;
}

/**
 * With a load gate, a free slot is not taken while the machine is over its threshold: the
 * first in line waits (polling every pollMs) and starts anyway after maxWaitMs, so a machine
 * that never quiets down still gets its checks.
 */
export function createLimiter(
  max: number | ((state: { active: number; sinceStartMs: number }) => number),
  gate?: LoadGate,
  now: () => number = Date.now,
  diskGate?: DiskGate,
  /**
   * With a limit that follows the Mac (checkConcurrency): how often a full limiter with checks
   * waiting looks again, so a slot the margin adds is taken without waiting for a check to end.
   */
  recheckMs?: number
): Limiter {
  let active = 0;
  let recheck: NodeJS.Timeout | undefined;
  const lookAgain = () => {
    if (!recheckMs || recheck) return;
    recheck = setTimeout(() => {
      recheck = undefined;
      next();
    }, recheckMs);
    recheck.unref?.();
  };
  let lastStartAt = 0;
  const waiting: {
    since: number;
    start: () => void;
    urgent?: () => boolean;
    disk?: LimiterDisk;
    diskWait?: boolean;
  }[] = [];
  let retry: NodeJS.Timeout | undefined;
  const isUrgent = (entry: (typeof waiting)[number]) => {
    try {
      return !!entry.urgent?.();
    } catch {
      return false;
    }
  };
  const later = (ms: number) => {
    retry = setTimeout(() => {
      retry = undefined;
      next();
    }, ms);
    retry.unref?.();
  };
  const limit = () => {
    try {
      return Math.max(
        1,
        typeof max === 'function' ? max({ active, sinceStartMs: now() - lastStartAt }) : max
      );
    } catch {
      return 1;
    }
  };
  const next = () => {
    if (waiting.length && active > 0 && active >= limit()) lookAgain();
    if (active >= limit() || !waiting.length || retry) return;
    const first = waiting.findIndex(isUrgent);
    if (first > 0) waiting.unshift(...waiting.splice(first, 1));
    const head = waiting[0];
    // Low disk first, and with no "start anyway" (see createDiskGate).
    if (diskGate && head.disk) {
      const low = diskGate.sample(head.disk.paths);
      if (low?.low) {
        if (!head.diskWait) {
          head.diskWait = true;
          try {
            head.disk.onWait?.(low);
          } catch {
            // A failing progress callback must not stop the line.
          }
        }
        later(diskGate.pollMs);
        return;
      }
      if (head.diskWait) {
        head.diskWait = false;
        try {
          head.disk.onWait?.(undefined);
        } catch {
          // As above.
        }
      }
    }
    if (gate && gate.sample().high && now() - head.since < gate.maxWaitMs) {
      later(gate.pollMs);
      return;
    }
    waiting.shift()?.start();
    next();
  };
  return {
    run<T>(
      task: () => Promise<T>,
      onStart?: () => void,
      signal?: AbortSignal,
      urgent?: () => boolean,
      disk?: LimiterDisk,
      since?: number
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          const at = waiting.indexOf(entry);
          if (at < 0) return;
          waiting.splice(at, 1);
          reject(new DOMException('The check is not needed any more', 'AbortError'));
          next();
        };
        const at = now();
        const entry: (typeof waiting)[number] = {
          // 2026-11-02: a restart put a check that had waited 9 of 10 min back at 0, at the
          // end of the line; under a load that never drops it never started.
          since: since !== undefined && Number.isFinite(since) ? Math.min(since, at) : at,
          urgent,
          disk,
          start: () => {
            signal?.removeEventListener('abort', abort);
            active++;
            lastStartAt = now();
            try {
              onStart?.();
            } catch {
              // A failing progress callback must not leak the slot.
            }
            Promise.resolve()
              .then(task)
              .then(resolve, reject)
              .finally(() => {
                active--;
                next();
              });
          },
        };
        if (signal?.aborted) {
          reject(new DOMException('The check is not needed any more', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        // In line by when each joined (first come, first served).
        const after = waiting.findIndex((other) => other.since > entry.since);
        if (after < 0) waiting.push(entry);
        else waiting.splice(after, 0, entry);
        next();
      });
    },
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
    ahead(since: number) {
      return waiting.filter((entry) => entry.since < since).length;
    },
    get limit() {
      return limit();
    },
  };
}

/**
 * Shared by the merge pipeline: at most checkLoad.maxConcurrent checks run at once across all
 * tasks and projects (default one per 6 cores, checksFromCores; read each time a slot frees, so
 * an edit of config.json counts without a restart), none starts
 * while the Mac is over its load threshold (up to checkLoad.maxWaitSec), and none while the
 * disk of its repo or worktree is low (checkDisk, for as long as it lasts).
 */
export const checkLimiter = createLimiter(
  (state) => {
    const settings = checkLoadSettings();
    if (settings.maxConcurrent > 0) return checkConcurrency(settings);
    const { load, threshold } = checkLoadGate.sample();
    let room = false;
    try {
      room = checkRoom();
    } catch {
      room = false;
    }
    return checkConcurrency(settings, os.availableParallelism(), {
      ...state,
      load,
      threshold,
      room,
    });
  },
  checkLoadGate,
  Date.now,
  checkDiskGate,
  CHECK_RECHECK_MS
);
