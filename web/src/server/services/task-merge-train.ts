/**
 * Two-level checks: a task's car in the merge batch (merge-train.ts), boarding it and going
 * back to its own work.
 */

import { isSafeRefName } from '../utils/exec-file.js';
import type { mergeTrainsFor, TrainCar, TrainCheck, TrainVerdict } from './merge-train.js';
import type { moveBase } from './task-merge-base.js';
import { startCheck } from './task-merge-check.js';
import { isAncestor, type MergeLog } from './task-merge-log.js';
import type {
  BuiltOnBatch,
  PipelineContext,
  PipelineOptions,
  PipelineResult,
  PipelineTask,
  QueuePlace,
} from './task-merge-types.js';

/** Where a car of a merge batch keeps its own tip and its batch commit (restart-safe). */
function trainRefs(id: string): { own: string; car: string; onto: string } | null {
  if (!isSafeRefName(`untether/train/${id}/own`)) return null;
  return {
    own: `refs/untether/train/${id}/own`,
    car: `refs/untether/train/${id}/car`,
    onto: `refs/untether/train/${id}/onto`,
  };
}

export async function writeTrainRefs(
  log: MergeLog,
  repoPath: string,
  id: string,
  built: { own: string; car: string; onto?: string }
): Promise<void> {
  const refs = trainRefs(id);
  if (!refs) return;
  await log.git(repoPath, ['update-ref', refs.own, built.own]);
  await log.git(repoPath, ['update-ref', refs.car, built.car]);
  if (built.onto) await log.git(repoPath, ['update-ref', refs.onto, built.onto]);
  else await log.git(repoPath, ['update-ref', '-d', refs.onto]);
}

async function dropTrainRefs(log: MergeLog, repoPath: string, id: string): Promise<void> {
  const refs = trainRefs(id);
  if (!refs) return;
  await log.git(repoPath, ['update-ref', '-d', refs.own]);
  await log.git(repoPath, ['update-ref', '-d', refs.car]);
  await log.git(repoPath, ['update-ref', '-d', refs.onto]);
}

/**
 * The branch out of the batch it built on (see BuiltOnBatch): nothing to undo when that batch
 * is in the base; else back to its own work. Null when done (its refs go), else why not (they stay).
 */
export async function leaveBatch(
  task: PipelineTask,
  log: MergeLog,
  built: BuiltOnBatch
): Promise<string | null> {
  const repoPath = task.repoPath as string;
  if (!(await isAncestor(log, repoPath, built.onto, `refs/heads/${task.baseBranch}`))) {
    const why = await backToOwnWork(task, log, built.own, built.car);
    if (why) return why;
  }
  await dropTrainRefs(log, repoPath, task.id);
  return null;
}

/**
 * Its branch back to its own work after a merge batch it was in did not merge it: what it built
 * on (other cars' work, not in the base) must not reach the base through it. Only when the
 * worktree is still at the batch commit; null when done (or nothing to do), else why not.
 */
async function backToOwnWork(
  task: PipelineTask,
  log: MergeLog,
  own: string,
  car: string
): Promise<string | null> {
  const wt = task.worktreePath as string;
  const headNow = await log.gitOut(wt, ['rev-parse', 'HEAD']);
  if (headNow === car) {
    // 2026-11-10: the reset threw away tracked files edited since (the agent at work while the
    // batch was checked). They stay, and the task says so.
    const edited = await log.gitOut(wt, ['status', '--porcelain', '--untracked-files=no']);
    if (edited === null || edited) {
      return `${task.branch} has uncommitted changes on top of a merge batch that did not merge`;
    }
    const reset = await log.git(wt, ['reset', '--hard', '-q', own]);
    if (reset.code !== 0) return `Could not take ${task.branch} back to its own work`;
    log.write(`# merge batch: ${task.branch} back to its own work ${own}`);
    return null;
  }
  if (headNow && headNow !== own && (await isAncestor(log, wt, car, headNow))) {
    return `${task.branch} has commits on top of a merge batch that did not merge`;
  }
  return null;
}

/**
 * A restart cut a merge batch short (2026-11-02): the car's refs are still there. Merged
 * (the base has its batch commit): only the refs go. Else its branch goes back to its own work.
 */
export async function undoTrainLeftover(
  task: PipelineTask,
  log: MergeLog,
  baseRef: string
): Promise<PipelineResult | null> {
  const refs = trainRefs(task.id);
  const repoPath = task.repoPath as string;
  if (!refs) return null;
  const own = await log.gitOut(repoPath, ['rev-parse', '--verify', '--quiet', refs.own]);
  const car = await log.gitOut(repoPath, ['rev-parse', '--verify', '--quiet', refs.car]);
  if (!own || !car) return null;
  // The batch it built on is in the base (or its own batch commit is): nothing of anyone's left.
  const onto = await log.gitOut(repoPath, ['rev-parse', '--verify', '--quiet', refs.onto]);
  const inBase =
    (!!onto && (await isAncestor(log, repoPath, onto, baseRef))) ||
    (await isAncestor(log, repoPath, car, baseRef));
  if (!inBase) {
    const why = await backToOwnWork(task, log, own, car);
    if (why) {
      return {
        state: 'needs_you',
        blocker: { kind: 'merge-error', message: why, detail: [`its own work: ${own}`] },
      };
    }
  }
  await dropTrainRefs(log, repoPath, task.id);
  return null;
}

interface BoardArgs {
  task: PipelineTask;
  options: PipelineOptions;
  log: MergeLog;
  ctx: PipelineContext;
  key: string;
  trains: ReturnType<typeof mergeTrainsFor>;
  place: QueuePlace;
  /** Its own tip, before the batch's tip was merged in. */
  own: string;
  /** What it took in from the batch on this or an earlier pass (undone instead of own/head). */
  built?: BuiltOnBatch;
  head: string;
  onto: string;
  main: string;
  level: 'related' | 'full';
  files: string[];
  fullCommand(files: string[]): string;
  record(): void;
  move(expected: string, sha: string): ReturnType<typeof moveBase>;
}

/** On board the merge batch (merge-train.ts) and wait for its verdict. */
export async function boardTrain(a: BoardArgs): Promise<TrainVerdict> {
  const { task, options, log, ctx, head } = a;
  const repoPath = task.repoPath as string;
  await writeTrainRefs(log, repoPath, task.id, a.built ?? { own: a.own, car: head });
  const car: TrainCar = {
    id: task.id,
    head,
    onto: a.onto,
    level: a.level,
    files: a.files,
    signal: options.signal,
    note: (text) => log.write(text),
    async fullCheck(files): Promise<TrainCheck> {
      const command = a.fullCommand(files);
      const started = startCheck(task, options, log, ctx, command, head, {
        level: 'batch',
        logName: 'verify-batch.log',
      });
      const verify = await started.done;
      if (verify.diskLow?.again) {
        return { passed: false, verify, internal: 'the disk was low while its whole check ran' };
      }
      if (verify.cancelled)
        return { passed: false, verify, internal: 'its whole check was stopped' };
      return { passed: verify.exitCode === 0 && !verify.timedOut, verify };
    },
    batchRan(run) {
      if (run.by !== task.id) ctx.stamp('verify', run.start, run.outcome, 'batch', run.end);
    },
    recordMove: () => a.record(),
    async move(expected, sha) {
      const moved = await a.move(expected, sha);
      if (moved.kind === 'blocked') {
        return {
          kind: 'blocked',
          reason: moved.result.blocker?.message ?? 'blocked',
          detail: moved.result,
        };
      }
      return moved;
    },
  };
  const boarding = a.trains.board(a.key, car, a.main);
  // Out of the merge queue: the next task takes its turn on top of this one.
  a.place.leave();
  log.write(`# merge batch: on board (${a.trains.cars(a.key).join(', ') || 'decided at once'})`);
  const verdict = await boarding;
  log.write(`# merge batch: ${verdict.kind}${'reason' in verdict ? ` (${verdict.reason})` : ''}`);
  if (verdict.kind !== 'merged') {
    const why = a.built
      ? await leaveBatch(task, log, a.built)
      : await backToOwnWork(task, log, a.own, head);
    if (why) {
      // The branch still holds the batch's commit: its refs stay, so the next run (or one after
      // a restart, undoTrainLeftover) takes it back to its own work or says why it can't.
      log.write(`# merge batch: ${why}; refs kept`);
      // The culprit keeps its verdict: its failure is what its agent must see.
      if (verdict.kind === 'failed' || verdict.kind === 'left') return verdict;
      return { kind: 'internal', reason: why };
    }
  }
  await dropTrainRefs(log, repoPath, task.id);
  return verdict;
}
