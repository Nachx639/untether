import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import { shieldLaunchdLabel } from '../../server/services/shielded-tmux.js';
import {
  dirInUseSync,
  envFromPsE,
  isUnder,
  markedDirsUnder,
  markerEnded,
  pathForms,
  readTestMarker,
  TEST_RUN_ENV,
} from '../../server/services/stray-tmux.js';
import { RM_TEST_DIR } from './rm-test-dir.js';

export { pathForms };

export interface ReapDeps {
  /** `ps -axo pid=,command=` output. */
  ps: () => string;
  /** UNTETHER_TEST_RUN_DIR in a process's environment (null when unset or unreadable). */
  runDirOf: (pid: number) => string | null;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** launchctl bootout of a launchd label (macOS). */
  bootout: (label: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Whether a process uses a dir (cwd, open files, HOME): such a dir is never removed. */
  inUse: (dir: string) => boolean;
}

export const defaultReapDeps: ReapDeps = {
  ps: () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 }),
  runDirOf: (pid) => {
    try {
      const out = execFileSync('ps', ['-wwE', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      return envFromPsE(out, [TEST_RUN_ENV])[TEST_RUN_ENV] ?? null;
    } catch {
      return null;
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  bootout: (label) => {
    const uid = process.getuid?.();
    if (process.platform !== 'darwin' || uid === undefined) return;
    execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  inUse: dirInUseSync,
};

/**
 * tmux servers in a `ps` listing whose `-S` socket is under one of `dirs`, with that socket.
 * Only the tmux server keeps its start command (`tmux -S <sock> start-server ; …`); clients of
 * the same socket exit with their tests.
 */
export function tmuxServersUnder(
  psOutput: string,
  dirs: string[]
): { pid: number; socket: string }[] {
  const found: { pid: number; socket: string }[] = [];
  for (const { pid, socket } of tmuxProcesses(psOutput)) {
    if (socket && dirs.some((dir) => socket.startsWith(`${dir}/`))) found.push({ pid, socket });
  }
  return found;
}

function tmuxProcesses(psOutput: string): { pid: number; socket?: string }[] {
  const found: { pid: number; socket?: string }[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match || path.basename(match[2]) !== 'tmux') continue;
    found.push({ pid: Number(match[1]), socket: /(?:^|\s)-S\s+(\S+)/.exec(match[3])?.[1] });
  }
  return found;
}

export interface RunTmuxServer {
  pid: number;
  socket?: string;
}

/**
 * The tmux processes of one test run: those whose `-S` socket is under `runDir`, and those
 * started with its UNTETHER_TEST_RUN_DIR mark (2026-11-01: tests that put their control dir
 * straight in /tmp, for a short socket path, were out of the run dir's reach).
 */
export function findRunTmuxServers(runDir: string, deps: ReapDeps): RunTmuxServer[] {
  const forms = pathForms(runDir);
  const found: RunTmuxServer[] = [];
  for (const proc of tmuxProcesses(deps.ps())) {
    const bySocket = proc.socket && forms.some((dir) => proc.socket?.startsWith(`${dir}/`));
    const mark = bySocket ? null : deps.runDirOf(proc.pid);
    if (bySocket || (mark && forms.includes(path.resolve(mark)))) found.push(proc);
  }
  return found;
}

/**
 * The dirs a run's tmux servers lived in that the harness marked for this run: for each socket
 * outside the run's dir, the nearest dir above it whose own marker names this run. Exactly that
 * dir, never a parent of it (2026-11-02: "the first dir under /tmp" would have taken all of
 * /tmp/ut with other runs' control dirs in it).
 */
export function leftTestDirs(servers: RunTmuxServer[], runDir: string): string[] {
  const runForms = pathForms(runDir);
  const dirs = new Set<string>();
  for (const { socket } of servers) {
    if (!socket || isUnder(socket, [runDir])) continue;
    for (let dir = path.dirname(socket); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const marker = readTestMarker(dir);
      if (!marker) continue;
      if (marker.runDir && runForms.includes(path.resolve(marker.runDir))) dirs.add(dir);
      break;
    }
  }
  return [...dirs];
}

function bootoutShields(servers: RunTmuxServer[], deps: ReapDeps): void {
  for (const { socket } of servers) {
    if (!socket || path.basename(socket) !== '.shield-tmux') continue;
    try {
      // launchd would start a killed job again.
      deps.bootout(shieldLaunchdLabel(path.dirname(socket)));
    } catch {
      // Not loaded (the usual case: tests don't use launchd).
    }
  }
}

function signal(servers: RunTmuxServer[], sig: NodeJS.Signals, deps: ReapDeps): void {
  for (const { pid } of servers) {
    try {
      // A tmux server ends its panes' programs when it exits.
      deps.kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
}

function removeDirs(dirs: string[], deps: ReapDeps): void {
  for (const dir of dirs) {
    if (!deps.inUse(dir)) fs.rmSync(dir, RM_TEST_DIR);
  }
}

/**
 * Kills every tmux server of one test run (findRunTmuxServers) and unloads its shield launchd
 * job if it has one, then removes the dirs marked for this run they lived in. Nothing of
 * another run is touched: other test runs (task worktrees run their checks at the same time)
 * and the developer's own tmux servers (~/.untether/control) keep running.
 *
 * 2026-10-24: 124 orphaned shield tmux servers (`$TMPDIR/ut/<4 hex>/.shield-tmux`, 194 `cat`
 * panes, some over a day old) took the Mac to a load of 70-80. The e2e tests' servers started
 * shielded sessions and stopServer only stopped the server: the shield outlives it by design.
 * Their own teardown kills it now (stopServer); this catches whatever a test still leaves.
 */
export async function reapRunTmuxServers(
  runDir: string,
  deps: ReapDeps = defaultReapDeps
): Promise<number[]> {
  const servers = findRunTmuxServers(runDir, deps);
  bootoutShields(servers, deps);
  const alive = (pid: number) => {
    try {
      deps.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  signal(servers, 'SIGTERM', deps);
  const deadline = deps.now() + 3000;
  while (servers.some(({ pid }) => alive(pid)) && deps.now() < deadline) {
    await deps.sleep(100);
  }
  signal(
    servers.filter(({ pid }) => alive(pid)),
    'SIGKILL',
    deps
  );
  removeDirs(leftTestDirs(servers, runDir), deps);
  return servers.map(({ pid }) => pid);
}

/**
 * The same, without waiting: for a run ending on a signal or `process.exit`, where nothing
 * asynchronous runs any more. SIGKILL at once (its panes get SIGHUP when the pty closes).
 */
export function reapRunTmuxServersNow(runDir: string, deps: ReapDeps = defaultReapDeps): number[] {
  const servers = findRunTmuxServers(runDir, deps);
  bootoutShields(servers, deps);
  signal(servers, 'SIGKILL', deps);
  removeDirs(leftTestDirs(servers, runDir), deps);
  return servers.map(({ pid }) => pid);
}

/**
 * Test runs that ended without their teardown (SIGKILL, a crash, a check cut by its timeout):
 * every marked dir in `base` (or one level deeper) whose marker ended (pid gone, or over 6 h
 * old) and that no process uses has its run's tmux servers killed (a run dir) and is removed,
 * exactly that dir. Unmarked dirs are never touched. Returns the dirs swept.
 */
export function sweepDeadTestRuns(
  base: string,
  ownRunDir: string,
  deps: ReapDeps = defaultReapDeps,
  now: number = Date.now()
): string[] {
  const swept: string[] = [];
  for (const dir of markedDirsUnder(base)) {
    const marker = readTestMarker(dir);
    if (!marker || isUnder(dir, [ownRunDir])) continue;
    if (marker.runDir && isUnder(marker.runDir, [ownRunDir])) continue;
    if (!markerEnded(marker, now) || deps.inUse(dir)) continue;
    // A run's own dir: the tmux servers its workers started go with it.
    if (marker.runDir && pathForms(marker.runDir).includes(path.resolve(dir))) {
      reapRunTmuxServersNow(dir, deps);
    }
    fs.rmSync(dir, RM_TEST_DIR);
    swept.push(dir);
  }
  return swept;
}

/** What the watchdog needs beyond a reap: every process with its environment, in one listing. */
export interface WatchDeps extends ReapDeps {
  /** `ps -axwwE -o pid=,command=` output: each process's command followed by its environment. */
  psEnv: () => string;
  /** This process, never one of the run's. */
  self: number;
}

export const defaultWatchDeps: WatchDeps = {
  ...defaultReapDeps,
  // No hurry here, and a loaded Mac is when runs get cut (2026-11-10: load 100-590): a `ps`
  // that takes a minute is waited for instead of given up on.
  psEnv: () =>
    execFileSync('ps', ['-axwwE', '-o', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    }),
  self: process.pid,
};

/**
 * What is left of one test run in a `ps -axwwE -o pid=,command=` listing: its tmux servers
 * (socket under its dir, or started with its UNTETHER_TEST_RUN_DIR mark) and every other
 * process started with that mark (workers, test servers and their children).
 */
export function runProcesses(
  psEnvOutput: string,
  runDir: string,
  self?: number
): { servers: RunTmuxServer[]; others: number[] } {
  const forms = pathForms(runDir);
  const servers: RunTmuxServer[] = [];
  const others: number[] = [];
  for (const line of psEnvOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match || Number(match[1]) === self) continue;
    const pid = Number(match[1]);
    const mark = envFromPsE(match[3], [TEST_RUN_ENV])[TEST_RUN_ENV];
    const marked = Boolean(mark && forms.includes(path.resolve(mark)));
    if (path.basename(match[2]) !== 'tmux') {
      if (marked) others.push(pid);
      continue;
    }
    const socket = /(?:^|\s)-S\s+(\S+)/.exec(match[3])?.[1];
    if (marked || (socket && forms.some((dir) => socket.startsWith(`${dir}/`)))) {
      servers.push({ pid, socket });
    }
  }
  return { servers, others };
}

/** How often the watchdog looks. */
const WATCH_POLL_MS = 1000;
/** Processes of a dead run get this long to end by themselves, then SIGTERM, then SIGKILL. */
const WATCH_TERM_AFTER_MS = 2000;
const WATCH_KILL_AFTER_MS = 10_000;
/** The watchdog gives up after this long; what is left then is the next run's and the doctor's. */
const WATCH_GIVE_UP_MS = 3 * 60_000;

/** The dirs the harness marked for one run (the run's own dir included), in /tmp and its base. */
function runMarkedDirs(runDir: string): string[] {
  const forms = pathForms(runDir);
  const bases = new Set(['/tmp', path.dirname(runDir)].flatMap(pathForms));
  const dirs = new Set<string>();
  for (const base of bases) {
    for (const dir of markedDirsUnder(base)) {
      const of = readTestMarker(dir)?.runDir;
      if (of && forms.includes(path.resolve(of))) dirs.add(pathForms(dir).sort()[0]);
    }
  }
  return [...dirs];
}

/**
 * The watchdog of one test run (run-watchdog.ts, a process of its own): waits for the run's
 * vitest to be gone, however it went, then closes what the run left until nothing of it is
 * alive: its tmux servers at once, any other process of the run after a moment (SIGTERM, then
 * SIGKILL), and last the dirs marked for the run. Only what carries the run's mark.
 *
 * 2026-11-10: the doctor closed the shield tmux server of a test server
 * (`ut/fe37/.shield-tmux` in its run dir) minutes after its run, at a load of 100-590 with runs
 * cut by their time limit or by a signal. The run cleaned up from inside its own vitest only:
 * killed with -9 nothing ran, and on SIGTERM the handler reaped once, before the run's other
 * processes were gone (a test server still starting a shielded session started its tmux server
 * after the reap), with a `ps` that gave up at 10 s.
 */
export async function watchRun(
  runDir: string,
  parent: number,
  deps: WatchDeps = defaultWatchDeps
): Promise<void> {
  const alive = (pid: number) => {
    try {
      deps.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };
  while (alive(parent)) await deps.sleep(WATCH_POLL_MS);
  const since = deps.now();
  let quiet = 0;
  while (deps.now() - since < WATCH_GIVE_UP_MS) {
    let left: ReturnType<typeof runProcesses> | null = null;
    try {
      left = runProcesses(deps.psEnv(), runDir, deps.self);
    } catch {
      // ps failed or timed out: look again.
    }
    if (left) {
      bootoutShields(left.servers, deps);
      signal(left.servers, 'SIGKILL', deps);
      const waited = deps.now() - since;
      if (waited >= WATCH_TERM_AFTER_MS) {
        const sig = waited >= WATCH_KILL_AFTER_MS ? 'SIGKILL' : 'SIGTERM';
        for (const pid of left.others) signal([{ pid }], sig, deps);
      }
      quiet = left.servers.length + left.others.length === 0 ? quiet + 1 : 0;
      // Twice in a row with nothing, past the moment a process still alive could start one.
      if (quiet >= 2 && waited >= WATCH_TERM_AFTER_MS) break;
    }
    await deps.sleep(WATCH_POLL_MS);
  }
  removeDirs(runMarkedDirs(runDir), deps);
}

/**
 * Starts the watchdog of this run (watchRun). Through a shell that ends at once and in its own
 * process group: its parent is 1, so neither killing the run's process tree nor a signal to its
 * group reaches it (the twin's watchdog does the same, scripts/gemelo.sh). Without the run's
 * mark, so it is never taken for one of the run's processes.
 */
export function startRunWatchdog(runDir: string, parent: number = process.pid): void {
  const tsx = pathToFileURL(createRequire(__filename).resolve('tsx')).href;
  const env = { ...process.env };
  delete env[TEST_RUN_ENV];
  spawnSync(
    '/bin/sh',
    [
      '-c',
      'set -m; "$@" </dev/null >/dev/null 2>&1 &',
      'sh',
      process.execPath,
      '--import',
      tsx,
      path.join(__dirname, 'run-watchdog.ts'),
      runDir,
      String(parent),
    ],
    { cwd: '/', env, stdio: 'ignore', timeout: 30_000 }
  );
}
