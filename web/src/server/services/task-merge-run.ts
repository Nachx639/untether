/**
 * The merge pipeline's entry: one run of a task, with or without a worktree, in its turn.
 */

import * as path from 'path';
import { formatPhaseDuration } from '../../shared/task-timings.js';
import type { TaskPhaseTiming } from '../../shared/tasks.js';
import { type MergeTicket, mergeQueue, mergeQueueKey } from './merge-queue.js';
import { finishIfInBase, finishMerged, ownWorkMerged } from './task-merge-base.js';
import { isAncestor, MergeLog } from './task-merge-log.js';
import { pipelineLoop } from './task-merge-loop.js';
import { leaveBatch } from './task-merge-train.js';
import type {
  BuiltOnBatch,
  PipelineContext,
  PipelineOptions,
  PipelineResult,
  PipelineTask,
  QueuePlace,
} from './task-merge-types.js';

/**
 * Run the pipeline for one task. Never throws: anything unexpected is an error of Untether's
 * own (git, the check and the review have their own blockers above), marked internal so the
 * scheduler runs it again by itself instead of asking the user (2026-10-23: a server reload
 * with a half edited task-verify.ts left a task needs_you "os is not defined").
 */
export async function runTaskPipeline(
  task: PipelineTask,
  options: PipelineOptions
): Promise<PipelineResult> {
  const log = new MergeLog(path.join(options.logDir, 'merge.log'));
  const now = options.now ?? Date.now;
  log.write(`\n# ${new Date(now()).toISOString()} ${options.mode} ${task.branch ?? ''}`);
  const round = options.round ?? 1;
  let closed = false;
  const ctx: PipelineContext = {
    timings: [],
    checks: { runs: 0, runMs: 0, reused: 0, savedMs: 0, loadFailed: 0 },
    stamp(phase, start, outcome, level, endAt) {
      const end = endAt ?? now();
      const timing: TaskPhaseTiming = {
        phase,
        startedAt: new Date(start).toISOString(),
        finishedAt: new Date(end).toISOString(),
        round,
        ...(outcome ? { outcome } : {}),
        ...(level ? { level } : {}),
      };
      log.write(
        `# phase ${phase}${level ? ` (${level})` : ''} (round ${round}): ${formatPhaseDuration(end - start)}${outcome ? `, ${outcome}` : ''}`
      );
      if (!closed) ctx.timings.push(timing);
      return timing;
    },
  };
  const ended = (result: PipelineResult): PipelineResult => {
    closed = true;
    const counted = ctx.checks.runs || ctx.checks.reused || ctx.checks.loadFailed;
    return {
      ...result,
      ...(ctx.timings.length ? { timings: [...ctx.timings] } : {}),
      ...(counted ? { checks: { ...ctx.checks } } : {}),
    };
  };
  let result: PipelineResult;
  try {
    result = await pipeline(task, options, log, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const where = error instanceof Error ? error.stack?.split('\n')[1]?.trim() : undefined;
    log.write(`# error of Untether's own: ${message}${where ? ` (${where})` : ''}`);
    result = {
      state: 'needs_you',
      blocker: {
        kind: 'merge-error',
        internal: true,
        message: 'Merging stopped on an error of Untether',
        detail: [message],
      },
    };
  }
  // 2026-10-31: no merge error is declared for a task whose work is in its base already (a
  // restart cut its merge short; its folder went meanwhile): it is merged, cleanup and all.
  if (mergeErrorToCheck(result)) {
    try {
      const merged = await finishIfInBase(task, options, log);
      if (merged) {
        log.write(`# not a merge error: ${result.blocker?.message} (the work is in the base)`);
        result = merged;
      }
    } catch (error) {
      log.write(`# could not look for the work in the base: ${error}`);
    }
  }
  return ended(result);
}

/**
 * A merge-error the pipeline was about to report, unless the task's work is in its base. Not
 * the one finishMerged gives when work was left behind (mergedSha set): that one is right.
 */
function mergeErrorToCheck(result: PipelineResult): boolean {
  if (result.blocker?.kind !== 'merge-error' || result.mergedSha) return false;
  return result.state === 'failed' || result.state === 'needs_you';
}

async function pipeline(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  ctx: PipelineContext
): Promise<PipelineResult> {
  const queue = options.mergeQueue ?? mergeQueue;
  const now = options.now ?? Date.now;
  const key = task.repoPath && task.baseBranch ? mergeQueueKey(task.repoPath, task.baseBranch) : '';
  // After a restart the run takes its old place (the time it first joined).
  const since = task.mergeQueue?.since ?? new Date(now()).toISOString();
  const at = Number.isFinite(Date.parse(since)) ? Date.parse(since) : now();
  let unsubscribe: (() => void) | undefined;
  let shown = '';
  const show = (ticket: MergeTicket) => {
    const spot = ticket.spot();
    if (!spot) return;
    const text = `${spot.position}/${spot.of}/${spot.priority ?? ''}`;
    if (text === shown) return;
    shown = text;
    options.onProgress?.({
      state: 'merge-queue',
      spot: { ...spot, since },
    });
  };
  const place: QueuePlace = {
    holding: false,
    join() {
      if (place.ticket) return place.ticket;
      const priority = options.mergePriority?.();
      const ticket = queue.join(key, { id: task.id, at, ...(priority ? { priority } : {}) });
      place.ticket = ticket;
      unsubscribe = queue.onChange((changed) => {
        if (changed === key) show(ticket);
      });
      show(ticket);
      return ticket;
    },
    leave() {
      unsubscribe?.();
      unsubscribe = undefined;
      place.ticket?.leave();
      place.ticket = undefined;
      place.holding = false;
      shown = '';
      options.onProgress?.({ state: 'merge-queue' });
    },
  };
  try {
    return await pipelineSteps(task, options, log, ctx, place);
  } finally {
    unsubscribe?.();
    if (place.ticket) {
      place.ticket.leave();
      options.onProgress?.({ state: 'merge-queue' });
    }
  }
}

/**
 * 2026-11-10: a task that built on the merge batch's tip and ended its pass before boarding (its
 * related tests failed, the review blocked it, a risk waited for the user) kept the other tasks'
 * commits on its branch, and nothing took them out: when that batch did not merge, its next pass
 * carried them to the base, or it was blamed for their break. However the pass ends, the branch
 * goes back to the task's own work unless the batch is in the base by then.
 */
async function pipelineSteps(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  ctx: PipelineContext,
  place: QueuePlace
): Promise<PipelineResult> {
  const batch: { built?: BuiltOnBatch } = {};
  const result = await pipelineLoop(task, options, log, ctx, place, batch);
  if (batch.built) {
    const why = await leaveBatch(task, log, batch.built);
    // Its refs stay: the next run (undoTrainLeftover) says why it cannot go on.
    if (why) log.write(`# merge batch: ${why}; refs kept`);
  }
  return result;
}

/** The worktree folder is gone: merged if its branch is in the base, else nothing to do. */
export async function withoutWorktree(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  baseNow: string
): Promise<PipelineResult> {
  const { repoPath, branch } = task;
  const tip = await log.gitOut(repoPath as string, [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}^{commit}`,
  ]);
  if (tip && (await ownWorkMerged(log, repoPath as string, task, tip, baseNow))) {
    return finishMerged(task, options, log, tip, baseNow);
  }
  // A rerun after the cleanup went through but before "merged" was saved.
  if (
    !tip &&
    task.mergedSha &&
    (await isAncestor(log, repoPath as string, task.mergedSha, baseNow))
  ) {
    return finishMerged(task, options, log, task.mergedSha, baseNow);
  }
  return {
    state: 'failed',
    blocker: {
      kind: 'merge-error',
      message: tip ? "The task's folder is gone" : "The task's folder and branch are gone",
    },
  };
}
