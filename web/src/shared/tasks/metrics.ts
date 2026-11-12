/** Where a task's time and budget went: phases, their timings, its budget and its metrics. */

import type { TaskBudget } from '../task-budget.js';
import type { TaskMetrics } from '../task-metrics.js';
import type { TaskCheckLevel } from './checks.js';

/**
 * Where a task's time goes between «ready» and «merged» (2026-10-31: bakery's 2b3c5cca took
 * 40 min across 4 rounds and nothing said which phase ate it).
 *  queue: its check waited for a free slot or a quieter Mac. merge-queue: it waited for its
 *  turn in the project's merge queue (2026-11-01: only the head of the line checks and merges).
 *  verify: the check itself.
 *  review: the AI review. risk-review: the second, risk-focused review. fix / conflict: its
 *  agent working on what Untether handed back (a conflict, or anything else). merge: moving the
 *  base branch and cleaning up.
 */
export type TaskPhase =
  | 'queue'
  | 'merge-queue'
  | 'verify'
  | 'review'
  | 'risk-review'
  | 'fix'
  | 'conflict'
  | 'merge';

export interface TaskPhaseTiming {
  phase: TaskPhase;
  startedAt: string;
  /** Unset while it is still going on (an agent fixing). */
  finishedAt?: string;
  /** 1 for the first pipeline run after the agent said done, +1 after each hand-back. */
  round: number;
  /** How it ended: passed, failed, ok, concerns, unavailable, cancelled, kept, merged… */
  outcome?: string;
  /** Phase verify: which check ran (TaskVerify.level). */
  level?: TaskCheckLevel;
  /** Phase verify, outcome 'reused': how long the run it stands on took (not spent now). */
  savedMs?: number;
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskMetricsFields {
  /** How long each phase of getting it merged took, oldest first (TASK_TIMINGS_MAX at most). */
  timings?: TaskPhaseTiming[];
  /**
   * Its budget (shared/task-budget.ts, 2026-11-01): limits of time, agent time, rounds and
   * tokens, what it spent, the warnings sent and the cut.
   */
  budget?: TaskBudget;
  /**
   * What it cost and how good its work was, and the saving features it ran with
   * (shared/task-metrics.ts, 2026-11-03); kept in the project's ledger once it is finished.
   */
  metrics?: TaskMetrics;
}
