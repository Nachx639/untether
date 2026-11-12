/** A working task's progress: its last real step, stalls and repeated failures. */

/** Where a task's last real progress came from (TaskRecord.progress). */
export type TaskProgressSource = 'agent' | 'files' | 'commit' | 'start';

export interface TaskProgressMark {
  at: string;
  by: TaskProgressSource;
  /** What its agent waits on now (a tool call open, background work), and since when. */
  waitingOn?: { what: string; since: string };
}

/**
 * An agent that made no progress for a while, waiting on one thing (2026-11-02: task 87df7078
 * sat 1h40m on a Monitor whose notice never came, "busy, last activity 0m ago" the whole time).
 */
export interface TaskStall {
  /** The progress it is measured from. */
  progressAt: string;
  waitingOn: string;
  /** Its orchestrator (or the user) was told and the agent was nudged, once. */
  notedAt: string;
  /** Still no progress by the nudge's deadline: told again, its agent time no longer counted. */
  escalatedAt?: string;
}

/**
 * A nudge typed into a task's agent that kept failing the same way (2026-11-03,
 * task-scheduler-loops.ts): the same command with the same error FAILURE_LOOP_REPEATS times in
 * one turn. Kept so the nudges' effect can be measured: did the failure stop (recovered), or
 * repeat as often again (escalated to its orchestrator)?
 */
export interface TaskFailureNudge {
  /** When it was typed (ISO). */
  at: string;
  /** The session it was about: its failures are followed only while it is the task's. */
  sessionId: string;
  /** The agent's turn it was typed in (its start, epoch ms; 0 before any): once per turn. */
  turnStartedAt: number;
  tool: string;
  command: string;
  /** The error line quoted in the nudge. */
  errorLine: string;
  /** Identical failures in that turn when it was nudged. */
  repeats: number;
  /** The failure's signature (agent-failure-loop.ts) and its session count when nudged. */
  signature: string;
  countAtNudge: number;
  /** When that run of failures began (epoch ms): a run begun later is another one. */
  runFirstAt: number;
  /** The same failure again after the nudge. */
  after: number;
  /**
   * recovered: that command worked, or failed another way, after the nudge; escalated: it
   * failed identically FAILURE_LOOP_REPEATS more times and the orchestrator was told.
   * Unset while neither happened.
   */
  outcome?: 'recovered' | 'escalated';
  /** When the outcome was seen (ISO). */
  outcomeAt?: string;
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskProgressFields {
  /**
   * Its agent's last real progress while it works (2026-11-02, task-stall.ts): model output or
   * a tool result in its own events, a file it changed, a commit. Not the screen redrawing,
   * not a long command merely open. What it waits on now, when it waits on something.
   */
  progress?: TaskProgressMark;
  /** No progress for the project's stallMinutes while it waits on one thing: told and nudged. */
  stall?: TaskStall;
  /**
   * Its agent kept failing the same way and was nudged (2026-11-03): each nudge and what
   * became of it, the latest last (at most TASK_FAILURE_NUDGES_KEPT).
   */
  failureNudges?: TaskFailureNudge[];
}
