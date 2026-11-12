/**
 * What a task starts, marked (2026-11-02). Bakery: a task started 12 `yes` to load the CPU,
 * zsh did not split the pid list, the processes were reparented to launchd (ppid 1) and kept
 * every CPU busy; the task guard refused to let the task kill them (no longer under its agent)
 * and the orchestrator stopped them by hand.
 *
 * A task's session runs with UNTETHER_TASK_ID=<task id> (SessionCreateOptions.taskId), which
 * every process it starts inherits, reparented or not. The guard lets the task kill those
 * (task-guard.ts), and Untether ends those still running once the task has closed and its
 * session stopped (TaskOrphanReaper), TERM then KILL, each one logged; the doctor tells.
 *
 * Reading the marker: `ps -E` appends a process's environment to its command line, for the
 * user's own processes. macOS hides it for its platform binaries (/bin/sleep, /usr/bin/yes: the
 * bakery case), whatever the caller. Its folder proves nothing (another program may work
 * there; AI review, 2026-11-02), nor its terminal: Claude's Bash tool starts each shell in a new
 * session (setsid), without one, and what it leaves keeps tty `??`.
 *
 * Shell groups: what proves those. That shell leads its own process group (pgid = its pid), and
 * every process it starts keeps that pgid, reparented or not. Each Bash shell of a task's agent
 * runs, before its command, a line that removes and creates `<groups dir>/$$`
 * (recordShellGroup): the shell records its own pid in the task's folder before running anything,
 * and the file's birth is when it did (made anew: a reused pid never keeps an older birth).
 *
 * That line never travels inside the agent's command (2026-11-11). Until then the guard's hook
 * put it in front of each one (Claude's updatedInput), and its `rm` made Claude Code run its
 * dangerous-removal check on every command of a task: one it could not analyse whole (a long
 * heredoc, a `bash -c` script) then stopped on a permission prompt, even with
 * --dangerously-skip-permissions (three tasks in two days, one sat 4 h). Reproduced with a real
 * Claude Code 2.1.322: the same command without the line, or with a line without `rm`, runs.
 * Now the guard's SessionStart hook writes the line into Claude Code's CLAUDE_ENV_FILE
 * (writeShellGroupEnv), which Claude runs in each Bash shell before the command and does not
 * judge as part of it. shellGroupsTrouble tells when that stops working.
 * Files of groups with nothing left in them go at each sweep (TaskOrphanReaper). A process whose environment is
 * hidden is the task's when its group is one so recorded and it started after the shell did, and
 * the group's leader, if alive, is still that shell (same start): a pid reused later is not. A
 * hidden one without that is never ended nor let killed; those left in a closed worktree task's
 * folder are only told (TaskOrphanReaper.suspects, the doctor).
 *
 * Only node built-ins: the guard's hook imports it and starts on every tool call.
 */
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { every } from '../utils/periodic-loop.js';

/** The variable a task's session carries, and every process it starts. */
export const TASK_MARKER_VAR = 'UNTETHER_TASK_ID';

/**
 * The task marker of a process: its id, null when its environment was read and has none,
 * undefined when the system hides it (a platform binary).
 */
export type TaskMarker = string | null | undefined;

export interface ProcessMark {
  marker: TaskMarker;
}

/** The folder of a task's recorded shell groups, beside its guard policy (task-guard-setup.ts). */
export const SHELL_GROUPS_DIR = 'groups';

/** In the groups folder: the env file the record line was written to (its path). */
export const SHELL_ENV_MARK = '.env';
/** In the groups folder: made by every shell that ran the record line. */
export const SHELL_SEEN_MARK = '.seen';
/** In the groups folder: a Bash call was let run (its birth: when the first was). */
const SHELL_ASKED_MARK = '.asked';
/** In the groups folder: the trouble was told once. */
const SHELL_TOLD_MARK = '.told';
/** A shell this long after the first Bash call and none ran the line: it is not run. */
const SHELL_SEEN_WITHIN_MS = 60_000;

/**
 * The line a task's Bash shell runs before its command: the shell records its group. The file
 * is removed first: `: >` alone keeps an existing file's birth, so a reused pid would look
 * like a shell started long ago (review, 2026-11-02). Never put inside the agent's command
 * (see the top of this file): it goes in Claude Code's env file.
 */
export function recordShellGroup(dir: string): string {
  const quoted = `'${dir.replace(/'/g, `'\\''`)}'`;
  const file = `${quoted}/"$$"`;
  return `{ /bin/rm -f ${file}; : >${file}; : >${quoted}/${SHELL_SEEN_MARK}; } 2>/dev/null\n`;
}

/**
 * Writes the record line into Claude Code's env file (CLAUDE_ENV_FILE, given to a SessionStart
 * hook; Claude runs it in each Bash shell before the command), once: a resumed session gets
 * the same file again. Throws when it cannot be written.
 */
export function writeShellGroupEnv(envFile: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const line = recordShellGroup(dir);
  let had = '';
  try {
    had = fs.readFileSync(envFile, 'utf8');
  } catch {
    had = '';
  }
  if (!had.includes(line)) {
    fs.appendFileSync(envFile, `${had && !had.endsWith('\n') ? '\n' : ''}${line}`);
  }
  fs.writeFileSync(path.join(dir, SHELL_ENV_MARK), `${envFile}\n`, { mode: 0o600 });
}

/**
 * Asked at each Bash call let run, in a session whose env file was written: why its shells are
 * not recording their group, once per task, or null. The env file is gone or lost the line, or
 * Bash calls have run for a while and no shell ever ran it (a Claude Code that no longer runs
 * its env file). A session without the mark (started before its SessionStart hook existed, or
 * Codex) is not judged.
 */
export function shellGroupsTrouble(dir: string, now = Date.now()): string | null {
  const at = (name: string) => path.join(dir, name);
  let envFile: string;
  try {
    envFile = fs.readFileSync(at(SHELL_ENV_MARK), 'utf8').trim();
  } catch {
    return null;
  }
  const tell = (why: string): string | null => {
    try {
      // 'wx': told once, also by two hooks at the same moment.
      fs.writeFileSync(at(SHELL_TOLD_MARK), `${why}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      return null;
    }
    return why;
  };
  let env = '';
  try {
    env = fs.readFileSync(envFile, 'utf8');
  } catch {
    env = '';
  }
  if (!env.includes(recordShellGroup(dir))) {
    return tell(
      `the shell-group record is no longer in Claude's env file (${envFile}): what this task's shells start is not marked as its own`
    );
  }
  if (fs.existsSync(at(SHELL_SEEN_MARK))) return null;
  let asked: number;
  try {
    const stat = fs.statSync(at(SHELL_ASKED_MARK));
    asked = stat.birthtimeMs || stat.mtimeMs;
  } catch {
    try {
      fs.writeFileSync(at(SHELL_ASKED_MARK), '', { flag: 'wx', mode: 0o600 });
    } catch {
      // made meanwhile by another call
    }
    return null;
  }
  if (now - asked < SHELL_SEEN_WITHIN_MS) return null;
  return tell(
    `Bash calls have run for ${Math.round((now - asked) / 1000)} s and no shell ran the shell-group record of Claude's env file (${envFile}): what this task's shells start is not marked as its own`
  );
}

/**
 * Removes the records of groups no process is in any more, among those older than `before`
 * (a shell that started after the process table was read is not in it yet). Returns their pgids.
 */
export function pruneShellGroups(
  dir: string,
  groups: ReadonlyMap<number, number>,
  inUse: ReadonlySet<number | undefined>,
  before: number
): number[] {
  const gone: number[] = [];
  for (const [pgid, since] of groups) {
    if (inUse.has(pgid) || since >= before - START_SLACK_MS) continue;
    try {
      fs.rmSync(path.join(dir, String(pgid)), { force: true });
      gone.push(pgid);
    } catch {
      // kept: tried again at the next sweep
    }
  }
  return gone;
}

/** A task's recorded shell groups: pgid → when its shell started (ms, the file's birth). */
export function readShellGroups(dir: string): Map<number, number> {
  const groups = new Map<number, number>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return groups;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      groups.set(Number(name), stat.birthtimeMs || stat.mtimeMs);
    } catch {
      // removed meanwhile
    }
  }
  return groups;
}

/** ps's lstart is to the second; a file's birth to the millisecond. */
const START_SLACK_MS = 2000;

/**
 * Whether a process belongs to one of the task's recorded shell groups: its group recorded, it
 * started after that shell did, and the group's leader, when still alive, is that shell (a
 * leader started at another time took a reused pid: not the task's).
 */
export function inShellGroup(
  entry: { pgid?: number; start?: number },
  groups: ReadonlyMap<number, number>,
  leader: { start?: number } | undefined
): boolean {
  if (!entry.pgid || entry.pgid <= 1 || entry.start === undefined) return false;
  const since = groups.get(entry.pgid);
  if (since === undefined) return false;
  if (entry.start < since - START_SLACK_MS) return false;
  if (leader) {
    if (leader.start === undefined) return false;
    if (Math.abs(leader.start - since) > START_SLACK_MS) return false;
  }
  return true;
}

/** ps's lstart ("Mon Nov  2 15:36:48 2026", local time) → ms. */
export function lstartMs(text: string): number | undefined {
  const ms = Date.parse(text.trim().replace(/\s+/g, ' '));
  return Number.isFinite(ms) ? ms : undefined;
}

/** One `ps -o pid=,ppid=,pgid=,lstart=,command=` line. */
export const PS_ROW_RE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/;

const MARKER_RE = new RegExp(`(?:^|\\s)${TASK_MARKER_VAR}=([A-Za-z0-9_-]+)(?=\\s|$)`);

/**
 * The marker in a `ps -E` line, given the same process's line without -E: the environment is
 * what -E added after the command. Nothing added: hidden.
 */
export function markerOf(withEnv: string, plain: string): TaskMarker {
  const env = withEnv.startsWith(plain) ? withEnv.slice(plain.length) : null;
  if (env === null) return undefined; // not the same process line: unknown
  if (!env.trim()) return undefined;
  return MARKER_RE.exec(env)?.[1] ?? null;
}

/** `pid rest` lines → pid → rest (as printed, so -E and plain lines compare). */
export function linesByPid(out: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match) lines.set(Number(match[1]), match[2]);
  }
  return lines;
}

/** lsof -Fpn output → pid → cwd. */
export function cwdsOf(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

const PS_OPTS = { encoding: 'utf8' as const, timeout: 5000, maxBuffer: 64 * 1024 * 1024 };

function runSync(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { ...PS_OPTS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // lsof exits 1 when one pid is gone, with the others still printed.
    const out = (error as { stdout?: string }).stdout;
    return typeof out === 'string' ? out : '';
  }
}

/** The marks of some processes, read now (the guard's hook: only the pids a kill names). */
export function readProcessMarks(pids: number[]): Map<number, ProcessMark> {
  const marks = new Map<number, ProcessMark>();
  const list = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 1);
  if (!list.length) return marks;
  const arg = list.join(',');
  const plain = linesByPid(runSync('ps', ['-ww', '-o', 'pid=,command=', '-p', arg]));
  const withEnv = linesByPid(runSync('ps', ['-Eww', '-o', 'pid=,command=', '-p', arg]));
  for (const [pid, line] of plain) {
    const env = withEnv.get(pid);
    marks.set(pid, { marker: env === undefined ? undefined : markerOf(env, line) });
  }
  return marks;
}

/** Whether `file` is `root` or inside it. */
export function within(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `root` and where it really leads (a symlinked folder: lsof prints the real path). */
export function rootForms(root: string): string[] {
  const forms = [path.resolve(root)];
  try {
    forms.push(fs.realpathSync(root));
  } catch {
    // gone (a merged task's worktree): its path as recorded
  }
  return [...new Set(forms)];
}

// ─── Leftovers of closed tasks ─────────────────────────────────────────────────────────────────

export interface MarkedProcess {
  pid: number;
  ppid: number;
  pgid?: number;
  /** When it started (ms). */
  start?: number;
  command: string;
  marker: TaskMarker;
  cwd?: string;
}

/** The user's processes with their markers (ps twice: with and without the environment). */
export async function listMarkedProcesses(): Promise<MarkedProcess[]> {
  const uid = String(process.getuid?.() ?? '');
  const run = (args: string[]) =>
    new Promise<string>((resolve) => {
      execFile('ps', args, PS_OPTS, (error, stdout) => resolve(error ? '' : stdout));
    });
  const select = uid ? ['-x', '-U', uid] : ['-ax'];
  const [plainOut, envOut] = await Promise.all([
    run(['-ww', ...select, '-o', 'pid=,ppid=,pgid=,lstart=,command=']),
    run(['-Eww', ...select, '-o', 'pid=,ppid=,pgid=,lstart=,command=']),
  ]);
  const parse = (out: string) => {
    const rows = new Map<number, { ppid: number; pgid: number; start?: number; command: string }>();
    for (const line of out.split('\n')) {
      // ps pads its columns to the widest value: only the command is compared.
      const match = PS_ROW_RE.exec(line);
      if (match) {
        rows.set(Number(match[1]), {
          ppid: Number(match[2]),
          pgid: Number(match[3]),
          start: lstartMs(match[4]),
          command: match[5],
        });
      }
    }
    return rows;
  };
  const plain = parse(plainOut);
  const withEnv = parse(envOut);
  const out: MarkedProcess[] = [];
  for (const [pid, row] of plain) {
    const env = withEnv.get(pid);
    out.push({
      pid,
      ppid: row.ppid,
      pgid: row.pgid,
      ...(row.start !== undefined ? { start: row.start } : {}),
      command: row.command,
      marker: env === undefined ? undefined : markerOf(env.command, row.command),
    });
  }
  return out;
}

/** The cwd of some processes (lsof). */
export async function readCwds(pids: number[]): Promise<Map<number, string>> {
  if (!pids.length) return new Map();
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], PS_OPTS, (_error, stdout) =>
      resolve(cwdsOf(typeof stdout === 'string' ? stdout : ''))
    );
  });
}

/** What the reaper needs of a task (TaskRecord's fields). */
export interface ReapableTask {
  id: string;
  name?: string;
  state: string;
  sessionId?: string;
  isolation?: string;
  worktreePath?: string;
  /** When the task was made (ISO): a process older than it cannot be the task's. */
  createdAt?: string;
}

/** One process the reaper ended. */
export interface OrphanKill {
  at: string;
  taskId: string;
  taskName?: string;
  pid: number;
  command: string;
  /**
   * How it is known the task's: its marker, a shell group the task recorded, or its folder
   * (reparented to launchd, started after the task was made, working inside its worktree).
   */
  by: 'marker' | 'group' | 'cwd';
  /** KILL: it outlived the TERM's grace period. */
  signal: 'TERM' | 'KILL';
}

/**
 * A process that may be a closed task's but is not proven so: its environment is hidden (a
 * platform binary), it was reparented and works in the task's worktree, but it cannot be shown
 * to have started during the task (no start time or creation time, or it is older). Told, never
 * ended.
 */
export interface OrphanSuspect {
  taskId: string;
  taskName?: string;
  pid: number;
  command: string;
  cwd: string;
}

interface Orphan {
  entry: MarkedProcess;
  task: ReapableTask;
  by: 'marker' | 'group' | 'cwd';
}

/** The shield's tmux (its server can sit in a worktree): never a task's leftover. */
function isShieldTmux(entry: MarkedProcess): boolean {
  return path.basename(entry.command.split(' ')[0] ?? '') === 'tmux';
}

/** Whether a process started after its task was made (ps's seconds, so a little slack). */
function startedDuringTask(entry: MarkedProcess, task: ReapableTask): boolean {
  if (entry.start === undefined || !task.createdAt) return false;
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) && entry.start >= created - START_SLACK_MS;
}

export const ORPHAN_GRACE_MS = 5000;
export const ORPHAN_SWEEP_MS = 5 * 60 * 1000;
const ORPHAN_LOG_MAX = 100;
const COMMAND_MAX = 200;

/** States after which nothing of the task should run once its session stopped. */
const CLOSED_STATES = ['merged', 'done', 'discarded', 'missed', 'failed'];

export interface TaskOrphanReaperDeps {
  tasks: () => readonly ReapableTask[];
  /** 'running' while the task's session still runs (its processes are still the task's). */
  sessionStatus: (sessionId: string) => string | undefined;
  list?: () => Promise<MarkedProcess[]>;
  cwds?: (pids: number[]) => Promise<Map<number, string>>;
  signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  graceMs?: number;
  log?: (message: string) => void;
  /** Never touched (the server and its ancestors). */
  selfPid?: number;
  /** A task's recorded shell groups (readShellGroups of its folder); none when not given. */
  shellGroups?: (taskId: string) => ReadonlyMap<number, number>;
  /**
   * Removes a task's group records with nothing left in them, older than `before`
   * (pruneShellGroups on its folder): every task's, open or closed, so the folder never grows.
   */
  pruneShellGroups?: (
    taskId: string,
    groups: ReadonlyMap<number, number>,
    inUse: ReadonlySet<number | undefined>,
    before: number
  ) => void;
}

/**
 * Ends what closed tasks left running: processes carrying the marker of a task that is final or
 * failed with its session stopped (a running session's processes are still the task's; a
 * shield's pane processes go with the session's stop). A task this Untether does not know is
 * never reaped (another Untether's: a dev server next to the app).
 */
export class TaskOrphanReaper {
  private readonly killed: OrphanKill[] = [];
  private suspected: OrphanSuspect[] = [];
  private running: Promise<OrphanKill[]> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly pending = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: TaskOrphanReaperDeps) {}

  /** Whether a task is closed: nothing of it should run any more. */
  closed(task: ReapableTask): boolean {
    if (!CLOSED_STATES.includes(task.state)) return false;
    return !task.sessionId || this.deps.sessionStatus(task.sessionId) !== 'running';
  }

  /** What it ended, newest last (the doctor reads it). */
  recent(): readonly OrphanKill[] {
    return this.killed;
  }

  /** What the last sweep found but could not prove (hidden environment): told, not ended. */
  suspects(): readonly OrphanSuspect[] {
    return this.suspected;
  }

  /** Once now, one sweep at a time. */
  reap(): Promise<OrphanKill[]> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** A task's session was stopped: its leftovers go once its state has settled. */
  afterStop(delayMs = 2000): void {
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      void this.reap().catch((error) => this.deps.log?.(`task orphan sweep failed: ${error}`));
    }, delayMs);
    timer.unref?.();
    this.pending.add(timer);
  }

  start(intervalMs = ORPHAN_SWEEP_MS): void {
    if (this.timer) return;
    this.timer = every(
      'task processes',
      () => {
        void this.reap().catch((error) => this.deps.log?.(`task orphan sweep failed: ${error}`));
      },
      intervalMs
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
  }

  private async sweep(): Promise<OrphanKill[]> {
    const closed = new Map<string, ReapableTask>();
    for (const task of this.deps.tasks()) if (this.closed(task)) closed.set(task.id, task);
    const recorded = new Map<string, ReadonlyMap<number, number>>();
    for (const task of this.deps.tasks()) {
      const groups = this.deps.shellGroups?.(task.id);
      if (groups?.size) recorded.set(task.id, groups);
    }
    if (!closed.size && !recorded.size) {
      this.suspected = [];
      return [];
    }
    const before = Date.now();
    const list = this.deps.list ?? listMarkedProcesses;
    const table = await list();
    // Records of shells whose groups have nothing left, every task's (the folder stays small).
    const inUse = new Set(table.map((entry) => entry.pgid));
    for (const [taskId, groups] of recorded) {
      this.deps.pruneShellGroups?.(taskId, groups, inUse, before);
    }
    if (!closed.size) {
      this.suspected = [];
      return [];
    }
    const spared = this.spared(table);
    const found = this.orphans(table, closed, spared);
    // Hidden environments (platform binaries) in a shell group a closed task recorded.
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    for (const task of closed.values()) {
      const groups = recorded.get(task.id);
      if (!groups?.size) continue;
      for (const entry of table) {
        if (entry.marker !== undefined || spared.has(entry.pid)) continue;
        if (found.some((f) => f.entry.pid === entry.pid)) continue;
        const leader = entry.pgid !== undefined ? byPid.get(entry.pgid) : undefined;
        if (leader && leader.pid !== entry.pid && leader.marker !== undefined) {
          // A leader whose environment is read: its marker decides (another task's or none).
          if (leader.marker !== task.id) continue;
        }
        if (inShellGroup(entry, groups, leader)) found.push({ entry, task, by: 'group' });
      }
    }
    // Hidden environments (platform binaries) reparented to launchd, working inside a closed
    // worktree task's folder. 2026-11-11: `zsh -c sleep 60` of a task's Bash tool outlived it and
    // the doctor only asked to end it by hand. One that started after the task was made and works
    // inside its folder (its cwd is readable for the user's own processes) is the task's: ended.
    // A folder alone, with no start time proving it came after the task, is only told.
    const suspects: OrphanSuspect[] = [];
    const roots = [...closed.values()]
      .filter((task) => task.isolation === 'worktree' && task.worktreePath)
      .map((task) => ({ task, forms: rootForms(task.worktreePath as string) }));
    if (roots.length) {
      const hidden = table.filter(
        (entry) =>
          entry.marker === undefined &&
          entry.ppid === 1 &&
          !isShieldTmux(entry) &&
          !spared.has(entry.pid) &&
          !found.some((f) => f.entry.pid === entry.pid)
      );
      const cwds = await (this.deps.cwds ?? readCwds)(hidden.map((entry) => entry.pid));
      for (const entry of hidden) {
        const cwd = cwds.get(entry.pid);
        if (!cwd) continue;
        const owner = roots.find(({ forms }) => forms.some((root) => within(cwd, root)));
        if (!owner || found.some((f) => f.entry.pid === entry.pid)) continue;
        if (startedDuringTask(entry, owner.task)) {
          found.push({ entry, task: owner.task, by: 'cwd' });
          continue;
        }
        suspects.push({
          taskId: owner.task.id,
          ...(owner.task.name ? { taskName: owner.task.name } : {}),
          pid: entry.pid,
          command: entry.command.slice(0, COMMAND_MAX),
          cwd,
        });
      }
    }
    this.suspected = suspects;
    if (!found.length) return [];
    return this.end(found, closed);
  }

  /** This server and its ancestors: never touched, whatever they carry. */
  private spared(table: MarkedProcess[]): Set<number> {
    const parent = new Map(table.map((entry) => [entry.pid, entry.ppid]));
    const spared = new Set<number>([1]);
    let at: number | undefined = this.deps.selfPid ?? process.pid;
    for (let hops = 0; at && at > 1 && hops < 64; hops++) {
      spared.add(at);
      at = parent.get(at);
    }
    return spared;
  }

  private orphans(
    table: MarkedProcess[],
    closed: Map<string, ReapableTask>,
    spared: Set<number>
  ): Array<Orphan> {
    const found: Array<Orphan> = [];
    for (const entry of table) {
      if (!entry.marker || spared.has(entry.pid)) continue;
      const task = closed.get(entry.marker);
      if (task) found.push({ entry, task, by: 'marker' });
    }
    return found;
  }

  private async end(
    found: Array<Orphan>,
    closed: Map<string, ReapableTask>
  ): Promise<OrphanKill[]> {
    const signal =
      this.deps.signal ?? ((pid: number, sig: 'SIGTERM' | 'SIGKILL') => process.kill(pid, sig));
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = this.deps.now ?? (() => new Date());
    const kills: OrphanKill[] = [];
    const record = (item: Orphan, sig: 'TERM' | 'KILL') => {
      const kill: OrphanKill = {
        at: now().toISOString(),
        taskId: item.task.id,
        ...(item.task.name ? { taskName: item.task.name } : {}),
        pid: item.entry.pid,
        command: item.entry.command.slice(0, COMMAND_MAX),
        by: item.by,
        signal: sig,
      };
      kills.push(kill);
      this.killed.push(kill);
      if (this.killed.length > ORPHAN_LOG_MAX)
        this.killed.splice(0, this.killed.length - ORPHAN_LOG_MAX);
      this.deps.log?.(
        `task ${item.task.id.slice(0, 8)} closed (${item.task.state}): ${sig} pid ${item.entry.pid} (${item.by}) ${kill.command}`
      );
    };
    const termed: typeof found = [];
    for (const item of found) {
      try {
        signal(item.entry.pid, 'SIGTERM');
        termed.push(item);
        record(item, 'TERM');
      } catch {
        // gone already
      }
    }
    if (!termed.length) return kills;
    await sleep(this.deps.graceMs ?? ORPHAN_GRACE_MS);
    // KILL only what is still the same process (same pid, command and owner as before).
    const after = new Map((await (this.deps.list ?? listMarkedProcesses)()).map((e) => [e.pid, e]));
    for (const item of termed) {
      const now = after.get(item.entry.pid);
      if (!now || now.command !== item.entry.command) continue;
      if (now.marker !== item.entry.marker || now.pgid !== item.entry.pgid) continue;
      if (!closed.has(item.task.id)) continue;
      try {
        signal(item.entry.pid, 'SIGKILL');
        record(item, 'KILL');
      } catch {
        // ended meanwhile
      }
    }
    return kills;
  }
}
