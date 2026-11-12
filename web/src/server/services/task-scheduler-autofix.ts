/**
 * Auto-fix rounds: a check, review or conflict the agent fixes on its own, how many rounds are
 * left, fresh conflicts and late reviews.
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import { conflictMetrics } from '../../shared/task-metrics.js';
import { currentRound, withTimings } from '../../shared/task-timings.js';
import {
  autoFixRounds,
  reviewBlocks,
  TASK_AUTO_FIX_MAX,
  TASK_AUTO_FIX_TOTAL_MAX,
  TASK_CONFLICT_FRESH_MAX,
  type TaskAutoFixReason,
  type TaskBlocker,
  type TaskPhaseTiming,
  type TaskPipelineRun,
  type TaskRecord,
  type TaskReview,
} from '../../shared/tasks.js';
import { TaskSchedulerFinish } from './task-scheduler-finish.js';
import {
  autoFixPrompt,
  conflictOf,
  lateReviewPrompt,
  sameConflict,
} from './task-scheduler-prompts.js';
import {
  budgeted,
  isFinal,
  noteReview,
  REVIEW_RETRY_DELAYS_MS,
  REVIEW_UNAVAILABLE_NOTIFY_MS,
} from './task-scheduler-rules.js';

export abstract class TaskSchedulerAutoFix extends TaskSchedulerFinish {
  /**
   * Untether may hand `reason` back to the agent once more: at most TASK_AUTO_FIX_MAX times per
   * reason and TASK_AUTO_FIX_TOTAL_MAX rounds in all.
   */
  protected autoFixLeft(task: TaskRecord, reason: TaskAutoFixReason): boolean {
    // A conflict new to the task (the base moved on) is not a failed fix (freshConflict).
    if (reason === 'conflict' && this.freshConflict(task, task.blocker)) return true;
    const used = task.autoFixes?.[reason] ?? 0;
    return used < TASK_AUTO_FIX_MAX && autoFixRounds(task) < TASK_AUTO_FIX_TOTAL_MAX;
  }

  /**
   * A conflict that is not the one last handed back (another base: other tasks merged since;
   * or other files): new work for the agent, not a failed fix, and not a round of its budget
   * (2026-11-01: four tasks merging in parallel gave one a new conflict after each resolution;
   * it ran out of fixes three times and spent 5 of its 6 rounds). Only the same conflict again
   * counts; past TASK_CONFLICT_FRESH_MAX new ones they count too, so a base that never stops
   * moving cannot loop.
   */
  protected freshConflict(task: TaskRecord, blocker: TaskBlocker | undefined): boolean {
    if (blocker?.kind !== 'conflict') return false;
    if ((task.freshConflicts ?? 0) >= TASK_CONFLICT_FRESH_MAX) return false;
    return !task.lastConflict || !sameConflict(task.lastConflict, conflictOf(blocker));
  }

  /**
   * The automatic fixes ran out: noted for the circuit breaker, and what the user is told
   * (once).
   */
  protected gaveUp(task: TaskRecord): string {
    delete task.autoFix;
    task.autoFixGaveUpAt = new Date(this.now()).toISOString();
    if (task.repoPath) this.checkBreaker(task.repoPath);
    const rounds = autoFixRounds(task);
    // Worded exactly so: the phone matches it to translate it.
    return `Untether had its agent fix it ${rounds} times and it still does not merge: ${task.blocker?.message ?? ''}`;
  }

  /**
   * Untether hands its blockers back to its agent by itself: a task that merges on its own,
   * or a security fix (it still waits for the user to merge, but arrives checked).
   */
  protected fixesOnItsOwn(task: TaskRecord): boolean {
    if (task.security && task.security.kind !== 'sweep' && task.isolation === 'worktree') {
      return true;
    }
    return this.mergesOnItsOwn(task);
  }

  /**
   * The AI review of a commit whose check failed first (the pipeline handed the failure back
   * without waiting for it, 2026-10-31). Kept while that commit is the task's: the same commit is not
   * reviewed again and the next commit gets only what changed since, with these findings.
   * Problems it found go to the agent at once when it is already fixing that commit's check,
   * so one round answers both.
   */
  protected lateReview(task: TaskRecord, review: TaskReview, timing: TaskPhaseTiming): void {
    task.timings = withTimings(task.timings, [timing]);
    // A newer commit's run sets headSha (and its own review) when it ends: this one is then old.
    const current = !isFinal(task) && !!review.headSha && review.headSha === task.headSha;
    if (!current) {
      this.save();
      return;
    }
    noteReview(task, review);
    if (review.verdict === 'unavailable') {
      this.deps.onError?.(`task ${task.id}: AI review unavailable`, review.reason);
    }
    this.save();
    // Handed back already (the hand-back was written without it): it follows. Not yet: the
    // hand-back includes it (fixPrompt).
    if (reviewBlocks(review) && task.autoFix?.reason === 'verify') {
      void this.deliverText(task, lateReviewPrompt(review), 'auto', true).catch((error) =>
        this.deps.onError?.(`task ${task.id}: could not send the late review`, error)
      );
    }
  }

  /**
   * The auto-fix loop (2026-10-20, THE PRINCIPLE: the user is in the loop as little as
   * possible): a failed check, a conflict, a blocking review or a merge error the agent can fix
   * is handed back to the task's agent by Untether itself, at most TASK_AUTO_FIX_MAX times per
   * reason; the pipeline (and the review) runs again when the agent is done. Meanwhile the
   * user hears nothing; an orchestrator is told it has nothing to do. False when the agent
   * could not be reached (then the user is told as before).
   */
  protected async startAutoFix(task: TaskRecord, reason: TaskAutoFixReason): Promise<boolean> {
    const blocker = task.blocker;
    if (!blocker) return false;
    // Another round would go past the task's budget (or it is spent already): held, the task
    // waits for more budget instead (2026-11-01).
    const fresh = reason === 'conflict' && this.freshConflict(task, blocker);
    const over = budgeted(task) ? this.handBackOver(task, fresh) : [];
    if (over.length) {
      this.cutBudget(task, over, {
        handBack: {
          reason,
          state: task.state === 'needs_you' ? 'needs_you' : 'ready',
          blocker: { ...blocker },
        },
      });
      return true;
    }
    // A new conflict is no fix attempt: its count starts again at 0 (the fixes of the one
    // before it worked) and it takes nothing from TASK_AUTO_FIX_TOTAL_MAX (autoFixRounds);
    // only the same conflict again counts (2026-11-01 review).
    const attempts = fresh ? 1 : (task.autoFixes?.[reason] ?? 0) + 1;
    task.autoFixes = { ...(task.autoFixes ?? {}), [reason]: fresh ? 0 : attempts };
    task.autoFix = {
      attempts,
      max: TASK_AUTO_FIX_MAX,
      reason,
      at: new Date(this.now()).toISOString(),
      ...(fresh ? { baseMoved: true } : {}),
    };
    if (reason === 'conflict') {
      task.lastConflict = conflictOf(blocker);
      if (fresh) task.freshConflicts = (task.freshConflicts ?? 0) + 1;
    }
    this.save();
    // Its orchestrator hears it with "already being fixed"; the phone does not.
    this.notifyState(task, '', { quiet: true });
    const result = await this.deliverText(
      task,
      autoFixPrompt(task, blocker, attempts),
      'auto',
      true
    );
    if (result.ok) {
      this.deps.onError?.(
        `Task ${task.id}: ${reason} handed back to its agent (${attempts}/${TASK_AUTO_FIX_MAX})`
      );
      // Counted for the project's ledger: every conflict the merge handed back, new ones too.
      if (reason === 'conflict') conflictMetrics(this.metricsOf(task)).conflictRounds += 1;
      // Its round's time with the agent, closed when the pipeline runs again (endAgentPhase).
      task.timings = withTimings(task.timings, [
        {
          phase: reason === 'conflict' ? 'conflict' : 'fix',
          startedAt: task.autoFix.at,
          round: currentRound(task.timings),
          outcome: reason,
        },
      ]);
      this.save();
      return true;
    }
    delete task.autoFix;
    this.save();
    return false;
  }

  /**
   * The review could not run: tried again by itself after REVIEW_RETRY_DELAYS_MS (then hourly),
   * quietly; the user is told once when it is still unavailable after
   * REVIEW_UNAVAILABLE_NOTIFY_MS. Returns how the push for this outcome goes.
   */
  protected scheduleReviewRetry(
    task: TaskRecord,
    run: TaskPipelineRun
  ): { quiet?: boolean; silent?: boolean; body?: string } {
    const now = this.now();
    const prior = task.reviewRetry;
    const attempts = prior?.attempts ?? 0;
    const delays = this.deps.reviewRetryDelaysMs ?? REVIEW_RETRY_DELAYS_MS;
    const delay = delays[Math.min(attempts, delays.length - 1)] ?? 60 * 60_000;
    const since = prior?.since ?? new Date(now).toISOString();
    const tell = !prior?.notified && now - Date.parse(since) >= REVIEW_UNAVAILABLE_NOTIFY_MS;
    // A verify run only checked: the retry merges the way it was going to (as the policy
    // says, unless an earlier merge asked for more).
    const asked = run.mode === 'verify' ? (prior ?? { mode: 'auto' as const }) : run;
    task.reviewRetry = {
      attempts,
      since,
      mode: asked.mode === 'merge' ? 'merge' : 'auto',
      ...(asked.acceptRisk ? { acceptRisk: true } : {}),
      ...(asked.keep ? { keep: true } : {}),
      // 2026-10-20: lost here, so a retried orchestrator merge counted as the user's.
      ...(asked.byAgent ? { byAgent: true } : {}),
      ...(prior?.notified || tell ? { notified: true } : {}),
    };
    task.reviewRetryAt = new Date(now + delay).toISOString();
    this.arm();
    if (tell) {
      return {
        body: `The AI review has not been able to run for ${Math.round((now - Date.parse(since)) / 3_600_000)} hours, so it was not merged. Untether keeps trying every hour; you can also merge it anyway.`,
      };
    }
    // The first time, its orchestrator hears that there is nothing to do; then nobody.
    return attempts === 0 ? { quiet: true } : { silent: true };
  }
}
