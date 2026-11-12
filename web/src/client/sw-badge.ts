/**
 * Home-screen icon badge while the app is closed. The open app sets the badge from its
 * unread count (utils/unread-tracker.ts) but, closed, it never runs: a "Claude needs you"
 * push arrived and the icon stayed blank. The worker counts the sessions that have a Claude
 * or Codex notification on screen (one per session, by tag) and badges that.
 */
import { isAgentPushTag } from '../shared/agent-push.js';

interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

interface NotificationSource {
  getNotifications(): Promise<Array<{ tag: string }>>;
}

export async function syncAppBadge(
  registration: NotificationSource,
  nav: BadgeNavigator
): Promise<void> {
  if (!nav.setAppBadge) return;
  try {
    const notifications = await registration.getNotifications();
    const count = notifications.filter((n) => isAgentPushTag(n.tag)).length;
    await (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.());
  } catch {
    // Badging is a nicety; never let it break showing the notification.
  }
}
