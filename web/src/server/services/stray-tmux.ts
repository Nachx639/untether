/**
 * Shield tmux servers and temporary dirs that tests and QA starts leave behind.
 *
 * 2026-11-01: four shield tmux servers of tests or QA starts had run for 18-20 days with idle
 * bash panes (/tmp/utq8/.untether/control/.shield-tmux, /tmp/utj.qhUj/…, /tmp/u37.AxYe/…,
 * ~/.uq/.uq/c/.shield-tmux), and one `-L untether-<hash>` server of a QA HOME in a scratchpad
 * had no session at all. A throwaway HOME gets its own shield tmux server, which outlives the
 * Untether that started it by design, and nobody killed it when the test or the QA run ended
 * or failed.
 *
 * Only what the test harness marked when it made it is ever closed or removed, never by a guess
 * about what runs inside or what a dir looks like (2026-11-02, the orchestrator's rule):
 * - a dir gets a marker file at its exact root (TEST_RUN_MARKER: pid, time, run dir) and only
 *   that exact dir is removed: once its pid is gone or the marker is over MARKER_STALE_MS old,
 *   and no process has it as cwd, among its open files or as its HOME;
 * - a tmux server carries UNTETHER_TEST_RUN_DIR in its environment (global-setup.ts puts it in
 *   every worker) and is closed only once that run ended.
 * Anything unmarked (a QA HOME in ~/.uq, any other shield tmux server) is only told.
 */
import { execFile, execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Environment mark of everything a test run starts (global-setup.ts sets it in its workers). */
export const TEST_RUN_ENV = 'UNTETHER_TEST_RUN_DIR';
/** Marker file at the exact root of a dir the test harness made. */
export const TEST_RUN_MARKER = '.untether-test-run';
/** A marker this old may go even if its pid looks alive (pids are reused). */
export const MARKER_STALE_MS = 6 * 60 * 60 * 1000;

export interface TestMarker {
  pid: number;
  /** When it was written (ms). */
  at: number;
  /** The test run it belongs to. */
  runDir?: string;
}

/** Writes the marker of a dir the test harness made. */
export function writeTestMarker(dir: string, runDir: string | undefined, pid = process.pid): void {
  const marker: TestMarker = { pid, at: Date.now(), ...(runDir ? { runDir } : {}) };
  fs.writeFileSync(path.join(dir, TEST_RUN_MARKER), JSON.stringify(marker));
}

/** The marker at the exact root of `dir`, when it is a real dir of this user with a valid one. */
export function readTestMarker(dir: string): TestMarker | null {
  try {
    const stat = fs.lstatSync(dir);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) return null;
    const file = path.join(dir, TEST_RUN_MARKER);
    const fileStat = fs.lstatSync(file);
    if (!fileStat.isFile() || (uid !== undefined && fileStat.uid !== uid)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TestMarker>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    if (typeof parsed.at !== 'number') return null;
    return {
      pid: parsed.pid as number,
      at: parsed.at,
      ...(typeof parsed.runDir === 'string' ? { runDir: parsed.runDir } : {}),
    };
  } catch {
    return null;
  }
}

/** Whether a process is alive (signal 0). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a marker's owner is over: its pid is gone, or the marker is stale. */
export function markerEnded(
  marker: TestMarker,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive
): boolean {
  return !alive(marker.pid) || now - marker.at > MARKER_STALE_MS;
}

/**
 * Whether the test run a tmux server's UNTETHER_TEST_RUN_DIR names has ended: its dir is gone
 * (a run removes it last) or its marker's pid is gone. A run dir without a valid marker is not
 * known to have ended.
 */
export function testRunEnded(runDir: string, alive: (pid: number) => boolean = pidAlive): boolean {
  if (!fs.existsSync(runDir)) return true;
  const marker = readTestMarker(runDir);
  return marker !== null && !alive(marker.pid);
}

/** The forms a directory's path can take in a process's arguments (/tmp vs /private/tmp). */
export function pathForms(dir: string): string[] {
  const forms = new Set([path.resolve(dir)]);
  try {
    forms.add(fs.realpathSync(dir));
  } catch {
    // Already removed.
  }
  const spellings = new Set(forms);
  for (const form of forms) {
    if (form.startsWith('/private/')) spellings.add(form.slice('/private'.length));
    else if (/^\/(tmp|var)\//.test(form)) spellings.add(`/private${form}`);
  }
  return [...spellings];
}

/** Whether `dir` is one of `bases` or inside one, in any spelling of either. */
export function isUnder(dir: string, bases: string[]): boolean {
  const forms = pathForms(dir);
  const baseForms = bases.flatMap(pathForms);
  return forms.some((form) =>
    baseForms.some((base) => form === base || form.startsWith(`${base}/`))
  );
}

/** Whether `ps -axwwE` output (commands with their environment) has a process whose HOME is in `dir`. */
export function homeInDir(psEnvOutput: string, dir: string): boolean {
  const forms = pathForms(dir);
  for (const token of psEnvOutput.split(/\s+/)) {
    if (!token.startsWith('HOME=')) continue;
    const home = token.slice('HOME='.length);
    if (forms.some((form) => home === form || home.startsWith(`${form}/`))) return true;
  }
  return false;
}

/** lsof +D is bounded: a dir it can't go through in this time counts as in use. */
const LSOF_TIMEOUT_MS = 15_000;

/**
 * `lsof -F p +D <dir>`: process ids as `p<pid>` lines, and on stderr a warning for every part of
 * the tree it could not go through. Never `-t`: it implies `-w`, which silences those warnings,
 * and an unreadable subdir then exits 1 with no output, the same as an unused dir (2026-11-02,
 * AI review: exit 1 alone would have allowed removing a dir lsof had not fully checked).
 */
const LSOF_ARGS = (dir: string) => ['-F', 'p', '+D', dir];

export interface LsofResult {
  /** Exit status; null when it was killed or did not start. */
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Whether a `lsof -F p +D` run proves nothing uses the dir: it ran to the end (exit 0 or 1, not
 * killed), listed no process and warned about nothing. Anything else is unknown, so in use.
 */
export function lsofProvesUnused(result: LsofResult): boolean {
  if (result.timedOut || (result.status !== 0 && result.status !== 1)) return false;
  if (result.stderr.trim()) return false;
  return !/^p\d+$/m.test(result.stdout);
}

function lsofFailure(error: unknown): LsofResult {
  const failure = error as {
    code?: unknown;
    status?: number | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    killed?: boolean;
    signal?: string | null;
  };
  const status =
    typeof failure.status === 'number'
      ? failure.status
      : typeof failure.code === 'number'
        ? failure.code
        : null;
  return {
    status,
    stdout: String(failure.stdout ?? ''),
    stderr: String(failure.stderr ?? ''),
    timedOut: Boolean(failure.killed || failure.signal),
  };
}

const PS_ENV_ARGS = ['-axwwE', '-o', 'command='];
const PS_ENV_OPTIONS = { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 };

/**
 * Whether any process uses `dir`: as its cwd or among its open files (`lsof +D`, which lists
 * both) or as its HOME. Unknown (lsof failed, warned, or timed out) counts as in use.
 */
export async function dirInUse(dir: string): Promise<boolean> {
  let lsof: LsofResult;
  try {
    const { stdout, stderr } = await execFileAsync('lsof', LSOF_ARGS(dir), {
      timeout: LSOF_TIMEOUT_MS,
    });
    lsof = { status: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    lsof = lsofFailure(error);
  }
  if (!lsofProvesUnused(lsof)) return true;
  try {
    const { stdout } = await execFileAsync('ps', PS_ENV_ARGS, PS_ENV_OPTIONS);
    return homeInDir(stdout, dir);
  } catch {
    return true;
  }
}

/** dirInUse without waiting, for a run ending on a signal or process.exit. */
export function dirInUseSync(dir: string): boolean {
  let lsof: LsofResult;
  try {
    const result = spawnSync('lsof', LSOF_ARGS(dir), {
      encoding: 'utf8',
      timeout: LSOF_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    lsof = {
      status: result.error ? null : result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: Boolean(result.signal),
    };
  } catch (error) {
    lsof = lsofFailure(error);
  }
  if (!lsofProvesUnused(lsof)) return true;
  try {
    return homeInDir(execFileSync('ps', PS_ENV_ARGS, { ...PS_ENV_OPTIONS, encoding: 'utf8' }), dir);
  } catch {
    return true;
  }
}

export interface ProcRow {
  pid: number;
  ppid: number;
  ageMs: number;
  command: string;
}

/** `ps` elapsed time (`[[dd-]hh:]mm:ss`) in milliseconds; 0 when unreadable. */
export function parseEtime(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
    1000
  );
}

/** Rows of `ps -axo pid=,ppid=,etime=,command=`. */
export function parsePs(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ageMs: parseEtime(match[3]),
      command: match[4],
    });
  }
  return rows;
}

/** Values of `names` in `ps -wwE -o command=` output (the environment follows the command). */
export function envFromPsE(output: string, names: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const token of output.trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const name = token.slice(0, eq);
    if (names.includes(name)) found[name] = token.slice(eq + 1);
  }
  return found;
}

/** The shield socket a tmux command line selects: `-S <dir>/.shield-tmux` or `-L untether-<hash>`. */
export function shieldSelection(command: string): string[] | null {
  const socket = /\s-S\s+(\S(?:.*?\S)?\/\.shield-tmux)(?=\s|$)/.exec(command);
  const name = socket ? null : /\s-L\s+(untether-[0-9a-f]{12})(?=\s|$)/.exec(command);
  const select = socket ? ['-S', socket[1]] : name ? ['-L', name[1]] : null;
  if (!select) return null;
  const at = command.indexOf(` ${select[0]} `);
  return path.basename(command.slice(0, at)) === 'tmux' ? select : null;
}

export interface ShieldServerInfo {
  pid: number;
  ageMs: number;
  /** tmux socket selection args. */
  select: string[];
  /** The control dir it serves, when known (-S: the socket's dir; -L: its environment). */
  controlDir?: string;
  /** The test run that started it (its UNTETHER_TEST_RUN_DIR): its only license to be closed. */
  testRunDir?: string;
  /** tmux clients attached to it: a live Untether (or a person) uses it. */
  clients: number;
  /** Its panes' programs, to tell (never to decide). */
  programs: string[];
}

const programOf = (command: string) =>
  path.basename(command.split(/\s+/)[0] ?? '').replace(/^-/, '');

/**
 * Shield tmux servers in a process table: tmux processes whose parent is launchd (servers
 * daemonize or are launchd jobs) on a shield socket. `envOf` reads a process's environment
 * (null when unreadable).
 */
export function shieldServers(
  rows: ProcRow[],
  envOf: (pid: number) => Record<string, string> | null
): ShieldServerInfo[] {
  const servers: ShieldServerInfo[] = [];
  for (const row of rows) {
    if (row.ppid !== 1) continue;
    const select = shieldSelection(row.command);
    if (!select) continue;
    const env = envOf(row.pid) ?? {};
    const controlDir =
      select[0] === '-S'
        ? path.dirname(select[1])
        : (env.UNTETHER_CONTROL_DIR ??
          (env.HOME ? path.join(env.HOME, '.untether', 'control') : undefined));
    const selection = select.join(' ');
    const clients = rows.filter(
      (other) =>
        other.ppid !== 1 &&
        other.pid !== row.pid &&
        programOf(other.command) === 'tmux' &&
        `${other.command} `.includes(` ${selection} `)
    ).length;
    servers.push({
      pid: row.pid,
      ageMs: row.ageMs,
      select,
      controlDir,
      testRunDir: env[TEST_RUN_ENV],
      clients,
      programs: rows.filter((pane) => pane.ppid === row.pid).map((pane) => programOf(pane.command)),
    });
  }
  return servers;
}

/** The user's own control dirs (~/.untether/control, ~/.untether-dev/control…). */
export function isUserControlDir(dir: string, home: string = os.homedir()): boolean {
  const resolved = path.resolve(dir);
  return (
    path.basename(resolved) === 'control' &&
    path.dirname(path.dirname(resolved)) === path.resolve(home) &&
    path.basename(path.dirname(resolved)).startsWith('.untether')
  );
}

/** A dir under /tmp or $TMPDIR the scan found. */
export interface TestDirInfo {
  dir: string;
  /** Its marker (null: unmarked, only ever told). */
  marker: TestMarker | null;
  /** Newest mtime of the dir and its first levels. */
  touchedAt: number;
}

const SCAN_ENTRY_CAP = 2000;
const NESTED_SCAN_CAP = 500;

function newestMtime(dir: string, depth: number, budget: { left: number }): number {
  let newest = 0;
  try {
    newest = fs.lstatSync(dir).mtimeMs;
  } catch {
    return 0;
  }
  if (depth <= 0) return newest;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, depth - 1, budget));
    else {
      try {
        newest = Math.max(newest, fs.lstatSync(full).mtimeMs);
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return newest;
}

function realDirs(dir: string, cap = Number.POSITIVE_INFINITY): string[] {
  const uid = process.getuid?.();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (dirs.length >= cap) break;
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isDirectory() && (uid === undefined || stat.uid === uid)) dirs.push(full);
    } catch {
      // Gone meanwhile.
    }
  }
  return dirs;
}

/** Unmarked dirs that look like a test's or a QA start's: told, never removed. */
function looksLikeTestDir(dir: string): boolean {
  const has = (...parts: string[]) => fs.existsSync(path.join(dir, ...parts));
  return (
    path.basename(dir).startsWith('ut-test-') || has('.shield-tmux') || has('.untether', 'control')
  );
}

/** Marked dirs right under `root` or one level deeper (e.g. /tmp/ut/<hex>). */
export function markedDirsUnder(root: string): string[] {
  const found: string[] = [];
  for (const dir of realDirs(root)) {
    if (readTestMarker(dir)) {
      found.push(dir);
      continue;
    }
    for (const nested of realDirs(dir, NESTED_SCAN_CAP)) {
      if (readTestMarker(nested)) found.push(nested);
    }
  }
  return found;
}

/**
 * Dirs under `roots` (/tmp, $TMPDIR) the test harness marked (right under a root or one level
 * deeper), and unmarked ones right under a root that look like a test's or a QA start's (a run
 * dir, an Untether home or control dir). Only real dirs of this user; symlinks never.
 */
export function findTestDirs(roots: string[]): TestDirInfo[] {
  const seen = new Set<string>();
  const found: TestDirInfo[] = [];
  for (const root of roots) {
    let real: string;
    try {
      real = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const marked = new Set(markedDirsUnder(real));
    for (const dir of marked) {
      found.push({
        dir,
        marker: readTestMarker(dir),
        touchedAt: newestMtime(dir, 3, { left: SCAN_ENTRY_CAP }),
      });
    }
    for (const dir of realDirs(real)) {
      if (marked.has(dir) || [...marked].some((m) => m.startsWith(`${dir}/`))) continue;
      if (!looksLikeTestDir(dir)) continue;
      found.push({ dir, marker: null, touchedAt: newestMtime(dir, 3, { left: SCAN_ENTRY_CAP }) });
    }
  }
  return found;
}
