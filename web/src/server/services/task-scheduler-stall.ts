/**
 * Progress and stalls of working agents (2026-11-02).
 *
 * Task 87df7078 committed its work at 15:54, started the full test suite in the background,
 * loaded Monitor and waited: the notice never came and it sat 1h40m until its agent budget ran
 * out. `ut task status` said "busy, last activity 0m ago" (the screen's spinner prints every
 * second) and the hourly note looked healthy, so nobody stepped in.
 *
 * Progress is what moves the work: the agent's own output or a tool result in its events
 * (Claude's hooks, Codex's rollout: agent-events.ts lastProgressAt), a file it changed in its
 * folder, a commit. Not the screen, not a long call merely open. When an agent made none for
 * the project's stallMinutes while it waits on one thing (a call open: Monitor, a sleep loop, a
 * long command; or Claude's reply over with background work running), whoever it reports to is
 * told once with that evidence and the agent is typed a nudge with a deadline. Still nothing by
 * then: told again, and its agent time stops counting against its budget until it moves.
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import { clockOf, progressLine } from '../../shared/task-progress.js';
import type { TaskProgressMark, TaskProgressSource, TaskRecord } from '../../shared/tasks.js';
import type { AgentSnapshot } from './agent-events.js';
import { BACKGROUND } from './claude-status-notifier.js';
import { TaskSchedulerBudgets } from './task-scheduler-budgets.js';
import { worktreeActivity } from './task-worktree.js';

/** Minutes without progress, waiting on one thing, before the agent is nudged (stallMinutes). */
export const STALL_MINUTES_DEFAULT = 20;
/** The nudge's deadline: at most this long, never longer than stallMinutes. */
export const STALL_NUDGE_DEADLINE_MS = 10 * 60_000;
/** The folder is looked at (git) at most this often per task, and only when the agent is quiet. */
export const STALL_WORKTREE_LOOK_MS = 60_000;
/** The agent's own events quiet this long before its folder is looked at for progress. */
export const STALL_QUIET_BEFORE_LOOK_MS = 2 * 60_000;

/** What the agent waits on, as one line: `Monitor "pnpm test"`. */
export function waitWhat(tool: string, detail?: string): string {
  return detail ? `${tool} "${detail}"` : tool;
}

/** Claude's reply is over and its session stays busy: background work it waits to hear from. */
export const BACKGROUND_WAIT =
  'background work (its reply is over; a background task or Monitor still runs)';

/**
 * What the agent waits on now, from its events and its status: its oldest call still open, or
 * background work after its reply. Undefined when it waits on nothing (it thinks, it writes).
 */
export function currentWait(
  snapshot: AgentSnapshot | undefined,
  status: string | undefined
): { what: string; since: number } | undefined {
  if (snapshot?.waitingOn) {
    return {
      what: waitWhat(snapshot.waitingOn.tool, snapshot.waitingOn.detail),
      since: snapshot.waitingOn.since,
    };
  }
  if (status === BACKGROUND && snapshot) {
    return { what: BACKGROUND_WAIT, since: snapshot.turnEndedAt ?? snapshot.lastEventAt };
  }
  return undefined;
}

/** The text typed into a stalled agent. */
export function stallNudgeText(
  minutes: number,
  wait: { what: string; since: number },
  deadlineMinutes: number
): string {
  return `[untether] No progress for ${minutes} min: you have been waiting on ${wait.what} since ${clockOf(wait.since)}. Do not wait for a notice. Check that job's output now (its output file or log, BashOutput, the test report, git status) and go on with the task; if the job is done, use its result; if it is stuck or gone, stop it and run what you need in the foreground. Show progress within ${deadlineMinutes} min (a tool call, a commit or your report).`;
}

export abstract class TaskSchedulerStall extends TaskSchedulerBudgets {
  /** The last look at each working task's folder (worktreeActivity). */
  private folderSeen = new Map<
    string,
    { lookedAt: number; at?: number; by?: 'files' | 'commit' }
  >();
  private folderLooking = new Set<string>();

  protected override forget(taskId: string): void {
    this.folderSeen.delete(taskId);
    super.forget(taskId);
  }

  /** The project's stallMinutes (0 = never). */
  protected stallMinutes(task: TaskRecord): number {
    const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
    const minutes = settings?.stallMinutes;
    return typeof minutes === 'number' && minutes >= 0 ? minutes : STALL_MINUTES_DEFAULT;
  }

  /**
   * A working task's last real progress now (its events, its folder as last looked at, the
   * start of this spell of work) and what it waits on.
   */
  protected progressNow(task: TaskRecord): TaskProgressMark | undefined {
    if (task.state !== 'working' || !task.sessionId) return undefined;
    const start = Date.parse(task.stateSince);
    let at = Number.isFinite(start) ? start : this.now();
    let by: TaskProgressSource = 'start';
    const snapshot = this.events(task);
    if (snapshot?.lastProgressAt !== undefined && snapshot.lastProgressAt >= at) {
      at = snapshot.lastProgressAt;
      by = 'agent';
    }
    const folder = this.folderSeen.get(task.id);
    if (folder?.at !== undefined && folder.by && folder.at > at) {
      at = folder.at;
      by = folder.by;
    }
    // A mark saved earlier (before a restart) still counts.
    const saved = task.progress ? Date.parse(task.progress.at) : Number.NaN;
    if (Number.isFinite(saved) && saved > at && task.progress) {
      at = saved;
      by = task.progress.by;
    }
    // Waiting for a check slot is not being stuck (2026-11-10): no stall while it waits, and
    // the quiet time counts again from when its turn came.
    const slot = this.deps.checkSlotWait?.(task.id);
    if (slot?.waiting) {
      at = this.now();
      by = 'agent';
    } else if (slot?.endedAt !== undefined && slot.endedAt > at) {
      at = slot.endedAt;
      by = 'agent';
    }
    const wait = currentWait(snapshot, this.lastStatus.get(task.sessionId));
    return {
      at: new Date(at).toISOString(),
      by,
      ...(wait
        ? { waitingOn: { what: wait.what, since: new Date(wait.since).toISOString() } }
        : {}),
    };
  }

  /** Looks at the task's folder in the background (at most every STALL_WORKTREE_LOOK_MS). */
  private lookAtFolder(task: TaskRecord): void {
    const dir = task.worktreePath ?? task.workingDir;
    if (!dir || this.folderLooking.has(task.id)) return;
    const last = this.folderSeen.get(task.id);
    if (last && this.now() - last.lookedAt < STALL_WORKTREE_LOOK_MS) return;
    this.folderLooking.add(task.id);
    const look = this.deps.worktreeActivity ?? worktreeActivity;
    this.track(
      Promise.resolve()
        .then(() => look(dir))
        .then((seen) => {
          this.folderSeen.set(task.id, { lookedAt: this.now(), ...(seen ?? {}) });
        })
        .catch(() => {
          this.folderSeen.set(task.id, { lookedAt: this.now() });
        })
        .finally(() => this.folderLooking.delete(task.id))
    );
  }

  /** Whether the folder was looked at since `since`. */
  private folderFresh(taskId: string, since: number): boolean {
    const seen = this.folderSeen.get(taskId);
    return !!seen && seen.lookedAt >= since;
  }

  /**
   * Every few seconds (checkExited): each working task's progress is brought up to date; one
   * quiet too long while it waits on one thing is told and nudged once, then told again if
   * the nudge's deadline passes with nothing.
   */
  protected watchProgress(): void {
    const now = this.now();
    let changed = false;
    for (const task of this.tasks) {
      if (task.state !== 'working' || !task.sessionId) {
        this.folderSeen.delete(task.id);
        if (task.stall) {
          delete task.stall;
          changed = true;
        }
        continue;
      }
      if (this.deps.sessionStatus(task.sessionId) !== 'running') continue;
      // Its heavy check waits for a check slot: no stall is called meanwhile (progressNow
      // counts the quiet time again from the wait's end).
      if (this.deps.checkSlotWait?.(task.id).waiting) continue;
      const snapshot = this.events(task);
      // Nothing structured to judge by (a Claude without its hooks): no stall is called.
      if (!snapshot) continue;
      const quietFor = now - (snapshot.lastProgressAt ?? Date.parse(task.stateSince));
      if (quietFor >= STALL_QUIET_BEFORE_LOOK_MS) this.lookAtFolder(task);
      const mark = this.progressNow(task);
      if (!mark) continue;
      const before = task.progress;
      if (
        before?.at !== mark.at ||
        before.by !== mark.by ||
        before.waitingOn?.what !== mark.waitingOn?.what
      ) {
        changed = true;
      }
      task.progress = mark;
      const progressAt = Date.parse(mark.at);
      // It moved since it was told: the stall is over (and its agent time counts again).
      if (task.stall && progressAt > Date.parse(task.stall.progressAt)) {
        this.deps.onError?.(
          `Task ${task.id}: progress again (${progressLine(mark, now)}) after its stall`
        );
        delete task.stall;
        changed = true;
      }
      const minutes = this.stallMinutes(task);
      if (!minutes) continue;
      const limit = minutes * 60_000;
      const deadline = Math.min(STALL_NUDGE_DEADLINE_MS, limit);
      if (task.stall) {
        if (!task.stall.escalatedAt && now - Date.parse(task.stall.notedAt) >= deadline) {
          task.stall.escalatedAt = new Date(now).toISOString();
          this.tellStall(task, mark, now, true);
          changed = true;
        }
        continue;
      }
      if (!mark.waitingOn || now - progressAt < limit) continue;
      // Its folder may have moved meanwhile (a command writing files): looked at first.
      if (!this.folderFresh(task.id, now - 2 * STALL_WORKTREE_LOOK_MS)) {
        this.lookAtFolder(task);
        continue;
      }
      task.stall = {
        progressAt: mark.at,
        waitingOn: mark.waitingOn.what,
        notedAt: new Date(now).toISOString(),
      };
      changed = true;
      this.tellStall(task, mark, now, false);
      const wait = { what: mark.waitingOn.what, since: Date.parse(mark.waitingOn.since) };
      const idle = Math.round((now - progressAt) / 60_000);
      this.track(
        this.deliverText(
          task,
          stallNudgeText(idle, wait, Math.round(deadline / 60_000)),
          'auto',
          false
        ).catch((error) => this.deps.onError?.(`Task ${task.id}: could not nudge its agent`, error))
      );
    }
    if (changed) this.save();
  }

  /** Tells whoever the task reports to (its orchestrator, the phone if it asked) about a stall. */
  private tellStall(task: TaskRecord, mark: TaskProgressMark, now: number, again: boolean): void {
    const idle = Math.round((now - Date.parse(mark.at)) / 60_000);
    const waiting = mark.waitingOn
      ? `it waits on ${mark.waitingOn.what} since ${clockOf(Date.parse(mark.waitingOn.since))}`
      : 'it waits on nothing Untether can name';
    const text = again
      ? `Still no progress ${idle} min after its last (${progressLine(mark, now)}), past the nudge's deadline; ${waiting}. Its agent time no longer counts against its budget until it moves. Look at \`ut task status ${task.id.slice(0, 8)}\` and its screen: send it what to do, or stop it.`
      : `No progress for ${idle} min: last ${progressLine(mark, now)}; ${waiting}. Untether typed it a nudge to check that job's output and go on within ${Math.round(Math.min(STALL_NUDGE_DEADLINE_MS, this.stallMinutes(task) * 60_000) / 60_000)} min.`;
    this.deps.onError?.(`Task ${task.id}: ${text}`);
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    if (!task.notify && !toOrchestrator) return;
    const payload = this.taskPayload(task, 'task-stalled', text);
    payload.data = {
      ...payload.data,
      lastProgressAt: mark.at,
      ...(mark.waitingOn
        ? { waitingOn: mark.waitingOn.what, waitingSince: mark.waitingOn.since }
        : {}),
      ...(again ? { escalated: true } : {}),
    };
    this.post(payload);
  }
}
