/** Admission: what the Mac is short of when a task waits for room. */

/** What a task waiting for room is short of (the global resource sampler). */
export type TaskResourceShortage = 'memory' | 'swap' | 'cpu';

export interface TaskQueuedResources {
  short: TaskResourceShortage[];
  /** Room, but the last task let in settles first (taskAdmission.settleSec). */
  settling?: boolean;
  /** Nothing really short: tasks are only let in one at a time (taskAdmission.steadySwapMaxWaitMin). */
  paced?: boolean;
  /** The numbers, in English: "memory 12 % free (min 20 %), load 40.0 (max 24)". */
  detail: string;
  /** When it was last looked at. */
  at: string;
  /**
   * Since when it has waited for the Mac's room without a break (2026-11-11), kept across
   * looks and server restarts (task-scheduler-rules.ts, ROOM_WAIT_FIRST_MS).
   */
  since?: string;
}
