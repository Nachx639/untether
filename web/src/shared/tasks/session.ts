/** A task's session: how often it was reopened or started over, and the messages still to be typed into it. */

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskSessionFields {
  sessionId?: string;
  /** Times its Claude conversation was reopened after its session died with the server. */
  resumes?: number;
  /**
   * Times the user (send, fix, retry) reopened its conversation after its session ended.
   * 2026-10-20: these used to count against MAX_TASK_RESUMES, so after two fixes the "Que lo
   * arregle" button answered "session ended" and the task could only be discarded.
   */
  reopens?: number;
  /**
   * The session the user reopened its conversation in by hand after it had finished: theirs,
   * never stopped for being finished, whichever task names it (2026-10-24: finished tasks'
   * sessions are stopped). Only that session: once it ends, a later one is stopped as usual.
   */
  keepSessionId?: string;
  /** Automatic retries of a failed setup (one). */
  setupRetries?: number;
  /**
   * When that automatic setup retry runs (ISO), while it waits: a restart arms it again.
   * 2026-11-02: kept only as a timer, a restart lost it and the task stayed failed, untold.
   */
  setupRetryAt?: string;
  /**
   * Restarts in a row that cut it while it was starting (no session yet): it starts over by
   * itself up to TASK_START_CUTS_MAX times (task-scheduler.ts cutWhileStarting).
   */
  startCuts?: number;
  /**
   * Messages (follow-ups, fix requests) not typed into the agent yet: retried until they are.
   * `brief`: the session's first message (the task itself), never typed, so its agent never
   * started: a session gone meanwhile is started again with it, not taken over.
   */
  pendingInput?: Array<{
    text: string;
    at: string;
    brief?: boolean;
    /** Its id in the ledger of messages between agents, told once it was typed in. */
    messageId?: string;
    /** The line typed above it: its id and who it is from ("[untether] Message … from …:"). */
    header?: string;
  }>;
  /**
   * Why pendingInput was not typed on its last try: a menu of Claude's own on the task's screen,
   * its agent not ready (Codex working, an agent still starting), or its session gone. Unset
   * while the first try is still under way.
   */
  pendingWhy?: 'menu' | 'busy' | 'gone';
  /** The user was told pendingInput waits (behind a menu, or busy too long): not told again. */
  pendingNoticed?: 'menu' | 'busy';
  /** Since when pendingInput could not be typed (ISO): the backoff's clock, across restarts. */
  pendingSince?: string;
  /** The session whose agent's choice on screen the user was told about (agentChoiceOnScreen). */
  choiceToldSession?: string;
}
