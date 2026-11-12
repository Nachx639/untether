/** What its agent said when it finished (`ut task done`). */

import type { TaskResult } from '../task-result.js';

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskReportFields {
  /** What the agent said it did (`ut task done --summary`). */
  summary?: string;
  /** What the agent said about how it checked its work and how to undo it (`ut task done`). */
  report?: { verified?: string; undo?: string };
  /** The agent's structured result (`ut task done --result`, shared/task-result.ts). */
  result?: TaskResult;
  /**
   * Where that result does not match its branch (it says no-change but there is a diff, it
   * names files the diff does not hold…), as last seen: shown, and told to the reviewer.
   */
  resultMismatch?: string;
  /**
   * What became of its result's memory note when it merged (server/services/task-memory-note.ts):
   * saved in the project's memoryDir (the file, and whether it replaced one of the same name),
   * or why not (memoryDir off, its folder missing, a write error): then the orchestrator gets it.
   */
  memoryNote?: { saved: string; updated: boolean } | { skipped: string };
}
