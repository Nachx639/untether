/** Why a task stopped and what the user is told of it. */

import type { TaskPrompt } from '../agent-prompt.js';

/** Why a task stopped short of merging on its own. */
export type TaskBlockerKind =
  | 'question'
  | 'permission'
  | 'conflict'
  | 'verify'
  | 'risk'
  | 'dirty-base'
  | 'no-check'
  | 'no-changes'
  | 'setup'
  | 'session-exit'
  | 'merge-error'
  /** The AI reviewer (project setting aiReview) found medium or high issues in the diff. */
  | 'review'
  /**
   * The AI reviewer could not run (2026-10-20: an unavailable review used to merge as if there
   * were no reviewer). The task waits ready; Untether tries the review again by itself
   * (TaskRecord.reviewRetryAt). The user may still merge it anyway (acceptReview).
   */
  | 'review-unavailable'
  /**
   * A security finding two reviewers confirmed (security-sweep.ts), or a dependency an
   * advisory names: the fix is in the branch, checked and reviewed; only the user merges it.
   */
  | 'security'
  /** Its agent was cut short by its usage limit, an API error or a lost login (paused). */
  | 'halted'
  /**
   * It reached a limit of its budget (TaskRecord.budget, 2026-11-01): its agent was stopped,
   * its work kept; more budget (`ut task budget <id> +…`) sends it on, or it is discarded.
   */
  | 'budget'
  /**
   * Its agent's structured result (`ut task done --result`) says the work is partial: it is
   * checked and reviewed, then waits for the user or its orchestrator (merge as it is, or send
   * what is left). 2026-11-01.
   */
  | 'partial'
  /**
   * Its agent's result contradicts its branch: it says no-change but there is a diff (merged
   * only by someone who looked), or it lists changed files and there is none.
   */
  | 'result-mismatch';

/** Every push the task scheduler sends (data.type): each needs strings in sw-notify-i18n. */
export const TASK_PUSH_TYPES = [
  'task-ready',
  'task-needs-you',
  'task-failed',
  'task-merged',
  'task-done',
  'task-paused',
  'task-queued',
  'task-started',
  'task-agent-changed',
  'task-budget',
  'task-stalled',
  'task-looping',
] as const;

export type TaskPushType = (typeof TASK_PUSH_TYPES)[number];

export const TASK_BLOCKER_KINDS: readonly TaskBlockerKind[] = [
  'question',
  'permission',
  'conflict',
  'verify',
  'risk',
  'dirty-base',
  'no-check',
  'no-changes',
  'setup',
  'session-exit',
  'merge-error',
  'review',
  'review-unavailable',
  'security',
  'halted',
  'budget',
  'partial',
  'result-mismatch',
];

export interface TaskBlocker {
  kind: TaskBlockerKind;
  message: string;
  detail?: string[];
  /**
   * A merge-error the agent can fix in its branch (a commit hook's complaint, a merge of the
   * base that failed without conflicts): Untether hands it over by itself (autoFix).
   */
  agentFixable?: boolean;
  /**
   * A question or permission prompt Claude itself shows on the task's screen (a menu): only a
   * choice made there answers it, and messages typed meanwhile wait (2026-10-20: `ut task send`
   * answers were retried every 15 s forever behind such a menu).
   */
  onScreen?: boolean;
  /**
   * Set by Claude's own prompt (status waiting), not by `ut task ask`: kept on the task so a
   * restart still knows an answer on its screen means back to work (2026-10-20 review).
   */
  fromPrompt?: boolean;
  /**
   * What that prompt says, read off the task's screen and its agent's events (2026-11-10):
   * `ut task status` shows it and `ut task answer` answers it (shared/agent-prompt.ts).
   */
  prompt?: TaskPrompt;
  /**
   * An error of Untether's own stopped the pipeline (an exception, not git, the check or the
   * review): nothing in the task's branch. 2026-10-23: a server reload with a half edited
   * task-verify.ts ("os is not defined") left a task needs_you as if its branch were at fault.
   * The scheduler runs the pipeline again by itself (TaskRecord.internalRetry) and the user
   * hears of it only when those retries ran out.
   */
  internal?: boolean;
  /** A conflict: the base commit the branch conflicted with (what makes it a new conflict). */
  base?: string;
  /**
   * A conflict: `base` is the tip of the merge batch the task was joining (the base branch and
   * the tasks merging before it), a commit the base branch does not hold yet.
   */
  batchTip?: boolean;
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskBlockersFields {
  blocker?: TaskBlocker;
}
