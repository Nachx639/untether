/**
 * config.json as a whole: the settings of each area put together. A new setting goes in its
 * area's file, never here.
 */

import type { AppUpdateConfig } from './app-update.js';
import type { GeneralConfig } from './general.js';
import type { MacSessionsConfig } from './mac-sessions.js';
import type { MacShareConfig } from './mac-share.js';
import type { ModelProvidersConfig } from './model-providers.js';
import type { NotificationsConfig } from './notifications.js';
import type { QuickStartConfig } from './quick-start.js';
import type { SessionsConfig } from './sessions.js';
import type { TasksConfig } from './tasks.js';

export interface UntetherConfig
  extends GeneralConfig,
    QuickStartConfig,
    NotificationsConfig,
    ModelProvidersConfig,
    SessionsConfig,
    AppUpdateConfig,
    TasksConfig,
    MacSessionsConfig,
    MacShareConfig {}
