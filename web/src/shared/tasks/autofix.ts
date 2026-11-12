/** Blockers handed back to the agent by Untether itself: reasons, limits and counts. */

/** Blockers Untether hands back to the task's agent by itself (TaskRecord.autoFix). */
export type TaskAutoFixReason = 'review' | 'verify' | 'conflict' | 'merge-error';

/** Automatic fix attempts per blocker reason per task, before the user is told. */
export const TASK_AUTO_FIX_MAX = 2;

/**
 * Automatic fix rounds per task across all reasons (2026-10-20: a task bouncing between a
 * failed check, a conflict and the review got 2 rounds of each, 8 in all, before anyone heard).
 */
export const TASK_AUTO_FIX_TOTAL_MAX = 3;

/**
 * Conflicts handed back to the agent because the base moved on (another merge), counted apart
 * from the fixes above (2026-11-01: four tasks merging in parallel gave one a new conflict
 * after every resolution; it ran out of fixes three times and spent 5 of its 6 rounds without
 * failing anything of its own). Only the same conflict again (same base, same files) counts as
 * a failed fix; this high cap stops a loop if the base never stops moving.
 */
export const TASK_CONFLICT_FRESH_MAX = 12;

/** Automatic fix rounds a task had so far, every reason together. */
export function autoFixRounds(task: { autoFixes?: Partial<Record<string, number>> }): number {
  return Object.values(task.autoFixes ?? {}).reduce<number>((sum, count) => sum + (count ?? 0), 0);
}

/** Untether is handing a blocker back to the agent on its own ("Arreglándose sola"). */
export interface TaskAutoFix {
  /** This attempt's number (1-based). */
  attempts: number;
  max: number;
  reason: TaskAutoFixReason;
  /** When it was handed over. */
  at: string;
  /**
   * A conflict new to the task (the base moved on since the last one it resolved): not a
   * failed fix and not a round of its budget (TASK_CONFLICT_FRESH_MAX).
   */
  baseMoved?: boolean;
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskAutofixFields {
  /** Set while Untether hands a blocker back to the agent by itself. */
  autoFix?: TaskAutoFix;
  /** Automatic fix attempts made so far, per reason (TASK_AUTO_FIX_MAX each). */
  autoFixes?: Partial<Record<TaskAutoFixReason, number>>;
  /** The last conflict handed back to the agent: a different one is new, not a failed fix. */
  lastConflict?: { base: string; files: string[] };
  /** Conflicts handed back as new because the base moved on (TASK_CONFLICT_FRESH_MAX). */
  freshConflicts?: number;
  /** Automatic fixes ran out and the task still did not merge (circuit breaker), when. */
  autoFixGaveUpAt?: string;
}
