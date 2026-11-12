/**
 * The doctor's checks of tasks and orchestrators: stuck ones, sessions and processes left
 * behind, the guard, the messages nobody answered.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  type AgentMessage,
  ageText,
  messageStateText,
  partyLabel,
  UNANSWERED_WARN_HOURS,
} from '../../shared/agent-messages.js';
import type { TaskCheckLevel, TaskRecord } from '../../shared/tasks.js';
import { describeNodeRuntime, type NodeRuntime } from '../utils/node-runtime.js';
import { MINUTE, minutes, shortId } from './doctor-checks-shared.js';
import type { FlakyTest } from './flaky-tests.js';
import type { AdmissionVerdict } from './resource-monitor.js';
import type { OrphanKill, OrphanSuspect } from './task-processes.js';
import type { DoctorCheck, DoctorFinding } from './untether-doctor.js';

const STUCK_AFTER_MS: Partial<Record<TaskRecord['state'], number>> = {
  preparing: 20 * MINUTE,
  verifying: 60 * MINUTE,
  merging: 20 * MINUTE,
};

/** A checking task still waiting for its check (merge queue, check slot) for this long. */
const QUEUED_STUCK_MS = 3 * 60 * MINUTE;

/**
 * First in its project's line, a slot free, and the Mac's admission would let it in: it should
 * start within the pump's seconds; told after this margin of the admission being open.
 */
const QUEUED_ADMITTED_MARGIN_MS = 10 * MINUTE;

/** First in line with a slot free but held by the Mac's admission (load, swap, memory): told after this. */
const QUEUED_ADMISSION_MAX_MS = 3 * 60 * MINUTE;

/** A running check (or the batch check a merging task waits on) whose logs stay still this long. */
const STUCK_NO_PROGRESS_MS = 15 * MINUTE;

/** Passed checks of the repository the typical duration is the median of (the latest ones). */
const TYPICAL_RUNS = 10;

const TYPICAL_MIN_RUNS = 3;

/** Expected: this many times the typical duration, never under the floor. */
const TYPICAL_FACTOR = 2;

const TYPICAL_FLOOR_MS = 10 * MINUTE;

const checkRunning = (task: TaskRecord) =>
  task.state === 'verifying' &&
  !!task.verify?.startedAt &&
  !task.verify.finishedAt &&
  !task.verify.queued;

/** The fast check of a two-level project, or the whole one (single level, full, batch). */
const checkKind = (level: TaskCheckLevel | undefined) =>
  level === 'related' ? 'related' : 'whole';

/**
 * The median of the latest passed checks of `kind` in `repoPath`, from every task's timings;
 * undefined with fewer than TYPICAL_MIN_RUNS. A batch run is stamped on each of its cars: once.
 */
export function typicalCheckMs(
  tasks: readonly TaskRecord[],
  repoPath: string | undefined,
  kind: 'related' | 'whole'
): number | undefined {
  const runs = new Map<string, { end: number; ms: number }>();
  for (const task of tasks) {
    if (task.repoPath !== repoPath) continue;
    for (const timing of task.timings ?? []) {
      if (timing.phase !== 'verify' || !timing.finishedAt) continue;
      if (!timing.outcome?.startsWith('passed') || checkKind(timing.level) !== kind) continue;
      const start = Date.parse(timing.startedAt);
      const end = Date.parse(timing.finishedAt);
      if (!Number.isFinite(start) || !(end >= start)) continue;
      runs.set(`${timing.startedAt}|${timing.finishedAt}`, { end, ms: end - start });
    }
  }
  const latest = [...runs.values()].sort((a, b) => b.end - a.end).slice(0, TYPICAL_RUNS);
  if (latest.length < TYPICAL_MIN_RUNS) return undefined;
  const sorted = latest.map((run) => run.ms).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Where a checking or merging task's time goes now, and how long that may take. */
interface TaskWait {
  /** The phase, in words: "its whole check", "in a merge batch, behind …". */
  phase: string;
  since: number;
  limit: number;
  typical?: number;
  /** Logs that grow while it goes on; none: its progress is not watched (a line waiting). */
  logs: string[];
  /** The check runs it waits on (their verify logs): one whose process is alive is progress. */
  checks: string[];
}

function checkWait(
  tasks: readonly TaskRecord[],
  task: TaskRecord,
  who: string
): Omit<TaskWait, 'logs' | 'checks'> & { log?: string } {
  const verify = task.verify as NonNullable<TaskRecord['verify']>;
  const kind = checkKind(verify.level);
  const typical = typicalCheckMs(tasks, task.repoPath, kind);
  return {
    phase: `${who} ${verify.level === 'batch' ? 'merge batch' : kind} check`,
    since: Date.parse(verify.startedAt),
    limit: typical
      ? Math.max(typical * TYPICAL_FACTOR, TYPICAL_FLOOR_MS)
      : (STUCK_AFTER_MS.verifying as number),
    typical,
    log: verify.logPath,
  };
}

const mergeLogOf = (task: TaskRecord) =>
  task.verify?.logPath ? path.join(path.dirname(task.verify.logPath), 'merge.log') : undefined;

const present = (files: Array<string | undefined>) => files.filter((f): f is string => !!f);

/**
 * `batch`: the ids of the merge batch the task is on board of (merge-train.ts, in order),
 * empty when it is on none.
 */
function taskWait(
  tasks: readonly TaskRecord[],
  task: TaskRecord,
  batch: readonly string[]
): TaskWait | null {
  if (task.state === 'preparing') {
    return {
      phase: 'preparing',
      since: Date.parse(task.stateSince),
      limit: STUCK_AFTER_MS.preparing as number,
      logs: [],
      checks: [],
    };
  }
  if (task.state !== 'verifying' && task.state !== 'merging') return null;
  const own = mergeLogOf(task);
  if (checkRunning(task)) {
    const wait = checkWait(tasks, task, 'its');
    return { ...wait, logs: present([wait.log, own]), checks: present([wait.log]) };
  }
  const sameLine = (other: TaskRecord) =>
    other.id !== task.id &&
    other.repoPath === task.repoPath &&
    other.baseBranch === task.baseBranch;
  const queueHead = tasks.find(
    (other) => sameLine(other) && other.state === 'verifying' && other.mergeQueue?.position === 1
  );
  if (task.state === 'verifying') {
    // Waiting for its check (a slot, its turn in the merge queue): timed from the last time its
    // line moved (the head's check started, a task of it merged), not from when it joined: a
    // long line that moves is no stuck task (2026-11-08 review: a 4 h wait was told near the
    // head). The head whose check stops moving is told itself.
    const spot = task.mergeQueue;
    const head = spot && spot.position > 1 ? queueHead : undefined;
    const moves = tasks
      .filter(sameLine)
      .flatMap((other) => [
        other.mergeQueue?.position === 1 ? Date.parse(other.verify?.startedAt ?? '') : Number.NaN,
        other.state === 'merged' ? Date.parse(other.stateSince) : Number.NaN,
      ])
      .filter(Number.isFinite);
    const where = task.verify?.queued
      ? 'waiting for a check slot'
      : spot
        ? `waiting in the merge queue (${spot.position} of ${spot.of})`
        : 'waiting for its check';
    const since = Date.parse(task.stateSince);
    return {
      phase: head ? `${where}, behind ${shortId(head.id)} "${head.name}"` : where,
      since: spot ? Math.max(since, ...moves) : since,
      limit: QUEUED_STUCK_MS,
      logs: [],
      checks: [],
    };
  }
  // Merging on board a merge batch (two-level project): it waits for the batch to leave and
  // for its whole check, run by its last car, or for the head of the merge queue, whose check
  // builds on it and the batch waits for (2026-11-08: 0b76eb3a told "merging for 23 min" while
  // its batch's check went on, and both merged without anyone). Only those: another task's
  // check in the same repository is no dependency of it.
  const onBoard = batch.includes(task.id);
  const deps = onBoard
    ? tasks.filter((o) => o.id !== task.id && (batch.includes(o.id) || o === queueHead))
    : [];
  const front = deps.filter(checkRunning).sort((a, b) => {
    const isBatch = Number(b.verify?.level === 'batch') - Number(a.verify?.level === 'batch');
    return isBatch || Date.parse(a.verify?.startedAt ?? '') - Date.parse(b.verify?.startedAt ?? '');
  })[0];
  if (front) {
    const wait = checkWait(tasks, front, `${shortId(front.id)} "${front.name}"'s`);
    return {
      ...wait,
      phase: `in a merge batch, behind ${wait.phase}`,
      logs: present([wait.log, mergeLogOf(front), own]),
      checks: present([wait.log]),
    };
  }
  // Moving the base, or its batch waiting to leave: timed from the last check its batch ran.
  const lastCheck = Math.max(
    ...deps.map((o) => Date.parse(o.verify?.finishedAt ?? '')).filter(Number.isFinite)
  );
  return {
    phase: onBoard ? `merging (in a merge batch of ${batch.length})` : 'merging',
    since: Math.max(Date.parse(task.stateSince), lastCheck),
    limit: STUCK_AFTER_MS.merging as number,
    logs: [],
    checks: [],
  };
}

const fileWrittenAt = (file: string): number | undefined => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * Tasks in a state they should have left long ago: preparing, checking or merging with no
 * progress or far past what that phase typically takes in this repository, a message to its
 * agent waiting for half an hour, a scheduled one far past its time.
 * Told, never touched: what moves them on is the engine's.
 */
export function stuckTasksCheck(deps: {
  tasks: () => readonly TaskRecord[];
  now?: () => number;
  /** When a log was last written (mtime, ms); undefined when it can't be read. */
  writtenAt?: (file: string) => number | undefined;
  /** The merge batch a task is on board of (its cars' ids, in order); none: empty. */
  batchOf?: (task: TaskRecord) => readonly string[];
  /**
   * Whether the check writing this verify log still has a live process (task-verify.ts
   * checkAlive); undefined when none of this server's checks writes it.
   */
  checkAlive?: (logPath: string) => boolean | undefined;
  /**
   * The scheduler's own admission decision (load, swap, memory, settling, grant turn); read-only.
   * The line's first task is «late» only when this would let it in (2026-11-11: a false alarm
   * at load 170, where tasks go in one every 20 min).
   */
  admission?: () => AdmissionVerdict;
}): DoctorCheck {
  const now = deps.now ?? Date.now;
  /** Since when the admission has been open for each first-in-line task (doctor looks). */
  const admittedSince = new Map<string, number>();
  const writtenAt = deps.writtenAt ?? fileWrittenAt;
  const batchOf = deps.batchOf ?? (() => []);
  const checkAlive = deps.checkAlive ?? (() => undefined);
  return {
    id: 'stuck-tasks',
    run() {
      const findings: DoctorFinding[] = [];
      const tasks = deps.tasks();
      for (const task of tasks) {
        const id = shortId(task.id);
        // A checking or merging task is timed by the phase it is in (2026-11-01: 2bda3273
        // flagged after 62 min, 58 of them queued; 2026-11-08: a merging car behind its batch's
        // check): told when what it waits on shows no progress (its logs still for
        // STUCK_NO_PROGRESS_MS and no live check process) or runs clearly past the typical
        // duration measured here.
        const wait = taskWait(tasks, task, batchOf(task));
        if (wait && Number.isFinite(wait.since)) {
          const elapsed = now() - wait.since;
          const written = wait.logs
            .map((file) => writtenAt(file))
            .filter((at): at is number => at !== undefined && Number.isFinite(at));
          const lastProgress = Math.max(wait.since, ...written);
          // A check that prints nothing for a while (tsc under load) is still progress while
          // its process lives: then only the expected duration tells.
          const alive = wait.checks.some((log) => checkAlive(log) === true);
          const still = wait.logs.length && !alive ? now() - lastProgress : 0;
          const why =
            elapsed > wait.limit
              ? wait.typical
                ? `, past the ${minutes(wait.limit)} min expected (typical check ${minutes(wait.typical)} min)`
                : ''
              : still > STUCK_NO_PROGRESS_MS
                ? `, no progress for ${minutes(still)} min`
                : null;
          if (why !== null) {
            findings.push({
              key: `stuck-task:${task.id}:${task.state}`,
              check: 'stuck-tasks',
              severity: 'warning',
              problem: `task ${id} "${task.name}" has been ${task.state} for ${minutes(now() - Date.parse(task.stateSince))} min (${wait.phase} for ${minutes(elapsed)} min${why})`,
            });
          }
        }
        const waiting = task.pendingInput?.[0];
        const waitingSince = waiting ? Date.parse(waiting.at) : Number.NaN;
        if (Number.isFinite(waitingSince) && now() - waitingSince > 30 * MINUTE) {
          findings.push({
            key: `stuck-input:${task.id}`,
            check: 'stuck-tasks',
            severity: 'warning',
            // Why, as the task knows it (2026-11-10: the doctor said only how long).
            problem: `a message for task ${id} "${task.name}" has waited ${Math.round((now() - waitingSince) / MINUTE)} min to be typed in${
              task.pendingWhy === 'menu'
                ? `: its agent shows a prompt of its own (\`ut task status ${id}\` shows it, \`ut task answer ${id} …\` answers it)`
                : task.pendingWhy === 'gone'
                  ? ': its session ended'
                  : task.pendingWhy === 'busy'
                    ? ': its agent is not ready at its prompt'
                    : ''
            }`,
          });
        }
        // First in its project's line with a slot free (2026-11-01, maxActiveTasks): the line
        // should have started it within seconds, unless the Mac's admission holds it. 2026-11-11:
        // false alarm at load 170 (max 24), where tasks go in one every 20 min: the check now
        // asks the scheduler's own admission decision. Its state is re-read on every list, so
        // this holds only while it is really so.
        const queued = task.state === 'queued' ? task.queued : undefined;
        const queuedSince = queued ? Date.parse(task.stateSince) : Number.NaN;
        const firstWithSlot =
          queued &&
          queued.position === 1 &&
          queued.active !== undefined &&
          queued.limit !== undefined &&
          queued.active < queued.limit &&
          Number.isFinite(queuedSince);
        if (!firstWithSlot) {
          admittedSince.delete(task.id);
        } else {
          const room = deps.admission?.();
          // No admission to ask: the scheduler's own note of waiting for the Mac stands in.
          const held = room ? !room.ok : !!queued.resources;
          if (held) {
            admittedSince.delete(task.id);
            const waited = now() - queuedSince;
            if (waited > QUEUED_ADMISSION_MAX_MS) {
              const reason = room?.short.length
                ? `by ${room.short.join(' and ')} of the Mac (${room.detail})`
                : room
                  ? `for the Mac's admission (${room.detail})`
                  : 'for the Mac';
              findings.push({
                key: `stuck-queued:${task.id}`,
                check: 'stuck-tasks',
                severity: 'warning',
                problem: `task ${id} "${task.name}" is first in its project's line with ${queued.active} of ${queued.limit} tasks running, waiting ${minutes(waited)} min ${reason}`,
              });
            }
          } else {
            const since = admittedSince.get(task.id) ?? now();
            admittedSince.set(task.id, since);
            if (now() - since > QUEUED_ADMITTED_MARGIN_MS && now() - queuedSince > 10 * MINUTE) {
              findings.push({
                key: `stuck-queued:${task.id}`,
                check: 'stuck-tasks',
                severity: 'warning',
                problem: `task ${id} "${task.name}" is first in its project's line with ${queued.active} of ${queued.limit} tasks running and the Mac's admission open for ${minutes(now() - since)} min, but has not started`,
              });
            }
          }
        }
        const runAt = Date.parse(task.runAt);
        if (task.state === 'scheduled' && Number.isFinite(runAt) && now() - runAt > 10 * MINUTE) {
          findings.push({
            key: `stuck-scheduled:${task.id}`,
            check: 'stuck-tasks',
            severity: 'warning',
            problem: `task ${id} "${task.name}" was due ${Math.round((now() - runAt) / MINUTE)} min ago and has not started`,
          });
        }
      }
      return findings;
    },
  };
}

/**
 * Orchestrators: a project still naming one whose session is gone, and a brief that has waited
 * across two looks (it never reached the session).
 */
export function orchestratorsCheck(deps: {
  registered: () => Array<{ repoPath: string; sessionId: string }>;
  running: () => Array<{ repoPath: string; sessionId: string; pending?: boolean }>;
  sessionStatus: (sessionId: string) => string | undefined;
}): DoctorCheck {
  let pendingBefore = new Set<string>();
  return {
    id: 'orchestrators',
    run() {
      const findings: DoctorFinding[] = [];
      for (const { repoPath, sessionId } of deps.registered()) {
        if (deps.sessionStatus(sessionId) === 'running') continue;
        findings.push({
          key: `orchestrator-gone:${repoPath}:${sessionId}`,
          check: 'orchestrators',
          severity: 'warning',
          problem: `${path.basename(repoPath)} still names orchestrator ${sessionId.slice(0, 8)}, whose session is not running`,
        });
      }
      const pendingNow = new Set<string>();
      for (const entry of deps.running()) {
        if (!entry.pending) continue;
        pendingNow.add(entry.sessionId);
        if (!pendingBefore.has(entry.sessionId)) continue;
        findings.push({
          key: `orchestrator-brief:${entry.sessionId}`,
          check: 'orchestrators',
          severity: 'warning',
          problem: `the brief of ${path.basename(entry.repoPath)}'s orchestrator has not reached its session yet`,
        });
      }
      pendingBefore = pendingNow;
      return findings;
    },
  };
}

/**
 * Tests flaky under load (2026-11-02, flaky-tests.ts): a task's check failed with the Mac over
 * its load threshold and passed on the rerun once the load dropped. The rerun keeps the task
 * moving; this keeps the tests from being forgotten: one warning per project naming them, the
 * most recently seen first. A test drops off once it has not failed so for two weeks.
 */
export function flakyUnderLoadCheck(deps: {
  list: () => Array<{ repoPath: string; tests: FlakyTest[] }>;
}): DoctorCheck {
  return {
    id: 'flaky-under-load',
    run() {
      return deps
        .list()
        .filter(({ tests }) => tests.length)
        .map(({ repoPath, tests }) => {
          const shown = tests
            .slice(0, 8)
            .map((test) => `${test.name}${test.count > 1 ? ` (×${test.count})` : ''}`);
          const more = tests.length > shown.length ? `; +${tests.length - shown.length} more` : '';
          return {
            key: `flaky-under-load:${repoPath}`,
            check: 'flaky-under-load',
            severity: 'warning' as const,
            problem: `${repoPath}: ${tests.length} test(s) failed in a task's check with the Mac under load and passed on the rerun (flaky under load, worth fixing): ${shown.join('; ')}${more}`,
          };
        });
    },
  };
}

/**
 * Finished tasks (done, merged, discarded, missed) whose agent's session still runs past the
 * scheduler's own stop (2026-10-24: three done tasks kept their Claude, RAM and CPU, in the
 * sidebar until the orchestrator killed them by hand). Healed by stopping the session.
 */
export function finishedTaskSessionsCheck(deps: {
  /** Finished tasks whose session has run on longer than it should (lingeringSessions). */
  lingering: () => readonly TaskRecord[];
  /** Stops one ('not-needed': it ended or became the user's meanwhile, nothing to tell). */
  stop: (taskId: string) => Promise<'stopped' | 'not-needed' | 'failed'>;
}): DoctorCheck {
  return {
    id: 'finished-task-sessions',
    async run() {
      const findings: DoctorFinding[] = [];
      for (const task of deps.lingering()) {
        const problem = `task ${task.id.slice(0, 8)} "${task.name}" is ${task.state} but its session ${task.sessionId?.slice(0, 8)} was still running`;
        const finding: DoctorFinding = {
          key: `finished-task-session:${task.id}`,
          check: 'finished-task-sessions',
          severity: 'warning',
          problem,
        };
        const outcome = await deps.stop(task.id).catch(() => 'failed' as const);
        if (outcome === 'not-needed') continue;
        findings.push(
          outcome === 'stopped'
            ? { ...finding, healed: 'session stopped' }
            : { ...finding, problem: `${problem}; stopping it failed` }
        );
      }
      return findings;
    },
  };
}

/**
 * Processes closed tasks left running (2026-11-02, bakery: 12 `yes` of a task, reparented to
 * launchd, kept every CPU busy after it). The reaper (task-processes.ts) ends them when a task's
 * session stops and every few minutes; the doctor sweeps once more and tells what was ended
 * (by the sweep or since the last run), so a task that keeps leaving processes behind shows.
 */
export function taskOrphansCheck(deps: {
  reap: () => Promise<readonly OrphanKill[]>;
  recent: () => readonly OrphanKill[];
  /** Maybe a closed task's but not proven (hidden environment): told, never ended. */
  suspects?: () => readonly OrphanSuspect[];
}): DoctorCheck {
  let told = 0;
  return {
    id: 'task-orphans',
    async run() {
      await deps.reap().catch(() => []);
      const recent = deps.recent();
      // recent() is capped: what is new since the last run is what came after the last told.
      const fresh = recent.filter((kill) => Date.parse(kill.at) > told);
      if (fresh.length) told = Math.max(...fresh.map((kill) => Date.parse(kill.at)));
      const byTask = new Map<string, OrphanKill[]>();
      for (const kill of fresh) {
        if (kill.signal !== 'TERM') continue;
        byTask.set(kill.taskId, [...(byTask.get(kill.taskId) ?? []), kill]);
      }
      const ended = [...byTask.entries()].map(([taskId, kills]) => {
        const forced = fresh.filter((k) => k.taskId === taskId && k.signal === 'KILL').length;
        const names = [...new Set(kills.map((k) => path.basename(k.command.split(' ')[0] ?? '')))];
        return {
          key: `task-orphans:${taskId}`,
          check: 'task-orphans',
          severity: 'warning' as const,
          problem: `task ${taskId.slice(0, 8)}${kills[0].taskName ? ` "${kills[0].taskName}"` : ''} had closed but left ${kills.length} process${kills.length === 1 ? '' : 'es'} running (${names.slice(0, 5).join(', ')}; pids ${kills
            .map((k) => k.pid)
            .slice(0, 10)
            .join(', ')})`,
          healed: `ended (TERM${forced ? `, ${forced} needed KILL` : ''})`,
        };
      });
      const suspectsByTask = new Map<string, OrphanSuspect[]>();
      for (const suspect of deps.suspects?.() ?? []) {
        suspectsByTask.set(suspect.taskId, [
          ...(suspectsByTask.get(suspect.taskId) ?? []),
          suspect,
        ]);
      }
      const suspects = [...suspectsByTask.entries()].map(([taskId, list]) => ({
        key: `task-orphans-suspect:${taskId}`,
        check: 'task-orphans',
        severity: 'warning' as const,
        problem: `task ${taskId.slice(0, 8)}${list[0].taskName ? ` "${list[0].taskName}"` : ''} has closed and ${list.length} reparented process${list.length === 1 ? '' : 'es'} still run${list.length === 1 ? 's' : ''} in its folder (${[...new Set(list.map((s) => path.basename(s.command.split(' ')[0] ?? '')))].slice(0, 5).join(', ')}; pids ${list
          .map((s) => s.pid)
          .slice(0, 10)
          .join(
            ', '
          )}); macOS hides their environment and nothing shows they started during the task, so they are not proven the task's and were left alone: end them by hand if they are`,
      }));
      return [...ended, ...suspects];
    },
  };
}

/**
 * The command guard of task agents (task-guard.ts, 2026-11-02): an open task whose agent runs
 * without it (its guard files could not be written, a shell wrapping the agent, the user's own
 * --settings, a Codex too old for unreviewed hooks) or whose guard failed on a call (it lets the
 * call run) is told, so an agent with permission bypass never runs unguarded unseen.
 */
export function taskGuardCheck(deps: {
  /** Open tasks (not merged, done, discarded or missed). */
  tasks: () => Array<Pick<TaskRecord, 'id' | 'name' | 'guardBlocks'>>;
}): DoctorCheck {
  return {
    id: 'task-guard',
    run() {
      const findings: DoctorFinding[] = [];
      for (const task of deps.tasks()) {
        const errors = (task.guardBlocks?.recent ?? []).filter(
          (entry) => entry.rule === 'guard-error'
        );
        const error = errors[errors.length - 1];
        if (!error) continue;
        findings.push({
          key: `task-guard:${task.id}`,
          check: 'task-guard',
          severity: 'warning',
          problem: `Task "${task.name}" (${task.id}): ${error.reason}`,
        });
      }
      return findings;
    },
  };
}

/**
 * The Node of open tasks' projects (2026-11-02: Homebrew node 26 as the default while the
 * project asked for "<25", and every task's build refused to run). A project whose default
 * node does not fit is told: as info when an installed Node that fits is put first for its
 * sessions and checks, as a warning when none installed fits (Untether installs nothing).
 */
export function taskNodeCheck(deps: {
  /** Open tasks (not merged, done, discarded or missed). */
  tasks: () => Array<Pick<TaskRecord, 'name' | 'workingDir' | 'worktreePath' | 'isolation'>>;
  resolve: (dir: string) => Promise<NodeRuntime>;
}): DoctorCheck {
  return {
    id: 'task-node',
    async run() {
      const dirs = new Map<string, string>();
      for (const task of deps.tasks()) {
        const dir =
          task.isolation === 'worktree' && task.worktreePath ? task.worktreePath : task.workingDir;
        if (dir && !dirs.has(dir) && fs.existsSync(dir)) dirs.set(dir, task.name);
      }
      const findings: DoctorFinding[] = [];
      for (const [dir, name] of dirs) {
        const runtime = await deps.resolve(dir);
        const line = describeNodeRuntime(runtime);
        if (!line || (runtime.kind !== 'switch' && runtime.kind !== 'missing')) continue;
        findings.push({
          key: `task-node:${runtime.kind}:${dir}`,
          check: 'task-node',
          severity: runtime.kind === 'missing' ? 'warning' : 'info',
          problem: `Task "${name}" (${dir}): ${line}`,
        });
      }
      return findings;
    },
  };
}

/**
 * A request from one project's orchestrator to another's (`ut project tell`) that got no
 * answer in UNANSWERED_WARN_HOURS (2026-11-10: nobody could tell whether a request had been
 * read; the asking project just waited). Says how far it got: never typed in (its orchestrator
 * busy, or the user's own text in its input), typed but no turn since, or read and left
 * unanswered. Not healed: answering is the other agent's, or the user's to chase. Clears when
 * the answer comes (`--reply-to`).
 */
export function unansweredMessagesCheck(deps: {
  unanswered: (olderThanMs: number) => AgentMessage[];
  now?: () => number;
  hours?: number;
}): DoctorCheck {
  return {
    id: 'messages-unanswered',
    run() {
      const now = (deps.now ?? Date.now)();
      const hours = deps.hours ?? UNANSWERED_WARN_HOURS;
      return deps.unanswered(hours * 60 * 60_000).map((message) => ({
        key: `messages-unanswered:${message.id}`,
        check: 'messages-unanswered',
        severity: 'warning' as const,
        problem: `Message ${message.id} from ${partyLabel(message.from)} to ${partyLabel(message.to)}, sent ${ageText(now - Date.parse(message.at))} ago, has no answer: ${messageStateText(message)}. It said: "${message.preview}". \`ut project messages\` lists it; the one it is for answers with \`ut project tell … --reply-to ${message.id}\``,
      }));
    },
  };
}
