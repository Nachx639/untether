/** Tasks of a project that change the same files, and a branch kept up to date with its base. */

/**
 * Another unfinished task of the same project changes files this one changes too (2026-11-11,
 * task-scheduler-overlap.ts): whichever merges second meets the other's work. One entry per
 * other task, kept while both are open.
 */
export interface TaskOverlap {
  /** The other task. */
  taskId: string;
  name: string;
  /** The files both change, sorted (at most TASK_OVERLAP_FILES_KEPT of `count`). */
  files: string[];
  count: number;
  /** When it was first seen (ISO). */
  since: string;
  /** The project's orchestrator was told of this pair (once per pair). */
  toldAt?: string;
}

/**
 * A working task brought up to date with its base while its agent still works (2026-11-11,
 * task-scheduler-overlap.ts, ProjectSettings.baseSync): after another task merged files it
 * touches, Untether merges the base into its branch at a gap of its agent (no tool running,
 * nothing uncommitted in tracked files) when that merge is clean, and tells the agent the
 * conflict's files when it is not.
 */
export interface TaskBaseSync {
  /** The base as last known to be in its branch: its commit, and when that was seen (ISO). */
  through?: string;
  at?: string;
  /** Merges of the base Untether made into its branch while it worked. */
  merges?: number;
  /** The base moved in files it touches and its branch does not have that yet. */
  pending?: {
    since: string;
    /** The merged tasks that changed them. */
    from: string[];
    files: string[];
  };
  /** Why the pending merge waits: uncommitted changes, or its agent busy on a merge of its own. */
  waiting?: 'dirty' | 'busy';
  /** The conflict its agent was told of (once per base commit and set of files). */
  conflict?: { base: string; files: string[]; toldAt: string };
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskOverlapFields {
  /**
   * The other unfinished tasks of its project that change files it changes too (2026-11-11),
   * shown by `ut task status` and `ut task list`.
   */
  overlaps?: TaskOverlap[];
  /** Its branch brought up to date with its base while it works (ProjectSettings.baseSync). */
  baseSync?: TaskBaseSync;
}
