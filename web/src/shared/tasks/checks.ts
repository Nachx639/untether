/** A task's check (verify): its run, its level and the Mac's load around it. */

/** The Mac's 1-minute load average sampled during one check run (task-verify.ts watchLoad). */
export interface TaskCheckLoad {
  peak: number;
  mean: number;
  /** checkLoad.maxLoadPerCore × cores at the time. */
  threshold: number;
  samples: number;
  /** Over the threshold, or memory/swap short, at some sample. */
  high?: boolean;
  /** What memory or swap was short of, when it was. */
  memory?: string;
}

export interface TaskVerify {
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  logPath?: string;
  /** The last lines of its output. */
  tail?: string;
  /** Waiting for a free slot (checkLoad.maxConcurrent per Mac): «comprobando (en cola)». */
  queued?: boolean;
  timedOut?: boolean;
  /** The commit it checked (base merged in): a passed check of the same commit is not rerun. */
  headSha?: string;
  /**
   * It failed once and passed when run again (a flaky test, a loaded machine): the first run's
   * last line, kept so the flake is seen rather than hidden.
   */
  flakyFirstRun?: string;
  /**
   * The first run failed while the Mac was over its load threshold (or short of memory) at
   * some point during it, at this peak 1-minute load: it ran again once the load dropped (or
   * after checkLoad.maxWaitSec anyway) before counting as the task's failure (2026-11-02).
   */
  firstRunLoad?: number;
  /** The Mac's load sampled during the run this result is of (the last one). */
  load?: TaskCheckLoad;
  /**
   * The first run failed under load and the rerun passed: the tests that failed in the first
   * run (failedTestNames; empty when none was named), also kept in the project's list of tests
   * flaky under load that `ut doctor` shows, so they get fixed instead of hidden.
   */
  flakyUnderLoad?: string[];
  /**
   * Ignored files in the worktree that are not known artifacts and with no proof they matter
   * (not created during the task, or not among versioned files): reported, never blocking
   * (task-ignored-inputs.ts).
   */
  ignoredNote?: string[];
  /**
   * Waiting for the disk of its repo or worktree to have room again (config checkDisk), before
   * it starts or before its rerun: «esperando disco». The emptiest volume and its free bytes.
   */
  waitingDisk?: { path: string; freeBytes: number };
  /**
   * 2026-11-01: a run failed while the disk was low (sampled during the run) or with a disk-full
   * error in its output (ENOSPC): the environment's, not the task's. It ran again once the disk
   * recovered; never handed to the agent as its failure. `again`: that rerun failed with the disk
   * low too, so the pipeline stopped as Untether's (retried by itself, the user told after).
   */
  diskLow?: { path?: string; freeBytes?: number; enospc?: boolean; again?: boolean };
  /**
   * Stopped before it finished (2026-10-31): the AI review, run alongside it on the same commit,
   * found problems first, so the task went back to its agent at once instead of after the check.
   * The check runs again on the agent's next commit.
   */
  cancelled?: boolean;
  /**
   * Which check this was (2026-11-02, projects with relatedTestCommand): 'related', the fast
   * check and only the tests related to the task's changed files; 'full', the project's whole
   * check (no two levels, or the related set could not be computed: `fullReason`); 'batch', the
   * whole check of a merge batch, run once on the combined result before the base moves.
   */
  level?: TaskCheckLevel;
  /** Level 'full' in a two-level project: why the related tests were not enough. */
  fullReason?: string;
  /**
   * Not run (2026-11-11, check-results.ts): the same command had passed on the very same tree
   * with the same lockfiles. When that run passed, how long it took (the time not spent now),
   * the tree, and the task whose run it was when it is another's.
   */
  reused?: { at: string; ms: number; tree: string; taskId?: string };
  /** Level 'related': how many changed files the related tests were picked from. */
  relatedFiles?: number;
}

/** See TaskVerify.level. */
export type TaskCheckLevel = 'related' | 'full' | 'batch';

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskChecksFields {
  verify?: TaskVerify;
  /** Told its check waits for disk or failed on a low disk, until a check runs with room. */
  diskNoticed?: 'waiting' | 'failed';
}
