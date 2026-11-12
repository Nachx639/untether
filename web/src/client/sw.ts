/// <reference no-default-lib="true" />
/// <reference lib="es2020" />
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

import { syncAppBadge } from './sw-badge.js';
import { handleNotificationClick } from './sw-notification-click.js';
import {
  coercePushPayload,
  fallbackPushNotification,
  isNotifyStrings,
  localizeActionTitles,
  localizeClaudeNotification,
  NOTIFY_STRINGS_URL,
  type NotifyStrings,
  notificationOptionsFor,
  type ShownPush,
} from './sw-notify-i18n.js';
import {
  isGuardedNavigation,
  OFFLINE_CACHE,
  OFFLINE_PAGE_URL,
  respondToNavigation,
} from './sw-offline.js';
import { SHELL_UPDATED_MESSAGE, ShellCache, shellRule } from './sw-shell.js';

type BadgeTarget = Parameters<typeof syncAppBadge>[1];

/** The client's files, one shell version at a time (sw-shell.ts). */
const shell = new ShellCache({ caches, fetch: (input, init) => fetch(input, init) });

// Notification tag prefix for Untether notifications

// Types for push notification payloads
interface SessionExitData {
  type: 'session-exit';
  sessionId: string;
  sessionName?: string;
  command?: string;
  exitCode: number;
  duration?: number;
  timestamp: number;
}

interface SessionStartData {
  type: 'session-start';
  sessionId: string;
  sessionName?: string;
  command?: string;
  timestamp: number;
}

interface SessionErrorData {
  type: 'session-error';
  sessionId: string;
  sessionName?: string;
  command?: string;
  error: string;
  timestamp: number;
}

interface ClaudeStatusData {
  type:
    | 'claude-finished'
    | 'claude-replied'
    | 'claude-waiting'
    | 'codex-finished'
    | 'codex-waiting';
  sessionId: string;
  timestamp: string;
}

interface CommandFinishedData {
  type: 'command-finished';
  sessionId: string;
  command: string;
  exitCode: number;
  duration: number;
  timestamp: string;
}

interface CommandErrorData {
  type: 'command-error';
  sessionId: string;
  command: string;
  exitCode: number;
  duration: number;
  timestamp: string;
}

type NotificationData =
  | ClaudeStatusData
  | SessionExitData
  | SessionStartData
  | SessionErrorData
  | CommandFinishedData
  | CommandErrorData;

// Install event
self.addEventListener('install', (event: ExtendableEvent) => {
  console.log('[SW] Installing service worker');

  // Force activation of new service worker
  self.skipWaiting();
  // The current shell version, so the next cold start doesn't wait on the network for it
  // (sw-shell.ts). Best effort: a failure must not keep the new worker from installing.
  event.waitUntil(shell.precache().catch(() => {}));
});

// Activate event
self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log('[SW] Activating service worker');

  event.waitUntil(
    Promise.all([
      // Take control of all pages
      self.clients.claim(),
      // Page loads start on the network while the worker boots, so guarding them with a
      // fetch handler doesn't slow every launch down.
      self.registration.navigationPreload?.enable().catch(() => {}),
      // Shell versions beyond the newest two, half-installed ones and caches of an earlier
      // layout (sw-shell.ts).
      shell.prune().catch(() => {}),
    ])
  );
});

// Failed page loads (Mac asleep, off the tailnet) get a retrying offline page instead of
// the browser's error screen. Network first; nothing but that static page is ever cached.
self.addEventListener('fetch', (event: FetchEvent) => {
  // The client's files: one shell version at a time from the worker's cache (sw-shell.ts).
  const rule = shellRule(event.request, self.location.origin);
  if (rule) {
    event.respondWith(
      shell.respond(new URL(event.request.url), rule, {
        waitUntil: (work) => event.waitUntil(work),
        notifyUpdated: () => notifyShellUpdated(event.clientId),
      })
    );
    return;
  }
  if (!isGuardedNavigation(event.request, self.location.origin)) {
    // Other navigations (an /api/fs/raw file opened in a tab) go to the network as usual,
    // but through the preload already in flight so they aren't requested twice.
    if (event.request.mode === 'navigate') {
      event.respondWith(
        (async () =>
          ((await event.preloadResponse) as Response | undefined) ?? fetch(event.request))()
      );
    }
    return;
  }
  event.respondWith(
    respondToNavigation(
      async () => ((await event.preloadResponse) as Response | undefined) ?? fetch(event.request),
      async () => {
        const cache = await caches.open(OFFLINE_CACHE);
        return cache.match(OFFLINE_PAGE_URL);
      }
    )
  );
});

/** The page that got an older shell version (or, unknown, every page) is told to reload. */
async function notifyShellUpdated(clientId: string): Promise<void> {
  const client = clientId ? await self.clients.get(clientId) : undefined;
  const targets = client ? [client] : await self.clients.matchAll({ type: 'window' });
  for (const target of targets) target.postMessage({ type: SHELL_UPDATED_MESSAGE });
}

// Push event - handle incoming push notifications.
// Every push shows a notification, even an unreadable one: iOS revokes the subscription of
// a web app whose pushes show nothing. (2026-10-20: an empty or malformed payload returned
// silently, and a payload without `data` threw on `data.type`.)
self.addEventListener('push', (event: PushEvent) => {
  console.log('[SW] Push event received');

  let payload: ShownPush | null = null;
  try {
    payload = event.data ? coercePushPayload(event.data.json()) : null;
  } catch (error) {
    console.error('[SW] Failed to parse push payload:', error);
  }
  if (!payload) console.warn('[SW] Unreadable push, showing the stand-in notification');

  event.waitUntil(handlePushNotification(payload));
});

// Notification click event - handle user interactions
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  console.log('[SW] Notification clicked:', event.notification.tag);

  event.notification.close();

  const data = event.notification.data as NotificationData;

  event.waitUntil(
    Promise.all([
      handleNotificationClick(event.action, data, self.clients, self.location.origin),
      syncAppBadge(self.registration, self.navigator as WorkerNavigator & BadgeTarget),
    ])
  );
});

// Notification close event - track dismissals
self.addEventListener('notificationclose', (event: NotificationEvent) => {
  console.log('[SW] Notification closed:', event.notification.tag);

  event.waitUntil(syncAppBadge(self.registration, self.navigator as WorkerNavigator & BadgeTarget));
});

// No background sync needed

async function storedNotifyStrings(): Promise<NotifyStrings | null> {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const response = await cache.match(NOTIFY_STRINGS_URL);
    const strings: unknown = response ? await response.json() : null;
    return isNotifyStrings(strings) ? strings : null;
  } catch {
    return null;
  }
}

async function handlePushNotification(raw: ShownPush | null): Promise<void> {
  const strings = await storedNotifyStrings();
  if (!raw) {
    await showPush(fallbackPushNotification(strings), strings);
    return;
  }
  // Never let translation stop a notification: iOS can revoke a push subscription whose
  // pushes show nothing.
  let payload = raw;
  try {
    payload = localizeClaudeNotification(raw, strings);
    payload = { ...payload, actions: localizeActionTitles(payload.actions, strings) };
  } catch (error) {
    console.warn('[SW] Notification left untranslated:', error);
  }
  if (!(await showPush(payload, strings))) {
    await showPush(fallbackPushNotification(strings), strings);
  }
}

/** Show one notification; false when the browser refused it. */
async function showPush(payload: ShownPush, strings: NotifyStrings | null): Promise<boolean> {
  const { title } = payload;
  try {
    await self.registration.showNotification(
      title,
      notificationOptionsFor(payload, strings, Date.now())
    );
    await syncAppBadge(self.registration, self.navigator as WorkerNavigator & BadgeTarget).catch(
      () => {}
    );

    console.log('[SW] Notification shown:', title);
    return true;
  } catch (error) {
    console.error('[SW] Failed to show notification:', error);
    return false;
  }
}

console.log('[SW] Service worker loaded');
