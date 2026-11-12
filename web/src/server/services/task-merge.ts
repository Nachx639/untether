/**
 * The way a finished worktree task gets into its base branch, or the reason it doesn't.
 *
 *  1. What the agent left uncommitted is committed (the repository's hooks run).
 *  2. Nothing new on the branch: already merged (a rerun after a crash) → cleaned up and
 *     merged; never changed anything → ready (no-changes). A tip the task's own base holds
 *     is never "already merged".
 *  3. The base branch's current commit is merged into the task's branch, in its worktree.
 *     A conflict is aborted at once → needs_you (conflict, with the files).
 *  4. Risk rules on base...HEAD (task-risk.ts) → needs_you (risk) unless the user accepted.
 *     With riskReview (2026-10-24) findings a second review may pass (shared/security.ts
 *     riskReviewable) do not stop it: it is checked and reviewed, then ends ready with
 *     riskPending instead of merging, for the scheduler's second review and countdown.
 *  4b. The merge queue (2026-11-01, merge-queue.ts): a run that is going to merge waits for its
 *     turn in its base branch's line before its check. Behind another task it only does the
 *     cheap steps and the AI review now; at its turn it goes back to 3 on the base as it is then,
 *     and the check runs on exactly the commit that merges. Before, every task ready at once
 *     was checked side by side, only the first merged, and the others' checks were thrown away.
 *     A review of the same work with only the base merged in since, cleanly, keeps its verdict.
 *  5. The check (projects.json checkCommand, else detected per package) runs in the worktree,
 *     at most checkLoad.maxConcurrent per Mac and not while the Mac is over its load threshold
 *     (queued meanwhile), its load sampled all along. A run that failed with the Mac over that
 *     threshold goes once more when the load drops (a pass keeps its failed tests as flaky
 *     under load); on a quiet Mac a failure counts at once. Failing → failed (verify, last lines). No check
 *     at all → ready (no-check) unless the project allows merging without one or the task
 *     only changed documentation (task-verify.ts onlyDocs).
 *  5a. Two levels (2026-11-02, relatedTestCommand set; merge-train.ts): the task's own check is
 *     the fast one and its related tests (planTaskCheck; the whole one when they can't be
 *     computed). At its turn it builds on the merge batch boarding, checks, and boards it instead
 *     of moving the base (7): the batch runs the whole check once on the combined result, moves
 *     the base once, and sends back the task that broke it (bisected). A car not merged goes back
 *     to its own work (refs/untether/train/<id>, also after a restart) before it builds again.
 *  5b. The AI reviewer (task-review.ts, project setting aiReview, on by default) reads the diff.
 *     An open medium or high finding → needs_you (review) unless the user merges anyway. The
 *     same commit reviewed before keeps its verdict; a later commit gets a re-review of only
 *     what changed since, with the earlier findings. A reviewer that can't run never lets it
 *     merge (2026-10-20: it used to merge as if there were no reviewer) → ready
 *     (review-unavailable; the scheduler retries), unless the user merges anyway.
 *  6. Policy "ask" (or a parallel group, or the project's auto-merge paused by the circuit
 *     breaker) after the agent finished → ready: the user merges. A check-only run with
 *     thenAuto (`ut task verify`) goes on here like 'auto'.
 *  7. Merging, one at a time per repository: the base branch must still be where step 3 saw it
 *     (moved → back to 3, at most twice more; only a move by hand can do it to a run holding
 *     its turn). Base checked out somewhere (the user's main
 *     checkout): `merge --ff-only` there, never with tracked changes in it (→ needs_you
 *     dirty-base). Not checked out: `update-ref` guarded by the old value. Never pushed.
 *     Before that, the branch must still be the commit that was checked (new commits or edited
 *     files → another pass).
 *  8. The base must now contain the task's commit (the move recorded first, onMoveBase, for the
 *     scheduler to save before anything can restart the server); then the worktree and branch
 *     go → merged, unless they hold work that is not in the base (→ needs_you, kept,
 *     mergedSha noted).
 *  No merge error is ever reported for a task whose work its base already holds (2026-10-31):
 *  that run ends merged with the cleanup (finishMergedTask, also used by the scheduler).
 *
 * Every git command runs through exec-file's run() (argv, never a shell) and is logged to
 * `<logDir>/merge.log`; the check's output goes to `<logDir>/verify.log`.
 */

export { finishMergedTask } from './task-merge-base.js';
export {
  resultHoldBlocker,
  reviewNotAccepted,
  riskBlocker,
  risksNotAccepted,
} from './task-merge-blockers.js';
export { composeCheckCommand } from './task-merge-check.js';
export { MERGE_REFLOG_ACTION } from './task-merge-log.js';
export { runTaskPipeline } from './task-merge-run.js';
export {
  BASE_MOVED_RETRIES,
  type PipelineChecks,
  type PipelineMode,
  type PipelineOptions,
  type PipelineProgress,
  type PipelineResult,
  type PipelineTask,
  TRAIN_AGAIN_MAX,
} from './task-merge-types.js';
