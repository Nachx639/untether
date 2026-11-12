/**
 * What stops a task before it merges (review, risk, a result that does not match) and what
 * the user already accepted of it.
 */

import { partialBlocker, saysNoChangeButChanged } from '../../shared/task-result.js';
import {
  issueBlocks,
  reviewIssueLine,
  type TaskBlocker,
  type TaskMergeOk,
  type TaskReview,
  type TaskRisk,
} from '../../shared/tasks.js';
import type { PipelineTask } from './task-merge-types.js';
import type { RiskFinding } from './task-risk.js';

/** `fresh`: the blocking issues the user's earlier OK did not cover (named first, as new). */
export function reviewBlocker(review: TaskReview, fresh?: TaskReview['issues']): TaskBlocker {
  if (fresh?.length) {
    return {
      kind: 'review',
      message:
        fresh.length === 1
          ? `The AI review found a new problem since your OK: ${reviewIssueLine(fresh[0])}`
          : `The AI review found ${fresh.length} new problems since your OK`,
      detail: [
        ...fresh.map((issue) => `new · ${reviewIssueLine(issue)}`),
        ...review.issues.filter((issue) => !fresh.includes(issue)).map(reviewIssueLine),
      ].slice(0, 20),
    };
  }
  const serious = review.issues.filter((issue) => issue.severity !== 'low');
  return {
    kind: 'review',
    message:
      review.summary ||
      `The AI review found ${serious.length} problem${serious.length === 1 ? '' : 's'}`,
    detail: review.issues.slice(0, 20).map(reviewIssueLine),
  };
}

const riskLine = (f: RiskFinding) =>
  `${f.rule}${f.file ? ` · ${f.file}` : ''}${f.detail ? ` · ${f.detail}` : ''}`;

/** `fresh`: the findings the user's earlier OK did not cover (named first, as new). */
export function riskBlocker(findings: RiskFinding[], fresh?: RiskFinding[]): TaskBlocker {
  if (fresh?.length) {
    const first = fresh[0];
    return {
      kind: 'risk',
      message:
        fresh.length === 1
          ? `A new risky change since your OK: ${first.rule}${first.file ? ` in ${first.file}` : ''}`
          : `${fresh.length} new risky changes since your OK`,
      detail: [
        ...fresh.map((f) => `new · ${riskLine(f)}`),
        ...findings.filter((f) => !fresh.includes(f)).map(riskLine),
      ].slice(0, 20),
    };
  }
  return {
    kind: 'risk',
    message:
      findings.length === 1
        ? `A risky change: ${findings[0].rule}${findings[0].file ? ` in ${findings[0].file}` : ''}`
        : `${findings.length} risky changes`,
    detail: findings.slice(0, 20).map(riskLine),
  };
}

/** The findings an OK limited to `accepted` does not cover (matched on rule and file). */
export function risksNotAccepted<T extends { rule: string; file?: string }>(
  findings: T[],
  accepted: TaskRisk[] | undefined
): T[] {
  if (!accepted) return [];
  return findings.filter(
    (f) => !accepted.some((a) => a.rule === f.rule && a.file === (f.file ?? ''))
  );
}

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 } as const;

const wording = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The blocking issues of `review` an OK limited to `accepted` does not cover: one the user
 * merged past is the same file and wording at the same severity or lower. An unavailable review
 * is covered only when the user merged past one of the same commit. Absent: all are covered.
 */
export function reviewNotAccepted(
  review: TaskReview,
  head: string,
  accepted: TaskMergeOk['review']
): TaskReview['issues'] | 'unavailable' {
  if (!accepted) return [];
  if (review.verdict === 'unavailable') {
    return accepted.unavailable && accepted.headSha === head ? [] : 'unavailable';
  }
  return review.issues
    .filter(issueBlocks)
    .filter(
      (issue) =>
        !accepted.issues.some(
          (a) =>
            a.file === issue.file &&
            wording(a.what) === wording(issue.what) &&
            SEVERITY_RANK[issue.severity] <= SEVERITY_RANK[a.severity]
        )
    );
}

/**
 * Why the agent's own result keeps a checked branch from merging on its own: it says the work
 * is partial, or that it changed nothing while the branch has changes. Undefined otherwise.
 */
export function resultHoldBlocker(
  task: Pick<PipelineTask, 'result' | 'resultMismatch'>,
  hasChanges: boolean
): TaskBlocker | undefined {
  const result = task.result;
  if (!result) return undefined;
  if (result.outcome === 'partial') return partialBlocker(result);
  if (saysNoChangeButChanged(result, hasChanges)) {
    return {
      kind: 'result-mismatch',
      message:
        task.resultMismatch ??
        "The agent's result says no-change, but its branch has changes: not merged on its own",
    };
  }
  return undefined;
}
