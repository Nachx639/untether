/**
 * The merge pipeline's steps in order (task-merge.ts, 1 to 8), repeated when the base moved.
 */

import * as fs from 'fs';
import { autoMergePaused, DEFAULT_PROJECT_SETTINGS } from '../../shared/projects.js';
import { riskReviewable } from '../../shared/security.js';
import {
  reviewBlocks,
  TASK_REVIEWER_VERSION,
  type TaskPhaseTiming,
  type TaskReview,
  type TaskVerify,
} from '../../shared/tasks.js';
import { isSafeRefName } from '../utils/exec-file.js';
import { repoMutex } from '../utils/repo-mutex.js';
import { mergeQueue, mergeQueueKey } from './merge-queue.js';
import { mergeTrainsFor } from './merge-train.js';
import { finishMerged, moveBase, ownWorkMerged } from './task-merge-base.js';
import {
  resultHoldBlocker,
  reviewBlocker,
  reviewNotAccepted,
  riskBlocker,
  risksNotAccepted,
} from './task-merge-blockers.js';
import { agentEditing, composeCheckCommand, startCheck } from './task-merge-check.js';
import { isAncestor, lastLines, type MergeLog, output } from './task-merge-log.js';
import { onlyBaseSince, runReview } from './task-merge-review.js';
import { withoutWorktree } from './task-merge-run.js';
import { boardTrain, leaveBatch, undoTrainLeftover, writeTrainRefs } from './task-merge-train.js';
import {
  BASE_MOVED_RETRIES,
  type BuiltOnBatch,
  type CheckWrites,
  COMMIT_TIMEOUT_MS,
  type PipelineContext,
  type PipelineOptions,
  type PipelineResult,
  type PipelineTask,
  type QueuePlace,
  RISK_BEFORE_CHECK,
  TRAIN_AGAIN_MAX,
} from './task-merge-types.js';
import { assessRisk, collectRiskInput } from './task-risk.js';
import {
  type DetectedCheck,
  detectCheck,
  formatGB,
  onlyDocs,
  planTaskCheck,
} from './task-verify.js';
import {
  branchChanges,
  commitLeftovers,
  LEFTOVERS_FAILED,
  leftoverExcludes,
  TaskWorktreeError,
  unsavedChanges,
} from './task-worktree.js';

export async function pipelineLoop(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  ctx: PipelineContext,
  place: QueuePlace,
  batch: { built?: BuiltOnBatch }
): Promise<PipelineResult> {
  const settings = options.settings ?? DEFAULT_PROJECT_SETTINGS;
  const now = options.now ?? Date.now;
  const { repoPath, baseBranch: base, branch, worktreePath: wt } = task;
  const mergeError = (message: string, detail?: string[]): PipelineResult => ({
    state: 'failed',
    blocker: { kind: 'merge-error', message, ...(detail?.length ? { detail } : {}) },
  });
  if (!repoPath || !base || !branch || !isSafeRefName(base) || !isSafeRefName(branch)) {
    return mergeError('The task has no branch to merge');
  }
  const baseRef = `refs/heads/${base}`;
  const exclude = leftoverExcludes(settings.cloneDirs);
  // A check-only run with thenAuto stops where 'auto' would (policy, group, paused).
  const auto = options.mode === 'auto' || (options.mode === 'verify' && !!options.thenAuto);
  const verifyOnly = options.mode === 'verify' && !options.thenAuto;
  let verify = task.verify;
  // The latest review, this run's included: a pass after the base moved re-reviews only what
  // changed since (it used to read the whole diff again).
  let lastReview = task.review;
  let review: TaskReview | undefined;
  let tipMoves = 0;
  // Two levels (2026-11-02, merge-train.ts): the task's own check is the fast one and its
  // related tests; the whole check runs once per merge batch before the base moves.
  const twoLevel = !!settings.relatedTestCommand;
  const queueKey = mergeQueueKey(repoPath, base);
  const trains = mergeTrainsFor(options.mergeQueue ?? mergeQueue);
  let trainRounds = 0;
  // A task no check covers cannot board a merge batch: it builds on the base (see step 5).
  let offTrain = false;
  if (twoLevel && wt && fs.existsSync(wt)) {
    const left = await undoTrainLeftover(task, log, baseRef);
    if (left) return left;
  }

  for (let attempt = 0; ; attempt++) {
    // At its turn in a two-level project it builds on the merge batch boarding (its last car),
    // and waits while a batch is checked: the base as it will be. The base is read after that
    // wait (the batch may just have moved it).
    const heldAtStart = place.holding;
    let trainTip: string | undefined;
    if (twoLevel && place.holding) {
      try {
        const batchTip = await trains.base(queueKey, options.signal);
        if (!offTrain) trainTip = batchTip;
      } catch {
        log.write('# merge batch: left while one was checked');
        return { state: 'ready', verify };
      }
    }
    const mainNow = await log.gitOut(repoPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    if (!mainNow) return mergeError(`The base branch ${base} is gone`);
    if (!wt || !fs.existsSync(wt)) return withoutWorktree(task, options, log, mainNow);
    const baseNow = trainTip ?? mainNow;
    if (trainTip) log.write(`# merge batch: builds on ${trainTip} (not merged yet)`);
    // What it took in on an earlier pass is not what it builds on now (that batch merged, or
    // did not and is gone): out of its branch, unless it is in the base.
    if (batch.built && !(trainTip && (await isAncestor(log, wt, batch.built.onto, trainTip)))) {
      const why = await leaveBatch(task, log, batch.built);
      const own = batch.built.own;
      batch.built = undefined;
      if (why) {
        return {
          state: 'needs_you',
          blocker: { kind: 'merge-error', message: why, detail: [`its own work: ${own}`] },
        };
      }
    }

    // Merged before a restart cut its cleanup short (2026-10-18): its branch, with commits of
    // its own, is in the base already (a rerun after a merge that was not saved, mergedSha
    // saved but the cleanup not done, or neither). Only the cleanup is left, unless the folder
    // holds work that is in no commit: then that work goes through the steps below.
    const branchTip = await log.gitOut(repoPath, [
      'rev-parse',
      '--verify',
      `refs/heads/${branch}^{commit}`,
    ]);
    if (branchTip && (await ownWorkMerged(log, repoPath, task, branchTip, mainNow))) {
      const unsaved = await unsavedChanges(wt, exclude);
      if (unsaved && !unsaved.tracked.length && !unsaved.untracked.length) {
        return finishMerged(task, options, log, branchTip, mainNow);
      }
      // 2026-10-31: the folder went while this run looked at it (the `git worktree remove` of
      // the run a restart cut short still going): the same as finding it gone.
      if (!unsaved && !fs.existsSync(wt)) return withoutWorktree(task, options, log, mainNow);
    }

    // 1. Leftovers.
    try {
      await commitLeftovers(
        wt,
        `${task.name}\n\n(uncommitted work, committed by Untether)`,
        exclude
      );
    } catch (error) {
      return {
        state: 'needs_you',
        blocker: {
          kind: 'merge-error',
          agentFixable: true,
          message: LEFTOVERS_FAILED,
          detail:
            error instanceof TaskWorktreeError ? [error.message, ...error.detail] : [String(error)],
        },
      };
    }
    const tip = await log.gitOut(wt, ['rev-parse', 'HEAD']);
    if (!tip) return mergeError('The task branch has no commit');

    // 2. Nothing of its own left on the branch.
    const own = Number.parseInt(
      (await log.gitOut(wt, ['rev-list', '--count', `${baseNow}..HEAD`])) ?? '0',
      10
    );
    if (!own && trainTip) {
      // 2026-11-11 (task a35010d2): four commits of its own, not merged, and it came back
      // "ready · no-changes" and was to be closed: the batch's tip held them (a car built on
      // this task's car of an earlier pass), so none counted as its own. What is its own is
      // counted against the base. It waits for that batch out of the line (the batch cannot
      // leave behind a task that holds the turn), then goes again on the base as it is then:
      // merged through that batch, or its own work still to merge.
      const sinceBase = Number.parseInt(
        (await log.gitOut(wt, ['rev-list', '--count', `${mainNow}..HEAD`])) ?? '0',
        10
      );
      if (sinceBase) {
        log.write(
          `# merge batch: its tip ${trainTip} holds this task's own work (${sinceBase} commit${sinceBase === 1 ? '' : 's'} not in ${base}): waits for that batch, then on ${base}`
        );
        place.leave();
        try {
          await trains.gone(queueKey, options.signal);
        } catch {
          log.write('# merge batch: left while one was boarding');
          return { state: 'ready', verify };
        }
        attempt--;
        continue;
      }
    }
    if (!own) {
      if (task.baseSha && (await ownWorkMerged(log, wt, task, tip, mainNow))) {
        return finishMerged(task, options, log, tip, mainNow);
      }
      // No baseSha here: the task's own base stays the commit it was made from (see
      // ownWorkMerged).
      return {
        state: 'ready',
        blocker: { kind: 'no-changes', message: 'The agent changed nothing' },
        files: [],
        stats: { commits: 0, files: 0, insertions: 0, deletions: 0 },
      };
    }

    // 3. The base's newest commit into the branch.
    if (!(await isAncestor(log, wt, baseNow, tip))) {
      const merged = await log.git(
        wt,
        ['merge', '--no-edit', '-m', `Merge ${base} into ${branch}`, baseNow],
        COMMIT_TIMEOUT_MS
      );
      if (merged.code !== 0) {
        const conflicted = await log.gitOut(wt, ['diff', '--name-only', '--diff-filter=U']);
        await log.git(wt, ['merge', '--abort']);
        const files = conflicted ? conflicted.split('\n').filter(Boolean) : [];
        if (files.length) {
          return {
            state: 'needs_you',
            blocker: {
              kind: 'conflict',
              // What it really conflicted with (2026-11-11: against a batch's tip it said
              // "Conflicts with main", and `git merge main` showed the agent no conflict).
              message: `Conflicts with ${trainTip ? `the merge batch ahead of it (${trainTip.slice(0, 12)}: ${base} and the tasks merging first)` : base} in ${files.length} file${files.length === 1 ? '' : 's'}`,
              detail: files.slice(0, 50),
              base: baseNow,
              ...(trainTip ? { batchTip: true } : {}),
            },
          };
        }
        return {
          state: 'needs_you',
          blocker: {
            kind: 'merge-error',
            agentFixable: true,
            message: `Could not merge ${base} into the task`,
            detail: lastLines(output(merged)),
          },
        };
      }
    }
    const head = await log.gitOut(wt, ['rev-parse', 'HEAD']);
    if (!head) return mergeError('The task branch has no commit');
    // The batch's tip came into the branch: recorded (and in refs, for a restart) until the
    // batch merges or the branch is back to its own work. A second merge on top of a first one
    // keeps the first record: the branch then holds more than `car`, which is never reset away.
    if (trainTip && head !== tip && !batch.built) {
      batch.built = { own: tip, onto: trainTip, car: head };
      await writeTrainRefs(log, repoPath, task.id, batch.built);
    }
    const changes = await branchChanges(wt, baseNow);
    const progress: Pick<PipelineResult, 'baseSha' | 'headSha' | 'files' | 'stats'> = {
      baseSha: baseNow,
      headSha: head,
      files: changes.files,
      stats: changes.stats,
    };

    // 4. Risk.
    review = undefined;
    const findings = assessRisk(
      await collectRiskInput(wt, baseNow, 'HEAD'),
      settings.riskIgnore ?? []
    );
    const risk = findings.map((f) => ({ rule: f.rule, file: f.file ?? '', detail: f.detail }));
    const freshRisk = options.acceptRisk ? risksNotAccepted(findings, options.acceptedRisk) : [];
    const pending =
      findings.length > 0 &&
      !options.acceptRisk &&
      !!options.riskReview &&
      riskReviewable(findings, changes.files);
    const riskStops = findings.length > 0 && (!options.acceptRisk || freshRisk.length > 0);
    const riskResult = (): PipelineResult => ({
      state: 'needs_you',
      blocker: riskBlocker(findings, freshRisk),
      risk,
      verify,
      ...(review ? { review } : {}),
      ...progress,
    });
    // Unattended, a risky change is checked and reviewed before the user is asked (2026-10-31):
    // their OK then merges at once on the result kept for this commit, instead of starting the
    // ~5 min check only then. Not when the change touches the check itself or deployment: that
    // code runs only once the user has seen it.
    const holdRisk =
      riskStops && !pending && auto && findings.every((f) => !RISK_BEFORE_CHECK.includes(f.rule));
    if (riskStops && !pending && !holdRisk) return riskResult();

    // 5. The check and 5b. the AI review, side by side on this very commit (2026-10-31: in
    // series a round took the check's ~5 min and then the review's; problems the review found
    // waited for the check before going back to the agent).
    const checks: DetectedCheck[] = settings.checkCommand
      ? [{ cwd: wt, command: settings.checkCommand, reason: 'project setting' }]
      : detectCheck(wt, changes.files);
    // Two levels: the related set when it can be computed (a whole check must exist, for the
    // batch); else the whole check, and why.
    const plan =
      twoLevel && checks.length
        ? planTaskCheck(settings, wt, changes.files, { renamed: changes.renamed.length })
        : null;
    if (plan?.level === 'full') log.write(`# check: the whole one (${plan.reason})`);
    // 2026-11-10: with no check it cannot board the batch it built on; it asked the base to
    // move from the batch's tip, where the base never is, and ended "kept moving" with the
    // batch's commits on its branch. Again from 3, on the base.
    if (!checks.length && trainTip) {
      log.write('# merge batch: no check covers this task, it cannot board: built on the base');
      offTrain = true;
      attempt--;
      continue;
    }
    if (!checks.length) {
      // Code no check covers merges with no human only when the project allows it and the AI
      // review (5b) reads it: in 'auto', and for an orchestrator's merge (2026-10-20: 'merge'
      // skipped the gate for orchestrators too, and the message told them to merge again).
      const unattended = auto || (options.mode === 'merge' && !!options.byAgent);
      const allowed = settings.allowMergeWithoutCheck && settings.aiReview;
      if (!onlyDocs(changes.files) && (verifyOnly || (unattended && !allowed))) {
        // A risky change no check covers: the user decides on both, risk first (as before).
        if (pending || holdRisk) {
          return riskResult();
        }
        // The two ways out, named once (the message said what was missing but not how to fix
        // it). Changing either setting is the user's call (`ut project set` asks them).
        return {
          state: 'ready',
          blocker: {
            kind: 'no-check',
            message: `Not merged on its own: no check covers the changed files (${changes.files.slice(0, 5).join(', ')}${changes.files.length > 5 ? ', …' : ''}). Set the project's check with \`ut project set --repo ${repoPath} --check "<command>"\`, or allow merging without one (allowMergeWithoutCheck=true, with the AI review on). Either way the user decides.`,
          },
          risk,
          ...progress,
        };
      }
      verify = undefined;
    }

    // What the user's OK covers of a review (2026-10-23: only as far as they saw it).
    const reviewPasses = (r: TaskReview) => {
      const notAccepted = options.acceptReview
        ? reviewNotAccepted(r, head, options.acceptedReview)
        : undefined;
      return {
        notAccepted,
        passed: !!options.acceptReview && Array.isArray(notAccepted) && !notAccepted.length,
      };
    };
    const reviewStops = (r: TaskReview) => reviewBlocks(r) && !reviewPasses(r).passed;

    // 4b. The merge queue: a run that will merge checks only at its turn (see the header).
    const policyNow =
      task.groupId || autoMergePaused(settings, now())
        ? 'ask'
        : (task.mergePolicy ?? settings.mergePolicy);
    // The agent's own result (`ut task done --result`): a partial one, or one that says
    // no-change on a branch with changes, is checked and reviewed but never merges on its own
    // (2026-11-01). The user's or an orchestrator's merge goes past it.
    // A run that ends ready without merging (verify, policy ask) still says why, with it.
    const resultHold =
      options.mode !== 'merge' ? resultHoldBlocker(task, changes.files.length > 0) : undefined;
    const willMerge =
      !verifyOnly && !pending && !holdRisk && !resultHold && !(auto && policyNow === 'ask');
    let waitTurn = false;
    if (willMerge && !place.holding) {
      const ticket = place.join();
      if (ticket.tryTurn()) {
        place.holding = true;
      } else {
        waitTurn = true;
        const spot = ticket.spot();
        log.write(
          `# merge queue: ${spot?.position ?? '?'} of ${spot?.of ?? '?'}; checked at its turn, on the base as it is then`
        );
      }
    }
    // Its turn came in this pass, with a merge batch boarding or checked: built on the base it
    // is not (the batch's tip is), so it goes again from 3 before any check.
    if (twoLevel && willMerge && place.holding && !heldAtStart && trains.busy(queueKey)) {
      attempt--;
      continue;
    }

    let checkRun: Promise<TaskVerify> | undefined;
    let liveVerify: (() => TaskVerify) | undefined;
    let stopCheck: (() => TaskVerify) | undefined;
    let checkWrites: (() => Promise<CheckWrites | undefined>) | undefined;
    if (checks.length && !waitTurn) {
      const command = plan?.level === 'related' ? plan.command : composeCheckCommand(wt, checks);
      const reuse =
        options.mode !== 'verify' &&
        verify?.exitCode === 0 &&
        verify.headSha === head &&
        verify.command === command;
      if (reuse) {
        log.write(`# check: kept (${head} passed before)`);
      } else {
        const started = startCheck(
          task,
          options,
          log,
          ctx,
          command,
          head,
          plan?.level === 'related'
            ? { level: 'related', relatedFiles: plan.files.length }
            : plan
              ? { level: 'full', fullReason: plan.reason }
              : {}
        );
        checkRun = started.done;
        liveVerify = started.current;
        stopCheck = started.stop;
        checkWrites = started.writes;
      }
    }
    let reviewRun: Promise<{ review: TaskReview; timing: TaskPhaseTiming }> | undefined;
    if (settings.aiReview) {
      // A verdict from an older reviewer is neither kept nor built on (2026-11-01).
      const previous = lastReview?.reviewer === TASK_REVIEWER_VERSION ? lastReview : undefined;
      if (lastReview && !previous) log.write('# review: written by an older reviewer, again');
      const reuse =
        !options.freshReview && previous?.headSha === head && previous.verdict !== 'unavailable';
      // The same work with only the base merged in since, cleanly (a task that waited in the
      // merge queue, or whose base moved under its check): the reviewer is not asked again.
      const carried =
        !reuse &&
        !options.freshReview &&
        !!previous?.headSha &&
        previous.verdict !== 'unavailable' &&
        (await onlyBaseSince(log, wt, baseNow, previous.headSha, head));
      if (reuse) {
        review = previous;
        log.write(`# review: ${review.verdict} (kept, ${head} reviewed before)`);
      } else if (carried && previous?.headSha) {
        // Carried, not answered again: it adds nothing to the task's review numbers.
        const { round: _round, ...kept } = previous;
        review = {
          ...kept,
          headSha: head,
          carriedFrom: previous.carriedFrom ?? previous.headSha,
        };
        lastReview = review;
        log.write(
          `# review: ${review.verdict} (kept, ${previous.headSha} reviewed; only ${base} came in since)`
        );
      } else {
        options.onProgress?.({
          state: 'reviewing',
          ...(liveVerify ? { verify: liveVerify() } : verify ? { verify } : {}),
        });
        // A later commit of a reviewed task (the agent fixed something): only what changed
        // since, with the earlier findings (2026-10-20: full re-reviews raised new nits on old
        // lines every round). A fresh review the user asked for reads it all again.
        const earlier =
          !options.freshReview && previous && previous.verdict !== 'unavailable' && previous.headSha
            ? previous
            : undefined;
        const reviewStart = now();
        reviewRun = runReview(task, options, log, baseNow, head, changes.files, earlier).then(
          (r) => ({
            review: r,
            timing: ctx.stamp(
              'review',
              reviewStart,
              `${r.verdict}${r.incremental ? ' (incremental)' : ''}${reviewBlocks(r) && !reviewStops(r) ? ' (accepted)' : ''}`
            ),
          })
        );
      }
    }

    // Whichever ends first decides what can be said at once.
    let checkFailedOnChange = false;
    while (checkRun || reviewRun) {
      const next = await Promise.race([
        ...(checkRun ? [checkRun.then((v) => ({ kind: 'check' as const, verify: v }))] : []),
        ...(reviewRun
          ? [reviewRun.then((r) => ({ kind: 'review' as const, review: r.review }))]
          : []),
      ]);
      if (next.kind === 'check') {
        checkRun = undefined;
        verify = next.verify;
        // Saved at once (2026-11-01): a restart before the merge keeps a check that passed on
        // this commit (reused above) instead of running it again.
        options.onProgress?.({ state: 'verifying', verify: { ...verify } });
        if (verify.exitCode !== 0 || verify.timedOut) {
          // Back to the agent now; a review still reading goes on and is kept (onLateReview):
          // the same commit is not reviewed again, a later one gets only what changed since.
          const late = reviewRun;
          if (late) {
            void late
              .then(({ review: r, timing }) => options.onLateReview?.(r, timing))
              .catch(() => undefined);
          }
          if (verify.diskLow?.again) {
            // The disk, not the task (2026-11-01): Untether's own stop, retried by itself
            // (TaskBlocker.internal), never handed to the agent as a fix.
            const where = verify.diskLow.path
              ? ` (${formatGB(verify.diskLow.freeBytes ?? 0)} free on ${verify.diskLow.path})`
              : '';
            return {
              state: 'needs_you',
              blocker: {
                kind: 'merge-error',
                internal: true,
                message: `The check failed while the disk was low${where}: not the task's`,
                detail: [`the disk was low while the check ran${where}`],
              },
              verify,
              risk,
              ...(review ? { review } : {}),
              ...progress,
            };
          }
          // 2026-11-01 (this task, auto-fix 2 of 2): the agent was still editing its worktree
          // while its check ran; the check failed on those half-made files and the failure
          // cost the task its last automatic fix. A check of files that changed under it says
          // nothing about the commit: another pass, like a pass in step 7. Only a new HEAD or
          // the agent's own writes count: files the check rewrote (a formatter, lint --fix,
          // snapshots) leave its failure a failure.
          const wrote = await checkWrites?.();
          if (wrote?.changed.length && !agentEditing(wrote, options)) {
            log.write(
              `# the check rewrote tracked files: ${wrote.changed.slice(0, 10).join(', ')}`
            );
          }
          if (wrote && (wrote.headMoved || agentEditing(wrote, options))) {
            if (tipMoves++ < BASE_MOVED_RETRIES) {
              checkFailedOnChange = true;
              break;
            }
            return {
              state: 'needs_you',
              blocker: {
                kind: 'merge-error',
                message: `${branch} kept changing while it was checked`,
              },
              verify,
              risk,
              ...(review ? { review } : {}),
              ...progress,
            };
          }
          return {
            state: 'failed',
            blocker: {
              kind: 'verify',
              message: verify.timedOut
                ? `The check timed out after ${settings.verifyTimeoutSec} s`
                : 'The check failed',
              detail: lastLines(verify.tail ?? ''),
            },
            verify,
            risk,
            ...(review ? { review } : {}),
            ...progress,
          };
        }
      } else {
        reviewRun = undefined;
        review = next.review;
        lastReview = review;
        // Saved at once, however it ended (2026-11-01): a restart keeps this commit's review.
        if (checkRun && liveVerify) {
          options.onProgress?.({ state: 'reviewed', review, verify: liveVerify() });
        } else {
          options.onProgress?.({ state: 'reviewed', review });
        }
        if (checkRun && reviewStops(review)) {
          // The agent has work to do whatever the check says: it gets it now, and the check
          // stops (it runs again on the agent's next commit).
          verify = (stopCheck as () => TaskVerify)();
          checkRun = undefined;
        }
      }
    }

    if (review) {
      const { notAccepted, passed } = reviewPasses(review);
      if (review.verdict === 'unavailable' && !passed) {
        if (holdRisk) return riskResult();
        return {
          state: 'ready',
          blocker: {
            kind: 'review-unavailable',
            message: `The AI review could not run${review.reason ? ` (${review.reason})` : ''}: nothing merges without one. Untether tries again by itself.`,
          },
          review,
          verify,
          risk,
          ...progress,
        };
      }
      if (reviewBlocks(review) && !passed) {
        return {
          state: 'needs_you',
          blocker: reviewBlocker(review, Array.isArray(notAccepted) ? notAccepted : undefined),
          review,
          verify,
          risk,
          ...progress,
        };
      }
    }
    // Before anything shows it ready (2026-11-10): this stood after the returns below, so
    // with merge "ask", a risk hold, a result hold or `ut task verify` the task came back
    // ready with its failed check and was never checked again.
    if (checkFailedOnChange) {
      log.write(`# ${branch} changed while it was checked (the check failed): again`);
      continue;
    }
    if (holdRisk) return riskResult();
    const reviewed = review ? { review } : {};

    // 6. Policy. The circuit breaker (too many undone or unfixable tasks lately) pauses
    // merging on its own for the project.
    // The same answer as at 4b: a run that did not join the merge queue never merges.
    const policy = policyNow;
    if (pending) {
      return { state: 'ready', riskPending: true, verify, risk, ...reviewed, ...progress };
    }
    // Before the policy: a partial or contradicted result keeps its own blocker at ready,
    // where the policy alone would leave none (2026-11-01 review).
    if (resultHold) {
      return { state: 'ready', blocker: resultHold, verify, risk, ...reviewed, ...progress };
    }
    if (verifyOnly || (auto && policy === 'ask')) {
      return { state: 'ready', verify, risk, ...reviewed, ...progress };
    }

    // 4b. Behind another task: its turn, then the base as it is then (back to 3).
    if (waitTurn && place.ticket) {
      const waitStart = now();
      try {
        await place.ticket.turn(options.signal);
      } catch {
        ctx.stamp('merge-queue', waitStart, 'left');
        log.write('# merge queue: left before its turn');
        return { state: 'ready', verify, risk, ...reviewed, ...progress };
      }
      place.holding = true;
      ctx.stamp('merge-queue', waitStart, 'its turn');
      log.write('# merge queue: its turn');
      // Not a move of the base under a check: the pass that counts starts now.
      attempt--;
      continue;
    }

    // 7. The branch must still be what was checked. 2026-10-20: commits made while the check
    // ran were left out of the merge, yet the task ended merged and its folder was removed.
    // New commits or edited files: another pass (leftovers committed, checked again).
    const headAfter = await log.gitOut(wt, ['rev-parse', 'HEAD']);
    const afterCheck = await unsavedChanges(wt, exclude);
    // Tracked files the check itself rewrote (a formatter, snapshots), with the agent quiet
    // meanwhile: what merges is still exactly what was checked; they stay in the folder,
    // which then keeps it (needs_you, as any work left uncommitted), and are named here.
    const wrote = await checkWrites?.();
    const byCheck = new Set(
      wrote && !wrote.headMoved && !agentEditing(wrote, options) ? wrote.changed : []
    );
    const ownChanges = afterCheck?.tracked.filter((file) => !byCheck.has(file)) ?? [];
    if (headAfter !== head || !afterCheck || ownChanges.length) {
      if (tipMoves++ < BASE_MOVED_RETRIES) {
        log.write(`# ${branch} changed while it was checked: again`);
        continue;
      }
      return {
        state: 'needs_you',
        blocker: { kind: 'merge-error', message: `${branch} kept changing while it was checked` },
        verify,
        risk,
        ...reviewed,
        ...progress,
      };
    }
    if (byCheck.size) {
      log.write(
        `# the check rewrote tracked files, not merged (what merges is what was checked): ${[...byCheck].slice(0, 10).join(', ')}`
      );
    }
    // New untracked files came from the check (its leftovers: reports, caches): not work.
    const artifacts = new Set(afterCheck.untracked);

    // Into the base branch, one merge per repository at a time.
    options.onProgress?.({ state: 'merging' });
    const mergeStart = now();
    const mutex = options.mutex ?? repoMutex;
    const moveTo = async (expected: string, sha: string, onto?: string) =>
      mutex.run(repoPath, async () => {
        // Recorded right before the move (task journal): a restart from here on looks at the
        // base. It throws when the record could not be saved: then the base is not moved.
        if (onto) options.onMoveBase?.({ sha, onto });
        return moveBase(log, repoPath, base, baseRef, expected, sha);
      });

    // Two levels: on board the merge batch; the base moves once its whole check passed.
    if (twoLevel && checks.length) {
      const verdict = await boardTrain({
        task,
        options,
        log,
        ctx,
        key: queueKey,
        trains,
        place,
        own: tip,
        built: batch.built,
        head,
        onto: baseNow,
        main: mainNow,
        level: plan?.level === 'related' ? 'related' : 'full',
        files: changes.files,
        fullCommand: (files) => {
          if (settings.checkCommand) return settings.checkCommand;
          const all = detectCheck(wt, files);
          return composeCheckCommand(wt, all.length ? all : checks);
        },
        record: () => options.onMoveBase?.({ sha: head, onto: baseNow }),
        move: (expected, sha) => moveTo(expected, sha),
      });
      // boardTrain took the branch back to its own work, or kept its refs and said why.
      batch.built = undefined;
      const kept = { verify, risk, ...reviewed, ...progress };
      if (verdict.kind === 'merged') {
        const done = await finishMerged(task, options, log, head, mainNow, artifacts);
        ctx.stamp('merge', mergeStart, done.state);
        return {
          ...done,
          ...kept,
          ...(done.mergedSha === head ? { mergedOnto: verdict.onto } : {}),
        };
      }
      ctx.stamp('merge', mergeStart, `batch: ${verdict.kind}`);
      if (verdict.kind === 'failed') {
        return {
          state: 'failed',
          blocker: {
            kind: 'verify',
            message: `The whole check failed on the merge batch (${verdict.batch} task${verdict.batch === 1 ? '' : 's'}) once this task's change was in it; its related tests passed, so it broke something else`,
            detail: lastLines(verdict.verify.tail ?? ''),
          },
          ...kept,
          verify: verdict.verify,
        };
      }
      if (verdict.kind === 'blocked') {
        // The base's stop (a dirty checkout, a move that failed): the same for every car that
        // would have merged. Without a result of its own, a merge error with the reason.
        const stop = verdict.detail as PipelineResult | undefined;
        return stop?.state && stop.blocker
          ? { state: stop.state, blocker: stop.blocker, ...kept }
          : {
              state: 'needs_you',
              blocker: { kind: 'merge-error', message: verdict.reason },
              ...kept,
            };
      }
      if (verdict.kind === 'internal') {
        return {
          state: 'needs_you',
          blocker: {
            kind: 'merge-error',
            internal: true,
            message: `The merge batch stopped: ${verdict.reason}`,
            detail: [verdict.reason],
          },
          ...kept,
        };
      }
      if (verdict.kind === 'left') {
        return { state: 'ready', ...kept };
      }
      // again: built on a batch that changed; from 3 on the base as it is now.
      if (trainRounds++ < TRAIN_AGAIN_MAX) {
        log.write(`# merge batch: again (${verdict.reason})`);
        attempt--;
        continue;
      }
      return {
        state: 'needs_you',
        blocker: {
          kind: 'merge-error',
          message: `${base} kept moving while the task was checked (merge batches: ${verdict.reason})`,
        },
        ...kept,
      };
    }

    const moved = await moveTo(baseNow, head, baseNow);
    if (moved.kind === 'merged') log.write(`# base moved: ${base} ${baseNow} → ${head}`);
    if (moved.kind !== 'merged') ctx.stamp('merge', mergeStart, moved.kind);
    if (moved.kind === 'blocked') {
      return { ...moved.result, verify, risk, ...reviewed, ...progress };
    }
    if (moved.kind === 'moved') {
      if (attempt < BASE_MOVED_RETRIES) {
        log.write(`# ${base} moved while the task was checked: again`);
        continue;
      }
      return {
        state: 'needs_you',
        blocker: { kind: 'merge-error', message: `${base} kept moving while the task was checked` },
        verify,
        risk,
        ...reviewed,
        ...progress,
      };
    }
    const done = await finishMerged(task, options, log, head, baseNow, artifacts);
    ctx.stamp('merge', mergeStart, done.state);
    return {
      ...done,
      verify,
      risk,
      ...reviewed,
      ...progress,
      ...(done.mergedSha === head ? { mergedOnto: baseNow } : {}),
    };
  }
}
