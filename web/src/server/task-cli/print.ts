/** What every family shows the same way. */

import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { pendingNote, queuedNote, shortId } from './format-task-line.js';
import type { PrintInput } from './types.js';

export function formatConfirmation(confirmation: TaskConfirmation): string {
  const lines = [
    `Waiting for the user's OK on the phone (confirmation ${shortId(confirmation.id)}): ${confirmation.summary}`,
    ...confirmation.detail.map((line) => `  ${line}`),
    `It runs once approved; it expires at ${confirmation.expiresAt}.`,
  ];
  return lines.join('\n');
}

/**
 * The task an op answered with, in one line, and why it waits when it does; `otherwise` adds
 * what the op has to say of a task that waits for nothing.
 */
export function printTask(
  { data, deps, line }: PrintInput,
  otherwise?: (task: TaskRecord) => void
): undefined {
  if (!data.task) return;
  const task = data.task as TaskRecord;
  deps.out(line(task));
  if (task.state === 'queued') deps.out(queuedNote(task));
  else if (task.pendingInput?.length) deps.out(pendingNote(task));
  else otherwise?.(task);
}
