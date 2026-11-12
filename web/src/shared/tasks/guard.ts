/** The command guard's blocks of a task's agent (task-guard.ts). */

/** One tool call the command guard blocked (server/services/task-guard.ts). */
export interface TaskGuardBlock {
  at: string;
  /** The rule (delete-outside, git-push, git-base, git-rebase-skip, private-paths, kill-foreign,
   * sudo), 'project' (the project's guardDeny), or one that let the call run: 'guard-error' (the
   * guard failed or the agent runs without it) and 'uncertain' (it could not tell). */
  rule: string;
  tool: string;
  /** The command or file, cut to size. */
  what: string;
  /** What the agent was told. */
  reason: string;
}

/** Blocked calls kept on a task's record (the count goes on). */
export const GUARD_BLOCKS_KEPT = 50;

/** Entries of the guard's log that did not block: it failed, or could not tell. */
export function guardLetThrough(rule: string): boolean {
  return rule === 'guard-error' || rule === 'uncertain';
}

export interface TaskGuardBlocks {
  /** Tool calls blocked. */
  count: number;
  /** Entries that let the call run (guardLetThrough): failures and calls it could not judge. */
  noted?: number;
  recent: TaskGuardBlock[];
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskGuardFields {
  /**
   * Tool calls of its agent that Untether's command guard blocked (2026-11-02, task-guard.ts):
   * how many in all and the latest ones (oldest first). The review is shown them.
   */
  guardBlocks?: TaskGuardBlocks;
}
