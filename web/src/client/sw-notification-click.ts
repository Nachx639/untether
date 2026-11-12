/**
 * Where a tapped push notification takes you. "Claude needs you" (or Codex) opens its session with the
 * answer sheet up (`?answer=1`): one tap from the lock screen to Claude's options. iOS shows
 * no action buttons on web pushes, so the tap itself is the main path; where buttons exist,
 * "Answer" goes to the same sheet. Nothing is ever answered from the notification itself.
 */
import { agentPush } from '../shared/agent-push.js';

export interface ClickData {
  type?: string;
  sessionId?: string;
  /** "Preview ready": the saved preview, and the dev server's port and path. */
  id?: string;
  port?: number;
  path?: string;
  /** "Confirm" (task-confirm): the pending action the confirm sheet shows. */
  confirmId?: string;
  /** Task pushes (task-ready, task-needs-you, task-failed, task-merged, task-missed …). */
  taskId?: string;
}

export interface ClickTarget {
  /** Path to open when no app window exists. */
  url: string;
  /** Action posted to an open app window (it navigates in place). */
  action: string;
}

/** `answer` opens the answer sheet: the notification tap or its "Answer" button. */
export function notificationClickTarget(action: string, data: ClickData | undefined): ClickTarget {
  const sessionId = data?.sessionId;
  if (agentPush(data?.type)?.kind === 'waiting' && sessionId && (!action || action === 'answer')) {
    return { url: `/session/${encodeURIComponent(sessionId)}?answer=1`, action: 'answer' };
  }
  // A task-engine action waiting for the user's OK: the app's confirm sheet (/?confirm=<id>).
  if (
    data?.type === 'task-confirm' &&
    typeof data.confirmId === 'string' &&
    (!action || action === 'view-session' || action === 'confirm')
  ) {
    return { url: `/?confirm=${encodeURIComponent(data.confirmId)}`, action: 'confirm' };
  }
  // A task's push (ready, needs you, failed, merged, not run, setup failed): the task's row in
  // the list (/?task=<id>), where Fusionar / Descartar are — not its agent's terminal. Pushes
  // without a session (task-missed, setup failed) went nowhere at all before.
  if (
    typeof data?.taskId === 'string' &&
    data.taskId &&
    typeof data.type === 'string' &&
    data.type.startsWith('task-') &&
    (!action || action === 'view-session')
  ) {
    return { url: `/?task=${encodeURIComponent(data.taskId)}`, action: 'view-task' };
  }
  // "Preview ready": straight into the preview's own view (/preview/<id>). The server always
  // sends the id (preview-registry.ts previewReadyPush).
  if (
    data?.type === 'preview-ready' &&
    sessionId &&
    typeof data.id === 'string' &&
    (!action || action === 'view-session')
  ) {
    const base = `/preview/${encodeURIComponent(data.id)}`;
    const url =
      data.path && data.path !== '/' ? `${base}?path=${encodeURIComponent(data.path)}` : base;
    return { url, action: 'view-session' };
  }
  // Tapping the notification itself (no action button) opens its session too.
  // (Not for session-exit: that session is gone.)
  if (!action && sessionId && data?.type !== 'session-exit') action = 'view-session';
  if (action === 'view-session' && sessionId) {
    return { url: `/session/${encodeURIComponent(sessionId)}`, action };
  }
  if (action === 'view-logs') return { url: '/logs', action };
  return { url: '/', action };
}

interface WindowClientLike {
  url: string;
  focused?: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface ClientsLike {
  matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly unknown[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * Reuses an open app window (the focused one first): it gets the action by postMessage and
 * navigates without a reload. Otherwise opens a new window at the deep link.
 */
export async function handleNotificationClick(
  action: string,
  data: ClickData | undefined,
  clients: ClientsLike,
  origin: string
): Promise<void> {
  if (action === 'dismiss') return;
  const target = notificationClickTarget(action, data);
  // The log viewer is a page of its own (/logs), not a view of the app. 2026-11-11: with the
  // app open "View Logs" was posted to it, which knows no such action and opened the session
  // that had just ended; with the app closed it opened the logs.
  if (target.action === 'view-logs') {
    await openWindow(clients, origin + target.url);
    return;
  }
  const windows = (await clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })) as WindowClientLike[];
  const ours = windows
    // Not the log viewer: it has no listener for the action, and the tap went nowhere.
    .filter(
      (client) =>
        client.url.startsWith(origin) &&
        !/^\/logs(\.html)?([/?#]|$)/.test(client.url.slice(origin.length))
    )
    .sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)));
  for (const client of ours) {
    try {
      await client.focus();
      client.postMessage({ type: 'notification-action', action: target.action, data });
      return;
    } catch (error) {
      console.warn('[SW] Failed to focus client:', error);
    }
  }
  await openWindow(clients, origin + target.url);
}

async function openWindow(clients: ClientsLike, url: string): Promise<void> {
  try {
    await clients.openWindow(url);
  } catch (error) {
    console.error('[SW] Failed to open window:', error);
  }
}
