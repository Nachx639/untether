/**
 * The commands: start and stop, the timer, creating tasks and what the user and the agent do with
 * them (send, retry, fix, merge, discard, revert, moves).
 * One layer of TaskScheduler (task-scheduler.ts).
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { agentPush } from '../../shared/agent-push.js';
import {
  bumpMergesOnItsOwn,
  fixMergesOnItsOwn,
  riskMergesOnItsOwn,
  securityMergeHeld,
} from '../../shared/security.js';
import { endEffect, pendingEffect } from '../../shared/task-effects.js';
import { TASK_AFTER_MAX, TASK_ZONES_MAX, WAIT_OVER_STATES } from '../../shared/task-serial.js';
import {
  TASK_LATE_GRACE_MS,
  TASK_NAME_MAX,
  TASK_QUESTION_MAX,
  type TaskBlockerKind,
  type TaskFollowUp,
  type TaskIsolation,
  type TaskPipelineRun,
  type TaskRecord,
} from '../../shared/tasks.js';
import { every, loopStep } from '../utils/periodic-loop.js';
import type { ClaudeStatus } from './claude-chat.js';
import { BACKGROUND } from './claude-status-notifier.js';
import { mergeQueue, mergeQueueKey } from './merge-queue.js';
import { mergeTrainsFor } from './merge-train.js';
import { normalizeRepoPath } from './project-settings.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { SessionReplacementFollower } from './session-replacements.js';
import { TaskSchedulerPipeline } from './task-scheduler-pipeline.js';
import { fixPrompt } from './task-scheduler-prompts.js';
import {
  budgeted,
  FIXABLE,
  followsReopenedSessions,
  isFinal,
  isSettled,
  MAX_TIMER_MS,
  mergeOkOf,
  RESTART_IDLE_AFTER_MS,
  runnerOf,
  SESSION_STATES,
  TASK_RETRY_TEXT,
} from './task-scheduler-rules.js';
import {
  type MergeOptions,
  type NewTask,
  repairWorktree,
  type TaskActionResult,
  type TaskLiveState,
  type TaskLogKind,
} from './task-scheduler-types.js';
import { commitsAhead, undoMergeCommand } from './task-worktree.js';

/** After a timer step that threw (2026-11-11): the scheduler's timer is armed again this late. */
const FIRE_AGAIN_AFTER_FAILURE_MS = 30_000;

export abstract class TaskSchedulerCommands extends TaskSchedulerPipeline {
  /** Load the saved tasks, run or mark the overdue ones, and arm the timer. */
  async start(exitCheckMs = 5000): Promise<void> {
    this.tasks = this.load();
    const now = this.now();
    this.startedAt = now;
    // The time the server was down is not counted against anyone's budget.
    for (const task of this.tasks) if (task.budget) delete task.budget.countedAt;
    // The steps a restart cut short (task journal, shared/task-effects.ts) are taken up first.
    // Pushes written with their state and not sent: sent now.
    this.sendOutbox();
    // Sessions being made: the one that runs is adopted, never started twice.
    this.recoverSessions();
    // Cut while they were starting, to start over once the rest is taken up.
    const startOver = new Set<TaskRecord>();
    for (const task of this.tasks) {
      // The server stopped while one was starting: its worktree may be half made (its
      // worktree step), or its session was never made (recoverSessions found none running).
      if (task.state === 'preparing' || (task.state === 'working' && !task.sessionId)) {
        if (this.cutWhileStarting(task)) startOver.add(task);
      }
      // A half-made worktree (this restart's, or one whose removal an earlier one cut short),
      // or a whole one a cut task made and never used (cutWhileStarting).
      this.dropPendingWorktree(task);
      // Starting over when an earlier restart cut it again, still scheduled (waiting for its
      // project or its agent): startCuts on disk says so, and its old runAt does not make it
      // missed (2026-11-02 review).
      if (task.state === 'scheduled' && task.startCuts) startOver.add(task);
    }
    this.sweepFinishedPlainTasks(now);
    this.save();
    // Finished before the restart, their stop still to come: armed again (the doctor is later).
    for (const task of this.tasks) {
      // Its busy limit counts from when it finished, not from this restart (2026-11-02).
      if (this.finishedSessionToStop(task)) {
        const finished = Date.parse(task.finishedAt ?? '');
        this.armFinishedStop(task, Number.isFinite(finished) ? Math.min(finished, now) : now);
      }
      // A worktree a restart cut off before it went (its session already gone).
      else this.track(this.dropDoneWorktree(task));
    }
    // A failed setup's automatic retry still to come (setupRetryAt): armed again.
    for (const task of this.tasks) {
      if (task.state === 'failed' && task.blocker?.kind === 'setup') this.armSetupRetry(task);
      else delete task.setupRetryAt;
    }
    // Messages that were never typed (the server stopped first) are tried again.
    for (const task of this.tasks) {
      if (task.pendingInput?.length && !isFinal(task)) this.track(this.pumpInput(task));
    }
    // The exit check starts first: the restart window (RESTART_WINDOW_MS) runs from now, and
    // 2026-10-20 overdue tasks used to be awaited here first, so a slow worktree setup ate the
    // window and the tasks the restart had cut off were never resumed.
    if (exitCheckMs > 0 && !this.exitTimer) {
      this.exitTimer = every('task scheduler exit check', () => this.checkExited(), exitCheckMs);
      this.exitTimer.unref?.();
    }
    // Interrupted mid-check or mid-merge (its pipeline step, whatever state it had got to show):
    // the pipeline runs again (it is idempotent), the way it was asked to run. With no step
    // recorded (a restart between the
    // state and the run), one that was merging had been cleared to merge; one checking is only
    // checked again, never merged on its own. One whose base move was recorded only has its
    // merge finished when the base holds it: cleanup, "merged" and its push, once.
    for (const task of this.tasks) {
      // Waiting out its backoff after an error of Untether's own (internalRetryAt): its time
      // is kept, arm() runs it then. 2026-11-02: a restart ran it at once, the backoff lost
      // and both retries spent within seconds.
      if (this.waitsForInternalRetry(task) && Date.parse(task.internalRetryAt as string) > now) {
        continue;
      }
      const recorded = !!pendingEffect(task, 'pipeline') && !isFinal(task);
      if (task.state === 'verifying' || task.state === 'merging' || recorded) {
        const asked = pendingEffect(task, 'pipeline')?.run;
        const mode = asked?.mode ?? (task.state === 'merging' ? 'merge' : 'verify');
        const { readyNote, mode: _mode, ...merge } = asked ?? { mode };
        const moving = !!pendingEffect(task, 'base');
        this.track(this.pipe(task, mode, merge, readyNote, moving));
      } else {
        // Ended while it ran (discarded, merged): nothing of it is left to take up.
        endEffect(task, 'pipeline');
        endEffect(task, 'base');
      }
    }
    const overdue = this.tasks.filter(
      (task) => task.state === 'scheduled' && Date.parse(task.runAt) <= now && !startOver.has(task)
    );
    for (const task of overdue) {
      if (now - Date.parse(task.runAt) <= TASK_LATE_GRACE_MS) {
        // Marked working / preparing before its first await, so arm() below skips it.
        this.track(this.run(task));
      } else {
        this.setState(task, 'missed');
        task.finishedAt = new Date(now).toISOString();
        // Saved with the push (post).
        this.post(this.missedPayload(task));
      }
    }
    // Started again the way they were first: its agent's limit, its project's slots, the
    // Mac's room (run → waitsForSlot). Never late: they were started on time.
    for (const task of startOver) this.track(this.run(task));
    this.arm();
    // Queued before the restart: they start as slots free up (or now, if there are some).
    this.requestPump();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.exitTimer) clearInterval(this.exitTimer);
    for (const hold of this.holds.values()) clearTimeout(hold);
    this.holds.clear();
    for (const timer of [
      ...this.inputTimers.values(),
      ...this.setupTimers.values(),
      ...this.finishedTimers.values(),
    ]) {
      clearTimeout(timer);
    }
    this.inputTimers.clear();
    this.setupTimers.clear();
    this.finishedTimers.clear();
    this.timer = null;
    this.exitTimer = null;
  }

  list(): TaskRecord[] {
    return this.tasks.map((task) => this.copy(task));
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.find((entry) => entry.id === id);
    return task ? this.copy(task) : undefined;
  }

  /**
   * Add a task; one due now runs right away (the result carries its sessionId). A worktree
   * task comes back `preparing`: its worktree is made in the background.
   */
  async create(input: NewTask): Promise<TaskRecord> {
    const [task] = await this.createGroup(input, 1);
    return task;
  }

  /**
   * Add `count` tasks with the same prompt, each in its own worktree (ut/<slug>-a, -b…), to
   * compare and keep one: a group never merges on its own. One task is a plain create.
   */
  async createGroup(input: NewTask, count: number): Promise<TaskRecord[]> {
    const now = this.now();
    const runAt = input.runAt && input.runAt.getTime() > now ? input.runAt : new Date(now);
    const due = runAt.getTime() <= now;
    const groupId = count > 1 ? randomUUID() : undefined;
    const isolation: TaskIsolation = count > 1 ? 'worktree' : (input.isolation ?? 'none');
    // Started after other tasks (shared/task-serial.ts): the ones named that still are to
    // merge or close, and its zones (named, and its project's rules on the paths it names).
    const after = [...new Set(input.after ?? [])]
      .filter((id) =>
        this.tasks.some((other) => other.id === id && !WAIT_OVER_STATES.includes(other.state))
      )
      .slice(0, TASK_AFTER_MAX);
    const zones = [
      ...new Set([
        ...(input.zones ?? []),
        ...(await this.projectZones(input.repoPath ?? input.workingDir, input.prompt)),
      ]),
    ].slice(0, TASK_ZONES_MAX);
    const created: TaskRecord[] = [];
    for (let index = 0; index < count; index++) {
      const task: TaskRecord = {
        id: randomUUID(),
        name: input.name,
        prompt: input.prompt,
        workingDir: input.workingDir,
        command: input.command,
        agent: input.agent,
        shielded: input.shielded,
        notify: input.notify,
        runAt: runAt.toISOString(),
        createdAt: new Date(now).toISOString(),
        state: 'scheduled',
        stateSince: new Date(now).toISOString(),
        isolation,
        origin: input.origin ?? (due ? 'user' : 'schedule'),
        followUps: [],
        files: [],
        ...(input.repoPath ? { repoPath: input.repoPath } : {}),
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(input.orchestratorSessionId
          ? { orchestratorSessionId: input.orchestratorSessionId }
          : {}),
        ...(input.createdBySessionId ? { createdBySessionId: input.createdBySessionId } : {}),
        ...(groupId ? { groupId, groupIndex: index, mergePolicy: 'ask' as const } : {}),
        ...(!groupId && input.mergePolicy ? { mergePolicy: input.mergePolicy } : {}),
        ...(input.revertOf ? { revertOf: input.revertOf } : {}),
        ...(input.security ? { security: input.security } : {}),
        ...(after.length ? { after } : {}),
        ...(zones.length ? { zones } : {}),
        ...this.chosenModel(input),
      };
      if (budgeted(task)) task.budget = this.budgetOf(task, input.budget);
      task.metrics = await this.newMetrics(task);
      this.tasks.push(task);
      created.push(task);
      this.recordTaskEvent(task);
    }
    this.save();
    if (due) {
      const plain = created.filter((task) => task.isolation !== 'worktree');
      for (const task of created) {
        if (task.isolation === 'worktree') this.track(this.run(task));
      }
      await Promise.all(plain.map((task) => this.run(task)));
    } else {
      this.arm();
    }
    return created.map((task) => this.copy(task));
  }

  /**
   * Change a task that has not run yet. Returns undefined when there is none to change.
   * `runAt: null` is "run now": it is due at once and starts as any due task does (its agent's
   * limit, its project's slots, the Mac's room).
   */
  update(
    id: string,
    patch: Partial<Omit<NewTask, 'runAt'>> & { runAt?: Date | null }
  ): TaskRecord | undefined {
    const task = this.tasks.find((entry) => entry.id === id && entry.state === 'scheduled');
    if (!task) return undefined;
    const { runAt, ...rest } = patch;
    Object.assign(task, rest);
    if (runAt) task.runAt = runAt.toISOString();
    else if (runAt === null) task.runAt = new Date(this.now()).toISOString();
    this.save();
    this.arm();
    return this.copy(task);
  }

  /**
   * Cancel a scheduled task, or drop one from the list. A worktree task still holding a
   * worktree or branch is not dropped ('active'): discard it.
   */
  remove(id: string): 'removed' | 'not-found' | 'active' {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return 'not-found';
    if (
      task.isolation === 'worktree' &&
      task.state !== 'scheduled' &&
      task.state !== 'queued' &&
      !isSettled(task)
    ) {
      return 'active';
    }
    this.tasks = this.tasks.filter((entry) => entry.id !== id);
    this.forget(id);
    this.save();
    this.arm();
    // A task that waited for it (--after, its zone) is looked at again.
    this.requestPump();
    return 'removed';
  }

  /**
   * The push for a task session: its plain "Claude finished" (or "Codex finished") is dropped
   * while the task is open, the task sends its own once it is done. Other pushes go out as
   * they are.
   */
  rewritePush(payload: NotificationPayload): NotificationPayload | null {
    if (agentPush(payload.type)?.kind !== 'finished') return payload;
    const sessionId = payload.data?.sessionId;
    if (typeof sessionId !== 'string') return payload;
    return this.tasks.some((entry) => entry.sessionId === sessionId) ? null : payload;
  }

  /** A status change of some session's Claude (ClaudeStatusNotifier.onTransition). */
  onClaudeTransition(
    sessionId: string,
    previous: string | undefined,
    status: string,
    claude: ClaudeStatus
  ): void {
    this.lastStatus.set(sessionId, status);
    const preview = claude.preview?.text ? `${claude.preview.role}:${claude.preview.text}` : '';
    const task = this.tasks.find(
      (entry) => entry.sessionId === sessionId && SESSION_STATES.includes(entry.state)
    );
    if (!task) {
      if (preview) this.previews.set(sessionId, preview);
      return;
    }
    if (claude.preview?.role === 'assistant' && claude.preview.text) {
      this.lastReply.set(task.id, claude.preview.text);
    }
    if (status === 'busy' || status === BACKGROUND) {
      this.cancelHold(task.id);
      if (task.state === 'working' || this.realFollowUp(task, preview)) {
        this.probing.delete(task.id);
        this.seenBusy.add(task.id);
        this.waitingOnPrompt.delete(task.id);
        if (task.state !== 'working') {
          this.setState(task, 'working');
          this.save();
        }
      } else {
        // 2026-10-20: any busy moved a settled task back to working, and opening its terminal
        // on the phone redraws Claude's screen (busy, then idle): the pipeline ran again and
        // could push or merge again. It stays where it is; new commits on idle reopen it.
        this.probing.add(task.id);
      }
    } else if (status === 'waiting') {
      this.cancelHold(task.id);
      this.probing.delete(task.id);
      const waitingFor = claude.waitingFor?.trim() ?? '';
      const kind: TaskBlockerKind = /permission/i.test(waitingFor) ? 'permission' : 'question';
      this.waitingOnPrompt.add(task.id);
      const fresh = task.state !== 'needs_you' || !task.blocker?.fromPrompt;
      // Still the prompt it was on: what was read of it stays until it is read again.
      const known = fresh ? undefined : task.blocker?.prompt;
      this.setState(task, 'needs_you', {
        kind,
        message: waitingFor || 'Waiting for your answer',
        fromPrompt: true,
        ...(known ? { prompt: known } : {}),
      });
      this.save();
      // What it asks, for `ut task status` and `ut task answer` (2026-11-10).
      this.track(this.readPromptOf(task).then(() => undefined));
      // First seen after a restart: the status notifier sends nothing for a first look, so the
      // prompt that came up meanwhile is told here (2026-10-20 review).
      if (previous === undefined && fresh) this.notifyState(task, waitingFor);
    } else if (status === 'idle') {
      if (this.probing.delete(task.id)) this.track(this.probeNewWork(task));
      const working = task.state === 'working' || this.onClaudePrompt(task);
      if (!working) return;
      // Claude is idle before its prompt is typed: only an agent seen working is done. After
      // a restart (nothing seen yet) a task that ran a while and sits idle is done too.
      const ranAWhile =
        previous === undefined &&
        task.startedAt !== undefined &&
        this.now() - Date.parse(task.startedAt) >= RESTART_IDLE_AFTER_MS;
      // Off its menu straight to idle (answered No, or the menu timed out; nothing was seen busy
      // after a restart): the prompt is over, it must not stay «te necesita» (2026-11-09).
      const promptOver = previous === 'waiting' && this.onClaudePrompt(task);
      if (this.seenBusy.has(task.id) || ranAWhile || promptOver) this.armHold(task);
    }
    if (preview) this.previews.set(sessionId, preview);
    // At its prompt again (off a menu, or a turn over): what waits to be typed goes in now,
    // not at the next try of its backoff.
    if (
      task.pendingInput?.length &&
      (status === 'idle' || (status !== 'waiting' && previous === 'waiting'))
    ) {
      this.typePendingNow(task);
    }
  }

  /** `ut task ask` from the task's own session: the agent stops and waits for the user. */
  ask(sessionId: string, question: string): TaskRecord | undefined {
    const task = this.tasks.find(
      (entry) => entry.sessionId === sessionId && SESSION_STATES.includes(entry.state)
    );
    if (!task) return undefined;
    this.cancelHold(task.id);
    this.waitingOnPrompt.delete(task.id);
    const message = question.trim().slice(0, TASK_QUESTION_MAX) || 'The agent has a question';
    this.setState(task, 'needs_you', { kind: 'question', message });
    this.save();
    this.notifyState(task, message);
    return this.copy(task);
  }

  /** Type a follow-up into an open task's session (it goes back to work). */
  async send(
    id: string,
    text: string,
    via: TaskFollowUp['via'],
    message?: { id: string; header: string }
  ): Promise<TaskActionResult> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (!SESSION_STATES.includes(task.state)) {
      return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    }
    if (this.discarding.has(task.id)) {
      return { ok: false, code: 'busy', message: 'The task is being discarded' };
    }
    // New instructions make new work: the user's merge OK was for the work as it was.
    if (via !== 'auto' && task.mergeOk) {
      delete task.mergeOk;
      this.save();
    }
    return await this.deliverText(task, text, via, task.agent === 'codex', message);
  }

  /**
   * Try a failed task again (2026-10-18 review: Descartar was its only way out). A task whose
   * agent had a conversation gets it reopened and is told to try again; otherwise (its setup
   * failed, or its session ended before anything was done) it starts over in a fresh worktree.
   * Work it committed is never thrown away here.
   */
  async retry(
    id: string,
    options: { agent?: string; force?: boolean } = {}
  ): Promise<TaskActionResult> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    const force = options.force === true;
    const changing = !!options.agent && options.agent !== runnerOf(task);
    if (changing && !task.heldFor && task.state !== 'paused') {
      return {
        ok: false,
        code: 'not-open',
        message: 'Only a paused task, or one that waits for its agent to start, can change agent',
      };
    }
    if (task.state === 'paused') {
      if (this.discarding.has(task.id) || this.finishing.has(task.id)) {
        return { ok: false, code: 'busy', message: 'The task is busy' };
      }
      // Paused tasks hold no slot: sent on only with one free in its project, or when forced.
      if (!force) {
        const room = await this.projectRoom(task);
        if (!room.ok) {
          return this.limitRefusal(
            task,
            room,
            task.halt?.nextTryAt
              ? 'Untether sends it on by itself when it can go on and one of them ends.'
              : 'try again when one of them ends.'
          );
        }
        if (task.state !== 'paused') {
          return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
        }
        // Asked again after the wait above (2026-11-11): a second retry that waited for the
        // slot beside the first one found the task still paused and handed it off too.
        if (this.discarding.has(task.id) || this.finishing.has(task.id)) {
          return { ok: false, code: 'busy', message: 'The task is busy' };
        }
      }
      if (changing) return await this.switchPaused(task, options.agent as string);
      return await this.resumeHalted(task, 'user');
    }
    if (task.state === 'scheduled' && task.heldFor) {
      return this.startHeld(task, options.agent, force);
    }
    // «Empezar ya»: past its project's limit, for this task (its group) only, when forced.
    if (task.state === 'queued') return this.startQueuedNow(task, force);
    if (task.state !== 'failed') {
      // 2026-11-10: "The task is needs_you" left its orchestrator with nothing to do next.
      if (this.onClaudePrompt(task)) {
        const ref = task.id.slice(0, 8);
        return {
          ok: false,
          code: 'not-open',
          message: `The task is not failed: its agent waits on a prompt of its own. \`ut task status ${ref}\` shows what it asks, \`ut task answer ${ref} approve | deny | <number> | --text "…"\` answers it`,
        };
      }
      return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    }
    if (
      this.piping.has(task.id) ||
      this.finishing.has(task.id) ||
      this.retrying.has(task.id) ||
      this.discarding.has(task.id)
    ) {
      return { ok: false, code: 'busy', message: 'The task is busy' };
    }
    // A failed task holds no slot of its project (2026-11-10: retried, it went to work past
    // maxActiveTasks). One that starts over waits in its project's line (run, below); one
    // whose agent goes on where it was needs a free slot, or --force.
    const startsOver =
      !(task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') &&
      (task.blocker?.kind === 'setup' || !task.sessionId) &&
      !(task.isolation === 'worktree' && task.worktreePath);
    if (!force && !startsOver) {
      const room = await this.projectRoom(task);
      if (!room.ok) return this.limitRefusal(task, room, 'try it again when one of them ends.');
      if (task.state !== 'failed') {
        return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
      }
    }
    // 2026-10-20: a failed task whose session still runs (a failed check leaves it open) was
    // reopened in a second session, two agents on one conversation. It is told in its own.
    if (task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') {
      return await this.deliverText(task, TASK_RETRY_TEXT, 'ui', true);
    }
    if (task.blocker?.kind !== 'setup' && this.reopenWith(task, TASK_RETRY_TEXT)) {
      this.save();
      return { ok: true, task: this.copy(task) };
    }
    if (task.isolation === 'worktree' && task.worktreePath) {
      // Two retries at once (a double tap) both passed this await and started it twice.
      this.retrying.add(task.id);
      try {
        if (await this.worktrees.hasUnmergedWork(task).catch(() => true)) {
          // 2026-10-20: a task with work and no conversation to reopen (a clean revert whose
          // check failed, a Codex task) could only be discarded. An agent starts in its
          // worktree, told what failed.
          if (task.state !== 'failed') {
            return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
          }
          const blocker = task.blocker;
          const text =
            blocker && FIXABLE.includes(blocker.kind)
              ? `${TASK_RETRY_TEXT}\n\n${fixPrompt(task, blocker)}`
              : TASK_RETRY_TEXT;
          if (this.startInWorktree(task, text)) {
            task.followUps.push({ at: new Date(this.now()).toISOString(), text, via: 'ui' });
            this.lastSent.set(task.id, this.now());
            this.save();
            return { ok: true, task: this.copy(task) };
          }
          return {
            ok: false,
            code: 'not-fixable',
            message: 'It has work of its own: ask its agent to fix it, or discard it',
          };
        }
        await this.worktrees.remove(task, { deleteUnmerged: true }).catch(() => undefined);
      } finally {
        this.retrying.delete(task.id);
      }
      if (task.state !== 'failed') {
        return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
      }
      for (const key of ['worktreePath', 'branch', 'baseSha', 'sessionId'] as const)
        delete task[key];
    }
    delete task.error;
    delete task.finishedAt;
    task.files = [];
    delete task.stats;
    // Starting over: through its project's line like a new task (a failed task holds no
    // slot), unless forced past it.
    this.track(this.run(task, force ? { admitted: true } : {}));
    return { ok: true, task: this.copy(task) };
  }

  /**
   * "Que lo arregle": the blocker (failed check, conflict, risky change, merge error) is typed
   * into the agent's session and the task is back at work.
   */
  async fix(id: string): Promise<TaskActionResult> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (this.piping.has(task.id) || this.discarding.has(task.id)) {
      return { ok: false, code: 'busy', message: 'The task is busy' };
    }
    if (!SESSION_STATES.includes(task.state)) {
      return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    }
    const blocker = task.blocker;
    if (!blocker || !FIXABLE.includes(blocker.kind) || blocker.internal) {
      return { ok: false, code: 'not-fixable', message: 'Nothing the agent can fix' };
    }
    return await this.deliverText(task, fixPrompt(task, blocker), 'ui', true);
  }

  /**
   * Merge a task now (the user's "Fusionar"): checked again unless the same commit already
   * passed, and merged whatever the project's policy. `acceptRisk` lets flagged changes in,
   * `acceptReview` merges past the AI review's concerns, `freshReview` asks it again.
   * Answers at once with the task verifying; the rest runs in the background.
   */
  merge(id: string, options: MergeOptions = {}): TaskActionResult {
    return this.startPipeline(id, 'merge', options);
  }

  /**
   * Run the check again (base merged in first). In the background, too. It ends at ready, or,
   * when nothing blocks it, goes on like an 'auto' run (2026-10-24: a stuck task relaunched by
   * hand still waited for «Fusionar»): merged as the policy says, a security task's countdown,
   * a risky task's second review.
   */
  verify(id: string): TaskActionResult {
    return this.startPipeline(id, 'verify', { thenAuto: true });
  }

  /** Where a task's log of `kind` is (it may not exist). */
  logPath(id: string, kind: TaskLogKind): string | undefined {
    if (!this.deps.logDir || !/^[A-Za-z0-9-]+$/.test(id)) return undefined;
    return path.join(this.deps.logDir, id, `${kind}.log`);
  }

  /**
   * The agent's live state for `ut task status`: its last status, its last real progress (not
   * the screen printing: 2026-11-02, "last activity 0m ago" for 1h40m of waiting) and what it
   * waits on, and a stall told.
   */
  liveState(id: string): TaskLiveState | undefined {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task?.sessionId) return undefined;
    const running = this.deps.sessionStatus(task.sessionId) === 'running';
    // 2026-11-01: a Codex task stopped at its usage limit said "running".
    const status = !running
      ? 'ended'
      : task.state === 'paused'
        ? 'paused'
        : (this.lastStatus.get(task.sessionId) ?? 'running');
    const progress = this.progressNow(task);
    return {
      status: status === BACKGROUND ? 'busy' : status,
      ...(progress ? { progress } : {}),
      ...(task.stall ? { stall: task.stall } : {}),
    };
  }

  /**
   * Throw a task away: its session ends, its worktree and branch go. Work that exists
   * nowhere else (commits, uncommitted changes) needs `confirm`.
   */
  async discard(id: string, options: { confirm?: boolean } = {}): Promise<TaskActionResult> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (isFinal(task)) return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    // Waiting behind other tasks in the merge queue: it leaves the line, then goes. The same on
    // board a merge batch that has not left yet (2026-11-11: out of the line by then, it
    // answered "busy" until the batch left, up to 15 min, and through its whole check; the
    // batch lets a car go, merge-train.ts, but nothing asked it to).
    const queued = this.pipeRuns.get(task.id);
    const boarding =
      !!queued &&
      !!task.repoPath &&
      !!task.baseBranch &&
      mergeTrainsFor(this.deps.mergeQueue ?? mergeQueue)
        .boarding(mergeQueueKey(task.repoPath, task.baseBranch))
        .includes(task.id);
    if (queued && ((task.mergeQueue?.position ?? 0) > 1 || boarding)) {
      queued.leave.abort();
      await queued.done;
    }
    // Its batch left and is being checked: the batch is not cut for a discard (decision of
    // 2026-11-11), so the answer says what it waits for and for how long.
    if (this.piping.has(task.id) && task.repoPath && task.baseBranch) {
      const trains = mergeTrainsFor(this.deps.mergeQueue ?? mergeQueue);
      const key = mergeQueueKey(task.repoPath, task.baseBranch);
      if (trains.cars(key).includes(task.id) && !trains.boarding(key).includes(task.id)) {
        return { ok: false, code: 'busy', message: this.batchCheckWait(task) };
      }
    }
    // 2026-10-20: a discard while finish() committed the leftovers (hooks, up to 180 s) was
    // undone when finish went on and set the task ready or verifying again.
    if (
      this.piping.has(task.id) ||
      this.finishing.has(task.id) ||
      this.retrying.has(task.id) ||
      this.discarding.has(task.id)
    ) {
      return { ok: false, code: 'busy', message: 'The task is busy' };
    }
    this.discarding.add(task.id);
    try {
      return await this.discardNow(task, options);
    } finally {
      this.discarding.delete(task.id);
    }
  }

  /**
   * Why a task on a batch under check cannot be discarded yet, and how long that should take:
   * how long its check has run, against the project's last whole check.
   */
  private batchCheckWait(task: TaskRecord): string {
    const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
    const soFar = Math.max(0, this.now() - Date.parse(task.stateSince));
    const last = this.tasks
      .filter((other) => other.repoPath === task.repoPath)
      .flatMap((other) => other.timings ?? [])
      .filter(
        (timing) =>
          timing.phase === 'verify' &&
          (timing.level === 'full' || timing.level === 'batch') &&
          timing.finishedAt &&
          timing.outcome !== 'reused'
      )
      .sort((a, b) => Date.parse(b.finishedAt as string) - Date.parse(a.finishedAt as string))[0];
    const took = last ? Date.parse(last.finishedAt as string) - Date.parse(last.startedAt) : 0;
    const left =
      took > 0
        ? took > soFar
          ? `; the project's last whole check took ${minutes(took)} min, so about ${minutes(took - soFar)} min are left`
          : `; the project's last whole check took ${minutes(took)} min, so it should end any moment`
        : '';
    return `The task's merge batch is being checked and is not cut short: it can be discarded when the check ends (${minutes(soFar)} min so far${left}). Discard it again then.`;
  }

  protected async discardNow(
    task: TaskRecord,
    options: { confirm?: boolean }
  ): Promise<TaskActionResult> {
    const sessionBefore = task.sessionId;
    let unmerged = false;
    if (task.isolation === 'worktree' && task.worktreePath) {
      unmerged = await this.worktrees.hasUnmergedWork(task).catch(() => true);
      if (unmerged && !options.confirm) {
        const commits = task.baseSha
          ? await commitsAhead(task.worktreePath, task.baseSha).catch(() => 0)
          : 0;
        return {
          ok: false,
          code: 'needs-confirmation',
          message: 'The task has work that is not merged anywhere',
          commits,
        };
      }
    }
    this.cancelHold(task.id);
    if (task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') {
      await this.deps.stopSession?.(task.sessionId).catch((error) => {
        this.deps.onError?.(`could not stop the session of task ${task.id}`, error);
      });
    }
    if (task.isolation === 'worktree' && (task.worktreePath || task.branch)) {
      const removed = await this.worktrees.remove(task, {
        deleteUnmerged: !!options.confirm || !unmerged,
      });
      if (!removed.branchDeleted && removed.error) {
        this.deps.onError?.(`task ${task.id}: branch ${task.branch} kept`, removed.error);
      }
    }
    if (isFinal(task)) return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    // A session started meanwhile (a resume that was already on its way) goes too.
    if (
      task.sessionId &&
      task.sessionId !== sessionBefore &&
      this.deps.sessionStatus(task.sessionId) === 'running'
    ) {
      await this.deps.stopSession?.(task.sessionId).catch(() => undefined);
    }
    this.setState(task, 'discarded');
    task.finishedAt = new Date(this.now()).toISOString();
    endEffect(task, 'pipeline');
    this.forget(task.id);
    this.save();
    // Tasks waiting on its branch (dirty-base) try again: it is gone, so they say so.
    this.releaseDependents(task);
    return { ok: true, task: this.copy(task) };
  }

  /**
   * "Deshacer" (2026-10-20): undo a merged task with a new task of the same project, made from
   * the base as it is now, that reverts the merged task's own commits with git (an agent only
   * when that conflicts), then goes through the check and the AI review and merges. Answers
   * with the new task (preparing). The same merged task undone again returns the open revert.
   */
  async revert(id: string): Promise<TaskActionResult> {
    // 2026-11-11: a second «Deshacer» while the first one made its task (a double tap) passed
    // the revertedBy check below and made a second revert task. It gets the first one's answer.
    const making = this.reverting.get(id);
    if (making) return making;
    const made = this.revertOnce(id).finally(() => this.reverting.delete(id));
    this.reverting.set(id, made);
    return made;
  }

  private reverting = new Map<string, Promise<TaskActionResult>>();

  private async revertOnce(id: string): Promise<TaskActionResult> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (task.state !== 'merged') {
      return { ok: false, code: 'not-open', message: 'Only a merged task can be undone' };
    }
    const open = task.revertedBy
      ? this.tasks.find((entry) => entry.id === task.revertedBy)
      : undefined;
    if (open && !['discarded', 'missed'].includes(open.state)) {
      return { ok: true, task: this.copy(open) };
    }
    if (!task.mergedOnto || !task.mergedSha || !task.repoPath || !task.baseBranch) {
      return {
        ok: false,
        code: 'not-fixable',
        message:
          'Untether has no record of exactly what this task merged, so it cannot undo it by itself',
      };
    }
    const range = { from: task.mergedOnto, to: task.mergedSha };
    const name = `Undo: ${task.name}`;
    const [created] = await this.createGroup(
      {
        name: name.length > TASK_NAME_MAX ? `${name.slice(0, TASK_NAME_MAX - 1)}…` : name,
        // 2026-10-20: it said to revert the task's non-merge commits, which leaves what an
        // agent changed in a "merge base into branch" commit (conflict resolutions) in place.
        prompt: [
          `Undo the merged task "${task.name}" on this branch: reverse exactly the change its merge made to ${task.baseBranch}, and nothing else.`,
          `Run \`${undoMergeCommand(range)}\`; it applies the reverse of that change with a 3-way merge.`,
          'Where it conflicts, keep the later changes of others and remove only what that merge brought in; then `git add` the resolved files.',
          `Commit it all as one commit with the message \`Undo: ${task.name.replace(/[`\n]/g, ' ')}\`. Change nothing else.`,
        ].join('\n'),
        workingDir: task.repoPath,
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        command: task.command,
        agent: task.agent,
        shielded: false,
        notify: true,
        isolation: 'worktree',
        origin: 'user',
        mergePolicy: 'auto',
        revertOf: { taskId: task.id, ...range },
      },
      1
    );
    task.revertedBy = created.id;
    task.revertedAt = new Date(this.now()).toISOString();
    this.save();
    if (task.autoMerged) this.checkBreaker(task.repoPath);
    return { ok: true, task: this.get(created.id) ?? created };
  }

  /**
   * Project folders that moved (ProjectSettingsStore.followMoves): open tasks follow them, so
   * their checks and merges run in the folder that exists (2026-10-20: tasks kept the old
   * repoPath of a renamed project). A worktree inside the old folder moved with it; one beside
   * it stays where it is and git's links between them are repaired.
   */
  async projectsMoved(moved: ReadonlyArray<{ from: string; to: string }>): Promise<number> {
    let count = 0;
    const under = (dir: string | undefined, from: string) =>
      !!dir && (dir === from || dir.startsWith(`${from}/`));
    const swap = (dir: string, from: string, to: string) => `${to}${dir.slice(from.length)}`;
    for (const { from, to } of moved) {
      for (const [id, repo] of this.taskProject) {
        if (repo === from) this.taskProject.set(id, to);
      }
      for (const task of this.tasks) {
        if (task.queued?.repoPath === from) {
          task.queued.repoPath = to;
          count++;
        }
        // Its metrics go to the project's ledger where the project is now.
        if (task.metrics?.project === from) {
          task.metrics.project = to;
          count++;
        }
      }
      for (const task of this.tasks) {
        if (!task.repoPath) continue;
        if (normalizeRepoPath(task.repoPath) !== from && task.repoPath !== from) continue;
        const oldRepo = task.repoPath;
        task.repoPath = to;
        if (under(task.workingDir, oldRepo)) task.workingDir = swap(task.workingDir, oldRepo, to);
        if (task.worktreePath && under(task.worktreePath, oldRepo)) {
          task.worktreePath = swap(task.worktreePath, oldRepo, to);
        }
        count++;
        // A finished task follows too (2026-11-10: it kept the old folder, so "Deshacer" on a
        // merged task made its worktree where nothing is, and `ut task list --repo` lost it);
        // it has no worktree to repair and nobody to tell.
        if (isFinal(task)) continue;
        if (task.worktreePath && fs.existsSync(task.worktreePath)) {
          await (this.deps.repairWorktree ?? repairWorktree)(to, task.worktreePath).catch((error) =>
            this.deps.onError?.(`task ${task.id}: git worktree repair after the move failed`, error)
          );
        }
        this.deps.onError?.(`Task ${task.id} follows its project from ${from} to ${to}`);
      }
    }
    if (count) this.save();
    return count;
  }

  /**
   * A task's session is about to be reopened as another (Blindar): its end is not the task's.
   * 2026-10-18: a task shielded from the phone kept pointing at the closed session.
   */
  sessionReplacing(sessionId: string): void {
    this.replacing.add(sessionId);
  }

  /** It was not reopened and still runs (Llevar a Untether's close failed): its tasks stay. */
  notReplaced(sessionId: string): void {
    this.replacing.delete(sessionId);
  }

  /** The reopened session (null when reopening failed) carries on the task of the old one. */
  sessionReplaced(
    oldSessionId: string,
    newSessionId: string | null,
    options: { resumed?: boolean } = {}
  ): number {
    this.replacing.delete(oldSessionId);
    if (!newSessionId) return 0;
    let moved = 0;
    for (const task of this.tasks) {
      if (!followsReopenedSessions(task)) continue;
      // Its own session, the orchestrator it reports to and the session that started it.
      if (task.sessionId === oldSessionId) {
        task.sessionId = newSessionId;
        moved++;
        // Reopened by hand once finished: that session is the user's now, never stopped for
        // being finished. A session reopened shielded (no resume) keeps the mark it had.
        if (options.resumed && isFinal(task)) {
          task.keepSessionId = newSessionId;
          this.cancelFinishedStop(task.id);
        } else if (task.keepSessionId === oldSessionId) {
          task.keepSessionId = newSessionId;
        }
        // Its conversation resumed by hand: its agent is at work on it again.
        if (options.resumed && !this.piping.has(task.id) && task.state !== 'working') {
          this.setState(task, 'working');
          this.seenBusy.delete(task.id);
        }
      }
      if (task.orchestratorSessionId === oldSessionId) {
        task.orchestratorSessionId = newSessionId;
        moved++;
      }
      if (task.createdBySessionId === oldSessionId) {
        task.createdBySessionId = newSessionId;
        moved++;
      }
    }
    if (moved) this.save();
    return moved;
  }

  /**
   * Its tasks, the orchestrator they report to and the session that started them follow a
   * session reopened as another (server.ts registers this with SessionReplacements). Its
   * references are what sessionReplaced moves (followsReopenedSessions): 2026-10-25, the
   * doctor counted merged tasks too and "healed" a move that had left nothing behind.
   */
  replacementFollower(): SessionReplacementFollower {
    return {
      replacing: (sessionId) => this.sessionReplacing(sessionId),
      notReplaced: (sessionId) => this.notReplaced(sessionId),
      replaced: (oldSessionId, newSessionId, options) =>
        this.sessionReplaced(oldSessionId, newSessionId, options),
      references: () =>
        this.tasks
          .filter(followsReopenedSessions)
          .flatMap((task) => [
            task.sessionId ?? '',
            task.orchestratorSessionId ?? '',
            task.createdBySessionId ?? '',
          ])
          .filter(Boolean),
    };
  }

  /**
   * `sessionId` became the orchestrator of `repoPath`: the open worktree tasks it started there
   * report to it from now on. Returns how many.
   */
  adoptTasks(sessionId: string, repoPath: string): number {
    const repo = normalizeRepoPath(repoPath);
    let count = 0;
    for (const task of this.tasks) {
      if (task.createdBySessionId !== sessionId || task.origin === 'orchestrator') continue;
      if (isFinal(task) || task.isolation !== 'worktree') continue;
      if (!task.repoPath || normalizeRepoPath(task.repoPath) !== repo) continue;
      task.origin = 'orchestrator';
      task.orchestratorSessionId = sessionId;
      count++;
    }
    if (count) this.save();
    return count;
  }

  /**
   * Tasks whose session ended report back; a Codex task quiet for CODEX_IDLE_MS is done.
   * A worktree task that ended without a commit failed ("session-exit").
   */
  async checkExited(): Promise<void> {
    // 2026-10-20: every 5 s with awaits inside (a resume, leftovers' hooks): a second run could
    // start on the same tasks and resume one twice.
    if (this.checking) return;
    this.checking = true;
    try {
      for (const task of Array.from(this.tasks)) {
        if (!task.sessionId) continue;
        if (!isFinal(task)) this.syncGuardBlocks(task);
        if (task.agent === 'codex' && (task.state === 'ready' || task.state === 'paused')) {
          if (this.deps.sessionStatus(task.sessionId) === 'running') this.checkCodexBack(task);
          continue;
        }
        if (task.state !== 'working' && task.state !== 'needs_you') continue;
        if (this.replacing.has(task.sessionId) || this.resuming.has(task.id)) continue;
        if (this.discarding.has(task.id)) continue;
        const status = this.deps.sessionStatus(task.sessionId);
        if (status === 'running') {
          if (task.agent === 'codex' && task.state === 'needs_you') this.checkCodexBack(task);
          if (task.agent === 'codex' && task.state === 'working') this.checkCodexIdle(task);
          else if (task.state === 'working') this.checkClaudeIdle(task);
          continue;
        }
        if (await this.resumeInterrupted(task)) continue;
        if (isFinal(task)) continue;
        // Its first message still being typed: the typing sees the session gone in a moment
        // and queues it, and the queue starts the task again with it (pumpInput).
        if (this.briefPending.get(task.id) === task.sessionId) continue;
        if (task.pendingInput?.length) {
          this.typePendingNow(task);
          if (this.replacing.has(task.sessionId)) continue;
        }
        this.cancelHold(task.id);
        await this.finish(task, { exited: true });
      }
      this.remindStale();
      this.watchPrompts();
      this.watchHalts();
      this.watchProgress();
      this.watchFailureLoops();
      this.watchOverlap();
      this.countBudgets();
      // A needs_you task past its hold, a session that ended, a limit raised by hand: a slot
      // may be free without any state change saying so.
      this.requestPump();
    } finally {
      this.checking = false;
    }
  }

  /** Scheduled tasks whose time came and whose start (fireDue) has not taken them yet. */
  private readonly dueStarting = new Set<string>();

  /** Arm one timer for the nearest scheduled task, review retry or internal retry. */
  protected arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // A task whose pipeline (or resume) is running is not timed: fireDue skips it, and the
    // end of that run arms again. 2026-11-10: a task waiting for a clean base kept its past
    // `baseWait.nextAt` while its pipeline ran, so this armed 0 ms, fireDue skipped it and
    // armed again: a timer every millisecond for as long as the pipeline took (minutes in the
    // merge queue).
    const idle = (task: TaskRecord) => !this.piping.has(task.id);
    const next = [
      ...this.tasks
        .filter((task) => task.state === 'scheduled' && !this.dueStarting.has(task.id))
        .map((task) => Date.parse(task.runAt)),
      ...this.tasks
        .filter((task) => this.waitsForReview(task) && idle(task))
        .map((task) => Date.parse(task.reviewRetryAt as string)),
      ...this.tasks
        .filter((task) => this.waitsForInternalRetry(task) && idle(task))
        .map((task) => Date.parse(task.internalRetryAt as string)),
      ...this.tasks
        .filter((task) => task.state === 'ready' && task.autoMergeAt && idle(task))
        .map((task) => Date.parse(task.autoMergeAt as string)),
      ...this.tasks
        .filter(
          (task) =>
            task.state === 'paused' &&
            task.halt?.nextTryAt &&
            !this.finishing.has(task.id) &&
            !this.discarding.has(task.id)
        )
        .map((task) => Date.parse(task.halt?.nextTryAt as string)),
      ...this.tasks
        .filter((task) => this.waitsForBase(task) && idle(task) && !this.lookingAtBase.has(task.id))
        .map((task) => Date.parse(task.baseWait?.nextAt as string)),
    ]
      .filter((at) => Number.isFinite(at))
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, next - this.now()));
    this.timer = setTimeout(
      loopStep('task scheduler timer', () =>
        this.fireDue().catch((error) => {
          // A step that failed armed nothing: looked at again in a while, not at once (a task
          // that fails the same way every time would arm a timer every millisecond).
          if (!this.timer) {
            this.timer = setTimeout(() => this.arm(), FIRE_AGAIN_AFTER_FAILURE_MS);
            this.timer.unref?.();
          }
          throw error;
        })
      ),
      delay
    );
    this.timer.unref?.();
  }

  protected async fireDue(): Promise<void> {
    this.timer = null;
    const now = this.now();
    const due = this.tasks.filter(
      (task) =>
        task.state === 'scheduled' &&
        Date.parse(task.runAt) <= now &&
        !this.dueStarting.has(task.id)
    );
    // Started in turn but not awaited here (2026-11-10): a worktree task's run waits for its
    // whole setup (minutes), and meanwhile no countdown merged, no paused task resumed and no
    // retry ran. `dueStarting` keeps the timer off a task until its run has taken it.
    if (due.length) {
      for (const task of due) this.dueStarting.add(task.id);
      this.track(
        (async () => {
          for (const task of due) {
            try {
              await this.run(task);
            } finally {
              this.dueStarting.delete(task.id);
            }
          }
        })().finally(() => this.arm())
      );
    }
    for (const task of this.tasks) {
      if (task.state !== 'paused' || !task.halt?.nextTryAt) continue;
      if (Date.parse(task.halt.nextTryAt) > now) continue;
      if (this.finishing.has(task.id) || this.discarding.has(task.id)) continue;
      // Still being started by the loop above: its run decides what it becomes.
      if (this.dueStarting.has(task.id)) continue;
      this.track(this.resumeWhenRoom(task));
    }
    for (const task of this.tasks) {
      if (!this.waitsForReview(task) || this.piping.has(task.id)) continue;
      if (Date.parse(task.reviewRetryAt as string) > now) continue;
      const retry = task.reviewRetry as NonNullable<TaskRecord['reviewRetry']>;
      retry.attempts++;
      delete task.reviewRetryAt;
      this.deps.onError?.(`Task ${task.id}: trying the AI review again (${retry.attempts})`);
      this.cancelHold(task.id);
      this.setState(task, 'verifying');
      this.save();
      this.track(
        this.pipe(task, retry.mode, {
          ...(retry.acceptRisk ? { acceptRisk: true } : {}),
          ...(retry.keep ? { keep: true } : {}),
          ...(retry.byAgent ? { byAgent: true } : {}),
        })
      );
    }
    for (const task of this.tasks) {
      if (!this.waitsForInternalRetry(task) || this.piping.has(task.id)) continue;
      if (Date.parse(task.internalRetryAt as string) > now) continue;
      const { readyNote, mode, ...merge } = (
        pendingEffect(task, 'pipeline') as { run: TaskPipelineRun }
      ).run;
      this.deps.onError?.(
        `Task ${task.id}: running the pipeline again after an error of Untether's own (${task.internalRetry?.attempts ?? 1})`
      );
      this.track(this.pipe(task, mode, merge, readyNote));
    }
    for (const task of this.tasks) {
      if (task.state !== 'ready' || !task.autoMergeAt || this.piping.has(task.id)) continue;
      if (Date.parse(task.autoMergeAt) > now) continue;
      delete task.autoMergeAt;
      // Asked again now: the project may have paused merges or turned this off meanwhile.
      const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
      const approved = task.autoApprovedMerge;
      if (approved && !approved.done) {
        // autoApprove counted it down: merged as the user's «Fusionar» would, with what they
        // would have accepted (the risk and the review as they stood), unless it is off now.
        if (!settings || !this.autoApproveAllowed(task, settings)) {
          this.holdForUser(task);
          this.save();
          this.notifyState(task, '');
          continue;
        }
        const merge: MergeOptions = {
          ...(approved.blocker.kind === 'risk' ? { acceptRisk: true } : {}),
          ...(approved.blocker.kind === 'review-unavailable' ? { acceptReview: true } : {}),
        };
        task.mergeOk = mergeOkOf(task, merge, now);
        this.deps.onError?.(`Task ${task.id}: its autoApprove countdown ended, merging it`);
        this.setState(task, 'verifying');
        this.save();
        this.track(this.pipe(task, 'merge', merge));
        continue;
      }
      const allowed =
        !!settings &&
        !securityMergeHeld(settings, now) &&
        (!task.security
          ? this.reviewsRisk(task, settings) && riskMergesOnItsOwn(task, settings, now)
          : task.security.kind === 'supply'
            ? bumpMergesOnItsOwn(task, settings)
            : fixMergesOnItsOwn(task, settings));
      if (!allowed) {
        this.holdForUser(task);
        this.save();
        this.notifyState(task, '');
        continue;
      }
      this.deps.onError?.(`Task ${task.id}: its countdown ended, merging it`);
      this.setState(task, 'verifying');
      this.save();
      this.track(
        this.pipe(
          task,
          'merge',
          task.security ? { byAgent: true } : { byAgent: true, riskReviewed: true }
        )
      );
    }
    const looks: Promise<void>[] = [];
    for (const task of this.tasks) {
      if (!this.waitsForBase(task) || this.piping.has(task.id)) continue;
      if (this.lookingAtBase.has(task.id)) continue;
      if (Date.parse(task.baseWait?.nextAt as string) > now) continue;
      looks.push(this.lookAtBase(task));
    }
    // Armed again once they set their next look.
    if (looks.length) this.track(Promise.all(looks).finally(() => this.arm()));
    this.arm();
  }
}
