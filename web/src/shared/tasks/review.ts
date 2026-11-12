/** The AI review of a task's change: verdict, issues and its numbers per reviewer. */

import type { TaskAgent } from './agents.js';

export type TaskReviewSeverity = 'high' | 'medium' | 'low';

/** 'security': the review's security pass; 'nit': style or preference (never blocks). */
export type TaskReviewCategory = 'bug' | 'security' | 'nit';

export interface TaskReviewIssue {
  file: string;
  line?: number;
  severity: TaskReviewSeverity;
  what: string;
  category?: TaskReviewCategory;
}

/**
 * What the AI reviewer said about a task's diff before it merged (project setting aiReview).
 * 'unavailable': it could not run (no claude, timeout, an answer that is not the JSON asked
 * for); the task never merges on that (blocker 'review-unavailable', retried by Untether).
 */
export interface TaskReview {
  verdict: 'ok' | 'concerns' | 'unavailable';
  /** One line, in Spanish (the reviewer is told to write it so). */
  summary: string;
  issues: TaskReviewIssue[];
  /** Why it is unavailable. */
  reason?: string;
  at: string;
  model: string;
  /** The commit it reviewed: the same commit again reuses the verdict. */
  headSha?: string;
  /** The diff was too big and only part of it was shown. */
  truncated?: boolean;
  /** Only the changes since an earlier reviewed commit were read (a re-review after a fix). */
  incremental?: boolean;
  /**
   * The commit the reviewer really read, when the verdict was carried to `headSha` because only
   * the base came in since, cleanly (2026-11-01: each merge of main into a waiting task asked the
   * reviewer again about the same work).
   */
  carriedFrom?: string;
  /** The reviewer said the diff it was shown does not hold the task's work (2026-11-01). */
  diffMismatch?: boolean;
  /** TASK_REVIEWER_VERSION of the reviewer that wrote it; missing = before versions. */
  reviewer?: number;
  /**
   * The family that reviewed (2026-11-01, cross review): 'codex' (`codex exec`) or 'claude'
   * (`claude -p`). Missing = Claude, the only reviewer before.
   */
  agent?: TaskAgent;
  /** It was reviewed by the other family than the task's agent (project setting crossReview). */
  crossReview?: boolean;
  /** The cross reviewer was wanted but could not answer, so Claude reviewed: why (English). */
  fallback?: string;
  /**
   * What this answer of the reviewer adds to the task's numbers (TaskReviewStats): only on an
   * answer the reviewer gave for it (never on a verdict kept or carried to another commit).
   */
  round?: TaskReviewRound;
}

/** One answer of the AI reviewer, counted for comparing reviewers (TaskReviewStats). */
export interface TaskReviewRound {
  /** Medium or high findings it raised that the previous review had not. */
  findings: number;
  /**
   * What became of the previous review's medium or high findings: re-raised = still open;
   * fixed = no longer raised and the agent changed that file since; rejected = no longer raised
   * though the file was not touched (the agent argued it away and the reviewer accepted).
   */
  previous?: { agent: TaskAgent; fixed: number; rejected: number; reraised: number };
}

/** One reviewer family's numbers on a task. */
export interface TaskReviewerTally {
  /** Answers it gave. */
  rounds: number;
  /** Medium or high findings it raised. */
  findings: number;
  /** Of its findings, the ones the agent fixed (real ones). */
  fixed: number;
  /** Of its findings, the ones the agent argued away and the next review accepted. */
  rejected: number;
  /** Times one of its findings was raised again by the next review. */
  reraised: number;
  /** Answers it gave as the fallback of an unavailable cross reviewer. */
  fallbacks: number;
}

/**
 * The AI review's numbers on one task (2026-11-01), to compare the reviewers with data: how
 * many review rounds, and per reviewer family how many findings were real (fixed) against
 * rejected by the agent.
 */
export interface TaskReviewStats {
  rounds: number;
  byAgent: Partial<Record<TaskAgent, TaskReviewerTally>>;
  /** `at` of the last review counted (the same review is never counted twice). */
  lastAt?: string;
}

function emptyTally(): TaskReviewerTally {
  return { rounds: 0, findings: 0, fixed: 0, rejected: 0, reraised: 0, fallbacks: 0 };
}

/** The task's numbers with `review` counted in (unchanged when it is not a new answer). */
export function countReview(
  stats: TaskReviewStats | undefined,
  review: TaskReview
): TaskReviewStats | undefined {
  const round = review.round;
  if (!round || review.verdict === 'unavailable' || review.at === stats?.lastAt) return stats;
  const next: TaskReviewStats = {
    rounds: (stats?.rounds ?? 0) + 1,
    byAgent: Object.fromEntries(
      Object.entries(stats?.byAgent ?? {}).map(([agent, tally]) => [agent, { ...tally }])
    ),
    lastAt: review.at,
  };
  const tally = (agent: TaskAgent) => {
    next.byAgent[agent] ??= emptyTally();
    return next.byAgent[agent] as TaskReviewerTally;
  };
  const own = tally(review.agent ?? 'claude');
  own.rounds++;
  own.findings += round.findings;
  if (review.fallback) own.fallbacks++;
  if (round.previous) {
    const earlier = tally(round.previous.agent);
    earlier.fixed += round.previous.fixed;
    earlier.rejected += round.previous.rejected;
    earlier.reraised += round.previous.reraised;
  }
  return next;
}

/**
 * Bumped whenever what the AI review is shown changes for the better: a verdict from an
 * older reviewer is never reused nor built on, the next pass reviews again on its own.
 * 2026-11-01: after the wrong-diff fix (a925a9722) old verdicts kept blocking tasks and only
 * the user could ask for a new review.
 */
export const TASK_REVIEWER_VERSION = 2;

/** An issue that stops the merge: a medium or high bug or security finding (never a nit). */
export function issueBlocks(issue: TaskReviewIssue): boolean {
  return issue.severity !== 'low' && issue.category !== 'nit';
}

/**
 * A review stops the merge: any open medium or high bug or security finding (a hard gate,
 * whatever verdict the reviewer wrote next to it). Low ones and nits never do.
 */
export function reviewBlocks(review: Pick<TaskReview, 'verdict' | 'issues'> | undefined): boolean {
  return (
    !!review &&
    review.verdict !== 'unavailable' &&
    review.issues.some((issue) => issueBlocks(issue))
  );
}

/** "high · security · src/a.ts:12 · what" (CLI, logs, the agent's fix prompt). */
export function reviewIssueLine(issue: TaskReviewIssue): string {
  const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''} · ` : '';
  const category = issue.category && issue.category !== 'bug' ? `${issue.category} · ` : '';
  return `${issue.severity} · ${category}${where}${issue.what}`;
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskReviewFields {
  /** The AI reviewer's last verdict (projects with aiReview on). */
  review?: TaskReview;
  /** The AI reviewer is reading it right now (state verifying: «revisando»). */
  reviewing?: boolean;
  /** The AI review's numbers on this task, per reviewer family (countReview). */
  reviewStats?: TaskReviewStats;
  /** Blocker 'review-unavailable': when Untether tries the review again by itself (ISO). */
  reviewRetryAt?: string;
  /** How the unavailable review is being retried (the scheduler's own bookkeeping). */
  reviewRetry?: {
    /** Retries made so far. */
    attempts: number;
    /** When the review was first unavailable. */
    since: string;
    /** The pipeline run to repeat ('auto': as the policy says; 'merge': the user asked). */
    mode: 'auto' | 'merge';
    acceptRisk?: boolean;
    keep?: boolean;
    /**
     * An orchestrator asked for the merge (2026-10-20: lost on the retry, so a merge no human
     * decided counted as the user's for the circuit breaker).
     */
    byAgent?: boolean;
    /** The user was told it is still unavailable (once). */
    notified?: boolean;
  };
}
