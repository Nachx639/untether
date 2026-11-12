/** What every task is: its limits, its states, where it runs and what it was asked. */

import type { TaskEffect } from '../task-effects.js';

export const TASK_NAME_MAX = 80;

export const TASK_PROMPT_MAX = 20000;

/**
 * What `ut task done` keeps. The API rejects longer text (the agent sees why and shortens it)
 * and the scheduler stores it whole. 2026-10-31: the API took 4000 characters but the
 * scheduler kept 2000, so a summary lost its last part (the measurements) without a word.
 */
export const TASK_SUMMARY_MAX = 4000;

export const TASK_VERIFIED_MAX = 4000;

export const TASK_UNDO_MAX = 2000;

/** `ut task ask`: same rule, rejected by the API when longer, kept whole. */
export const TASK_QUESTION_MAX = 4000;

export const MAX_TASK_TEMPLATES = 50;

/** Agents launched at once with the same prompt. */
export const TASK_PARALLEL_MAX = 4;

/** A task whose time passed while the server was down still runs if it is at most this late. */
export const TASK_LATE_GRACE_MS = 6 * 60 * 60 * 1000;

export interface TaskTemplate {
  id: string;
  name: string;
  prompt: string;
}

export type TaskState =
  /** Waiting for its time. */
  | 'scheduled'
  /**
   * Waiting for a free slot of its project (ProjectSettings.maxActiveTasks, 2026-11-01): its
   * prompt is kept, no worktree nor session yet; it starts by itself, first in first out
   * (TaskRecord.queued), when the project runs fewer tasks than its limit.
   */
  | 'queued'
  /** Its worktree and branch are being made (dependencies cloned or installed). */
  | 'preparing'
  /** The agent is at work in its session. */
  | 'working'
  /** The agent waits for the user (a permission, a question) or the engine stopped (blocker). */
  | 'needs_you'
  /**
   * Its agent was cut short by something outside the task (its usage limit, an API error, a
   * lost login: TaskRecord.halt, 2026-11-01): never taken for finished; Untether sends it on
   * in the same session at halt.nextTryAt.
   */
  | 'paused'
  /** The project's check runs on the task's branch. */
  | 'verifying'
  /** The branch is going into the base branch. */
  | 'merging'
  /** Done and waiting for the user: merge it, look at it (or nothing to merge: blocker). */
  | 'ready'
  /** In the base branch; worktree and branch removed. */
  | 'merged'
  /**
   * A task without a worktree whose agent finished (2026-10-24): its work is in its folder,
   * there is nothing to merge. 2026-10-24: they stayed "ready" for days, closed only by
   * «Descartar», which reads as throwing the work away.
   */
  | 'done'
  /** Starting, checking or merging it failed (blocker says why). */
  | 'failed'
  /** Thrown away by the user. */
  | 'discarded'
  /** The server was down too long past its time; not run. */
  | 'missed';

export const TASK_STATES: readonly TaskState[] = [
  'scheduled',
  'queued',
  'preparing',
  'working',
  'needs_you',
  'paused',
  'verifying',
  'merging',
  'ready',
  'merged',
  'done',
  'failed',
  'discarded',
  'missed',
];

/** States in which the agent or the engine is still at it ("trabajando"). */
export const TASK_BUSY_STATES: readonly TaskState[] = [
  'preparing',
  'working',
  'verifying',
  'merging',
];

/** States that never change again ("Hechas" shows merged, done and discarded). */
export const TASK_FINAL_STATES: readonly TaskState[] = ['merged', 'done', 'discarded', 'missed'];

/** 'worktree': its own branch and folder, merged back when done; 'none': runs in the folder. */
export type TaskIsolation = 'worktree' | 'none';

export type TaskOrigin = 'user' | 'schedule' | 'orchestrator' | 'copilot';

/** A message sent to a running task after its prompt. */
export interface TaskFollowUp {
  at: string;
  text: string;
  /** Routed from the home box, typed with `ut task send`, sent from the task's row, or an automatic fix (auto). */
  via: 'route' | 'cli' | 'ui' | 'auto';
}

export interface TaskStats {
  commits: number;
  files: number;
  insertions: number;
  deletions: number;
}

/** A task's name from its prompt: its first line, cut at a word near TASK_NAME_MAX. */
export function taskTitleFromPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= TASK_NAME_MAX) return line || 'Task';
  const cut = line.slice(0, TASK_NAME_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Fill `{folder}` (last path segment), `{path}` (full folder) and `{date}` in a prompt. */
export function fillTaskPlaceholders(text: string, values: { folder: string; now?: Date }): string {
  const trimmed = values.folder.replace(/\/+$/, '');
  const base = trimmed.split('/').pop() || trimmed || values.folder;
  const date = (values.now ?? new Date()).toISOString().slice(0, 10);
  return text
    .replace(/\{folder\}/g, base)
    .replace(/\{path\}/g, values.folder)
    .replace(/\{date\}/g, date);
}

/** The next 2:00 local time after `now` (tonight, or tomorrow if it is already past 2:00). */
export function nextNightAt2(now = new Date()): Date {
  const at = new Date(now);
  at.setHours(2, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** What a task's record keeps of this (TaskRecord, tasks/record.ts). */
export interface TaskCoreFields {
  id: string;
  name: string;
  prompt: string;
  /** Where the user asked for it; a worktree task's session runs in `worktreePath`. */
  workingDir: string;
  /** The agent's command line as argv (the user's quick start, e.g. ["claude", "--flag"]). */
  command: string[];
  shielded: boolean;
  notify: boolean;
  /** ISO time it should run. */
  runAt: string;
  createdAt: string;
  state: TaskState;
  /** When it entered `state`. */
  stateSince: string;
  isolation: TaskIsolation;
  origin: TaskOrigin;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** The main checkout of its repository (worktree tasks). */
  repoPath?: string;
  /** The branch it merges into, and that branch's commit when the worktree was made. */
  baseBranch?: string;
  baseSha?: string;
  /** Its own branch (ut/<slug>, ut/<slug>-a … in a parallel group). */
  branch?: string;
  worktreePath?: string;
  /** Tasks launched together with the same prompt ("Lanzar en paralelo ×N"). */
  groupId?: string;
  groupIndex?: number;
  orchestratorSessionId?: string;
  /** The session that ran `ut task new` (adopt: its open tasks report to it as orchestrator). */
  createdBySessionId?: string;
  /**
   * Steps with effects outside tasks.json under way: recorded before each is taken, dropped
   * with its result (shared/task-effects.ts). A restart takes up what is left here.
   */
  effects?: TaskEffect[];
  /**
   * The key of the last push about where it ended (task-scheduler.ts notifyState): the same
   * outcome is not pushed twice, across restarts too. A new turn of its agent clears it.
   */
  pushed?: string;
  followUps: TaskFollowUp[];
  /** Files its branch changed, relative to the repository. */
  files: string[];
  stats?: TaskStats;
  /**
   * A failed task without a worktree closed as done because a newer task with the same prompt
   * in the same folder finished (2026-10-24): that task's id.
   */
  supersededBy?: string;
  /**
   * 2026-10-31: reminders that it still waits on someone (ready or needs_you, nobody acting),
   * for the spell that started at `since` (its stateSince): how many and the last one's time.
   * A new state starts over.
   */
  staleReminder?: { since: string; count: number; at: string };
  /**
   * A task without a worktree in a git checkout: the files that had uncommitted changes when it
   * started, and how they looked. `ut task done` refuses to close it while files the task
   * changed are left uncommitted in a project that merges on its own (2026-10-24: b5b3d787 ended
   * done with 10 uncommitted files on the base branch and blocked the next task's merge).
   */
  startDirty?: Array<{ file: string; sig: string }>;
}
