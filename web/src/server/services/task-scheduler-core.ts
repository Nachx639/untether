/**
 * The scheduler's state and what every part leans on: the fields, saving and loading tasks.json,
 * state changes and the pushes they send.
 * One layer of TaskScheduler (task-scheduler.ts).
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { autoMergePaused, type ProjectSettings } from '../../shared/projects.js';
import type { TaskBudget, TaskBudgetSpec } from '../../shared/task-budget.js';
import { currentRound, withTimings } from '../../shared/task-timings.js';
import {
  GUARD_BLOCKS_KEPT,
  guardLetThrough,
  TASK_BUSY_STATES,
  TASK_FINAL_STATES,
  type TaskAutoFixReason,
  type TaskBlocker,
  type TaskBlockerKind,
  type TaskFollowUp,
  type TaskPhaseTiming,
  type TaskPushType,
  type TaskRecord,
  type TaskState,
  type TaskVerify,
} from '../../shared/tasks.js';
import {
  type AgentDecision,
  type AgentSnapshot,
  SignalLedger,
  type SignalSource,
} from './agent-events.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { PipelineMode } from './task-merge.js';
import {
  autoFixReasonOf,
  budgeted,
  HISTORY_LIMIT,
  isFinal,
  isSettled,
  outboxPayload,
  PUSH_SEND_TRIES,
  riskFilesOf,
  riskReviewSaid,
  STORE_VERSION,
  validRecord,
} from './task-scheduler-rules.js';
import {
  gitTaskWorktrees,
  type LaunchedSession,
  type MergeOptions,
  type OutboxEntry,
  type TaskActionResult,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler-types.js';
import { resolveMainRepo } from './task-worktree.js';

export abstract class TaskSchedulerCore {
  protected tasks: TaskRecord[] = [];
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected exitTimer: ReturnType<typeof setInterval> | null = null;
  protected readonly now: () => number;
  protected readonly worktrees: TaskWorktrees;
  /** Per task: the "idle long enough" timer after its agent stopped working. */
  protected holds = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions being reopened (sessionReplacing): their end does not finish a task. */
  protected readonly replacing = new Set<string>();
  /** When start() ran (RESTART_WINDOW_MS). */
  protected startedAt = Number.NEGATIVE_INFINITY;
  /**
   * Sessions this server started: one of them that ends did not die with an earlier server,
   * so it is never taken for a restart's victim (an agent that quits at once ends its task).
   */
  protected readonly launchedHere = new Set<string>();
  /** Per session: the last status the notifier reported. */
  protected lastStatus = new Map<string, string>();
  /** Tasks whose agent was seen working since this server started. */
  protected seenBusy = new Set<string>();
  /** Tasks waiting on Claude's own prompt (not `ut task ask`): idle again means it moved on. */
  protected waitingOnPrompt = new Set<string>();
  /** Why the typing into a session waits on the user's own input there (user-input-guard.ts). */
  protected userHolds = new Map<string, string>();
  /**
   * Prompts the user's phone was told of that are on no blocker (a task not «needs you» whose
   * screen shows one): per task, what it asked. One push each, however often an agent's
   * answer to it is refused.
   */
  protected promptTold = new Map<string, string>();
  /** Tasks whose prompt is being read off their screen now (one read at a time each). */
  protected promptReads = new Set<string>();
  /** Per task: the agent's last reply, for the push and "ended on a question". */
  protected lastReply = new Map<string, string>();
  /** Per task: when a follow-up was last typed (a Codex task's quiet spell starts there). */
  protected lastSent = new Map<string, number>();
  /**
   * Pushes written to tasks.json with the state that caused them and not sent yet (post):
   * sent right after the write, dropped once sent; a restart sends what is left.
   */
  protected outbox: OutboxEntry[] = [];
  /** The outbox is being sent (a push that saves does not send it again meanwhile). */
  protected sending = false;
  protected finishing = new Set<string>();
  /**
   * Tasks being discarded (2026-10-20 review: discard awaited the session's stop and the
   * worktree's removal holding nothing, so a resume, a finish or a merge could start meanwhile:
   * an orphan session in a removed folder, or a merged task marked discarded).
   */
  protected discarding = new Set<string>();
  /** Tasks whose retry() is deciding how (it awaits git). */
  protected retrying = new Set<string>();
  /** Tasks being resumed after a restart right now. */
  protected resuming = new Set<string>();
  /** checkExited() is running (it awaits; the 5 s interval must not start it twice). */
  protected checking = false;
  /** The guard log's stamp last read per task (syncGuardBlocks). */
  protected guardStamps = new Map<string, string>();
  /**
   * The saved tasks could not be read and could not be put aside either: nothing is saved
   * over them (2026-10-20: an unreadable tasks.json was loaded as no tasks and overwritten).
   */
  protected saveBlocked = false;
  /** Worktrees are made one at a time (a parallel group's git commands never race). */
  protected preparing: Promise<unknown> = Promise.resolve();
  /** Tasks in the merge pipeline right now. */
  protected piping = new Set<string>();
  /**
   * A pipeline run's way out of the merge queue while it waits there (a discard), and its end
   * (2026-11-01: the wait behind other tasks can be long; the task stays discardable).
   */
  protected pipeRuns = new Map<string, { leave: AbortController; done: Promise<void> }>();
  /** Tasks whose dirty base checkout is being looked at right now (lookAtBase). */
  protected lookingAtBase = new Set<string>();
  /** Work started in the background (worktree setup, pipelines), for settled(). */
  protected jobs = new Set<Promise<unknown>>();
  /** Per task: the message being typed into its agent right now (TaskRecord.pendingInput). */
  protected typing = new Map<string, Promise<void>>();
  /**
   * Tasks whose session's first message (brief, resume text) is still being typed: until it
   * went in, a quiet agent has not even started (2026-10-23: two Codex tasks were called done,
   * "The agent changed nothing", 2 min in, their briefs still waiting on a dialog). By task,
   * the session it is typed into: a session started since then has a brief of its own.
   */
  protected briefPending = new Map<string, string>();
  /** Per Codex task back at rest: the output time its worktree was last checked for commits. */
  protected codexProbedAt = new Map<string, number>();
  /** Per task: the timer of the next try at typing what is pending, or of a setup retry. */
  protected inputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  protected setupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per task: the timer that stops its session once it is finished (stopFinishedSession). */
  protected finishedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Per task: messages that could not be typed (backoff, the last reason logged, since when,
   * whether the user was told).
   */
  protected inputStalls = new Map<
    string,
    { attempts: number; since: number; reason: string; noticed?: boolean }
  >();
  /** Per session: the last message of its conversation the notifier showed (preview). */
  protected previews = new Map<string, string>();
  /** Per task: its conversation's last message when it settled (ready, failed, needs you). */
  protected settledPreview = new Map<string, string | undefined>();
  /** Settled tasks seen busy with no sign of a follow-up: on idle, new commits are looked for. */
  protected probing = new Set<string>();
  /** The project (main checkout) each task belongs to, once asked (maxActiveTasks). */
  protected taskProject = new Map<string, string>();
  /** Budgets: when each task's tokens were last read, the reads under way, the last save. */
  protected tokensReadAt = new Map<string, number>();
  protected readingTokens = new Set<string>();
  protected budgetSavedAt = 0;
  protected pumpArmed = false;
  protected pumping = false;
  protected pumpAgain = false;

  protected readonly signals: SignalLedger;

  // Implemented by the layers above (task-scheduler.ts lists them).
  protected abstract budgetOf(task: TaskRecord, own?: TaskBudgetSpec): TaskBudget;
  protected abstract observeMetrics(): void;
  protected abstract countTime(task: TaskRecord, now: number): void;
  protected abstract newRound(task: TaskRecord, before: TaskState): boolean;
  protected abstract projectOf(task: TaskRecord): Promise<string | undefined>;
  protected abstract queuePlace(task: TaskRecord): { position: number; of: number; active: number };
  protected abstract requestPump(): void;
  protected abstract cancelHold(taskId: string): void;
  protected abstract deliverText(
    task: TaskRecord,
    text: string,
    via: TaskFollowUp['via'],
    backToWork: boolean
  ): Promise<TaskActionResult>;
  protected abstract watchTyped(task: TaskRecord, launched: LaunchedSession): void;
  protected abstract armFinishedStop(task: TaskRecord, since?: number): void;
  protected abstract cancelFinishedStop(taskId: string): void;
  protected abstract dropSession(task: TaskRecord, sessionId: string): Promise<void>;
  protected abstract launchPrompt(task: TaskRecord): string;
  protected abstract openSession(
    task: TaskRecord,
    first: { text: string; brief?: boolean },
    open: (sessionId: string) => Promise<LaunchedSession>
  ): Promise<LaunchedSession>;
  protected abstract reopenWith(task: TaskRecord, text: string): boolean;
  protected abstract run(
    task: TaskRecord,
    options?: { anyway?: boolean; admitted?: boolean; pastAgentLimit?: boolean }
  ): Promise<void>;
  protected abstract startAgain(task: TaskRecord): boolean;
  protected abstract startInWorktree(task: TaskRecord, text: string): boolean;
  protected abstract dropDoneWorktree(task: TaskRecord, sessionStopped?: boolean): Promise<void>;
  protected abstract finish(
    task: TaskRecord,
    options?: { exited?: boolean; reported?: boolean }
  ): Promise<void>;
  protected abstract noteStartDirty(task: TaskRecord): Promise<void>;
  protected abstract autoFixLeft(task: TaskRecord, reason: TaskAutoFixReason): boolean;
  protected abstract fixesOnItsOwn(task: TaskRecord): boolean;
  protected abstract freshConflict(task: TaskRecord, blocker: TaskBlocker | undefined): boolean;
  protected abstract gaveUp(task: TaskRecord): string;
  protected abstract startAutoFix(task: TaskRecord, reason: TaskAutoFixReason): Promise<boolean>;
  protected abstract finishSweep(task: TaskRecord, options: { exited?: boolean }): Promise<void>;
  protected abstract mergesOnItsOwn(task: TaskRecord): boolean;
  protected abstract pipe(
    task: TaskRecord,
    mode: PipelineMode,
    merge?: MergeOptions,
    readyNote?: TaskBlocker,
    resumeMove?: boolean
  ): Promise<void>;
  protected abstract runRevert(task: TaskRecord): Promise<boolean>;
  protected abstract waitsForBase(task: TaskRecord): boolean;
  protected abstract arm(): void;
  abstract discard(id: string, options?: { confirm?: boolean }): Promise<TaskActionResult>;
  abstract retry(id: string, options?: { agent?: string }): Promise<TaskActionResult>;

  constructor(protected deps: TaskSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.worktrees = deps.worktrees ?? gitTaskWorktrees;
    this.signals = deps.signals ?? new SignalLedger((message) => deps.onError?.(message), this.now);
  }

  /** Where the scheduler's decisions about agents came from, so far (agent-events.ts). */
  signalCounts(): ReturnType<SignalLedger['snapshot']> {
    return this.signals.snapshot();
  }

  protected decided(
    decision: AgentDecision,
    source: SignalSource,
    task: TaskRecord,
    why?: string
  ): void {
    this.signals.record(
      decision,
      source,
      task.sessionId,
      why ? `task ${task.id}, ${why}` : `task ${task.id}`
    );
  }

  /** The agent's state from its own events (Claude's hooks, Codex's rollout), if any. */
  protected events(task: TaskRecord): AgentSnapshot | undefined {
    if (!task.sessionId) return undefined;
    try {
      return this.deps.agentState?.(task.sessionId);
    } catch (error) {
      this.deps.onError?.(`Task ${task.id}: its agent's events could not be read`, error);
      return undefined;
    }
  }

  /**
   * Whether the task's agent did something since `since` (a check's start): its events first
   * (a tool call or result, a turn start, a command still running), else whether its session
   * printed meanwhile (a phone redrawing it prints too: 94aef32c's false "still editing").
   */
  protected agentActedSince(task: TaskRecord, since: number): boolean {
    const events = this.events(task);
    if (events) {
      this.decided('agent-active', 'events', task);
      return events.toolsOpen > 0 || (events.lastActionAt ?? Number.NEGATIVE_INFINITY) >= since;
    }
    this.decided('agent-active', 'output', task, 'no events of its agent');
    const at = task.sessionId ? this.deps.lastOutputAt?.(task.sessionId) : undefined;
    return at !== undefined && at >= since;
  }

  /** The agent's whole last reply: its last event's message, else its transcript. */
  protected async reportOf(sessionId: string, task?: TaskRecord): Promise<string | undefined> {
    const events = task ? this.events(task) : undefined;
    if (events?.finalMessage && (events.state === 'turn-ended' || events.state === 'starting')) {
      return events.finalMessage;
    }
    return this.deps.finalReply?.(sessionId).catch(() => undefined);
  }

  /** Resolves once the background work started so far (setup, pipelines) is done. */
  async settled(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled(this.jobs);
  }

  /** The settings of a task's project, found the way its slot is (projectOf). */
  protected async settingsOf(task: TaskRecord): Promise<ProjectSettings | undefined> {
    const repo = await this.projectOf(task).catch(() => undefined);
    return repo ? this.deps.settings?.get(repo) : undefined;
  }

  /** Records a phase of `task` from `started` to now (TaskRecord.timings). */
  protected stamp(
    task: TaskRecord,
    phase: TaskPhaseTiming['phase'],
    started: number,
    outcome?: string
  ) {
    task.timings = withTimings(task.timings, [
      {
        phase,
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(this.now()).toISOString(),
        round: currentRound(task.timings),
        ...(outcome ? { outcome } : {}),
      },
    ]);
  }

  /** The agent's open fix or conflict round (TaskRecord.timings) ends now. */
  protected endAgentPhase(task: TaskRecord): void {
    const at = new Date(this.now()).toISOString();
    for (const timing of task.timings ?? []) {
      if (!timing.finishedAt && (timing.phase === 'fix' || timing.phase === 'conflict')) {
        timing.finishedAt = at;
      }
    }
  }

  /**
   * The push for where a task just ended up (when it wants pushes). `quiet`: only for its
   * orchestrator, never the phone (an auto-fix under way, a review being retried, a task that
   * wants no pushes). `body` replaces what the push says.
   */
  protected notifyState(
    task: TaskRecord,
    detail: string,
    options: { quiet?: boolean; body?: string; notice?: string; reminder?: string } = {}
  ): void {
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    // 2026-10-20: a task with pushes off returned here before its orchestrator heard anything.
    if (!task.notify && !toOrchestrator) return;
    const blocker = task.blocker;
    // While Untether fixes it by itself, the steps on the way are no news for the user.
    const fixing = !!task.autoFix && !!autoFixReasonOf(blocker);
    const quiet = options.quiet || fixing || !task.notify;
    if (quiet && !toOrchestrator) return;
    // The same outcome of the same commit again is not news, however it is worded (2026-10-20:
    // a redraw re-ran the pipeline and pushed it again with another detail). A new turn of the
    // agent (setState → working) clears it; `notice` tells distinct notices apart.
    const key = JSON.stringify([
      task.state,
      blocker?.kind,
      task.headSha ?? task.verify?.headSha ?? task.stats?.commits ?? null,
      quiet,
      options.notice ?? '',
    ]);
    if (task.pushed === key) return;
    task.pushed = key;
    const say = (type: Parameters<TaskSchedulerCore['taskPayload']>[1], text: string) => {
      const body = options.body || text;
      const payload = this.taskPayload(
        task,
        type,
        options.reminder ? [options.reminder, body].filter(Boolean).join(' · ') : body
      );
      if (quiet) payload.data = { ...payload.data, quiet: true };
      // Its orchestrator's event says it is a reminder (orchestrator.ts routeTaskPush).
      if (options.reminder) payload.data = { ...payload.data, reminder: options.reminder };
      this.post(payload);
    };
    switch (task.state) {
      case 'merged':
        say(
          'task-merged',
          task.review?.verdict === 'unavailable'
            ? [detail, 'AI review unavailable'].filter(Boolean).join(' · ')
            : detail
        );
        break;
      case 'done':
        say('task-done', detail);
        break;
      case 'ready':
        say('task-ready', blocker?.message || this.pausedNote(task) || detail);
        break;
      case 'needs_you':
        say('task-needs-you', blocker?.message || detail);
        break;
      case 'failed':
        say('task-failed', blocker?.message || detail);
        break;
      case 'paused':
        say('task-paused', blocker?.message || detail);
        break;
      case 'scheduled':
        // Held for its agent's usage limit (holdForAgent).
        if (task.heldFor) say('task-paused', detail);
        break;
      case 'working':
        // An auto-fix handed over: its orchestrator hears that it is being fixed.
        if (task.autoFix && quiet) say('task-failed', blocker?.message || detail);
        break;
    }
  }

  /**
   * The check waits for disk, or failed while the disk was low (2026-11-01: ~1 GB free, a
   * bakery task relaunched by hand): its orchestrator, and the phone when the task wants
   * pushes, hear the cause once per episode; the task is not the one at fault. The episode is
   * on the task (diskNoticed) until a check runs with room: 2026-11-02, compared with the last
   * check only, each restart and each rerun of the pipeline told the same wait again.
   */
  protected noticeDisk(task: TaskRecord, now: TaskVerify): void {
    if (!now.diskLow && !now.waitingDisk) {
      // Running (or done) with room: the episode is over.
      if (!now.queued && task.diskNoticed) delete task.diskNoticed;
      return;
    }
    const failedNow = !!now.diskLow && task.diskNoticed !== 'failed';
    const waitsNow = !!now.waitingDisk && !now.diskLow && !task.diskNoticed;
    if (!failedNow && !waitsNow) return;
    task.diskNoticed = failedNow ? 'failed' : 'waiting';
    const gb = (bytes?: number) => `${((bytes ?? 0) / 1024 / 1024 / 1024).toFixed(1)} GB`;
    const where = (spot?: { path?: string; freeBytes?: number }) =>
      spot?.path ? ` (${gb(spot.freeBytes)} free on ${spot.path})` : '';
    const text = failedNow
      ? `The check failed while the disk was low${now.diskLow?.enospc && !now.diskLow.path ? ' (the output says the disk was full)' : where(now.diskLow)}: not the task's fault. It runs again by itself once there is room; free disk space to speed it up.`
      : `The check waits for disk space${where(now.waitingDisk)}: it starts by itself once there is room; free disk space to speed it up.`;
    this.deps.onError?.(`Task ${task.id}: ${text}`);
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    if (!task.notify && !toOrchestrator) return;
    const payload = this.taskPayload(task, 'task-paused', text);
    if (!task.notify) payload.data = { ...payload.data, quiet: true };
    this.post(payload);
  }

  /** "Auto-merge is paused …" for a ready task of a project whose auto-merge is paused. */
  protected pausedNote(task: TaskRecord): string {
    if (!task.repoPath || !this.mergesOnItsOwn(task)) return '';
    const settings = this.deps.settings?.get(task.repoPath);
    if (!settings || !autoMergePaused(settings, this.now())) return '';
    return `Not merged on its own: auto-merge is paused for this project (${settings.autoMergePausedReason ?? 'too many problems lately'})`;
  }

  protected track(job: Promise<unknown>): void {
    const tracked = job.catch((error) => this.deps.onError?.('task job failed', error));
    this.jobs.add(tracked);
    void tracked.finally(() => this.jobs.delete(tracked));
  }

  protected setState(task: TaskRecord, state: TaskState, blocker?: TaskBlocker): void {
    const before = task.state;
    const beforeReason = task.blocker?.kind;
    // The time up to now counts as what it was doing until now (budgets).
    if (budgeted(task) && !isFinal(task)) this.countTime(task, this.now());
    if (budgeted(task) && state === 'working' && this.newRound(task, before)) {
      this.budgetOf(task).spent.rounds += 1;
    }
    task.state = state;
    // Off «te necesita»: a push about it still held back would announce something over.
    if (before === 'needs_you' && state !== 'needs_you') {
      this.deps.withdrawPush?.(
        (push) => push.type === 'task-needs-you' && push.data?.taskId === task.id
      );
    }
    // Every path to a final state ends the agent's session (2026-10-24: closeAsDone did not),
    // and the agent's fix round it was in, if any (its time stops counting).
    if (TASK_FINAL_STATES.includes(state)) {
      // What is kept per task while it runs is dropped on every way to a final state
      // (2026-11-11: only a merge, a discard and a removal did; a task closed as done, missed
      // or dropped from the history left its entries for as long as the server ran).
      if (!TASK_FINAL_STATES.includes(before)) this.forget(task.id);
      this.armFinishedStop(task);
      this.endAgentPhase(task);
      // What still waited to be typed into its agent never will be: the senders are told, on
      // every way to a final state (2026-11-10: only an attempt in flight told them, so a
      // message to a task then merged, discarded or closed stayed "queued" for good).
      if (task.pendingInput?.length) {
        for (const message of task.pendingInput) {
          if (message.messageId)
            this.deps.messageDropped?.(message.messageId, `the task is ${state}`);
        }
      }
      delete task.pendingInput;
      delete task.pendingWhy;
      delete task.pendingNoticed;
      delete task.pendingSince;
    } else this.cancelFinishedStop(task.id);
    // A countdown to merging holds only while the task stays ready as it was checked.
    if (state !== 'ready') {
      delete task.autoMergeAt;
      if (task.autoApprovedMerge) task.autoApprovedMerge.done = true;
    }
    task.stateSince = new Date(this.now()).toISOString();
    if (blocker) task.blocker = blocker;
    else delete task.blocker;
    if (state !== 'queued') delete task.queued;
    if (before !== state || beforeReason !== blocker?.kind) {
      this.recordTaskEvent(task, before, blocker);
    }
    // A task leaving a slot (or a queued one discarded) may let the next one in line start.
    if (before !== state) this.requestPump();
    // 2026-10-20: "fixing itself" stayed on a task that had moved to another blocker (a
    // permission prompt, a question) or whose session had ended, so the phone kept showing it
    // and its pushes stayed quiet. It holds only while that same blocker is being fixed.
    if (
      task.autoFix &&
      !TASK_BUSY_STATES.includes(state) &&
      state !== 'working' &&
      // Paused, its fix round goes on when the agent does (2026-11-01).
      state !== 'paused' &&
      autoFixReasonOf(blocker) !== task.autoFix.reason
    ) {
      delete task.autoFix;
    }
    if (state === 'working' && before !== 'working') {
      // A new turn of the agent: what it ends with is news again (pushes dedupe on outcome).
      delete task.pushed;
      // New work: a wait for the base starts over when it is merged again.
      delete task.baseWait;
    }
    // A halt holds while the agent is paused or sent on; any other end closes the streak.
    if (state !== 'paused' && state !== 'working') delete task.halt;
    if (state === 'ready' || state === 'failed' || state === 'needs_you' || state === 'paused') {
      this.settledPreview.set(
        task.id,
        task.sessionId ? this.previews.get(task.sessionId) : undefined
      );
    }
  }

  /** A task's state for the event log: ids, state and why, never its prompt or title. */
  protected recordTaskEvent(task: TaskRecord, from?: TaskState, blocker?: TaskBlocker): void {
    this.deps.recordEvent?.({
      type: 'task.state',
      taskId: task.id,
      project: task.repoPath,
      dir: task.workingDir,
      branch: task.branch,
      agent: task.agent,
      sessionId: task.sessionId,
      state: task.state,
      from,
      reason: blocker?.kind,
      message: blocker?.message,
    });
  }

  protected fail(
    task: TaskRecord,
    kind: TaskBlockerKind,
    message: string,
    detail?: string[]
  ): void {
    this.setState(task, 'failed', { kind, message, ...(detail?.length ? { detail } : {}) });
    task.error = message;
    task.finishedAt = new Date(this.now()).toISOString();
  }

  /**
   * Drops what is kept per task in memory: on a final state (setState), when it is removed
   * and when it leaves the history (save). Every map or set keyed by task id belongs here or
   * in an override (task-scheduler-forget.test.ts holds the list against the class).
   */
  protected forget(taskId: string): void {
    this.cancelHold(taskId);
    for (const timers of [this.inputTimers, this.setupTimers]) {
      const timer = timers.get(taskId);
      if (timer) clearTimeout(timer);
      timers.delete(taskId);
    }
    this.guardStamps.delete(taskId);
    this.settledPreview.delete(taskId);
    this.probing.delete(taskId);
    this.inputStalls.delete(taskId);
    this.seenBusy.delete(taskId);
    this.waitingOnPrompt.delete(taskId);
    this.promptReads.delete(taskId);
    this.promptTold.delete(taskId);
    this.lastReply.delete(taskId);
    this.lastSent.delete(taskId);
    this.briefPending.delete(taskId);
    this.codexProbedAt.delete(taskId);
    this.taskProject.delete(taskId);
    this.tokensReadAt.delete(taskId);
    this.deps.forgetAgentUsage?.(taskId);
  }

  protected copy(task: TaskRecord): TaskRecord {
    const out = structuredClone(task);
    if (out.state === 'queued' && out.queued) Object.assign(out.queued, this.queuePlace(task));
    return out;
  }

  /** task-ready / task-needs-you / task-failed / task-merged / task-done, localized by the phone. */
  protected taskPayload(task: TaskRecord, type: TaskPushType, text: string): NotificationPayload {
    const review = type === 'task-needs-you' && task.blocker?.kind === 'review';
    const riskSaid =
      type === 'task-needs-you' && task.blocker?.kind === 'risk' ? riskReviewSaid(task) : undefined;
    const detail = riskSaid ? `${text} · ${riskSaid}` : text;
    const baseWait =
      type === 'task-ready' && task.blocker?.kind === 'dirty-base' ? task.baseWait : undefined;
    const titles = {
      'task-ready': baseWait ? `⏳ Waiting to merge: ${task.name}` : `✅ Task ready: ${task.name}`,
      'task-needs-you': review ? `🔎 Review: ${task.name}` : `⏳ Task needs you: ${task.name}`,
      'task-failed': `❌ Task failed: ${task.name}`,
      'task-merged': `✅ Task merged: ${task.name}`,
      'task-done': `✅ Task done: ${task.name}`,
      'task-paused': `⏸ Task paused: ${task.name}`,
      'task-queued': `🕒 Task queued: ${task.name}`,
      'task-started': `▶️ Task started: ${task.name}`,
      'task-agent-changed': `🔀 Other agent: ${task.name}`,
      'task-budget': `💸 Task near its budget: ${task.name}`,
      'task-stalled': `🐢 Task stalled: ${task.name}`,
      'task-looping': `🔁 Task stuck in a loop: ${task.name}`,
    } as const;
    const fallback = {
      'task-ready': 'Open it to see the result',
      'task-needs-you': 'Open it to answer',
      'task-failed': 'Open it to see why',
      'task-merged': `In ${task.baseBranch ?? 'its base branch'}`,
      'task-done': 'Open it to see the result',
      'task-paused': 'Untether sends it on by itself',
      'task-queued': 'It starts by itself when a slot frees up',
      'task-started': 'A slot of its project freed up',
      'task-agent-changed': 'It goes on with another agent',
      'task-budget': 'Open it to see what it spent',
      'task-stalled': 'No progress: its agent waits on something',
      'task-looping': 'Its agent keeps failing the same way',
    } as const;
    return {
      type,
      title: titles[type],
      body: detail.slice(0, 200) || fallback[type],
      icon: '/apple-touch-icon.png',
      badge: '/favicon-32.png',
      tag: `untether-task-${task.id}`,
      ...(type === 'task-needs-you' ? { requireInteraction: true } : {}),
      actions: [
        { action: 'view-session', title: 'Open' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
      data: {
        type,
        sessionId: task.sessionId,
        taskId: task.id,
        where: task.name,
        // A budget warning carries where the time went and a suggestion: its orchestrator reads it.
        detail: detail.slice(
          0,
          type === 'task-budget' ||
            type === 'task-stalled' ||
            type === 'task-looping' ||
            // What it waits for and what can be decided: its orchestrator reads it whole.
            (type === 'task-queued' && !!task.queued?.waitsFor?.length)
            ? 1000
            : 200
        ),
        ...(task.blocker ? { blocker: task.blocker.kind } : {}),
        ...(task.autoFix
          ? {
              autoFix: {
                attempts: task.autoFix.attempts,
                max: task.autoFix.max,
                reason: task.autoFix.reason,
              },
            }
          : {}),
        ...(task.reviewRetryAt ? { reviewRetryAt: task.reviewRetryAt } : {}),
        ...(type === 'task-paused' && task.halt?.nextTryAt
          ? { resumeAt: task.halt.nextTryAt }
          : {}),
        ...(type === 'task-paused' && task.heldFor ? { resumeAt: task.heldFor.until } : {}),
        ...(type === 'task-queued' && task.queued
          ? (({ position, of, active, limit, resources, waitsFor }) => ({
              position,
              of,
              active,
              limit,
              ...(resources?.short.length && !resources.paced
                ? { waitingFor: resources.short }
                : {}),
              // Started after other tasks (--after, its zone): which, and whether one of them
              // stopped (then it does not start by itself: a decision is asked for).
              ...(waitsFor?.length
                ? {
                    waitsOn: waitsFor.map((wait) => wait.taskId.slice(0, 8)),
                    ...(waitsFor.some((wait) => wait.stopped) ? { waitStopped: true } : {}),
                  }
                : {}),
            }))({
              ...task.queued,
              ...this.queuePlace(task),
            })
          : {}),
        ...(baseWait ? { baseWaitSince: baseWait.since, base: task.baseBranch } : {}),
        ...(task.autoMergeAt && type === 'task-ready'
          ? {
              autoMergeAt: task.autoMergeAt,
              headline: task.security?.headline ?? '',
              // A risky task's countdown: what merges and the files flagged (2026-10-24).
              ...(task.security
                ? {}
                : task.risk?.length
                  ? { headline: task.name, riskFiles: riskFilesOf(task) }
                  : { headline: task.name }),
              // Counting down because the user's autoApprove gave the merge OK.
              ...(task.autoApprovedMerge && !task.autoApprovedMerge.done
                ? { autoApproved: true }
                : {}),
            }
          : {}),
        // A risky task the second review did not confirm: what it said (Spanish), or that it
        // could not run.
        ...(riskSaid && task.riskReview
          ? {
              riskReview: task.riskReview.verdict,
              ...(task.riskReview.verdict === 'dismissed' && task.riskReview.reason
                ? { riskReason: task.riskReview.reason }
                : {}),
            }
          : {}),
        ...(type === 'task-merged' && task.baseBranch ? { branch: task.baseBranch } : {}),
        ...(type === 'task-merged' && task.review?.verdict === 'unavailable'
          ? { review: 'unavailable' }
          : {}),
        timestamp: new Date(this.now()).toISOString(),
      },
    };
  }

  protected missedPayload(task: TaskRecord): NotificationPayload {
    const type = 'task-missed';
    return {
      type,
      title: `⚠️ Task not run: ${task.name}`,
      body: 'The server was off at its time',
      icon: '/apple-touch-icon.png',
      badge: '/favicon-32.png',
      tag: `untether-task-${task.id}`,
      actions: [{ action: 'dismiss', title: 'Dismiss' }],
      data: {
        type,
        taskId: task.id,
        where: task.name,
        detail: '',
        timestamp: new Date(this.now()).toISOString(),
      },
    };
  }

  /** The settings of the project a worktree task is in (none without a settings store). */
  protected async projectSettings(task: TaskRecord): Promise<ProjectSettings | undefined> {
    if (!this.deps.settings) return undefined;
    const repo = await resolveMainRepo(task.repoPath ?? task.workingDir).catch(() => null);
    return repo ? this.deps.settings.get(repo) : undefined;
  }

  protected load(): TaskRecord[] {
    this.outbox = [];
    let text: string;
    try {
      text = fs.readFileSync(this.deps.storePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      this.deps.onError?.('could not read saved tasks', error);
      this.putAside('unreadable');
      return [];
    }
    let data: { version?: unknown; tasks?: unknown; outbox?: unknown };
    try {
      data = JSON.parse(text);
    } catch (error) {
      this.deps.onError?.('saved tasks are not valid JSON', error);
      this.putAside('not valid JSON');
      return [];
    }
    // No compatibility: another version's file (or a broken record) is dropped, kept aside.
    if (data?.version !== STORE_VERSION || !Array.isArray(data.tasks)) {
      this.putAside(`version ${String(data?.version)}`);
      return [];
    }
    if (Array.isArray(data.outbox)) {
      this.outbox = (data.outbox as OutboxEntry[]).filter(
        (entry) => typeof entry?.id === 'string' && typeof entry.payload?.type === 'string'
      );
    }
    return (data.tasks as TaskRecord[]).filter(validRecord);
  }

  /**
   * A tasks.json that can't be used is copied to tasks.json.corrupt-<time> before anything is
   * saved over it; when even that fails, nothing is saved (2026-10-20: it was overwritten).
   */
  protected putAside(why: string): void {
    const aside = `${this.deps.storePath}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.copyFileSync(this.deps.storePath, aside, fs.constants.COPYFILE_EXCL);
      this.deps.onError?.(`saved tasks (${why}) kept as ${aside}`);
    } catch (error) {
      this.saveBlocked = true;
      this.deps.onError?.(
        `saved tasks (${why}) could not be kept aside: not saving over ${this.deps.storePath}`,
        error
      );
    }
  }

  /**
   * What the command guard blocked for the task (its log, task-guard-setup.ts) into its record:
   * the count and the latest GUARD_BLOCKS_KEPT. Read only when the log changed.
   */
  syncGuardBlocks(task: TaskRecord): void {
    const log = this.deps.guardLog;
    if (!log) return;
    const stamp = log.stamp(task.id);
    if (!stamp || this.guardStamps.get(task.id) === stamp) return;
    this.guardStamps.set(task.id, stamp);
    const entries = log.read(task.id);
    const before = (task.guardBlocks?.count ?? 0) + (task.guardBlocks?.noted ?? 0);
    if (!entries.length || entries.length === before) return;
    const noted = entries.filter((entry) => guardLetThrough(entry.rule)).length;
    task.guardBlocks = {
      count: entries.length - noted,
      ...(noted ? { noted } : {}),
      recent: entries.slice(-GUARD_BLOCKS_KEPT),
    };
    for (const entry of entries.slice(before)) {
      this.deps.onError?.(`Task ${task.id}: guard ${entry.rule} on ${entry.tool}: ${entry.what}`);
    }
    this.save();
  }

  /**
   * A push: written to tasks.json together with the state that caused it (the outbox), then
   * sent, then dropped from the file (save). Killed in between, the next start sends it: a
   * push is never lost with the state it was about.
   *
   * The guarantee is AT LEAST ONCE, deduplicated by the entry's id at the receivers: a kill
   * (SIGKILL, a crash) after the send and before the write sends the same entry again, and no
   * outside send can be exactly once. So each entry carries its id (outboxPayload): the phone
   * shows it under the tag `untether-push-<id>` (the system replaces a notification with the
   * same tag instead of showing two) and the orchestrator ignores an id it already took
   * (orchestrator.ts routeTaskPush). A rerun never makes a second entry for one outcome
   * (notifyState keys each on its outcome, TaskRecord.pushed).
   */
  protected post(payload: NotificationPayload): void {
    this.outbox.push({ id: randomUUID(), at: new Date(this.now()).toISOString(), payload });
    this.save();
  }

  /** Send the pushes written so far; the file is written again without them. */
  protected sendOutbox(): void {
    if (this.sending || !this.outbox.length) return;
    this.sending = true;
    try {
      // 2026-11-01 review: a push whose sending threw was dropped all the same. It stays and
      // goes again with the next save, PUSH_SEND_TRIES times in all, then it is given up (said).
      const failed: OutboxEntry[] = [];
      while (this.outbox.length) {
        const entry = this.outbox.shift() as OutboxEntry;
        try {
          this.deps.notify(outboxPayload(entry));
        } catch (error) {
          const tries = (entry.tries ?? 0) + 1;
          if (tries < PUSH_SEND_TRIES) failed.push({ ...entry, tries });
          this.deps.onError?.(
            `could not send a task push (${entry.payload.type}, try ${tries}/${PUSH_SEND_TRIES}${tries < PUSH_SEND_TRIES ? '' : ', given up'})`,
            error
          );
        }
      }
      this.outbox = [...failed, ...this.outbox];
      this.write();
    } finally {
      this.sending = false;
    }
  }

  /**
   * Write tasks.json, then send the pushes it holds. False when it could not be written: a
   * step about to be taken (a session, a base move) is then not taken, since a restart could
   * not know of it. Pushes go anyway: a push without its journal is the push as it was before
   * it, a lost one is worse.
   */
  protected save(): boolean {
    // Quality signals first seen now, finished tasks into their project's ledger (metrics).
    try {
      this.observeMetrics();
    } catch (error) {
      this.deps.onError?.('task metrics', error);
    }
    // Nothing can be written: the pushes go anyway (only their journal is missing).
    if (this.saveBlocked) {
      this.sendOutbox();
      return false;
    }
    // Keep every task with something left to do or clean up, and only the latest settled.
    const settled = this.tasks.filter(isSettled);
    if (settled.length > HISTORY_LIMIT) {
      const drop = new Set(
        settled
          .sort((a, b) => Date.parse(a.finishedAt ?? a.runAt) - Date.parse(b.finishedAt ?? b.runAt))
          .slice(0, settled.length - HISTORY_LIMIT)
          .map((task) => task.id)
      );
      this.tasks = this.tasks.filter((task) => !drop.has(task.id));
      // Out of the history: nothing of it is kept in memory either.
      for (const id of drop) this.forget(id);
    }
    const written = this.write();
    this.sendOutbox();
    return written;
  }

  /**
   * tasks.json, whole: tasks (with the steps they have under way, TaskRecord.effects) and the
   * pushes not sent yet, in one atomic write (tmp + rename): the journal's transaction.
   */
  protected write(): boolean {
    // Never over a tasks.json that could not be read nor kept aside (putAside).
    if (this.saveBlocked) return false;
    try {
      fs.mkdirSync(path.dirname(this.deps.storePath), { recursive: true });
      const tmp = `${this.deps.storePath}.${process.pid}.tmp`;
      const data = {
        version: STORE_VERSION,
        tasks: this.tasks,
        ...(this.outbox.length ? { outbox: this.outbox } : {}),
      };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, this.deps.storePath);
      return true;
    } catch (error) {
      this.deps.onError?.('could not save tasks', error);
      return false;
    }
  }
}
