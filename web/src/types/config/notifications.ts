/** Notification preferences and their defaults. */

/**
 * Unified notification preferences used across Mac and Web
 * This is the single source of truth for notification settings
 */
export interface NotificationPreferences {
  enabled: boolean;
  sessionStart: boolean;
  sessionExit: boolean;
  commandCompletion: boolean;
  commandError: boolean;
  bell: boolean;
  // UI preferences
  soundEnabled: boolean;
  vibrationEnabled: boolean;
}

/** Its part of config.json (UntetherConfig, config/untether-config.ts). */
export interface NotificationsConfig {
  /** Written by the Mac app's notification settings and by PUT /api/config. */
  preferences?: {
    notifications?: NotificationPreferences;
  };
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false,
  sessionStart: false,
  sessionExit: false, // noise on a phone; Claude finished/waiting covers the useful case
  commandCompletion: false,
  commandError: true,
  // Off by default: agents ring the bell constantly; their own notifications cover it.
  bell: false,
  soundEnabled: true,
  vibrationEnabled: false,
};

/**
 * Recommended notification preferences for new users
 * These are sensible defaults when notifications are enabled
 */
export const RECOMMENDED_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  sessionStart: false,
  sessionExit: false, // noise on a phone; Claude finished/waiting covers the useful case
  commandCompletion: false,
  commandError: true,
  // Off by default: agents ring the bell constantly; their own notifications cover it.
  bell: false,
  soundEnabled: true,
  vibrationEnabled: false,
};
