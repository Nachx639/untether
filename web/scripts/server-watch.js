/**
 * Dev-mode server watcher: runs `tsx src/cli.ts` and restarts it when server code changes,
 * in place of `tsx watch`.
 *
 * 2026-11-02: `tsx watch` restarted the dev server on every file change, and the task pipeline
 * merges into the main checkout every few minutes: each merge was a restart, and each restart
 * lost in-memory state (the 2 h admission waits). Here:
 * - A hand edit restarts as `tsx watch` did (a short debounce).
 * - A change that comes from Untether's own merge (the pipeline's fast-forward of the main
 *   checkout, see mergeSignal) is batched: one restart once merges stop for RESTART_QUIET_MS,
 *   at the latest RESTART_MAX_WAIT_MS after the first one.
 * - A batched restart waits while a task is being started or a check/merge is under way (the
 *   task journal in tasks.json says so, see restartHolds), again up to RESTART_MAX_WAIT_MS.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

/** Batched restarts: quiet time after the last merge, and the longest a merge's code waits. */
const RESTART_QUIET_MS = 90_000;
const RESTART_MAX_WAIT_MS = 10 * 60_000;
/** While something holds the restart: how often to look again. */
const RESTART_HOLD_POLL_MS = 5_000;
/** Hand edits: events this close together are one restart (an editor's save, a formatter). */
const HUMAN_DEBOUNCE_MS = 300;
/** Events are classified after they settle (git writes the files before it moves HEAD). */
const SETTLE_MS = 1_000;
/** The reflog action Untether's merge into a checked-out base uses (task-merge-base.ts moveBase). */
const MERGE_REFLOG_ACTION = 'untether-merge';
/** A merge seen in the reflog this recently explains changes on disk. */
const MERGE_REFLOG_WINDOW_MS = 2 * 60_000;
/** Task states a task is being started in (the worktree and its setup, the session). */
const STARTING_STATES = new Set(['preparing']);
/** Journal steps that hold a restart: a check/review/merge, the base moving, a task's start. */
const HOLDING_EFFECTS = new Set(['pipeline', 'base', 'worktree', 'session']);

const CODE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Whether a change under src/ can change the running server. The server never imports the
 * client or the tests (tsx watch only watched what the server imported).
 */
function isServerSource(relative) {
  const file = relative.split(path.sep).join('/');
  if (!CODE_FILE.test(file) || TEST_FILE.test(file)) return false;
  return !/^(?:client|test)\//.test(file) && !file.includes('/__snapshots__/');
}

/**
 * When to restart. Hand edits restart after HUMAN_DEBOUNCE_MS; merges wait for quiet and for
 * the holds, never longer than maxWaitMs from the first merge waiting.
 */
class RestartBatcher {
  constructor(options) {
    this.restartNow = options.restart;
    this.holds = options.holds ?? (() => []);
    this.quietMs = options.quietMs ?? RESTART_QUIET_MS;
    this.maxWaitMs = options.maxWaitMs ?? RESTART_MAX_WAIT_MS;
    this.pollMs = options.pollMs ?? RESTART_HOLD_POLL_MS;
    this.humanDelayMs = options.humanDelayMs ?? HUMAN_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.log = options.log ?? (() => {});
    this.timer = null;
    /** First merge change not restarted for yet, and the last one. */
    this.pendingSince = null;
    this.lastMerge = null;
    this.humanPending = false;
    this.holdLogged = '';
  }

  /** A change, from a merge (`merge`) or by hand. */
  change(kind) {
    if (kind === 'merge') {
      const at = this.now();
      if (this.pendingSince === null) {
        this.pendingSince = at;
        this.log(
          `merged code changed: restarting once merges settle (${Math.round(this.quietMs / 1000)} s quiet, at most ${Math.round(this.maxWaitMs / 60_000)} min)`
        );
      }
      this.lastMerge = at;
      if (!this.humanPending) this.arm(this.nextCheck());
      return;
    }
    this.humanPending = true;
    this.arm(this.humanDelayMs);
  }

  /** A restart is waiting. */
  pending() {
    return this.humanPending || this.pendingSince !== null;
  }

  /** Forget what waits (the server was restarted another way). */
  reset() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.pendingSince = null;
    this.lastMerge = null;
    this.humanPending = false;
    this.holdLogged = '';
  }

  dispose() {
    this.reset();
  }

  nextCheck() {
    const at = this.now();
    const quietAt = this.lastMerge + this.quietMs;
    const deadline = this.pendingSince + this.maxWaitMs;
    return Math.max(0, Math.min(quietAt, deadline) - at);
  }

  arm(ms) {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.check();
    }, ms);
  }

  check() {
    if (this.humanPending) return this.fire('code changed');
    if (this.pendingSince === null) return;
    const at = this.now();
    const deadline = this.pendingSince + this.maxWaitMs;
    if (at >= deadline) {
      const held = this.safeHolds();
      return this.fire(
        held.length
          ? `merged code waited ${Math.round(this.maxWaitMs / 60_000)} min (still: ${held.join(', ')})`
          : 'merged code changed'
      );
    }
    if (at < this.lastMerge + this.quietMs) return this.arm(this.nextCheck());
    const held = this.safeHolds();
    if (!held.length) return this.fire('merged code changed');
    const text = held.join(', ');
    if (text !== this.holdLogged) {
      this.holdLogged = text;
      this.log(`restart waits for: ${text}`);
    }
    this.arm(Math.min(this.pollMs, deadline - at));
  }

  safeHolds() {
    try {
      return this.holds();
    } catch {
      return [];
    }
  }

  fire(reason) {
    this.reset();
    this.restartNow(reason);
  }
}

/** The task store the server keeps (server-app.ts CONTROL_DIR). */
function tasksFile(env = process.env) {
  const dir = env.UNTETHER_CONTROL_DIR || path.join(os.homedir(), '.untether/control');
  return path.join(dir, 'tasks.json');
}

function readTasks(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * What keeps a batched restart waiting, from the task journal (shared/task-effects.ts): every
 * step with effects outside tasks.json is recorded on its task before it is taken and dropped
 * with its result, so a step under way is on disk. A task being started is in 'preparing'.
 */
function restartHolds(file) {
  const holds = [];
  for (const task of readTasks(file)) {
    if (!task || typeof task !== 'object') continue;
    const id = String(task.id ?? '?').slice(0, 8);
    const kinds = new Set(
      (Array.isArray(task.effects) ? task.effects : [])
        .map((effect) => effect?.kind)
        .filter((kind) => HOLDING_EFFECTS.has(kind))
    );
    if (STARTING_STATES.has(task.state)) kinds.add('start');
    for (const kind of [...kinds].sort()) holds.push(`${kind} ${id}`);
  }
  return holds;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * Whether the files that changed in `repoRoot` came from Untether's own merge:
 * - a task's base is moving right now on this repository (journal step `base`), or
 * - the checkout's last reflog entry is Untether's fast-forward (MERGE_REFLOG_ACTION), recent,
 *   and the changed files are what HEAD has (a hand edit since then would differ).
 */
function mergeSignal({ repoRoot, gitDir, tasks, files, now = Date.now(), git = gitRun }) {
  for (const task of readTasks(tasks)) {
    const moving = (task?.effects ?? []).some((effect) => effect?.kind === 'base');
    if (moving && samePath(task.repoPath, repoRoot)) return true;
  }
  const entry = lastReflogEntry(gitDir);
  if (!entry || !entry.message.startsWith(`${MERGE_REFLOG_ACTION}`)) return false;
  if (now - entry.at > MERGE_REFLOG_WINDOW_MS) return false;
  if (!files.length) return true;
  const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...files]);
  return status !== null && status.trim() === '';
}

/** The last entry of HEAD's reflog in `gitDir`: its time (ms) and message. */
function lastReflogEntry(gitDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(gitDir, 'logs', 'HEAD'), 'utf8');
  } catch {
    return null;
  }
  const lines = text.trimEnd().split('\n');
  const line = lines[lines.length - 1];
  const match = /^\S+ \S+ .*? (\d+) [+-]\d{4}\t(.*)$/.exec(line ?? '');
  if (!match) return null;
  return { at: Number(match[1]) * 1000, message: match[2] };
}

function gitRun(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

/**
 * node's flags to run a .ts file with tsx: the ones `tsx <file>` gives the node it starts.
 * 2026-11-10: the server ran as `tsx <entry>`, a wrapper with the server as ITS child. The wrapper
 * hands on SIGTERM but SIGKILL cannot be handed on, so a server that did not end on SIGTERM
 * survived the restart, kept the port and the new one died on EADDRINUSE. Without the wrapper the
 * process this watcher signals is the server.
 */
function tsxFlags(webDir) {
  const resolve = (name) => require.resolve(name, { paths: [webDir] });
  return ['--require', resolve('tsx/preflight'), '--import', pathToFileURL(resolve('tsx')).href];
}

/**
 * Runs the server (node with tsx's loader, `<entry> ...args`) and restarts it as RestartBatcher says. Returns
 * { stop(), restart(reason), batcher }.
 */
function watchServer(options) {
  const webDir = options.webDir;
  const entry = path.resolve(webDir, options.entry ?? 'src/cli.ts');
  const srcDir = path.resolve(webDir, options.srcDir ?? 'src');
  const env = options.env ?? process.env;
  const log = options.log ?? ((text) => console.log(`[server-watch] ${text}`));
  const command = options.command ?? [process.execPath, [...tsxFlags(webDir), entry, ...(options.args ?? [])]];
  const repoRoot = (gitRun(webDir, ['rev-parse', '--show-toplevel']) ?? '').trim() || webDir;
  const gitDir = (gitRun(webDir, ['rev-parse', '--absolute-git-dir']) ?? '').trim();
  const tasks = options.tasksFile ?? tasksFile(env);

  let child = null;
  let stopping = false;
  let restarting = false;
  const start = () => {
    child = spawn(command[0], command[1], { cwd: webDir, env, stdio: options.stdio ?? 'inherit' });
    const started = child;
    // Without a listener a failed spawn is an uncaught exception that ends this watcher.
    started.on('error', (error) => log(`could not start the server: ${error.message}`));
    started.on('exit', (code, signal) => {
      if (started !== child || restarting || stopping) return;
      log(`server exited (${signal ?? code}); waiting for a change to start it again`);
      // Nothing runs: code waiting for a batched restart need not wait any more.
      if (batcher.pending()) batcher.fire('the server exited with changed code waiting');
    });
  };
  const alive = () => child && child.exitCode === null && child.signalCode === null;

  const restart = (reason) => {
    if (stopping || restarting) return;
    log(`restarting: ${reason}`);
    if (!alive()) return start();
    restarting = true;
    const old = child;
    const kill = setTimeout(() => old.kill('SIGKILL'), options.killAfterMs ?? 5000);
    old.once('exit', () => {
      clearTimeout(kill);
      restarting = false;
      if (!stopping) start();
    });
    old.kill('SIGTERM');
  };

  const batcher = new RestartBatcher({
    ...options.batch,
    restart,
    // A server that is not running holds nothing.
    holds: () => (alive() ? restartHolds(tasks) : []),
    log,
  });

  // Changed files gather for SETTLE_MS, then are classified together.
  let changed = new Set();
  let settle = null;
  const classify = () => {
    settle = null;
    const files = [...changed];
    changed = new Set();
    const merge =
      gitDir &&
      mergeSignal({
        repoRoot,
        gitDir,
        tasks,
        files: files.map((file) => path.relative(repoRoot, path.join(srcDir, file))),
        git: options.git ?? gitRun,
      });
    // A server that is not running starts at once, whatever changed.
    batcher.change(merge && alive() ? 'merge' : 'human');
  };
  // A watcher error with no listener is an uncaught exception: this process would die and leave
  // the server running with nobody to restart it. The watch is opened again instead.
  let watcher = null;
  let rewatch = null;
  const watch = () => {
    rewatch = null;
    try {
      watcher = fs.watch(srcDir, { recursive: true }, (_event, name) => {
        if (!name || !isServerSource(String(name))) return;
        changed.add(String(name));
        if (!settle) settle = setTimeout(classify, options.settleMs ?? SETTLE_MS);
      });
    } catch (error) {
      return watchFailed(error);
    }
    watcher.on('error', watchFailed);
  };
  const watchFailed = (error) => {
    log(`watching ${srcDir} failed (${error.message}); opening it again`);
    watcher?.close();
    watcher = null;
    if (!stopping && !rewatch) rewatch = setTimeout(watch, options.rewatchMs ?? 2000);
  };
  watch();

  start();
  return {
    batcher,
    restart,
    child: () => child,
    stop(signal = 'SIGTERM') {
      stopping = true;
      watcher?.close();
      if (rewatch) clearTimeout(rewatch);
      if (settle) clearTimeout(settle);
      batcher.dispose();
      if (!alive()) return Promise.resolve();
      const stopped = child;
      return new Promise((resolve) => {
        // A server that does not end on the signal is killed: stop() always ends, and before
        // dev.js (3 s) gives up on this process and leaves the server behind.
        const kill = setTimeout(() => stopped.kill('SIGKILL'), options.stopKillAfterMs ?? 2000);
        stopped.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        stopped.kill(signal);
      });
    },
  };
}

module.exports = {
  HUMAN_DEBOUNCE_MS,
  MERGE_REFLOG_ACTION,
  RESTART_MAX_WAIT_MS,
  RESTART_QUIET_MS,
  RestartBatcher,
  isServerSource,
  lastReflogEntry,
  mergeSignal,
  restartHolds,
  tasksFile,
  tsxFlags,
  watchServer,
};

if (require.main === module) {
  const webDir = path.resolve(__dirname, '..');
  const server = watchServer({ webDir, args: process.argv.slice(2) });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      server.stop('SIGTERM').then(() => process.exit(0));
    });
  }
}
