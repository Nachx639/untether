// Push notifications: the service and the session monitor / PTY events that send them.
import { ServerEventType } from '../shared/types.js';
import type { AppContext } from './server-context.js';
import {
  NOTIFICATION_PREFERENCE_FOR_TYPE,
  PushNotificationService,
} from './services/push-notification-service.js';
import { colors } from './utils/colors.js';
import { createLogger } from './utils/logger.js';
import { DEFAULT_VAPID_CONTACT, VapidManager } from './utils/vapid-manager.js';

const logger = createLogger('server');

export async function setupPush(ctx: AppContext) {
  const { config, configService, ptyManager } = ctx;
  // Initialize push notification services
  let vapidManager: VapidManager | null = null;
  let pushNotificationService: PushNotificationService | null = null;

  if (config.pushEnabled) {
    try {
      logger.log('Initializing push notification services');

      // Initialize VAPID manager with auto-generation
      vapidManager = new VapidManager();
      await vapidManager.initialize({
        contactEmail: config.vapidEmail || DEFAULT_VAPID_CONTACT,
        generateIfMissing: true, // Auto-generate keys if none exist
      });

      logger.log('VAPID keys initialized successfully');

      // Initialize push notification service
      pushNotificationService = new PushNotificationService(vapidManager);
      // Every push goes through the Settings switches (the server used to ignore them).
      pushNotificationService.setPreferenceFilter((type) => {
        const key = NOTIFICATION_PREFERENCE_FOR_TYPE[type];
        return key ? configService.getNotificationPreferences()[key] !== false : true;
      });
      await pushNotificationService.initialize();
      pushNotificationService.setEventSink((event) => ctx.eventLog.record(event));
      pushNotificationService.setMuteFilter((sessionId) => ptyManager.isSessionMuted(sessionId));

      logger.log(colors.green('Push notification services initialized'));
    } catch (error) {
      logger.error('Failed to initialize push notification services:', error);
      logger.warn('Continuing without push notifications');
      vapidManager = null;
      pushNotificationService = null;
    }
  } else {
    logger.debug('Push notifications disabled');
  }
  return { vapidManager, pushNotificationService };
}

/** "45s", "1m 30s": whole minutes, never rounded up (90 s read "2m 30s", 2026-11-10). */
export function commandDurationText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

export function wireMonitorPushes(ctx: AppContext) {
  const { pushNotificationService, sessionMonitor } = ctx;
  // Connect SessionMonitor to push notification service
  if (sessionMonitor && pushNotificationService) {
    logger.info('Connecting SessionMonitor to push notification service');

    // Of the monitor's notifications only the bell is pushed from here. The others have their
    // own senders, and pushing them here too sent a second copy: session start (the
    // control-dir watcher), session end (the ptyManager 'sessionExited' listener, with the
    // exit code), a finished command (its 'commandFinished' listener, with where and how
    // long; 2026-11-10: that one still went out twice, under two tags) and the test
    // notification (its endpoint).
    sessionMonitor.on('notification', (event) => {
      if (event.type !== ServerEventType.Bell || !event.sessionId) return;
      const where = event.sessionName || 'Terminal';
      try {
        // Held, deduped against agent notifications and throttled per session.
        pushNotificationService.queueSessionBell(event.sessionId, {
          type: 'bell',
          title: `🔔 ${where} needs attention`,
          body: 'The terminal rang its bell',
          icon: '/apple-touch-icon.png',
          badge: '/favicon-32.png',
          actions: [
            { action: 'view-session', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' },
          ],
          data: {
            type: 'bell',
            sessionId: event.sessionId,
            timestamp: event.timestamp,
            where,
          },
        });
      } catch (error) {
        logger.error('Failed to queue the bell push:', error);
      }
    });
  }
}

export function wireSessionPushes(ctx: AppContext) {
  const { ptyManager, pushNotificationService, sessionManager } = ctx;
  // Connect session exit notifications if push notifications are enabled
  if (pushNotificationService) {
    ptyManager.on('sessionExited', (sessionId: string) => {
      // Load session info to get details
      const sessionInfo = sessionManager.loadSessionInfo(sessionId);
      const exitCode = sessionInfo?.exitCode ?? 0;
      const sessionName = sessionInfo?.userTitle || sessionInfo?.name || `Session ${sessionId}`;

      // Determine notification type based on exit code
      const notificationType = exitCode === 0 ? 'session-exit' : 'session-error';
      const title = exitCode === 0 ? 'Session Ended' : 'Session Ended with Errors';
      const body =
        exitCode === 0
          ? `${sessionName} has finished.`
          : `${sessionName} exited with code ${exitCode}.`;

      pushNotificationService
        .sendNotification({
          type: notificationType,
          title,
          body,
          icon: '/apple-touch-icon.png',
          badge: '/favicon-32.png',
          tag: `untether-${notificationType}-${sessionId}`,
          requireInteraction: false,
          data: {
            type: notificationType,
            sessionId,
            sessionName,
            exitCode,
            timestamp: new Date().toISOString(),
          },
          actions: [
            { action: 'view-logs', title: 'View Logs' },
            { action: 'dismiss', title: 'Dismiss' },
          ],
        })
        .catch((error) => {
          logger.error('Failed to send session exit notification:', error);
        });
    });
    logger.debug('Connected session exit notifications to PTY manager');

    // Connect command finished notifications
    ptyManager.on('commandFinished', ({ sessionId, command, exitCode, duration, timestamp }) => {
      const isClaudeCommand = command.toLowerCase().includes('claude');

      // Enhanced logging for Claude commands
      if (isClaudeCommand) {
        logger.log(
          colors.magenta(
            `📬 Server received Claude commandFinished event: sessionId=${sessionId}, command="${command}", exitCode=${exitCode}, duration=${duration}ms`
          )
        );
      } else {
        logger.debug(
          `Server received commandFinished event for session ${sessionId}: "${command}"`
        );
      }

      // Determine notification type based on exit code
      const notificationType = exitCode === 0 ? 'command-finished' : 'command-error';
      const title = exitCode === 0 ? 'Command Completed' : 'Command Failed';
      const body =
        exitCode === 0
          ? `${command} completed successfully`
          : `${command} failed with exit code ${exitCode}`;

      // Format duration for display
      const durationStr = commandDurationText(duration);

      logger.debug(
        `Sending push notification: type=${notificationType}, title="${title}", body="${body} (${durationStr})"`
      );

      pushNotificationService
        .sendNotification({
          type: notificationType,
          title,
          body: `${body} (${durationStr})`,
          icon: '/apple-touch-icon.png',
          badge: '/favicon-32.png',
          tag: `untether-command-${sessionId}-${Date.now()}`,
          // A failed command stays on screen, as the monitor's copy of this push did.
          requireInteraction: notificationType === 'command-error',
          data: {
            type: notificationType,
            sessionId,
            command,
            exitCode,
            duration,
            timestamp,
            // Rebuilt in the user's language by the service worker (sw-notify-i18n.ts).
            where: command,
            detail: durationStr,
          },
          actions: [
            { action: 'view-session', title: 'View Session' },
            { action: 'dismiss', title: 'Dismiss' },
          ],
        })
        .catch((error) => {
          logger.error('Failed to send command finished notification:', error);
        });
    });
    logger.debug('Connected command finished notifications to PTY manager');
  }
}
