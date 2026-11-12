/**
 * Finishing: an agent that is done (or quiet, or gone) ends its task, plain tasks close as done,
 * and waiting ones are reminded.
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import { TASK_REPORT_MAX } from '../../shared/orchestrator-prompt.js';
import {
  blockedBlocker,
  partialBlocker,
  resultMismatch,
  type TaskResult,
} from '../../shared/task-result.js';
import {
  TASK_SUMMARY_MAX,
  TASK_UNDO_MAX,
  TASK_VERIFIED_MAX,
  type TaskBlocker,
  type TaskRecord,
} from '../../shared/tasks.js';
import type { AgentSnapshot } from './agent-events.js';
import { type AgentHalt, detectAgentHalt } from './agent-halt.js';
import {
  autoFixReasonOf,
  HALT_LOOK_EVERY_MS,
  HALT_LOOK_QUIET_MS,
  isFinal,
  PLAIN_READY_SWEEP_MS,
  SESSION_STATES,
  STALE_REMIND_MAX_MS,
  STALE_REMIND_MS,
  START_DIRTY_MAX,
} from './task-scheduler-rules.js';
import { TaskSchedulerSessions } from './task-scheduler-sessions.js';
import type { TaskActionResult, TaskRunner } from './task-scheduler-types.js';
import {
  dirtyFiles,
  LEFTOVERS_FAILED,
  leftoverExcludes,
  TaskWorktreeError,
} from './task-worktree.js';

/** A look at a quiet working task for a halt nobody told (watchHalts). */
interface HaltLook {
  sessionId: string;
  at: number;
  looking: boolean;
  /** The halt its screen showed at the last look. */
  seen?: string;
}

export abstract class TaskSchedulerFinish extends TaskSchedulerSessions {
  private haltLooks = new Map<string, HaltLook>();

  protected override forget(taskId: string): void {
    this.haltLooks.delete(taskId);
    super.forget(taskId);
  }

  /**
   * `ut task done` from the task's own session: finished now, with the agent's summary.
   * Undefined when the session runs no open task.
   */
  async markDone(
    sessionId: string,
    summary?: string,
    report: { verified?: string; undo?: string; result?: TaskResult } = {}
  ): Promise<TaskRecord | undefined> {
    const task = this.tasks.find(
      (entry) => entry.sessionId === sessionId && SESSION_STATES.includes(entry.state)
    );
    if (!task) return undefined;
    if (summary?.trim()) task.summary = summary.trim().slice(0, TASK_SUMMARY_MAX);
    const verified = report.verified?.trim().slice(0, TASK_VERIFIED_MAX);
    const undo = report.undo?.trim().slice(0, TASK_UNDO_MAX);
    if (verified || undo) {
      task.report = { ...(verified ? { verified } : {}), ...(undo ? { undo } : {}) };
    }
    // Each `ut task done` says where the work stands now: a result from an earlier round
    // (partial, then done in prose) would decide for this one otherwise.
    if (report.result) task.result = report.result;
    else delete task.result;
    delete task.resultMismatch;
    this.cancelHold(task.id);
    await this.finish(task, { reported: true });
    return this.copy(task);
  }

  /** A task without a worktree in a git checkout: what was uncommitted before it started. */
  protected async noteStartDirty(task: TaskRecord): Promise<void> {
    const files = await (this.deps.dirtyFiles ?? dirtyFiles)(task.workingDir).catch(() => null);
    if (files) task.startDirty = files.slice(0, START_DIRTY_MAX);
  }

  /**
   * What `ut task done` from a task without a worktree would leave uncommitted in its git
   * checkout: files new or changed since it started (startDirty), when the project merges on
   * its own or autoApprove is on. Those files then sit on the base branch and stop the next
   * task's merge (2026-10-24: b5b3d787 left 10, f80c5d25 waited «needs you · dirty-base»).
   * Empty when nothing is left, or when what was there before it started is not known.
   */
  async uncommittedWork(sessionId: string): Promise<string[]> {
    const task = this.tasks.find((entry) => entry.sessionId === sessionId && !isFinal(entry));
    if (task?.isolation !== 'none' || !task.startDirty) return [];
    const settings = await this.projectSettings(task);
    const policy = task.mergePolicy ?? settings?.mergePolicy ?? 'auto';
    if (policy !== 'auto' && !this.deps.autoApprove?.()) return [];
    const now = await (this.deps.dirtyFiles ?? dirtyFiles)(task.workingDir).catch(() => null);
    if (!now) return [];
    const before = new Map(task.startDirty.map((entry) => [entry.file, entry.sig]));
    return now.filter((entry) => before.get(entry.file) !== entry.sig).map((entry) => entry.file);
  }

  /**
   * `ut task merge` on a task without a worktree (2026-10-24): nothing to merge, so it closes
   * as done. Its session and folder are left as they are.
   */
  complete(id: string): TaskActionResult {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (task.isolation !== 'none') {
      return { ok: false, code: 'not-open', message: 'The task has a branch of its own: merge it' };
    }
    if (isFinal(task)) return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    if (this.finishing.has(task.id) || this.discarding.has(task.id)) {
      return { ok: false, code: 'busy', message: 'The task is busy' };
    }
    if (!['ready', 'needs_you', 'failed'].includes(task.state)) {
      return { ok: false, code: 'busy', message: `The task is ${task.state}` };
    }
    this.closeAsDone(task);
    this.save();
    this.closeSuperseded(task);
    return { ok: true, task: this.copy(task) };
  }

  /**
   * A worktree task that finished with nothing to merge closes as done with its report
   * (task-done push to its orchestrator or the user), the way one without a worktree does
   * (closeIfReported): reported, no follow-up still to be typed, nothing of its own in its
   * worktree (no commit ahead of its base, nothing uncommitted). Its worktree and branch go once its session stopped
   * (dropDoneWorktree). False leaves it to the caller (ready). 2026-10-31: only tasks without a
   * worktree did (2026-10-24); a worktree one sat "ready · changed nothing" for hours.
   */
  protected async closeUnchanged(
    task: TaskRecord,
    options: { reported: boolean }
  ): Promise<boolean> {
    if (!task.summary || task.pendingInput?.length) return false;
    // A Codex without a rollout tells no status: a quiet spell may be a pause (checkCodexBack
    // follows it when it works again), so only its own `ut task done` closes it. Its rollout's
    // end of turn is an end like Claude's.
    if (task.agent === 'codex' && !options.reported && this.events(task)?.state !== 'turn-ended') {
      return false;
    }
    if (await this.worktrees.hasUnmergedWork(task).catch(() => true)) return false;
    return this.closeIfReported(task);
  }

  /** Reported, nothing still to be typed into it, still open: closed as done (no awaits). */
  protected closeIfReported(task: TaskRecord): boolean {
    if (!task.summary || task.pendingInput?.length) return false;
    if (isFinal(task) || this.discarding.has(task.id)) return false;
    this.closeAsDone(task);
    this.closeSuperseded(task);
    return true;
  }

  /**
   * A worktree task done without changes: its worktree and branch go, after its session was
   * stopped (`ut task done` gets its answer first; setState → armFinishedStop). Kept when
   * anything of its own turned up meanwhile, or while its session still runs in it.
   */
  protected async dropDoneWorktree(task: TaskRecord, sessionStopped = false): Promise<void> {
    if (task.state !== 'done' || task.isolation !== 'worktree') return;
    if (!task.worktreePath) return;
    if (
      !sessionStopped &&
      task.sessionId &&
      this.deps.sessionStatus(task.sessionId) === 'running'
    ) {
      return;
    }
    if (await this.worktrees.hasUnmergedWork(task).catch(() => true)) {
      this.deps.onError?.(`task ${task.id}: done, but its worktree holds work: kept`);
      return;
    }
    const removed = await this.worktrees
      .remove(task, { deleteUnmerged: true })
      .catch((error: unknown) => ({ worktreeRemoved: false, branchDeleted: false, error }));
    if (!removed.worktreeRemoved || !removed.branchDeleted) {
      this.deps.onError?.(`task ${task.id}: its worktree or branch could not go`, removed.error);
      return;
    }
    // Gone: not looked at again (the next start would try once more otherwise).
    delete task.worktreePath;
    this.save();
  }

  /**
   * Its orchestrator got the report of a task that changed nothing (orchestrator.ts): it closes
   * as done the way finish() closes one (it used to be discarded, 2026-10-20). Answers whether
   * it did; one with work of its own in its worktree stays open.
   */
  async closeReported(id: string): Promise<boolean> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (task?.state !== 'ready' || task.blocker?.kind !== 'no-changes') return false;
    if (this.piping.has(task.id) || this.finishing.has(task.id)) return false;
    if (!(await this.closeUnchanged(task, { reported: true }))) return false;
    this.save();
    return true;
  }

  protected closeAsDone(task: TaskRecord): void {
    this.cancelHold(task.id);
    this.setState(task, 'done');
    task.finishedAt = new Date(this.now()).toISOString();
    this.inputStalls.delete(task.id);
  }

  /**
   * A task without a worktree done: older failed ones with the same prompt in the same folder
   * were tried again by it, so they close as done too (2026-10-24: they stayed open for good).
   */
  protected closeSuperseded(task: TaskRecord): void {
    if (task.isolation !== 'none' || task.state !== 'done') return;
    const prompt = task.prompt.trim();
    const created = Date.parse(task.createdAt);
    let closed = false;
    for (const older of this.tasks) {
      if (
        older.id === task.id ||
        older.isolation !== 'none' ||
        older.state !== 'failed' ||
        older.workingDir !== task.workingDir ||
        older.prompt.trim() !== prompt ||
        !(Date.parse(older.createdAt) <= created) ||
        this.finishing.has(older.id) ||
        this.discarding.has(older.id)
      ) {
        continue;
      }
      this.closeAsDone(older);
      older.supersededBy = task.id;
      closed = true;
    }
    if (closed) this.save();
  }

  /**
   * Once at startup (2026-10-24): tasks without a worktree left "ready" over a day with their
   * session gone, from before they closed on their own, close as done; failed ones a newer
   * done task redid, too.
   */
  protected sweepFinishedPlainTasks(now: number): void {
    for (const task of this.tasks) {
      if (task.isolation !== 'none' || task.state !== 'ready' || task.blocker) continue;
      const since = Date.parse(task.stateSince);
      if (!(now - since > PLAIN_READY_SWEEP_MS)) continue;
      if (task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') continue;
      this.closeAsDone(task);
    }
    for (const task of this.tasks) this.closeSuperseded(task);
  }

  /**
   * The generic net (2026-10-31): a task ready or waiting for an answer with nobody acting on
   * it tells whoever it reports to again (its orchestrator, else the user's phone), after
   * STALE_REMIND_MS and then twice as long each time; never while Untether itself still acts
   * on it (a countdown, a retry, a wait for its base). Remembered in the task, so a restart
   * does not repeat one.
   */
  protected remindStale(): void {
    const first = this.deps.staleRemindMs?.() ?? STALE_REMIND_MS;
    if (!(first > 0)) return;
    const now = this.now();
    let reminded = false;
    for (const task of this.tasks) {
      if (!this.waitsOnSomeone(task)) continue;
      const since = Date.parse(task.stateSince);
      if (!Number.isFinite(since)) continue;
      const prior = task.staleReminder?.since === task.stateSince ? task.staleReminder : undefined;
      const count = prior?.count ?? 0;
      const last = prior ? Date.parse(prior.at) : since;
      if (now - last < Math.min(first * 2 ** count, STALE_REMIND_MAX_MS)) continue;
      task.staleReminder = {
        since: task.stateSince,
        count: count + 1,
        at: new Date(now).toISOString(),
      };
      reminded = true;
      this.remind(task, now - since);
    }
    if (reminded) this.save();
  }

  /** Ready or needs_you with someone to tell and nothing of Untether's own under way. */
  protected waitsOnSomeone(task: TaskRecord): boolean {
    if (task.state !== 'ready' && task.state !== 'needs_you') return false;
    if (task.security?.kind === 'sweep') return false;
    if (
      this.piping.has(task.id) ||
      this.finishing.has(task.id) ||
      this.discarding.has(task.id) ||
      this.retrying.has(task.id)
    ) {
      return false;
    }
    if (task.autoMergeAt || task.reviewRetryAt || task.internalRetryAt || task.baseWait) {
      return false;
    }
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    return task.notify || toOrchestrator || !!task.repoPath;
  }

  protected remind(task: TaskRecord, waitedMs: number): void {
    const minutes = Math.max(1, Math.round(waitedMs / 60_000));
    const waited = minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
    const reminder = `Still ${task.state === 'ready' ? 'ready' : 'waiting for you'} after ${waited}, nobody acted on it`;
    const count = task.staleReminder?.count ?? 1;
    // Keyed by its spell too: a later spell's first reminder is no repeat of an earlier one's
    // (pushes dedupe on state, blocker, commit and notice).
    this.notifyState(task, task.summary || '', {
      reminder,
      notice: `stale-${task.stateSince}-${count}`,
    });
    // Untether's own tasks (a security sweep's fix) report to the user: the project's
    // orchestrator, if one runs, hears too (2026-10-31: it never heard of aab57353).
    if (task.origin !== 'orchestrator' && task.repoPath) {
      this.deps.projectNotice?.(
        task.repoPath,
        `Task ${task.id.slice(0, 8)} "${task.name}" (not yours: ${task.origin === 'schedule' ? 'Untether started it' : 'the user started it'}) is ${task.state}${task.blocker ? ` (${task.blocker.message})` : ''}. ${reminder}. Tell the user if it needs them; \`ut task show ${task.id.slice(0, 8)}\` has the details.`
      );
    }
  }

  /**
   * A base branch with uncommitted changes that is another open task's branch: those changes
   * are that task's work in progress, not leftovers (2026-10-18: an orchestrator read them as
   * leftovers and offered to throw away a working agent's changes).
   */
  protected explainDirtyBase(task: TaskRecord, blocker?: TaskBlocker): TaskBlocker | undefined {
    if (blocker?.kind !== 'dirty-base' || !task.baseBranch) return blocker;
    const owner = this.baseOwner(task);
    if (!owner) return blocker;
    return {
      ...blocker,
      message: `${blocker.message}: they are the work in progress of task ${owner.id.slice(0, 8)} "${owner.name}" (${owner.state}), whose branch this merges into. Do not discard them; wait until that task is done, then merge this one again.`,
    };
  }

  /** The open task whose branch `task` merges into (its agent may be at work in it). */
  protected baseOwner(task: TaskRecord): TaskRecord | undefined {
    if (!task.baseBranch) return undefined;
    return this.tasks.find(
      (entry) =>
        entry.id !== task.id &&
        entry.branch === task.baseBranch &&
        (entry.state === 'working' || entry.state === 'needs_you' || entry.state === 'preparing')
    );
  }

  /**
   * The task's agent was cut short: another agent, account or model carries it on at once
   * when the project says so (ProjectSettings.agentFallback 'auto'), else the task pauses with
   * the other one offered. Called with the task in `finishing`, which it leaves.
   */
  protected async haltStops(task: TaskRecord, halt: AgentHalt): Promise<void> {
    let offer: TaskRunner | undefined;
    try {
      const fallback = await this.fallbackFor(task, halt);
      if (fallback.runner && fallback.auto && SESSION_STATES.includes(task.state)) {
        if (await this.handOff(task, fallback.runner, halt, 'auto')) return;
      }
      offer = fallback.runner;
    } finally {
      this.finishing.delete(task.id);
    }
    if (!SESSION_STATES.includes(task.state) || this.discarding.has(task.id)) return;
    this.pause(task, halt, offer);
  }

  /**
   * Every few seconds (checkExited), the net under the end of a turn (2026-11-09, f3719fe5: a
   * Codex at its usage limit in a fix round sat "working" for 54 min, its end of turn taken
   * for an older one's, and only the hourly note came). A working task quiet for
   * HALT_LOOK_QUIET_MS (no event of its agent, nothing typed into it) is looked at every
   * HALT_LOOK_EVERY_MS, in any phase and with nobody writing to it: its events saying it was
   * cut short are believed at once; its screen (agent-halt.ts) when two looks in a row show
   * the same error as the agent's last word. Then it is handed on or paused as at the end of
   * a turn, long before the stall notice.
   */
  protected watchHalts(): void {
    const now = this.now();
    for (const task of this.tasks) {
      const sessionId = task.sessionId;
      if (task.state !== 'working' || !sessionId) {
        this.haltLooks.delete(task.id);
        continue;
      }
      if (this.finishing.has(task.id) || this.piping.has(task.id)) continue;
      if (this.discarding.has(task.id) || this.resuming.has(task.id)) continue;
      if (this.replacing.has(sessionId) || this.inputOutstanding(task)) continue;
      if (this.deps.sessionStatus(sessionId) !== 'running') continue;
      const events = this.events(task);
      const since = Date.parse(task.stateSince);
      const quietSince = Math.max(
        this.lastTypedAt(task),
        Number.isFinite(since) ? since : 0,
        events?.lastEventAt ?? 0
      );
      const look = this.haltLooks.get(task.id);
      // It did something since the last look (or runs in another session): looked at afresh.
      if (now - quietSince < HALT_LOOK_QUIET_MS || (look && look.sessionId !== sessionId)) {
        this.haltLooks.delete(task.id);
        continue;
      }
      if (look && (look.looking || now - look.at < HALT_LOOK_EVERY_MS)) continue;
      const next = { ...look, sessionId, at: now, looking: true };
      this.haltLooks.set(task.id, next);
      this.track(
        this.lookForHalt(task, sessionId, events, next)
          .catch((error) =>
            this.deps.onError?.(`Task ${task.id}: could not look for a halt`, error)
          )
          .finally(() => {
            next.looking = false;
          })
      );
    }
  }

  private async lookForHalt(
    task: TaskRecord,
    sessionId: string,
    events: AgentSnapshot | undefined,
    look: HaltLook
  ): Promise<void> {
    let halt: AgentHalt | null = null;
    let source: 'events' | 'screen' = 'events';
    if (events?.state === 'halted' && events.halt) {
      halt = events.halt;
    } else if (this.deps.screenText) {
      source = 'screen';
      const screen = await this.deps.screenText(sessionId).catch(() => undefined);
      halt = screen ? detectAgentHalt(screen, this.now()) : null;
      // A screen is believed the second time it says the same: an error the agent is about
      // to retry by itself is gone, or under new output, by then.
      const seenBefore = !!halt && look.seen === halt.message;
      look.seen = halt?.message;
      if (!seenBefore) return;
    }
    if (!halt) return;
    // Still the same quiet task: anything that happened meanwhile decides instead.
    if (this.haltLooks.get(task.id) !== look) return;
    if (task.state !== 'working' || task.sessionId !== sessionId) return;
    if (this.finishing.has(task.id) || this.piping.has(task.id)) return;
    if (this.discarding.has(task.id) || this.resuming.has(task.id)) return;
    if (this.replacing.has(sessionId) || this.inputOutstanding(task)) return;
    if (this.deps.sessionStatus(sessionId) !== 'running') return;
    if ((this.events(task)?.lastEventAt ?? 0) > (events?.lastEventAt ?? 0)) return;
    this.haltLooks.delete(task.id);
    this.decided(
      'halt',
      source,
      task,
      `a look at a quiet working task: ${events ? `its events say ${events.state}` : 'no events of its agent'}`
    );
    this.deps.onError?.(
      `Task ${task.id}: its agent stopped with nobody told (${halt.message}), seen on a look at its ${source}`
    );
    this.cancelHold(task.id);
    this.finishing.add(task.id);
    await this.haltStops(task, halt);
  }

  /**
   * The agent is done (idle, `ut task done`, its session ended). A worktree task gets what
   * the agent left uncommitted committed and its changes counted; with commits it goes
   * through the merge pipeline, without it is done (closeUnchanged), ready (no-changes: a
   * Codex quiet spell, or files of its own still in it), needs the user (it ended on a
   * question) or failed (its session ended first).
   */
  protected async finish(
    task: TaskRecord,
    options: { exited?: boolean; reported?: boolean } = {}
  ): Promise<void> {
    if (this.finishing.has(task.id) || this.piping.has(task.id) || this.discarding.has(task.id)) {
      return;
    }
    this.finishing.add(task.id);
    // The turn ended without `ut task done`: its agent may have been cut short by its usage
    // limit, an API error or a lost login (2026-11-01). Then nothing is finished.
    // Only awaited when there is a screen to read: finishing stays as quick as before.
    // Only awaited when a transcript or a screen is to be read: finishing stays as quick as
    // before when the agent's events answer.
    if (!options.reported && !options.exited) {
      const told = this.haltFromEvents(task);
      const halt =
        told !== undefined ? told : this.haltNeedsALook(task) ? await this.haltOf(task) : null;
      if (halt && SESSION_STATES.includes(task.state) && !this.discarding.has(task.id)) {
        await this.haltStops(task, halt);
        return;
      }
    }
    if (task.security?.kind === 'sweep') {
      try {
        await this.finishSweep(task, options);
      } finally {
        this.finishing.delete(task.id);
      }
      return;
    }
    let pipeline = false;
    // Untether was fixing it by itself (setState drops the mark when the blocker changes).
    const wasFixing = !!task.autoFix;
    try {
      const reply = this.lastReply.get(task.id) ?? '';
      if (task.isolation === 'worktree' && task.worktreePath) {
        let blocker: TaskBlocker | undefined;
        const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
        try {
          await this.worktrees.commitLeftovers(task, leftoverExcludes(settings?.cloneDirs));
        } catch (error) {
          // 2026-10-20: this was a 'verify' blocker, so "Que lo arregle" told the agent the
          // check had failed, with the output of an older check.
          blocker = {
            kind: 'merge-error',
            agentFixable: true,
            message: LEFTOVERS_FAILED,
            detail:
              error instanceof TaskWorktreeError
                ? [error.message, ...error.detail]
                : [String(error)],
          };
        }
        // Discarded while the hooks ran (discard waits for finish, but a restart may not).
        if (isFinal(task)) return;
        let renamed: { from: string; to: string }[] | undefined;
        try {
          const changes = await this.worktrees.changes(task);
          task.files = changes.files;
          task.stats = changes.stats;
          renamed = changes.renamed;
        } catch (error) {
          this.deps.onError?.(`task ${task.id}: could not read its changes`, error);
        }
        if (isFinal(task)) return;
        const changed = (task.stats?.commits ?? 0) > 0;
        // What the agent's own result says, against its branch (2026-11-01: decided by its
        // outcome, no longer by its prose).
        const result = task.result;
        if (result) {
          const mismatch = resultMismatch(
            result,
            changed,
            changed ? task.files : undefined,
            renamed
          );
          if (mismatch) task.resultMismatch = mismatch;
          else delete task.resultMismatch;
        }
        if (blocker) {
          this.setState(task, 'needs_you', blocker);
        } else if (result?.outcome === 'blocked') {
          // It cannot go on without someone: what blocks it is in its follow-ups.
          this.setState(task, 'needs_you', blockedBlocker(result));
        } else if (changed) {
          // A partial result, or one that says no-change, is checked and reviewed, then waits
          // (task-merge-loop.ts resultHold).
          pipeline = true;
        } else if (options.exited) {
          this.setState(task, 'failed', {
            kind: 'session-exit',
            message: 'The session ended before the agent changed anything',
          });
        } else if (result?.outcome === 'partial') {
          this.setState(task, 'ready', partialBlocker(result));
        } else if (result && result.outcome !== 'no-change') {
          // It says done and lists changed files, but its branch has none: not closed as if
          // it had answered something.
          this.setState(task, 'ready', {
            kind: 'result-mismatch',
            message:
              task.resultMismatch ?? "The agent's result says done, but its branch has no change",
          });
        } else if (!result && this.endedOnQuestion(task, reply)) {
          this.setState(task, 'needs_you', {
            kind: 'question',
            message: (this.events(task)?.finalMessage ?? reply).slice(0, 2000),
          });
        } else {
          // Its report is what it made (a review, an investigation): kept whole, so the
          // orchestrator gets it with the event and the task can close once it has
          // (2026-10-20: review tasks stayed open with only a 160-character preview).
          if (!task.summary && task.sessionId) {
            const report = await this.reportOf(task.sessionId, task);
            if (report) task.summary = report.slice(0, TASK_REPORT_MAX);
          }
          if (isFinal(task)) return;
          // 2026-10-31: a task that changed nothing sat "ready" for hours with nothing to
          // merge (bakery aab57353, Codex, `ut task done` "No files changed"). Reported and
          // nothing of its own in its worktree: done, like a task without a worktree.
          if (!(await this.closeUnchanged(task, { reported: !!options.reported }))) {
            if (isFinal(task)) return;
            this.setState(task, 'ready', {
              kind: 'no-changes',
              message: 'The agent changed nothing',
            });
          }
        }
      } else if (options.exited) {
        // 2026-10-20: a task without a worktree whose session died mid-work (a restart killed
        // it) was called ready, its work half done.
        this.setState(task, 'failed', {
          kind: 'session-exit',
          message: 'The session ended before the agent said it was done',
        });
      } else {
        // It ended on a question it did not report with `ut task done`: the user looks.
        const asked = !task.summary && this.endedOnQuestion(task, reply);
        // Its own result decides where a blocked or partial one stands, not its prose.
        const outcome = task.result?.outcome;
        // Its report is what the user (or its orchestrator) reads: kept whole when the agent
        // gave none with `ut task done` (2026-10-20: atlas-guard's report reached nobody).
        if (!task.summary && task.sessionId) {
          const report = await this.reportOf(task.sessionId, task);
          if (report) task.summary = report.slice(0, TASK_REPORT_MAX);
        }
        if (isFinal(task)) return;
        // 2026-10-24: these stayed "ready" for days with nothing to merge (`ut task merge`
        // refused them), closed only by «Descartar». Reported, and nothing blocking it (no
        // question, no follow-up still to be typed): done.
        if (task.result && outcome === 'blocked') {
          this.setState(task, 'needs_you', blockedBlocker(task.result));
        } else if (task.result && outcome === 'partial') {
          this.setState(task, 'ready', partialBlocker(task.result));
        } else if ((!task.result && asked) || !this.closeIfReported(task)) {
          this.setState(task, 'ready');
        }
      }
      task.finishedAt = new Date(this.now()).toISOString();
      if (pipeline) {
        // Shown as checking right away; the pipeline sends the push when it ends.
        this.setState(task, 'verifying');
        this.save();
      } else {
        this.save();
        // A commit hook's complaint is the agent's to fix, by itself first (auto-fix loop).
        const reason = autoFixReasonOf(task.blocker);
        const autoFix =
          !!reason && !options.exited && this.fixesOnItsOwn(task) && this.autoFixLeft(task, reason);
        if (!autoFix || !reason || !(await this.startAutoFix(task, reason))) {
          // Fixing it by itself ran out (or the blocker it fixed became one it does not fix):
          // the user hears it once, in plain words.
          const body = wasFixing && reason ? this.gaveUp(task) : undefined;
          delete task.autoFix;
          this.save();
          this.notifyState(task, task.summary || reply, body ? { body } : {});
        }
      }
    } finally {
      this.finishing.delete(task.id);
    }
    // Not awaited: `ut task done` and the exit check answer at once; the check takes minutes.
    // A session that ended without the agent saying it was done (killed, crashed) may hold
    // half-done work: checked, never merged on its own (2026-10-18 review).
    if (pipeline && options.exited) {
      this.track(
        this.pipe(
          task,
          'verify',
          {},
          {
            kind: 'session-exit',
            message:
              'Its session ended before the agent said it was done: look at the changes before merging',
          }
        )
      );
    } else if (pipeline) {
      // A revert's agent resolved its conflicts: the user asked for the undo, risk and all.
      this.track(this.pipe(task, 'auto', task.revertOf ? { acceptRisk: true } : {}));
    } else this.releaseDependents(task);
  }
}
