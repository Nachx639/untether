/**
 * Folded groups (2026-11-10, user request: fold the projects so they do not all show open): a
 * project of the
 * phone list or the sidebar shows only its header and a short summary of what it holds. Which
 * ones are folded is the user's, kept on the server beside the group order
 * (TaskStore.collapsedGroups), so every device shows the same. Pure logic; the header's button
 * is in project-group.ts and repository-header.ts.
 *
 * A folded project never hides something that waits for the user without saying so: its
 * summary counts it first (needsYouItems, the same rule as the «Te necesita» section, which a
 * folded project leaves untouched).
 */
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';
import { needsYouItems } from './needs-you.js';

/** "Otras" among the folded groups (server/services/group-order.ts COLLAPSED_OTHERS). */
export const FOLDED_OTHERS = '(others)';

/** A group's name among the folded ones: its key, or FOLDED_OTHERS for "Otras". */
export function foldKey(key: string | null): string {
  return key ?? FOLDED_OTHERS;
}

export function isFolded(collapsed: readonly string[], key: string | null): boolean {
  return collapsed.includes(foldKey(key));
}

/** The folded groups after folding or unfolding `key`; the others stay as they are. */
export function withFolded(
  collapsed: readonly string[],
  key: string | null,
  folded: boolean
): string[] {
  const name = foldKey(key);
  const others = collapsed.filter((entry) => entry !== name);
  return folded ? [...others, name] : others;
}

/** What a folded group holds, for its one line. */
export interface FoldSummary {
  /** Its session rows (its orchestrator among them; a task's session is its task). */
  sessions: number;
  /** Its open tasks. */
  tasks: number;
  /** Rows that wait for the user: as many as the «Te necesita» section lists from here. */
  needsYou: number;
  /** Tasks waiting in the project's line. */
  queued: number;
}

export function foldSummary(input: {
  /** The group's session rows. */
  sessions: readonly Session[];
  /** The group's open tasks. */
  tasks: readonly TaskRecord[];
  /** Every session by id: a task's session says whether its agent asks. */
  sessionsById: ReadonlyMap<string, Session>;
  /** Tasks that ended: a session of theirs still asking waits for nobody (needs-you.ts). */
  closed?: readonly Pick<TaskRecord, 'id' | 'sessionId'>[];
  now?: number;
}): FoldSummary {
  const taskSessions = input.tasks
    .map((task) => (task.sessionId ? input.sessionsById.get(task.sessionId) : undefined))
    .filter((session): session is Session => !!session);
  const waiting = needsYouItems({
    sessions: [...new Set([...input.sessions, ...taskSessions])],
    tasks: input.tasks,
    closed: input.closed,
    now: input.now,
  });
  return {
    sessions: input.sessions.length,
    tasks: input.tasks.length,
    needsYou: waiting.length,
    queued: input.tasks.filter((task) => task.state === 'queued').length,
  };
}
