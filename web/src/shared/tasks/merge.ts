/** Merging a task into its base: policy, the merge queue, the waits, risk and what undoes it. */

import type { TaskSecurity } from '../security.js';
import type { TaskBlocker } from './blockers.js';
import type { TaskReviewIssue } from './review.js';

/** A task waiting for a dirty base checkout to be clean tells the user once after this long. */
export const TASK_BASE_WAIT_NOTIFY_MS = 2 * 60 * 60 * 1000;

/** … and stops waiting (needs the user) after this long. */
export const TASK_BASE_WAIT_MAX_MS = 24 * 60 * 60 * 1000;

/** 'auto': merged on its own when the check passes and nothing is risky; 'ask': never. */
export type TaskMergePolicy = 'auto' | 'ask';

export interface TaskMergeQueueSpot {
  /** 1: its turn; 2 and on: waiting behind the ones ahead. */
  position: number;
  /** How many are in the line, itself included. */
  of: number;
  /** When it joined (ISO). */
  since: string;
  /** 'urgent': marked so, first in line; 'user': the user's own merge, ahead of unattended ones. */
  priority?: 'urgent' | 'user';
}

export interface TaskRisk {
  rule: string;
  file: string;
  detail?: string;
}

/** A merge pipeline run as asked (its TaskEffect of kind pipeline). */
export interface TaskPipelineRun {
  /** 'auto' (the agent finished), 'merge' (the user asked), 'verify' (check only). */
  mode: 'auto' | 'merge' | 'verify';
  acceptRisk?: boolean;
  acceptReview?: boolean;
  freshReview?: boolean;
  /** "Quedarme con este": once merged, the other tasks of its group are discarded. */
  keep?: boolean;
  /** Asked by an orchestrator, not the user: a merge no human decided (circuit breaker). */
  byAgent?: boolean;
  /** Shown on a task the pipeline leaves ready with nothing to say. */
  readyNote?: TaskBlocker;
  /**
   * A check-only run (`ut task verify`) that goes on like an 'auto' run when it ends ready with
   * nothing blocking (2026-10-24): relaunching a stuck task by hand costs no tap.
   */
  thenAuto?: boolean;
  /**
   * The countdown of a risky task ended: its risk findings are accepted as far as the second
   * review saw them (TaskRecord.riskReview.risk); any other finding asks the user.
   */
  riskReviewed?: boolean;
}

/**
 * The user's own "merge it" (2026-10-23), kept on the task until it merges: the automatic
 * rounds (a failed check, a conflict or a review handed back to its agent) merge it the way
 * the user asked instead of asking again. It covers only what the user saw: a risk finding or
 * a blocking review issue that is not in here asks again, named as new.
 */
export interface TaskMergeOk {
  at: string;
  /** acceptRisk: the findings the user accepted (matched on rule and file). */
  risk?: TaskRisk[];
  /**
   * acceptReview: the blocking issues the user merged past (matched on file and wording, at
   * the same severity or lower); an unavailable review only for the commit it was about.
   */
  review?: { headSha?: string; unavailable?: boolean; issues: TaskReviewIssue[] };
  keep?: boolean;
}

export interface TaskRiskReview {
  verdict: 'confirmed' | 'dismissed' | 'unavailable';
  /** The reviewer's reason, in plain words (Spanish). */
  reason: string;
  headSha?: string;
  risk?: TaskRisk[];
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskMergeFields {
  /**
   * The user asked to merge it, and what they accepted. 2026-10-23: their OK with risky changes
   * was lost when the check failed under load and the agent's round re-ran as 'auto', so the
   * task asked for the same OK again.
   */
  mergeOk?: TaskMergeOk;
  risk?: TaskRisk[];
  mergePolicy?: TaskMergePolicy;
  mergedSha?: string;
  /**
   * The branch's commit the last pipeline run looked at (base merged in). Pushes are deduped
   * on it (2026-10-20: a terminal redraw re-ran the pipeline and the same outcome was pushed
   * again with another wording).
   */
  headSha?: string;
  /**
   * Its place in its project's merge queue while a pipeline run that will merge it goes on
   * (2026-11-01): position 1 checks against the base and merges, the others wait for it. `since`
   * is when it joined, its place in line again after a restart.
   */
  mergeQueue?: TaskMergeQueueSpot;
  /**
   * Fast lane (2026-11-01, asked by bakery): the user or an orchestrator marked it urgent
   * (`ut task priority <id> urgent`, the card's «Urgente»). It goes ahead in the merge queue
   * and in the line for a check slot; it still passes the whole check and the review.
   */
  urgent?: boolean;
  /**
   * The pipeline stopped on an error of Untether's own (TaskBlocker.internal): when it runs
   * again by itself (ISO). Meanwhile the task stays verifying/merging with its pipeline effect kept,
   * so the retry (and a restart) runs it the same way.
   */
  internalRetryAt?: string;
  /** Retries of the pipeline after errors of Untether's own so far, and the last error. */
  internalRetry?: { attempts: number; error: string };
  /**
   * Blocker 'dirty-base' (2026-10-24): the base branch's checkout had uncommitted changes, so it
   * could not move. The task waits ready, nothing asked of anyone: Untether looks at the checkout
   * every minute and merges it the way it was going to (`run`) once it is clean. The user is
   * told once after TASK_BASE_WAIT_NOTIFY_MS, and it stops waiting (needs_you) after
   * TASK_BASE_WAIT_MAX_MS. 2026-10-24: f80c5d25 sat «needs you · dirty-base» until its
   * orchestrator committed someone else's leftovers and verified it by hand.
   */
  baseWait?: {
    /** When it first found the base dirty. */
    since: string;
    /** When it looks again. */
    nextAt: string;
    run: TaskPipelineRun;
    /** The user was told it still waits (once). */
    notified?: boolean;
  };
  /** Merged with no human deciding it (policy auto): counted by the circuit breaker. */
  autoMerged?: boolean;
  /** The base commit the merge moved from: the task's change is mergedOnto..mergedSha. */
  mergedOnto?: string;
  /** A revert task: the merged task it undoes and its commit range. */
  revertOf?: { taskId: string; from: string; to: string };
  /** The revert task made for this merged task ("Deshacer"), and when. */
  revertedBy?: string;
  revertedAt?: string;
  /**
   * A task of the security sweep (security-sweep.ts): it waits for the user unless every gate
   * holds (shared/security.ts fixMergesOnItsOwn, bumpMergesOnItsOwn).
   */
  security?: TaskSecurity;
  /**
   * A security task that passed every gate merges on its own at this time (ISO), unless the
   * user stops it before («Parar»); the user was told when (2026-10-23).
   */
  autoMergeAt?: string;
  /**
   * The second, risk-focused review of a risky task (2026-10-24): the adversarial reviewer read
   * the diff of the flagged files, told why they were flagged, and confirms the change weakens
   * no auth, permission, secrets handling or session isolation. For the commit it read
   * (headSha) and the findings it was shown: a new commit is reviewed again.
   */
  riskReview?: TaskRiskReview;
  /**
   * The user's autoApprove setting stood in for their merge OK (2026-10-24): the task stopped
   * only for a tap (its blocker: risk, security, no-check, review-unavailable past its retries)
   * and counts down (autoMergeAt) to merging as if the user had tapped «Fusionar». Kept once
   * used up for that commit (headSha), so it does not count down again until a new one.
   */
  autoApprovedMerge?: {
    /** What it stopped for, and where it stood: what «Parar» puts back. */
    blocker: TaskBlocker;
    state: 'ready' | 'needs_you';
    headSha?: string;
    at: string;
    /** Used up: the countdown ended, was stopped, or the task left ready meanwhile. */
    done?: true;
  };
}
