/**
 * Notifications about something already resolved go away while the app is open (2026-11-09: a
 * "needs you" stayed in the phone's notification center after the question was answered and
 * the task closed). A push can't take one back: iOS shows every push, so the open app closes
 * them, by what each one is about (its data, since its tag can be the push's own id).
 */
import { agentPush } from '../../shared/agent-push.js';
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskRecord } from '../../shared/tasks.js';
import type { Session } from '../../shared/types.js';

export interface WaitingView {
  sessions: readonly Pick<Session, 'id' | 'status' | 'claudeStatus' | 'agentStatus'>[];
  tasks: readonly Pick<TaskRecord, 'id' | 'state'>[];
  confirmations: readonly Pick<TaskConfirmation, 'id'>[];
}

interface PushData {
  type?: unknown;
  sessionId?: unknown;
  taskId?: unknown;
  confirmId?: unknown;
}

/** What a notification announced is over. Anything unknown stays: only a known end closes it. */
export function pushIsResolved(data: PushData | null | undefined, view: WaitingView): boolean {
  if (agentPush(data?.type)?.kind === 'waiting' && typeof data?.sessionId === 'string') {
    const session = view.sessions.find((entry) => entry.id === data.sessionId);
    if (!session || session.status === 'exited') return true;
    const status = session.claudeStatus?.status ?? session.agentStatus?.status;
    return !!status && status !== 'waiting';
  }
  if (data?.type === 'task-needs-you' && typeof data.taskId === 'string') {
    const task = view.tasks.find((entry) => entry.id === data.taskId);
    return !task || task.state !== 'needs_you';
  }
  if (data?.type === 'task-confirm' && typeof data.confirmId === 'string') {
    return !view.confirmations.some((entry) => entry.id === data.confirmId);
  }
  return false;
}

/** Closes the notifications on screen whose subject `view` says is over. */
export async function closeResolvedNotifications(view: WaitingView): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const notifications = (await registration?.getNotifications()) ?? [];
    for (const notification of notifications) {
      if (pushIsResolved(notification.data as PushData, view)) notification.close();
    }
  } catch {
    // A nicety: never let it break the list.
  }
}
