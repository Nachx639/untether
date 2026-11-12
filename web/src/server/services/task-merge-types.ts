/**
 * The merge pipeline's own types and limits (task-merge.ts tells the whole way).
 */

import type { ProjectSettings } from '../../shared/projects.js';
import type {
  TaskBlocker,
  TaskCheckLevel,
  TaskMergeOk,
  TaskMergeQueueSpot,
  TaskPhase,
  TaskPhaseTiming,
  TaskRecord,
  TaskReview,
  TaskRisk,
  TaskStats,
  TaskVerify,
} from '../../shared/tasks.js';
import type { NodeRuntime } from '../utils/node-runtime.js';
import type { KeyedMutex } from '../utils/repo-mutex.js';
import type { CheckResults } from './check-results.js';
import type { MergePriority, MergeQueue, MergeTicket } from './merge-queue.js';
import type { TaskReviewer } from './task-review.js';
import type { RiskRule } from './task-risk.js';
import type {
  DiskGate,
  Limiter,
  LoadGate,
  RunCheckOptions,
  RunCheckResult,
} from './task-verify.js';

export const GIT_TIMEOUT_MS = 30_000;

/** Merges and commits run the repository's hooks. */
export const COMMIT_TIMEOUT_MS = 180_000;

/** Times the base may move under a task's check before the engine gives up for now. */
export const BASE_MOVED_RETRIES = 2;

/** Times a car of a merge batch builds again (the batch changed under it) before it gives up. */
export const TRAIN_AGAIN_MAX = 6;

/**
 * Risk findings whose code runs only once the user has seen it: a change to the check itself or
 * to deployment is not run ahead of their OK (see holdRisk in the pipeline).
 */
export const RISK_BEFORE_CHECK: readonly RiskRule[] = ['check-config', 'deploy'];

/**
 * 'auto': the agent just finished; merges only when the project's policy allows.
 * 'merge': the user asked (or a restart found it mid-merge): no policy gate, no check is fine.
 * 'verify': only (re)run the check; ends at ready.
 */
export type PipelineMode = 'auto' | 'merge' | 'verify';

export type PipelineTask = Pick<
  TaskRecord,
  | 'id'
  | 'name'
  | 'repoPath'
  | 'baseBranch'
  | 'baseSha'
  | 'branch'
  | 'worktreePath'
  | 'groupId'
  | 'mergePolicy'
  | 'verify'
  | 'mergedSha'
  | 'mergedOnto'
  | 'effects'
  | 'headSha'
  | 'prompt'
  | 'summary'
  | 'review'
  | 'mergeQueue'
> &
  Partial<Pick<TaskRecord, 'followUps' | 'agent' | 'result' | 'resultMismatch' | 'guardBlocks'>>;

export type PipelineProgress =
  | { state: 'verifying'; verify: TaskVerify }
  /** The check's result when one ran (2026-10-20: status said "running" all through the review). */
  | { state: 'reviewing'; verify?: TaskVerify }
  /**
   * The review ended while the check, run alongside it, still goes on; or, without verify,
   * while it waits for its turn in the merge queue (no check yet).
   */
  | { state: 'reviewed'; review: TaskReview; verify?: TaskVerify }
  /** Its place in the merge queue changed; no spot: it is out of the line. */
  | { state: 'merge-queue'; spot?: TaskMergeQueueSpot }
  | { state: 'merging' };

export interface PipelineOptions {
  mode: PipelineMode;
  /** The user saw the risk findings and wants it merged anyway. */
  acceptRisk?: boolean;
  /**
   * With acceptRisk: only these findings are accepted (the user's OK kept through automatic
   * rounds); any other asks again, named as new. Absent: every finding is.
   */
  acceptedRisk?: TaskRisk[];
  /** The user read the AI review's concerns and wants it merged anyway. */
  acceptReview?: boolean;
  /** With acceptReview: only this review is merged past (see TaskMergeOk.review). */
  acceptedReview?: TaskMergeOk['review'];
  /** The user asked for a new review even if this commit was reviewed before. */
  freshReview?: boolean;
  /**
   * Risk findings a second review may pass (riskReviewable) do not stop the run: it ends ready
   * with riskPending after the check and the AI review, never merged (2026-10-24).
   */
  riskReview?: boolean;
  /** Mode 'verify' that goes on like 'auto' once checked (`ut task verify`, 2026-10-24). */
  thenAuto?: boolean;
  /**
   * An orchestrator asked for the merge, not the user (mode 'merge'): the gates that keep
   * unchecked code from merging with no human hold as in 'auto' (2026-10-20: `ut task merge`
   * from an orchestrator merged a task no check covered).
   */
  byAgent?: boolean;
  /** The AI reviewer (projects with aiReview on); default: Claude Sonnet via claude -p. */
  reviewer?: TaskReviewer;
  settings?: ProjectSettings;
  /** The task's own log folder (merge.log, verify.log). */
  logDir: string;
  onProgress?: (progress: PipelineProgress) => void;
  /**
   * The base branch is about to be moved to the task's commit `sha` (from `onto`): recorded
   * at once (its TaskEffect of kind base), before the move, since what comes next may restart
   * the server (the merge changed its own files) or end the task's session. A restart that
   * finds it looks whether the base holds `sha` (finishMergedTask) instead of merging again.
   */
  onMoveBase?: (move: { sha: string; onto: string }) => void;
  /** Right after the base branch has the task's commit, before its worktree goes. */
  beforeCleanup?: () => Promise<void>;
  limiter?: Limiter;
  /** The Mac's load: sampled during each check run; a run failed under it waits to rerun. */
  loadGate?: LoadGate;
  /** How often the load is sampled during a check run (default 10 s; tests go faster). */
  loadSampleMs?: number;
  /** When the disk is low: a check failed meanwhile (or by ENOSPC) waits for room and reruns. */
  diskGate?: DiskGate;
  mutex?: KeyedMutex;
  /** The merge queues (default: the server's one). */
  mergeQueue?: MergeQueue;
  /**
   * Its priority now (read when it joins a line and each time its check waits for a slot):
   * 'urgent' goes first in the merge queue and in the check limiter, 'user' (the user's own
   * merge) ahead of the unattended ones in the merge queue. Only the order changes. Marked
   * while it waits, the scheduler moves it (MergeQueue.prioritize).
   */
  mergePriority?: () => MergePriority | undefined;
  /** Aborted (the task discarded): a run still waiting in the merge queue leaves it and ends. */
  signal?: AbortSignal;
  /**
   * The task's agent printed something since `ms` (its session was at work). Files that changed
   * while the check ran are then the agent's edits, not the check's own rewrites.
   */
  agentActiveSince?: (ms: number) => boolean;
  runCheck?: (options: RunCheckOptions) => Promise<RunCheckResult>;
  /**
   * The kept passes (check-results.ts): a check whose command passed on the very tree it would
   * run on is not run again. Default: the server's store; null: nothing is kept nor reused.
   */
  checkResults?: CheckResults | null;
  /** The Node the worktree's project asks for (utils/node-runtime.ts); tests hand their own. */
  nodeRuntime?: (cwd: string) => Promise<NodeRuntime>;
  now?: () => number;
  /** The round this run is (TaskPhaseTiming.round); default 1. */
  round?: number;
  /**
   * A review that was still reading when the check failed and the run ended: it ends later and
   * is handed over here with its timing, to be kept (the same commit is not reviewed again).
   */
  onLateReview?: (review: TaskReview, timing: TaskPhaseTiming) => void;
}

export interface PipelineResult {
  state: 'merged' | 'ready' | 'needs_you' | 'failed';
  blocker?: TaskBlocker;
  mergedSha?: string;
  /** The base commit the branch now contains (after the base was merged in). */
  baseSha?: string;
  /** The branch's commit this run looked at (the base merged in). */
  headSha?: string;
  files?: string[];
  stats?: TaskStats;
  verify?: TaskVerify;
  risk?: TaskRisk[];
  /** The AI review of this run (projects with aiReview on). */
  review?: TaskReview;
  /** The worktree or branch could not be removed after the merge (kept, not fatal). */
  cleanupError?: string;
  /** Merged by this run: the base commit it moved from (the change is mergedOnto..mergedSha). */
  mergedOnto?: string;
  /** Ready but risky: it merges on its own only past the second review (riskReview). */
  riskPending?: boolean;
  /** How long each phase of this run took (TaskRecord.timings). */
  timings?: TaskPhaseTiming[];
  /** Its check runs: made, reused, failed by load (TaskMetrics.checks). */
  checks?: PipelineChecks;
}

/** A run's check runs (added to the task's TaskCheckMetrics). */
export interface PipelineChecks {
  runs: number;
  runMs: number;
  reused: number;
  savedMs: number;
  loadFailed: number;
}

/** What a run collects about itself while it goes. */
export interface PipelineContext {
  timings: TaskPhaseTiming[];
  checks: PipelineChecks;
  /** Records `phase` from `start` to now (also in merge.log); after the run, only returned. */
  stamp(
    phase: TaskPhase,
    start: number,
    outcome?: string,
    level?: TaskCheckLevel,
    end?: number
  ): TaskPhaseTiming;
}

/**
 * What changed in the worktree while its check ran (2026-11-01): HEAD, and every tracked file
 * whose content differs between a snapshot right before the check and one right after.
 */
export interface CheckWrites {
  headMoved: boolean;
  changed: string[];
  /** When the check started (ms): the agent's output since then says it was at work. */
  startedAt: number;
}

/** A run's place in its base branch's merge queue, once it joined. */
export interface QueuePlace {
  ticket?: MergeTicket;
  /** It has its turn: its check counts for the merge. */
  holding: boolean;
  join(): MergeTicket;
  /** Out of the line (it boarded a merge batch): the next one takes its turn. */
  leave(): void;
}

/**
 * What a task took into its branch from a merge batch (step 3): work of other tasks that is not
 * in the base, and may never be.
 */
export interface BuiltOnBatch {
  /** Its tip before. */
  own: string;
  /** The batch's tip. */
  onto: string;
  /** The merge of both. */
  car: string;
}

export type MoveResult =
  | { kind: 'merged' }
  | { kind: 'moved' }
  | { kind: 'blocked'; result: PipelineResult };
