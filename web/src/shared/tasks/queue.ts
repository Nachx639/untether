/** A project's line of tasks: its place in it, the tasks it starts after and its zones. */

import type { TaskQueuedResources } from './admission.js';
import type { TaskState } from './core.js';

/**
 * A needs_you task holds its project's slot (maxActiveTasks) this long while its session runs:
 * an agent waiting for an answer goes on once it gets one, but a forgotten question must not
 * hold the project's queue for good.
 */
export const TASK_QUEUE_NEEDS_YOU_HOLD_MS = 30 * 60_000;

/** Where a queued task stands in its project's line (TaskRecord.queued). */
export interface TaskQueued {
  /** The project (its main checkout) whose slot it waits for. */
  repoPath: string;
  /** When it joined the line. */
  since: string;
  /** Its place: lower goes first; the tasks of a parallel group share one. */
  order: number;
  /** The project's limit when it was queued (maxActiveTasks); none: it waits for room only. */
  limit?: number;
  /**
   * The Mac has no room for one more task (2026-11-01, config.json taskAdmission): what is
   * short when it was last looked at, in words with the numbers. Gone once only its project's
   * line holds it.
   */
  resources?: TaskQueuedResources;
  /** The user (or its orchestrator) heard it is queued; its start is told then too. */
  told?: boolean;
  /**
   * The tasks it waits for before it may start (2026-11-11: `--after`, or an earlier task of
   * one of its zones), as last looked at. While there is one it holds its place in the line and
   * no slot, and the tasks behind it go past it.
   */
  waitsFor?: TaskWaitFor[];
  /** It waited for other tasks at some point (what its start is told with). */
  waited?: boolean;
  /** The waited-for tasks whose stop (discarded, failed, not run) was already told. */
  stoppedTold?: string[];
  /** Filled in by the server on every read: its place (1 = next) and the line's length. */
  position?: number;
  of?: number;
  /** Tasks of the project holding a slot now (filled in on every read). */
  active?: number;
}

/** A task another one waits for before it starts (TaskQueued.waitsFor). */
export interface TaskWaitFor {
  taskId: string;
  name: string;
  /** after: named with `--after`; zone: an earlier task of the project in the same zone. */
  why: 'after' | 'zone';
  zone?: string;
  /** Its state when last looked at. */
  state: TaskState;
  /**
   * It was discarded, failed or never ran: its work will not reach the base by itself, so the
   * waiting task does not start on its own; whoever it reports to decides.
   */
  stopped?: boolean;
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskQueueFields {
  /**
   * State queued: its project ran as many tasks as its limit (maxActiveTasks) when it was due,
   * so it waits in line for a slot (2026-11-01: bakery ran 5 to 6 tasks at once on a 24 GB
   * Mac, 7 to 9 GB of swap, checks of 7 to 18 min).
   */
  queued?: TaskQueued;
  /**
   * `ut task new --after` (2026-11-11): the tasks it starts after. It waits queued until each
   * is merged or done, so its worktree is made from a base that holds their work; one that is
   * discarded, fails or never runs keeps it waiting for a decision (shared/task-serial.ts).
   */
  after?: string[];
  /**
   * Its zones (`--zone`, or the project's `zones` rules matched on the paths its prompt names):
   * two tasks of a project that share a zone never work at once, the later one waits for the
   * earlier as if it were started `--after` it.
   */
  zones?: string[];
}
