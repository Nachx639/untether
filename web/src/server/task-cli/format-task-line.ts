/** One task in one line (`ut task list`), and the notes that go under it. */

import { overlapsShort } from '../../shared/task-overlap.js';
import { waitsForNote, waitsForShort } from '../../shared/task-serial.js';
import { TASK_FINAL_STATES, type TaskRecord, type TaskState } from '../../shared/tasks.js';

export const shortId = (id: string) => id.slice(0, 8);

/** "queued 2/3" for a task waiting in its project's line. */
function queuedLabel(task: TaskRecord): string | undefined {
  const place = task.state === 'queued' ? task.queued : undefined;
  // Started after other tasks (--after, its zone): what it waits for, before its place.
  const waits = waitsForShort(place?.waitsFor);
  if (waits) return waits;
  if (!place?.position) return undefined;
  const room = place.resources?.short.length
    ? ` · waiting for ${place.resources.short.join('+')}`
    : '';
  return `queued ${place.position}/${place.of ?? place.position}${room}`;
}

/** What a queued task waits for and what can be done, one line. */
export function queuedNote(task: TaskRecord): string {
  const place = task.queued;
  if (task.state !== 'queued' || !place) return '';
  const waits = waitsForNote(task);
  if (waits) return waits;
  const id = shortId(task.id);
  const actions = `'ut task retry ${id} --force' starts it now anyway, 'ut task move ${id} 1' puts it first, 'ut task discard ${id}' drops it.`;
  const line = `Queued (${place.position ?? '?'} of ${place.of ?? '?'} in line)`;
  const room = place.resources;
  if (room?.paced) {
    return `${line}: the Mac lets tasks in one at a time (${room.detail}; thresholds in config.json taskAdmission); it starts by itself on its turn. ${actions}`;
  }
  if (room?.short.length) {
    return `${line}: waiting for ${room.short.join(' and ')} on the Mac (${room.detail}; thresholds in config.json taskAdmission); it starts by itself when there is room. ${actions}`;
  }
  if (room?.settling) {
    return `${line}: waiting a few seconds for the task let in last to settle (${room.detail}). ${actions}`;
  }
  if (place.limit === undefined) {
    return `${line}: behind other tasks waiting for room on the Mac. ${actions}`;
  }
  return `${line}: ${place.active ?? '?'} of ${place.limit} tasks of the project are running (maxActiveTasks); it starts by itself when one ends. ${actions}`;
}

export const STATE_LABEL: Record<TaskState, string> = {
  scheduled: 'scheduled',
  queued: 'queued',
  preparing: 'preparing',
  working: 'working',
  needs_you: 'needs you',
  paused: 'paused',
  verifying: 'checking',
  merging: 'merging',
  ready: 'ready',
  merged: 'merged',
  done: 'done',
  failed: 'failed',
  discarded: 'discarded',
  missed: 'missed',
};

/** Who hears of a task: its orchestrator (you, when that is the caller) or the user. */
export function reportsTo(task: TaskRecord, me?: string): string {
  if (task.origin === 'orchestrator' && task.orchestratorSessionId) {
    return task.orchestratorSessionId === me ? 'you' : 'its orchestrator';
  }
  return 'the user';
}

/** "3m", "2h", "4d" since `iso`. */
export function age(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return '?';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export interface FormatContext {
  /** The caller's session (UNTETHER_SESSION_ID). */
  me?: string;
  now?: number;
}

export function formatTaskLine(task: TaskRecord, context: FormatContext = {}): string {
  const state = waitsInMergeQueue(task)
    ? `merge queue ${task.mergeQueue?.position}/${task.mergeQueue?.of}`
    : task.state === 'verifying' && task.verify?.waitingDisk
      ? 'checking (waiting for disk)'
      : task.state === 'verifying' && task.verify?.queued
        ? 'checking (queued)'
        : task.autoFix && task.state === 'working'
          ? 'fixing (auto)'
          : task.baseWait && task.state === 'ready'
            ? 'waiting'
            : (queuedLabel(task) ?? STATE_LABEL[task.state]);
  const parts = [shortId(task.id), state.padEnd(10), task.name];
  if (task.urgent && !TASK_FINAL_STATES.includes(task.state)) parts.push('(urgent)');
  if (task.branch) parts.push(`[${task.branch}]`);
  parts.push(
    `(${age(task.createdAt, context.now ?? Date.now())}, reports to ${reportsTo(task, context.me)})`
  );
  if (task.blocker && !['merged', 'done', 'discarded'].includes(task.state)) {
    parts.push(`— ${task.blocker.message}`);
  }
  // 2026-11-11: another open task of the project changes the same files.
  const overlaps = TASK_FINAL_STATES.includes(task.state)
    ? undefined
    : overlapsShort(task.overlaps);
  if (overlaps) parts.push(`⇄ ${overlaps}`);
  return parts.join('  ');
}

/** Behind another task in its project's merge queue (2026-11-01). */
export function waitsInMergeQueue(task: TaskRecord): boolean {
  return (
    !!task.mergeQueue &&
    task.mergeQueue.position > 1 &&
    (task.state === 'verifying' || task.state === 'merging')
  );
}

/**
 * Why a task's messages are not typed yet, as it really is (2026-10-23: "the agent is busy" was
 * said of a Claude that takes messages while it works, and of messages held behind a menu).
 */
export function pendingNote(task: TaskRecord): string {
  const count = task.pendingInput?.length ?? 0;
  const what = count === 1 ? '1 message' : `${count} messages`;
  if (!task.pendingWhy) return `${what} being typed into its agent now.`;
  const why = {
    menu: `not typed yet: Claude shows a choice of its own on the task's screen (a question or a permission); it goes in once that is answered ('ut task status ${shortId(task.id)}' shows it, 'ut task answer ${shortId(task.id)} approve | deny | <number> | --text "…"' answers it)`,
    busy:
      task.agent === 'codex'
        ? 'not typed yet: Codex is working and only takes text at its prompt; it goes in once Codex is back there'
        : 'not typed yet: Claude is not ready to take it (still starting, or a screen Untether does not know); Untether keeps trying',
    gone: 'not typed yet: its session ended and could not be reopened; Untether keeps trying for an hour',
  }[task.pendingWhy];
  return `${what} ${why}. Typed over 2 min after it was sent, it carries the time it was sent.`;
}
