/**
 * The task journal (2026-11-01): every step of a task with effects outside tasks.json is
 * recorded on the task (TaskRecord.effects) BEFORE it is taken, keyed so a second record of
 * the same step replaces the first, and dropped in the same save that records its result.
 * tasks.json is written whole and atomically (tmp + rename), so a task's state and the steps it
 * has under way are one transaction: a restart (tsx watch restarts the server often, sometimes
 * in the middle of merging Untether itself) finds every step it cut short and the scheduler
 * takes each one up (TaskScheduler.start → recover): it retries the ones that are safe to run
 * again and verifies the others instead of repeating them blindly.
 *
 * | kind     | recorded before          | taken up after a restart                              |
 * |----------|--------------------------|-------------------------------------------------------|
 * | worktree | `git worktree add`+setup | the half-made folder and branch go; setup tried again |
 * | session  | a session is created     | that session id running → adopted (no second one), a  |
 * |          | (its id chosen first)    | first message not confirmed typed is typed again;     |
 * |          |                          | not running → as if never started                     |
 * | pipeline | check · review · merge   | run again as asked (idempotent: it starts with a look) |
 * | base     | the base branch moves    | base holds `sha` → only the merge is finished (cleanup,|
 * |          |                          | "merged", one push); else the pipeline runs as asked   |
 *
 * Pushes have their own outbox in the same file (task-scheduler.ts post): written with the
 * state that caused them, sent after the write, dropped once sent; a restart sends what is
 * left. TaskRecord.pushed (the last push's key) keeps a rerun from saying the same twice.
 *
 * Not journaled because the state itself already says what to do and doing it again is
 * harmless: stopping a finished task's session (armFinishedStop), removing a finished task's
 * worktree (dropDoneWorktree), and messages waiting to be typed (TaskRecord.pendingInput).
 */
import type { TaskPipelineRun } from './tasks.js';

interface Recorded {
  /** Idempotency key: recording the same step again replaces it. */
  key: string;
  /** When it was recorded (ISO). */
  at: string;
}

export type TaskEffect =
  | (Recorded & {
      kind: 'worktree';
      repoPath: string;
      branch: string;
      worktreePath: string;
    })
  | (Recorded & {
      kind: 'session';
      sessionId: string;
      /** The first message typed into it, until it is confirmed typed. */
      text?: string;
      /** `text` is the task's brief. */
      brief?: boolean;
    })
  | (Recorded & { kind: 'pipeline'; run: TaskPipelineRun })
  | (Recorded & {
      kind: 'base';
      /** The task's commit the base branch is being moved to. */
      sha: string;
      /** Where the base was (the change is onto..sha). */
      onto: string;
    });

export type TaskEffectKind = TaskEffect['kind'];
type EffectOf<K extends TaskEffectKind> = Extract<TaskEffect, { kind: K }>;

interface Journaled {
  effects?: TaskEffect[];
}

/** Record a step before it is taken; one of the same kind and key already there is replaced. */
export function beginEffect<K extends TaskEffectKind>(task: Journaled, effect: EffectOf<K>): void {
  const others = (task.effects ?? []).filter(
    (entry) => !(entry.kind === effect.kind && entry.key === effect.key)
  );
  task.effects = [...others, effect];
}

/** The step is done (or will never be): dropped, with every other of its kind when no key. */
export function endEffect(task: Journaled, kind: TaskEffectKind, key?: string): void {
  if (!task.effects) return;
  const left = task.effects.filter(
    (entry) => !(entry.kind === kind && (key === undefined || entry.key === key))
  );
  if (left.length) task.effects = left;
  else delete task.effects;
}

/** The step of this kind (and key) under way, if any. */
export function pendingEffect<K extends TaskEffectKind>(
  task: Journaled,
  kind: K,
  key?: string
): EffectOf<K> | undefined {
  return task.effects?.find(
    (entry): entry is EffectOf<K> => entry.kind === kind && (key === undefined || entry.key === key)
  );
}
