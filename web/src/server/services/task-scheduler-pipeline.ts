/**
 * The verify/merge hand-off: the merge pipeline run (task-merge.ts), its waits (dirty base, review,
 * internal retries), risky and security merges and the merge OK.
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import * as path from 'path';
import { TASK_REPORT_MAX } from '../../shared/orchestrator-prompt.js';
import { autoMergePaused, type ProjectSettings } from '../../shared/projects.js';
import {
  bumpMergesOnItsOwn,
  bumpReadyForReview,
  fixMergesOnItsOwn,
  fixReadyForReview,
  riskMergesOnItsOwn,
  riskReadyForReview,
  securityConfig,
  securityMergeHeld,
  type TaskSecurity,
} from '../../shared/security.js';
import { beginEffect, endEffect, pendingEffect } from '../../shared/task-effects.js';
import { checkMetrics } from '../../shared/task-metrics.js';
import { currentRound, withTimings } from '../../shared/task-timings.js';
import {
  TASK_BASE_WAIT_MAX_MS,
  TASK_BASE_WAIT_NOTIFY_MS,
  TASK_BUSY_STATES,
  type TaskAutoFixReason,
  type TaskBlocker,
  type TaskPipelineRun,
  type TaskRecord,
  type TaskRiskReview,
} from '../../shared/tasks.js';
import { mergeQueue, mergeQueueKey } from './merge-queue.js';
import { resolveMemoryDir, saveMemoryNote } from './task-memory-note.js';
import {
  finishMergedTask,
  type PipelineMode,
  type PipelineOptions,
  riskBlocker,
  runTaskPipeline,
} from './task-merge.js';
import type { RiskRule } from './task-risk.js';
import { TaskSchedulerAutoFix } from './task-scheduler-autofix.js';
import {
  autoFixReasonOf,
  BASE_WAIT_POLL_MS,
  BASE_WAIT_RERUN_MS,
  heldOnlyForMergeOk,
  INTERNAL_RETRY_DELAYS_MS,
  isFinal,
  mergeOkOf,
  mergePriorityOf,
  noteReview,
  riskFilesOf,
  riskReviewSaid,
} from './task-scheduler-rules.js';
import type { MergeOptions, TaskActionResult } from './task-scheduler-types.js';
import { baseCheckoutDirty, type RevertResult, revertRange } from './task-worktree.js';

export abstract class TaskSchedulerPipeline extends TaskSchedulerAutoFix {
  protected startPipeline(
    id: string,
    mode: PipelineMode,
    merge: MergeOptions = {}
  ): TaskActionResult {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (task.isolation !== 'worktree' || !task.branch) {
      return { ok: false, code: 'not-open', message: 'The task has no branch of its own' };
    }
    // 2026-11-02: a ready task whose merge already runs (back from a dirty-base wait) answered
    // «The task is ready», which read as a refusal for no reason.
    if (this.piping.has(task.id)) {
      return {
        ok: false,
        code: 'busy',
        message: 'The task is already being checked or merged: it goes on by itself',
      };
    }
    if (TASK_BUSY_STATES.includes(task.state)) {
      return { ok: false, code: 'busy', message: `The task is ${task.state}` };
    }
    if (this.discarding.has(task.id)) {
      return { ok: false, code: 'busy', message: 'The task is being discarded' };
    }
    if (!['ready', 'needs_you', 'failed'].includes(task.state)) {
      return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    }
    this.cancelHold(task.id);
    // The user's own merge stands until the task merges, for what they saw (2026-10-23).
    if (mode === 'merge' && !merge.byAgent) task.mergeOk = mergeOkOf(task, merge, this.now());
    // Shown at once; the pipeline refines it (queued, running).
    this.setState(task, 'verifying');
    this.save();
    this.track(this.pipe(task, mode, merge));
    return { ok: true, task: this.copy(task) };
  }

  /** Run the merge pipeline for a task and apply where it ended (state, push). */
  protected async pipe(
    task: TaskRecord,
    mode: PipelineMode,
    merge: MergeOptions = {},
    /** Shown on a task the pipeline leaves ready with nothing to say (why it did not merge). */
    readyNote?: TaskBlocker,
    /**
     * A restart found its base move recorded (task journal): the merge is only finished when
     * the base holds the commit (finishMergedTask); else the pipeline runs as asked.
     */
    resumeMove = false
  ): Promise<void> {
    if (this.piping.has(task.id)) return;
    this.piping.add(task.id);
    const leave = new AbortController();
    let ended: () => void = () => {};
    this.pipeRuns.set(task.id, { leave, done: new Promise<void>((resolve) => (ended = resolve)) });
    // The agent's fix (or conflict) round, if it was in one, ends here.
    this.endAgentPhase(task);
    // 2026-10-23: the user OK'd a merge with risky changes, the check failed under load, the
    // agent's round re-ran as 'auto' without acceptRisk and the task asked for the same OK
    // again. Every run but a check-only one carries the user's standing OK, limited to what
    // they accepted (a revert's own acceptRisk is the user's undo, risk and all).
    const ok = mode === 'verify' ? undefined : task.mergeOk;
    if (ok) {
      if (mode === 'auto') mode = 'merge';
      merge = {
        ...merge,
        ...(ok.risk && !task.revertOf ? { acceptRisk: true } : {}),
        ...(ok.review ? { acceptReview: true } : {}),
        ...(ok.keep ? { keep: true } : {}),
      };
    }
    // Recorded with the task (task journal): a restart mid-pipeline runs it the same way.
    const run: TaskPipelineRun = {
      mode,
      ...(merge.acceptRisk ? { acceptRisk: true } : {}),
      ...(merge.acceptReview ? { acceptReview: true } : {}),
      ...(merge.freshReview ? { freshReview: true } : {}),
      ...(merge.keep ? { keep: true } : {}),
      ...(merge.byAgent ? { byAgent: true } : {}),
      ...(readyNote ? { readyNote } : {}),
      ...(mode === 'verify' && merge.thenAuto ? { thenAuto: true } : {}),
      ...(merge.riskReviewed ? { riskReviewed: true } : {}),
    };
    this.recordPipeline(task, run);
    // Unattended: the agent finished, or a check-only run that goes on like it.
    const unattended = mode === 'auto' || !!run.thenAuto;
    // A run now replaces a retry that was waiting.
    delete task.internalRetryAt;
    this.save();
    try {
      if (task.repoPath) this.clearExpiredPause(task.repoPath);
      // What the guard blocked goes to the review with the rest.
      this.syncGuardBlocks(task);
      const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
      const logDir = this.deps.logDir
        ? path.join(this.deps.logDir, task.id)
        : path.join(path.dirname(this.deps.storePath), 'task-logs', task.id);
      // byAgent goes along: an orchestrator's merge keeps the no-check gate (task-merge.ts).
      const {
        keep: _keep,
        riskReviewed: _riskReviewed,
        thenAuto: _thenAuto,
        ...pipelineMerge
      } = merge;
      const pipelineOptions: PipelineOptions = {
        mode,
        ...pipelineMerge,
        ...(ok?.risk && !task.revertOf ? { acceptedRisk: ok.risk } : {}),
        // The countdown of a risky task ended: what its second review saw, nothing more.
        ...(run.riskReviewed && task.riskReview?.risk
          ? { acceptRisk: true, acceptedRisk: task.riskReview.risk }
          : {}),
        ...(run.thenAuto ? { thenAuto: true } : {}),
        ...(unattended && !merge.acceptRisk && this.reviewsRisk(task, settings)
          ? { riskReview: true }
          : {}),
        ...(ok?.review ? { acceptedReview: ok.review } : {}),
        ...(this.deps.reviewer ? { reviewer: this.deps.reviewer } : {}),
        settings,
        logDir,
        now: this.now,
        // Urgent first (fast lane), then the user's own «Fusionar», then the unattended merges;
        // read live, so a mark made while it waits counts.
        mergePriority: () => mergePriorityOf(task),
        // Files changed while its check ran: the agent's edits only if its session printed
        // meanwhile; else the check's own rewrites (a formatter), and its result stands.
        agentActiveSince: (since) => this.agentActedSince(task, since),
        signal: leave.signal,
        ...(this.deps.mergeQueue ? { mergeQueue: this.deps.mergeQueue } : {}),
        round: currentRound(task.timings),
        onLateReview: (review, timing) => this.lateReview(task, review, timing),
        onProgress: (progress) => {
          if (progress.state === 'verifying') {
            this.noticeDisk(task, progress.verify);
            task.verify = progress.verify;
            if (task.state !== 'verifying') this.setState(task, 'verifying');
          } else if (progress.state === 'reviewed') {
            // The check, run alongside, still goes on (or it waits for its merge turn).
            delete task.reviewing;
            noteReview(task, progress.review);
            if (progress.verify) task.verify = progress.verify;
          } else if (progress.state === 'merge-queue') {
            if (progress.spot) task.mergeQueue = progress.spot;
            else delete task.mergeQueue;
          } else if (progress.state === 'reviewing') {
            if (progress.verify) task.verify = progress.verify;
            task.reviewing = true;
            if (task.state !== 'verifying') this.setState(task, 'verifying');
          } else {
            delete task.reviewing;
            this.setState(task, 'merging');
          }
          this.save();
        },
        onMoveBase: ({ sha, onto }) => {
          // Recorded before the base moves (task journal): 2026-10-31, merging a task into
          // Untether's own folder restarted the server (tsx watch) before "merged" was saved,
          // and the rerun failed a task whose work was in the base. A restart that finds this
          // looks at the base (finishMergedTask) instead of merging again.
          endEffect(task, 'base');
          beginEffect(task, {
            kind: 'base',
            key: sha,
            at: new Date(this.now()).toISOString(),
            sha,
            onto,
          });
          // Not on disk: the base is not moved (the pipeline stops as Untether's own error,
          // retried by itself), since a restart could not know of the move.
          if (!this.save()) {
            endEffect(task, 'base');
            throw new Error('Could not save tasks.json before moving the base');
          }
        },
        beforeCleanup: async () => {
          // The merge is in: the agent's session (in the folder about to go) ends.
          this.cancelHold(task.id);
          if (task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') {
            await this.deps.stopSession?.(task.sessionId);
          }
        },
      };
      const finished = resumeMove
        ? await (this.deps.finishMerge ?? finishMergedTask)(this.copy(task), pipelineOptions)
        : null;
      // Not in the base: the move never happened; the pipeline makes it.
      if (resumeMove && !finished) endEffect(task, 'base');
      let result =
        finished ??
        (await (this.deps.pipeline ?? runTaskPipeline)(this.copy(task), pipelineOptions));
      // Its steps end in the save that records where it ended (below).
      delete task.reviewing;
      endEffect(task, 'pipeline');
      endEffect(task, 'base');
      delete task.mergeQueue;
      if (result.timings?.length) task.timings = withTimings(task.timings, result.timings);
      if (result.checks) {
        // Its check runs: made, reused, failed by load (`ut task status`, `ut project stats`).
        const checks = checkMetrics(this.metricsOf(task));
        checks.runs += result.checks.runs;
        checks.runMs += result.checks.runMs;
        checks.reused += result.checks.reused;
        checks.savedMs += result.checks.savedMs;
        checks.loadFailed += result.checks.loadFailed;
      }
      if (isFinal(task)) return;
      // It left the merge queue to be discarded: the discard goes on from here.
      if (leave.signal.aborted && result.state !== 'merged') {
        this.setState(task, 'ready');
        this.save();
        return;
      }
      if (result.blocker?.internal) {
        const final = this.retryInternal(task, run, result.blocker.detail?.[0] ?? '');
        if (!final) return;
        result = { ...result, blocker: final };
      } else {
        delete task.internalRetry;
      }
      if (result.review) {
        noteReview(task, result.review);
        if (result.review.verdict === 'unavailable') {
          this.deps.onError?.(`task ${task.id}: AI review unavailable`, result.review.reason);
        }
      }
      if (result.baseSha) task.baseSha = result.baseSha;
      if (result.headSha) task.headSha = result.headSha;
      // Also when it stopped short after the base got the commit (work left in the folder):
      // the pipeline's rerun knows what is in already.
      if (result.mergedSha) task.mergedSha = result.mergedSha;
      if (result.files) task.files = result.files;
      if (result.stats) task.stats = result.stats;
      if (result.verify?.flakyUnderLoad && result.verify.finishedAt !== task.verify?.finishedAt) {
        try {
          this.deps.onFlakyUnderLoad?.(task, result.verify);
        } catch (error) {
          this.deps.onError?.(`task ${task.id}: recording tests flaky under load`, error);
        }
      }
      if (result.verify) task.verify = result.verify;
      if (result.risk) task.risk = result.risk;
      if (result.cleanupError) {
        this.deps.onError?.(`task ${task.id}: cleanup after merge`, result.cleanupError);
      }
      const blocker =
        result.state === 'ready' && !result.blocker
          ? readyNote
          : this.explainDirtyBase(task, result.blocker);
      // Whether Untether was fixing it by itself before this run (setState drops the mark
      // when the blocker changed).
      const wasFixing = !!task.autoFix;
      // The base's checkout is dirty: nothing for anyone to do, it merges once it is clean.
      const waiting = blocker?.kind === 'dirty-base' ? this.waitForBase(task, run) : undefined;
      if (!waiting) delete task.baseWait;
      // Read before the state changes: a final state forgets the agent's last reply.
      const detail = task.summary || this.lastReply.get(task.id) || '';
      this.setState(task, waiting ? 'ready' : result.state, blocker);
      // Its next look at the base, now that it waits ready.
      if (waiting) this.arm();
      if (result.mergedOnto) task.mergedOnto = result.mergedOnto;
      // Nothing of its own left to merge (its commits undone, or already in the base by
      // other means): done, the way finish() closes one that never changed anything. Not a
      // Codex one: a pipeline run says nothing about whether its agent is through (review).
      if (
        task.state === 'ready' &&
        task.blocker?.kind === 'no-changes' &&
        (await this.closeUnchanged(task, { reported: false }))
      ) {
        this.save();
        this.notifyState(task, detail);
        queueMicrotask(() => this.releaseDependents(task));
        return;
      }
      let push: { quiet?: boolean; silent?: boolean; body?: string } = waiting ?? {};
      let autoFix: TaskAutoFixReason | undefined;
      if (result.state === 'merged') {
        task.finishedAt = new Date(this.now()).toISOString();
        delete task.error;
        if (unattended || run.byAgent || task.autoApprovedMerge) task.autoMerged = true;
        delete task.mergeOk;
        delete task.autoApprovedMerge;
        delete task.autoFix;
        delete task.reviewRetry;
        delete task.reviewRetryAt;
        this.forget(task.id);
        this.keepMemoryNote(task, settings);
        if (run.keep) this.track(this.discardSiblings(task));
        // The base moved: the working tasks that touch its files get it soon (after the
        // save below, in a microtask: its files and its merge are on the record by then).
        queueMicrotask(() => this.baseMovedBy(task));
      } else {
        if (result.state === 'failed') task.error = result.blocker?.message;
        // 2026-10-20: a verify run (the user's or an orchestrator's) dropped the retry while
        // the blocker still said Untether tries again by itself; it keeps retrying.
        if (task.blocker?.kind === 'review-unavailable') {
          push = this.scheduleReviewRetry(task, run);
        } else {
          delete task.reviewRetry;
          delete task.reviewRetryAt;
        }
        const reason = autoFixReasonOf(task.blocker);
        if (reason && run.mode !== 'verify' && this.fixesOnItsOwn(task)) {
          if (this.autoFixLeft(task, reason)) autoFix = reason;
          else if (wasFixing) {
            // 2026-10-20 (THE PRINCIPLE): the user hears of a blocker only once Untether's own
            // fixes ran out, in plain words, once.
            push = { body: this.gaveUp(task) };
          }
        } else {
          delete task.autoFix;
        }
      }
      // A security task waits for the user (needs_you), whatever the project's policy, unless
      // every gate holds (shared/security.ts): then it merges after a countdown the user can
      // stop (2026-10-23).
      let countdown = false;
      if (
        task.security &&
        task.security.kind !== 'sweep' &&
        result.state === 'ready' &&
        !task.blocker &&
        run.mode !== 'merge'
      ) {
        countdown = unattended && !!settings && (await this.securityMerges(task, settings, run));
        if (isFinal(task)) return;
        if (!countdown && (task.state === 'ready' || task.state === 'verifying')) {
          this.holdSecurity(task);
        }
      } else if (result.riskPending && result.state === 'ready' && !result.blocker) {
        // A risky change merges on its own only past a second, risk-focused review, after the
        // same countdown (2026-10-24); else it waits for the user as before, with the reason.
        countdown = !!settings && (await this.riskMerges(task, settings, run));
        if (isFinal(task)) return;
        if (!countdown && (task.state === 'ready' || task.state === 'verifying')) {
          this.holdRisk(task);
        }
      }
      // autoApprove: stopped only for the user's merge OK → the same countdown, then merged
      // as their «Fusionar» would (2026-10-24). A check-only run decides nothing.
      if (
        !countdown &&
        !autoFix &&
        (run.mode !== 'verify' || !!run.thenAuto) &&
        settings &&
        this.autoApprovesMerge(task, settings)
      ) {
        this.approveMerge(task);
        countdown = true;
      }
      this.save();
      if (countdown && settings) {
        this.startCountdown(task, settings);
      } else if (!autoFix || !(await this.startAutoFix(task, autoFix))) {
        if (!push.silent) this.notifyState(task, detail, push);
      }
      // After `finally` drops it from `piping`.
      queueMicrotask(() => this.releaseDependents(task));
    } catch (error) {
      delete task.reviewing;
      endEffect(task, 'pipeline');
      endEffect(task, 'base');
      delete task.mergeQueue;
      this.deps.onError?.(`task ${task.id}: merge pipeline`, error);
      if (!isFinal(task)) {
        const final = this.retryInternal(task, run, String(error));
        if (final) this.setState(task, 'needs_you', final);
      }
      this.save();
      queueMicrotask(() => this.releaseDependents(task));
    } finally {
      this.piping.delete(task.id);
      this.pipeRuns.delete(task.id);
      ended();
      // What came due for this task while its pipeline ran (arm leaves a piping task out).
      this.arm();
    }
  }

  /**
   * Its result's memory note, now that it merged: saved in the project's memoryDir, or why not
   * (TaskRecord.memoryNote); its orchestrator's merged event carries the note when it was not.
   */
  protected keepMemoryNote(task: TaskRecord, settings: ProjectSettings | undefined): void {
    const note = task.result?.memoryNote;
    if (!note || !task.repoPath) return;
    const where = resolveMemoryDir(settings?.memoryDir, task.repoPath, this.deps.memoryHome);
    if ('off' in where) {
      task.memoryNote = { skipped: where.off };
      return;
    }
    try {
      task.memoryNote = saveMemoryNote(where.dir, note);
    } catch (error) {
      this.deps.onError?.(`task ${task.id}: saving its memory note`, error);
      task.memoryNote = {
        skipped: `could not write it in ${where.dir}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * The base branch's checkout had uncommitted changes (dirty-base): the task waits ready and
   * Untether looks at the checkout every BASE_WAIT_POLL_MS, merging it the way `run` asked once
   * it is clean (lookAtBase). Its orchestrator hears once that there is nothing to do; nobody
   * else. Undefined once it waited TASK_BASE_WAIT_MAX_MS: then it is the user's (needs_you).
   */
  protected waitForBase(
    task: TaskRecord,
    run: TaskPipelineRun
  ): { quiet?: boolean; silent?: boolean } | undefined {
    if (!task.repoPath || !task.baseBranch) return undefined;
    const now = this.now();
    const prior = task.baseWait;
    const since = prior?.since ?? new Date(now).toISOString();
    if (now - Date.parse(since) >= TASK_BASE_WAIT_MAX_MS) return undefined;
    // Run again on a clean look and still stopped (untracked files in the way of the
    // fast-forward, which the look does not see): the next run waits longer.
    const poll = this.deps.baseWaitPollMs ?? BASE_WAIT_POLL_MS;
    task.baseWait = {
      since,
      nextAt: new Date(now + (prior ? Math.max(poll, BASE_WAIT_RERUN_MS) : poll)).toISOString(),
      // A check-only run merges nothing: the wait goes on the way it was going to merge.
      run: run.mode === 'verify' && prior ? prior.run : run,
      ...(prior?.notified ? { notified: true } : {}),
    };
    return prior ? { silent: true } : { quiet: true };
  }

  /** A ready task waiting for its base checkout to be clean (TaskRecord.baseWait). */
  protected waitsForBase(task: TaskRecord): boolean {
    return task.state === 'ready' && task.blocker?.kind === 'dirty-base' && !!task.baseWait;
  }

  /**
   * Its time to look at the base checkout came: clean → the pipeline runs again as it was asked;
   * still dirty → it looks again later, tells the user once after TASK_BASE_WAIT_NOTIFY_MS
   * (nothing to do: it goes on by itself) and gives up after TASK_BASE_WAIT_MAX_MS. A base that
   * is another open task's branch waits for that task (releaseDependents), not for a clean tree:
   * its agent commits as it goes.
   */
  protected async lookAtBase(task: TaskRecord): Promise<void> {
    const wait = task.baseWait;
    if (!wait || !task.repoPath || !task.baseBranch) return;
    let dirty = true;
    // Timers may fire again while git answers: one look at a time.
    this.lookingAtBase.add(task.id);
    try {
      if (!this.baseOwner(task)) {
        dirty = await (this.deps.baseDirty ?? baseCheckoutDirty)(
          task.repoPath,
          task.baseBranch,
          task.branch ?? task.baseBranch
        ).catch((error) => {
          this.deps.onError?.(`Task ${task.id}: could not look at ${task.baseBranch}`, error);
          return true;
        });
      }
    } finally {
      this.lookingAtBase.delete(task.id);
    }
    if (!this.waitsForBase(task) || task.baseWait !== wait || this.piping.has(task.id)) return;
    const now = this.now();
    if (!dirty) {
      this.deps.onError?.(`Task ${task.id}: ${task.baseBranch} is clean again, merging it`);
      const { readyNote, mode, ...merge } = wait.run;
      this.track(this.pipe(task, mode, merge, readyNote));
      return;
    }
    const waited = now - Date.parse(wait.since);
    const hours = Math.max(1, Math.round(waited / 3_600_000));
    if (waited >= TASK_BASE_WAIT_MAX_MS) {
      delete task.baseWait;
      const blocker = task.blocker as TaskBlocker;
      this.setState(task, 'needs_you', {
        ...blocker,
        message: `${blocker.message} (Untether waited ${hours} hours for it to be clean)`,
      });
      this.save();
      this.notifyState(task, '');
      return;
    }
    wait.nextAt = new Date(now + (this.deps.baseWaitPollMs ?? BASE_WAIT_POLL_MS)).toISOString();
    if (!wait.notified && waited >= TASK_BASE_WAIT_NOTIFY_MS) {
      wait.notified = true;
      this.notifyState(task, '', {
        notice: 'base-wait',
        body: `${task.baseBranch} has had uncommitted changes for ${hours} hours, so this task is not merged yet. Nothing to do: Untether merges it as soon as ${task.baseBranch} is clean.`,
      });
    }
    this.save();
  }

  /** The pipeline run as asked, recorded (task journal) until where it ends is saved. */
  protected recordPipeline(task: TaskRecord, run: TaskPipelineRun): void {
    beginEffect(task, {
      kind: 'pipeline',
      key: 'pipeline',
      at: new Date(this.now()).toISOString(),
      run,
    });
  }

  /**
   * The pipeline stopped on an error of Untether's own, not of the task (TaskBlocker.internal):
   * it runs again by itself, the same way (`run`, its pipeline step kept), after each of
   * INTERNAL_RETRY_DELAYS_MS, with the task still verifying/merging and nobody told. Returns
   * undefined when a retry is scheduled, else the blocker the user gets: it is Untether's.
   */
  protected retryInternal(
    task: TaskRecord,
    run: TaskPipelineRun,
    error: string
  ): TaskBlocker | undefined {
    const delays = this.deps.internalRetryDelaysMs ?? INTERNAL_RETRY_DELAYS_MS;
    const attempts = task.internalRetry?.attempts ?? 0;
    if (attempts < delays.length) {
      const delay = delays[attempts];
      task.internalRetry = { attempts: attempts + 1, error };
      task.internalRetryAt = new Date(this.now() + delay).toISOString();
      this.recordPipeline(task, run);
      if (task.state !== 'verifying' && task.state !== 'merging') this.setState(task, 'verifying');
      this.deps.onError?.(
        `Task ${task.id}: the pipeline stopped on an error of Untether's own, running it again in ${Math.round(delay / 1000)} s (${attempts + 1}/${delays.length}): ${error}`
      );
      this.save();
      this.arm();
      return undefined;
    }
    delete task.internalRetry;
    delete task.internalRetryAt;
    this.deps.onError?.(
      `Task ${task.id}: the pipeline still stops on an error of Untether's own after ${attempts} retries, the user is told: ${error}`
    );
    return {
      kind: 'merge-error',
      internal: true,
      message: `An error inside Untether (not in the task) stopped the merge: ${error}`,
      detail: [error, `Untether ran it again ${attempts} times by itself; see merge.log`],
    };
  }

  /** "Quedarme con este" went through: the rest of its group is thrown away. */
  protected async discardSiblings(kept: TaskRecord): Promise<void> {
    // After `finally` drops it from `piping`.
    await Promise.resolve();
    const siblings = this.tasks.filter(
      (entry) => entry.groupId === kept.groupId && entry.id !== kept.id && !isFinal(entry)
    );
    for (const sibling of siblings) {
      const result = await this.discard(sibling.id, { confirm: true });
      if (!result.ok) {
        this.deps.onError?.(`task ${sibling.id}: not discarded after keeping ${kept.id}`, result);
      }
    }
  }

  /**
   * A security task that passed its pipeline merges on its own (after a countdown): a safe
   * bump or a confirmed fix, whose diff the adversarial reviewer also passes (for a bump: the
   * upgrade is safe). Never while the project holds automatic merges (policy ask, the circuit
   * breaker's pause, the sweep paused).
   */
  protected async securityMerges(
    task: TaskRecord,
    settings: ProjectSettings,
    run: TaskPipelineRun
  ): Promise<boolean> {
    if (securityMergeHeld(settings, this.now())) return false;
    const bump = task.security?.kind === 'supply';
    const ready = bump ? bumpReadyForReview(task, settings) : fixReadyForReview(task, settings);
    if (!ready || !this.deps.securityFixReview) return false;
    const security = task.security as TaskSecurity;
    // A review that could not run is tried again on the next run (2026-10-24: a re-check the
    // user asked for kept the old 'unavailable' and the task waited for a tap).
    if (
      security.fixReview?.headSha !== task.headSha ||
      security.fixReview?.verdict === 'unavailable'
    ) {
      // Shown as reviewing while the adversarial reviewer reads the fix. The pipeline run is
      // kept with it (2026-10-23 review): a restart meanwhile runs the pipeline again, and the
      // fix is reviewed again, instead of leaving it verifying for good.
      task.reviewing = true;
      this.recordPipeline(task, run);
      this.setState(task, 'verifying');
      this.save();
      const started = this.now();
      const look = await this.deps
        .securityFixReview(this.copy(task))
        .catch((error) => ({ verdict: 'unavailable' as const, reason: String(error) }));
      this.stamp(task, 'risk-review', started, `security: ${look.verdict}`);
      delete task.reviewing;
      endEffect(task, 'pipeline');
      // Merged, discarded or taken elsewhere by the user meanwhile: nothing to decide here.
      if (task.state !== 'verifying') {
        this.save();
        return false;
      }
      security.fixReview = { ...look, ...(task.headSha ? { headSha: task.headSha } : {}) };
      this.setState(task, 'ready');
    }
    return bump ? bumpMergesOnItsOwn(task, settings) : fixMergesOnItsOwn(task, settings);
  }

  /**
   * A risky task (shared/security.ts riskReadyForReview) merges on its own after a countdown
   * when the second review confirms, on this commit and for these findings, that the change
   * weakens no auth, permission, secrets handling or session isolation (2026-10-24). Its verdict
   * is kept on the task (riskReview): the same commit is not reviewed twice, a new one is.
   */
  protected async riskMerges(
    task: TaskRecord,
    settings: ProjectSettings,
    run: TaskPipelineRun
  ): Promise<boolean> {
    if (!this.reviewsRisk(task, settings) || !riskReadyForReview(task, settings)) return false;
    const review = this.deps.riskReview;
    if (!review) return false;
    const look = task.riskReview;
    const seen =
      look &&
      look.verdict !== 'unavailable' &&
      look.headSha === task.headSha &&
      (task.risk ?? []).every((finding) =>
        (look.risk ?? []).some((had) => had.rule === finding.rule && had.file === finding.file)
      );
    if (!seen) {
      // Shown as reviewing meanwhile; a restart runs the pipeline (and this review) again.
      task.reviewing = true;
      this.recordPipeline(task, run);
      this.setState(task, 'verifying');
      this.save();
      const started = this.now();
      const ruling = await review(this.copy(task)).catch(
        (error): TaskRiskReview => ({ verdict: 'unavailable', reason: String(error) })
      );
      this.stamp(task, 'risk-review', started, ruling.verdict);
      delete task.reviewing;
      endEffect(task, 'pipeline');
      // Merged, discarded or taken elsewhere by the user meanwhile: nothing to decide here.
      if (task.state !== 'verifying') {
        this.save();
        return false;
      }
      task.riskReview = {
        verdict: ruling.verdict,
        reason: ruling.reason,
        ...(task.headSha ? { headSha: task.headSha } : {}),
        risk: (task.risk ?? []).map(({ rule, file }) => ({ rule, file })),
      };
      this.deps.onError?.(
        `Task ${task.id}: second review of its risky change: ${ruling.verdict} (${ruling.reason})`
      );
      this.setState(task, 'ready');
    }
    return riskMergesOnItsOwn(task, settings, this.now());
  }

  /**
   * Whether a risky task of this project may go to the second review at all: a reviewer, a
   * worktree task that merges on its own (policy auto, no group), never a revert or a security
   * task, the project's automatic merges not held (policy ask, circuit breaker, sweep paused).
   */
  protected reviewsRisk(task: TaskRecord, settings: ProjectSettings | undefined): boolean {
    return (
      !!this.deps.riskReview &&
      !!settings &&
      !task.revertOf &&
      !task.security &&
      this.mergesOnItsOwn(task) &&
      !securityMergeHeld(settings, this.now())
    );
  }

  /**
   * A risky task waits for the user: needs_you with its findings, as before, and what the second
   * review said when it did not confirm this commit (TaskRecord.riskReview).
   */
  protected holdRisk(task: TaskRecord): void {
    const blocker = riskBlocker(
      (task.risk ?? []).map((finding) => ({
        rule: finding.rule as RiskRule,
        ...(finding.file ? { file: finding.file } : {}),
        detail: finding.detail ?? '',
      }))
    );
    const said = riskReviewSaid(task);
    this.setState(task, 'needs_you', {
      ...blocker,
      ...(said ? { detail: [said, ...(blocker.detail ?? [])] } : {}),
    });
  }

  /** «Parar», a countdown whose gates no longer hold: the task waits for the user. */
  protected holdForUser(task: TaskRecord): void {
    const approved = task.autoApprovedMerge;
    if (approved && !approved.done) {
      // What it stopped for before autoApprove counted it down (a review-unavailable one goes
      // back to its retries); not counted down again for this commit.
      approved.done = true;
      this.setState(task, approved.state, approved.blocker);
    } else if (task.security) this.holdSecurity(task);
    else this.holdRisk(task);
  }

  /** A security task waits for the user: needs_you, with what it is and its fix. */
  protected holdSecurity(task: TaskRecord): void {
    const look = task.security?.fixReview;
    this.setState(task, 'needs_you', {
      kind: 'security',
      message:
        task.security?.headline ??
        'A security fix two reviewers confirmed is ready: merge it if you agree',
      ...(look && look.verdict !== 'confirmed' && look.reason
        ? {
            detail: [`${task.security?.kind === 'supply' ? 'Bump' : 'Fix'} review: ${look.reason}`],
          }
        : {}),
    });
  }

  /**
   * autoApprove may stand in for the user's merge OK on this project now: the setting is on
   * and the project holds nothing back (a security task: policy ask, the circuit breaker's
   * pause, the sweep paused; any other: it merges on its own, policy auto and no group, and
   * auto-merge is not paused).
   */
  protected autoApproveAllowed(task: TaskRecord, settings: ProjectSettings): boolean {
    if (!this.deps.autoApprove?.()) return false;
    if (task.isolation !== 'worktree' || !task.branch || task.groupId) return false;
    return task.security
      ? !securityMergeHeld(settings, this.now())
      : this.mergesOnItsOwn(task) && !autoMergePaused(settings, this.now());
  }

  /**
   * The task stopped only because it needs the user's merge OK, and autoApprove gives it: risky
   * changes, a held security fix, no check, a review that still could not run after Untether's
   * retries for hours (the user would be told now). Once per commit: «Parar» holds it.
   */
  protected autoApprovesMerge(task: TaskRecord, settings: ProjectSettings): boolean {
    if (task.state !== 'ready' && task.state !== 'needs_you') return false;
    if (task.autoMergeAt || !heldOnlyForMergeOk(task)) return false;
    if (task.autoApprovedMerge?.done && task.autoApprovedMerge.headSha === task.headSha) {
      return false;
    }
    return this.autoApproveAllowed(task, settings);
  }

  /** Counted down instead of waiting: ready, its blocker kept aside for «Parar». */
  protected approveMerge(task: TaskRecord): void {
    const blocker = task.blocker as TaskBlocker;
    task.autoApprovedMerge = {
      blocker,
      state: task.state === 'needs_you' ? 'needs_you' : 'ready',
      ...(task.headSha ? { headSha: task.headSha } : {}),
      at: new Date(this.now()).toISOString(),
    };
    this.setState(task, 'ready');
  }

  /**
   * The user just turned autoApprove on: tasks already waiting only for their merge OK count
   * down now, as if they had stopped after it was on.
   */
  approveHeldMerges(): void {
    for (const task of this.tasks) {
      if (this.piping.has(task.id) || isFinal(task) || !task.repoPath) continue;
      const settings = this.deps.settings?.get(task.repoPath);
      if (!settings || !this.autoApprovesMerge(task, settings)) continue;
      this.approveMerge(task);
      this.startCountdown(task, settings);
    }
  }

  /** «Se fusiona a las HH:MM»: the push, then the merge when the time comes (fireDue). */
  protected startCountdown(task: TaskRecord, settings: ProjectSettings): void {
    const at = this.now() + securityConfig(settings).autoMergeDelayMin * 60_000;
    task.autoMergeAt = new Date(at).toISOString();
    this.save();
    this.arm();
    const clock = new Date(at).toTimeString().slice(0, 5);
    const approved = task.autoApprovedMerge;
    if (approved && !approved.done) {
      this.deps.onError?.(
        `Task ${task.id}: held for the user's OK (${approved.blocker.kind}), autoApprove is on, merging at ${clock}`
      );
      this.notifyState(
        task,
        `Merges on its own at ${clock} (autoApprove): ${task.name}. It was waiting for your OK: ${approved.blocker.message}`,
        { notice: 'auto-merge' }
      );
      return;
    }
    if (task.security) {
      this.deps.onError?.(`Task ${task.id}: every security gate holds, merging at ${clock}`);
      this.notifyState(
        task,
        `Merges on its own at ${clock}: ${task.security.headline ?? task.name}`,
        { notice: 'auto-merge' }
      );
      return;
    }
    // A risky task: what merges and why it was flagged (2026-10-24).
    this.deps.onError?.(
      `Task ${task.id}: risky, the second review confirmed it, merging at ${clock}`
    );
    this.notifyState(
      task,
      `Merges on its own at ${clock}: ${task.name}. Flagged as risky (${riskFilesOf(task)}); a second review found nothing weakened`,
      { notice: 'auto-merge' }
    );
  }

  /**
   * Fast lane (2026-11-01): `ut task priority <id> urgent|normal`, the card's «Urgente». An
   * urgent task goes ahead in the merge queue and takes the next free check slot first; it
   * still passes the whole check and the review. Waiting in a line now, it moves at once.
   */
  setPriority(id: string, urgent: boolean): TaskActionResult {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (isFinal(task)) return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    if (urgent) task.urgent = true;
    else delete task.urgent;
    // Waiting to start: first of its project's line, and first among projects for room.
    if (task.state === 'queued') this.requestPump();
    if (task.mergeQueue && task.repoPath && task.baseBranch) {
      (this.deps.mergeQueue ?? mergeQueue).prioritize(
        mergeQueueKey(task.repoPath, task.baseBranch),
        task.id,
        mergePriorityOf(task)
      );
    }
    this.save();
    return { ok: true, task: this.copy(task) };
  }

  /**
   * «Parar» (2026-10-23): a security or risky task counting down to its merge waits for the
   * user instead. Not counting down: not-open.
   */
  holdAutoMerge(id: string): TaskActionResult {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (!task.autoMergeAt || task.state !== 'ready') {
      return { ok: false, code: 'not-open', message: 'The task is not about to merge on its own' };
    }
    delete task.autoMergeAt;
    this.holdForUser(task);
    this.save();
    this.arm();
    return { ok: true, task: this.copy(task) };
  }

  /**
   * A security sweep's search ended (security-sweep.ts reads what it found): never a merge,
   * never a push. Its findings file is not its work and is never committed.
   */
  protected async finishSweep(task: TaskRecord, options: { exited?: boolean }): Promise<void> {
    if (isFinal(task)) return;
    if (!task.summary && task.sessionId) {
      const report = await this.reportOf(task.sessionId, task);
      if (report) task.summary = report.slice(0, TASK_REPORT_MAX);
    }
    if (isFinal(task)) return;
    task.finishedAt = new Date(this.now()).toISOString();
    if (options.exited && !task.summary) {
      this.fail(task, 'session-exit', 'The session ended before the sweep reported');
    } else {
      this.setState(task, 'ready');
    }
    this.save();
  }

  /** A worktree task that merges by itself when all is well (policy auto, not a group). */
  protected mergesOnItsOwn(task: TaskRecord): boolean {
    if (task.isolation !== 'worktree' || task.groupId) return false;
    const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
    return (task.mergePolicy ?? settings?.mergePolicy ?? 'auto') === 'auto';
  }

  /**
   * A revert task's worktree is ready: the merged task's commits are reverted in it with git,
   * no agent needed, and the pipeline (check, AI review) merges it. True when an agent is to
   * resolve it after all (the revert conflicts): it starts with the conflict in its prompt.
   */
  protected async runRevert(task: TaskRecord): Promise<boolean> {
    const revert = task.revertOf as NonNullable<TaskRecord['revertOf']>;
    const original = this.tasks.find((entry) => entry.id === revert.taskId);
    const message = `Undo: ${original?.name ?? revert.taskId}\n\nReverses what Untether task ${revert.taskId.slice(0, 8)} merged into ${task.baseBranch ?? 'its base'} (${revert.from.slice(0, 8)}..${revert.to.slice(0, 8)}).`;
    const result = await (this.deps.revertCommits ?? revertRange)(
      task.worktreePath as string,
      { from: revert.from, to: revert.to },
      message
    ).catch(
      (error): RevertResult => ({ ok: false, conflict: false, message: String(error), files: [] })
    );
    if (isFinal(task)) return false;
    if (!result.ok && result.conflict) {
      const note = `Untether ran it by itself first and it conflicted in:\n${result.files.map((file) => `- ${file}`).join('\n')}`;
      // Started over after a restart (cutWhileStarting): the conflict is said once.
      if (!task.prompt.includes(note)) task.prompt = `${task.prompt}\n\n${note}`;
      this.save();
      return true;
    }
    if (!result.ok) {
      this.fail(task, 'merge-error', result.message, result.files);
      this.save();
      this.notifyState(task, result.message);
      return false;
    }
    const now = new Date(this.now()).toISOString();
    task.startedAt = now;
    task.finishedAt = now;
    task.summary = `Undid "${original?.name ?? revert.taskId}": the change its merge made to ${task.baseBranch ?? 'its base'} (${result.commits} commit(s)) was reversed with git.`;
    task.report = {
      verified:
        "the reverse of the merge's diff applied cleanly with git apply --3way; the project's check and the AI review run next",
      undo: `Revert this commit again (it brings back ${original?.name ?? 'the task'})`,
    };
    try {
      const changes = await this.worktrees.changes(task);
      task.files = changes.files;
      task.stats = changes.stats;
    } catch (error) {
      this.deps.onError?.(`task ${task.id}: could not read its changes`, error);
    }
    this.setState(task, 'verifying');
    this.save();
    // The user asked for the undo ("Deshacer"): risk findings of a revert are expected.
    this.track(this.pipe(task, 'merge', { acceptRisk: true }));
    return false;
  }

  /** A ready task whose unavailable AI review is to be tried again. */
  protected waitsForReview(task: TaskRecord): boolean {
    return (
      task.state === 'ready' &&
      task.blocker?.kind === 'review-unavailable' &&
      !!task.reviewRetry &&
      !!task.reviewRetryAt
    );
  }

  /** A task whose pipeline waits to run again after an error of Untether's own. */
  protected waitsForInternalRetry(task: TaskRecord): boolean {
    return (
      (task.state === 'verifying' || task.state === 'merging') &&
      !!task.internalRetryAt &&
      !!pendingEffect(task, 'pipeline')
    );
  }
}
