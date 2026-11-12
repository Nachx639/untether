/**
 * The merge queue of each project's base branch (2026-11-01, bakery: with 5 tasks ready at
 * once all checked side by side, only the first to finish merged; main moved under the others,
 * their passed checks no longer counted and each went back for another whole check: 751b4753
 * ran 4 checks, 41 min, and waited 49 min queued, for one merge).
 *
 * Only the task at the head of its line checks against the base as it is and merges; the ones
 * behind it wait, after their AI review and the cheap steps, and spend no check on a base that
 * is about to change. Order: the time each joined (its «ready»); the urgent ones first (the
 * user or an orchestrator marked them, `ut task priority <id> urgent`), then the user's own
 * merges (they asked for that one now); never ahead of the one already holding its turn. The
 * order is all a priority changes: each still checks on the base as it is at its turn.
 */

/** 'urgent': marked so (fast lane); 'user': the user's own «Fusionar». */
export type MergePriority = 'urgent' | 'user';

const RANK: Record<MergePriority, number> = { urgent: 2, user: 1 };
const rank = (priority?: MergePriority) => (priority ? RANK[priority] : 0);

export interface MergeQueueEntry {
  id: string;
  /** When it joined (ms): first come, first served. Kept across restarts (TaskRecord.mergeQueue). */
  at: number;
  /** Urgent ahead of the user's merges, both ahead of the unattended ones still waiting. */
  priority?: MergePriority;
}

export interface MergeQueueSpot {
  /** 1: its turn (checking against the base, merging); 2 and on: waiting. */
  position: number;
  /** How many are in the line, itself included. */
  of: number;
  priority?: MergePriority;
}

export interface MergeTicket {
  /** Its place now; undefined once it left. */
  spot(): MergeQueueSpot | undefined;
  /** True when it is first in line: its turn is taken at once (nobody can go ahead of it). */
  tryTurn(): boolean;
  /**
   * Resolves when it is first in line, its turn taken. Aborting `signal` while it waits leaves
   * the line and rejects with an AbortError.
   */
  turn(signal?: AbortSignal): Promise<void>;
  /** Out of the line (merged, blocked, failed, discarded): the next one gets its turn. */
  leave(): void;
}

export interface MergeQueue {
  join(key: string, entry: MergeQueueEntry): MergeTicket;
  /**
   * Its priority changed (marked urgent, or no longer): it moves to its new place, unless it
   * already holds its turn. False when it is not in that line.
   */
  prioritize(key: string, id: string, priority: MergePriority | undefined): boolean;
  /** Called with the key whose line changed (someone joined, left or got its turn). */
  onChange(listener: (key: string) => void): () => void;
  /** The ids in line for `key`, in order. */
  line(key: string): string[];
}

interface Slot extends MergeQueueEntry {
  /** It has its turn: first in line, and stays there until it leaves. */
  granted: boolean;
  waiters: (() => void)[];
}

/** a goes before b. */
const ahead = (a: MergeQueueEntry, b: MergeQueueEntry) =>
  rank(a.priority) !== rank(b.priority) ? rank(a.priority) > rank(b.priority) : a.at <= b.at;

/** Its place in `line`: after the ones holding their turn and every one ahead of it. */
const placeIn = (line: Slot[], slot: Slot) => {
  for (let i = 0; i < line.length; i++) {
    if (line[i].granted) continue;
    if (!ahead(line[i], slot)) return i;
  }
  return line.length;
};

export function createMergeQueue(): MergeQueue {
  const lines = new Map<string, Slot[]>();
  const listeners = new Set<(key: string) => void>();
  const changed = (key: string) => {
    for (const listener of listeners) {
      try {
        listener(key);
      } catch {
        // A listener's failure is not the queue's.
      }
    }
  };
  /** The first in line, if it is not holding its turn yet, is woken to take it. */
  const wake = (line: Slot[]) => {
    const first = line[0];
    if (!first?.waiters.length) return;
    first.granted = true;
    for (const resolve of first.waiters.splice(0)) resolve();
  };

  return {
    join(key, entry) {
      const line = lines.get(key) ?? [];
      lines.set(key, line);
      // The same task again (a pass that left without saying so): its old place goes.
      const old = line.findIndex((slot) => slot.id === entry.id);
      if (old >= 0) line.splice(old, 1);
      const slot: Slot = { ...entry, granted: false, waiters: [] };
      line.splice(placeIn(line, slot), 0, slot);
      changed(key);
      let gone = false;
      const leave = () => {
        if (gone) return;
        gone = true;
        const index = line.indexOf(slot);
        if (index >= 0) line.splice(index, 1);
        if (!line.length) lines.delete(key);
        wake(line);
        changed(key);
      };
      return {
        spot() {
          const index = line.indexOf(slot);
          return gone || index < 0
            ? undefined
            : {
                position: index + 1,
                of: line.length,
                ...(slot.priority ? { priority: slot.priority } : {}),
              };
        },
        tryTurn() {
          if (gone || line[0] !== slot) return false;
          if (!slot.granted) {
            slot.granted = true;
            changed(key);
          }
          return true;
        },
        turn(signal) {
          if (gone) return Promise.reject(new Error('Not in the merge queue any more'));
          if (signal?.aborted) {
            leave();
            return Promise.reject(new DOMException('Left the merge queue', 'AbortError'));
          }
          if (line[0] === slot) {
            if (!slot.granted) {
              slot.granted = true;
              changed(key);
            }
            return Promise.resolve();
          }
          return new Promise<void>((resolve, reject) => {
            const abort = () => {
              leave();
              reject(new DOMException('Left the merge queue', 'AbortError'));
            };
            signal?.addEventListener('abort', abort, { once: true });
            slot.waiters.push(() => {
              signal?.removeEventListener('abort', abort);
              changed(key);
              resolve();
            });
          });
        },
        leave,
      };
    },
    prioritize(key, id, priority) {
      const line = lines.get(key);
      const index = line?.findIndex((slot) => slot.id === id) ?? -1;
      if (!line || index < 0) return false;
      const slot = line[index];
      if (slot.priority === priority) return true;
      if (priority) slot.priority = priority;
      else delete slot.priority;
      if (!slot.granted) {
        line.splice(index, 1);
        line.splice(placeIn(line, slot), 0, slot);
        // A waiter that is now first takes its turn.
        wake(line);
      }
      changed(key);
      return true;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    line(key) {
      return (lines.get(key) ?? []).map((slot) => slot.id);
    },
  };
}

/** The line of one base branch: the repository and the branch. */
export function mergeQueueKey(repoPath: string, baseBranch: string): string {
  return `${repoPath}\0${baseBranch}`;
}

/** Shared by every merge pipeline of this server. */
export const mergeQueue = createMergeQueue();
