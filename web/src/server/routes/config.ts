import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import type { MacOpenMode } from '../../shared/mac-sessions.js';
import type { MacShareLauncher, MacShareOffReason } from '../../shared/mac-share.js';
import type { AvatarIcons } from '../../shared/model-providers.js';
import { quickStartProgram } from '../../shared/quick-start.js';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type QuickStartCommand,
  type UntetherConfig,
} from '../../types/config.js';
import {
  type ConfigService,
  MacOpenModeSchema,
  MacShareLauncherSchema,
} from '../services/config-service.js';
import {
  type MacSessionsStartOptions,
  macSessionsSettings,
} from '../services/mac-sessions/settings.js';
import {
  type MacShareStartOptions,
  macShareSettings,
} from '../services/mac-sessions/share-settings.js';
import { type PublicModelProvider, sanitizedProviders } from '../services/model-providers.js';
import { sendIconFile } from '../services/project-icon.js';
import { resolveProviderIcon } from '../services/provider-icon.js';
import { QuickStartAvailability } from '../services/quick-start-availability.js';
import { clampIdleMinutes } from '../services/session-suspender.js';
import {
  isValidSigningIdentity,
  listSigningIdentities,
  STABLE_TMUX_IDENTIFIER,
  type StableTmux,
} from '../services/stable-tmux.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('config');

// Validation schemas
const NotificationPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    sessionStart: z.boolean(),
    sessionExit: z.boolean(),
    commandCompletion: z.boolean(),
    commandError: z.boolean(),
    bell: z.boolean(),
    soundEnabled: z.boolean(),
    vibrationEnabled: z.boolean(),
  })
  .partial();

const QuickStartCommandSchema = z.object({
  name: z.string().optional(),
  command: z.string().min(1).trim(),
});

export interface AppConfig {
  repositoryBasePath: string;
  serverConfigured?: boolean;
  quickStartCommands?: QuickStartCommand[];
  notificationPreferences?: NotificationPreferences;
  /** Days after which exited sessions are removed automatically; 0 = off. */
  autoCleanupExitedAfterDays: number;
  /**
   * Nothing waits for the user's OK on the phone (2026-10-24, off unless turned on). Read
   * only here: it is changed through PUT /api/confirmations/auto-approve (its rules there).
   */
  autoApprove: boolean;
  /** Interface style for clients with no choice of their own (config.json), when set. */
  look?: string;
  /** New web/phone sessions are shielded (survive restarts); on unless turned off. */
  shieldNewSessions: boolean;
  /** Idle Claude sessions are restarted on the installed version (2026-10-31); default off. */
  restartUpdatedClaude: boolean;
  /** The installed Mac app is rebuilt and replaced by itself (2026-11-11); default off. */
  autoUpdateInstalledApp: boolean;
  /** Idle Claude sessions are suspended (2026-10-31, session-suspender.ts); default off. */
  suspendIdleClaude: boolean;
  agentExplain: boolean;
  /** Minutes of inactivity before that (default 120). */
  suspendIdleMinutes: number;
  /** tmux is installed on this Mac, so sessions can be shielded at all. */
  shieldAvailable: boolean;
  /** The installed Mac app this development server runs under: it can be kept up to date. */
  installedApp?: string;
  /** "On this Mac" in the session list: the switch, forced or from config.json (default on). */
  macSessions: boolean;
  /** What a tap on a tmux session there opens (default control: ready to type). */
  macSessionsOpenMode: MacOpenMode;
  /** The switch was forced when the server started; macSessionsLockedBy names how. */
  macSessionsLocked: boolean;
  macSessionsLockedBy?: string;
  /** False where nothing can be listed (not macOS or Linux, HQ mode): Settings hides it. */
  macSessionsSupported: boolean;
  /** "Share with phone": the switch, forced or from config.json (default off). */
  macShare: boolean;
  /** What is typed to reopen an agent (default ut). */
  macShareLauncher: MacShareLauncher;
  /** The switch was forced when the server started; macShareLockedBy names how. */
  macShareLocked: boolean;
  macShareLockedBy?: string;
  /** False off macOS and in HQ mode: Settings hides it. */
  macShareSupported: boolean;
  /** Why it isn't offered although supported: off, "On this Mac" off, or no login. */
  macShareReason?: MacShareOffReason;
  /** The server's platform ("darwin", "linux"…): Settings says "this Mac" only on macOS. */
  platform: string;
  /**
   * External model providers the New Session dialog can open a session against (model-providers.ts),
   * without the key or base URL. Empty when none is configured.
   */
  modelProviders: PublicModelProvider[];
  avatarIcons?: AvatarIcons;
  /** QA: clients log their touch scrolls ("scrollPerf" in config.json); sent only when on. */
  scrollPerf?: true;
  /** Experiment: the chat keyboard band fix ("chatKeyboardFix" in config.json); sent only when on. */
  chatKeyboardFix?: true;
  /** Experiment: the chat keyboard fix, iteration 3 ("chatKeyboardFix2"); sent only when on. */
  chatKeyboardFix2?: true;
  /** Experiment: the chat keyboard fix, iteration 4 ("chatKeyboardFix3"); sent only when on. */
  chatKeyboardFix3?: true;
}

const AutoCleanupDaysSchema = z.number().int().min(0).max(3650);

interface ConfigRouteOptions {
  configService: ConfigService;
  isShieldAvailable?: () => boolean;
  /** The stable tmux copy (macOS, the user's own server); missing: Settings hides it. */
  stableTmux?: Pick<StableTmux, 'refresh' | 'clearFailure' | 'lastStatus'>;
  /** Code signing identities in the keychain (tests pass their own). */
  signingIdentities?: () => Promise<Array<{ hash: string; name: string }>>;
  /** Which quick-start programs exist here; tests pass one that starts no shell. */
  quickStartAvailability?: Pick<QuickStartAvailability, 'check'>;
  /** The installed Mac app this server runs under as a development server, if any. */
  installedAppPath?: () => string | undefined;
  /** How the server was started, for the Mac sessions switch (--no-mac-sessions, HQ mode). */
  macSessions?: MacSessionsStartOptions;
  /** Same, for "Share with phone" (--no-mac-share, --no-auth); defaults to macSessions. */
  macShare?: MacShareStartOptions;
}

/**
 * Create routes for application configuration
 */
export function createConfigRoutes(options: ConfigRouteOptions): Router {
  const router = Router();
  const { configService } = options;
  const quickStartAvailability = options.quickStartAvailability ?? new QuickStartAvailability();

  /**
   * Which quick starts can run on this machine: { "<program>": true|false } for the first
   * word of each configured command (services/quick-start-availability.ts). {} when it
   * can't be told: the client then offers every quick start, as before.
   * GET /api/quick-start/availability
   */
  router.get('/quick-start/availability', async (_req, res) => {
    try {
      const programs = configService
        .getConfig()
        .quickStartCommands.map((entry) => quickStartProgram(entry.command));
      res.json(await quickStartAvailability.check(programs));
    } catch (error) {
      logger.warn('[GET /api/quick-start/availability] check failed:', error);
      res.json({});
    }
  });

  /**
   * The stable tmux copy (stable-tmux.ts): the identity chosen, the keychain's code signing
   * identities to choose from, and how the copy is. { supported: false } where there is none.
   * GET /api/tmux-signing
   */
  router.get('/tmux-signing', async (_req, res) => {
    const stableTmux = options.stableTmux;
    if (!stableTmux) return res.json({ supported: false });
    let identities: Array<{ hash: string; name: string }> = [];
    try {
      identities = await (options.signingIdentities ?? (() => listSigningIdentities()))();
    } catch (error) {
      logger.warn('[GET /api/tmux-signing] could not list signing identities:', error);
    }
    res.json({
      supported: true,
      identifier: STABLE_TMUX_IDENTIFIER,
      identity: configService.getConfig().tmuxSigningIdentity ?? null,
      identities,
      status: stableTmux.lastStatus ?? null,
    });
  });

  /** An image from ~/.untether/icons for a provider or avatar (provider-icon.ts): cached a day. */
  router.get('/model-providers/icon/:file', (req, res) => {
    const icon = resolveProviderIcon(req.params.file);
    if ('error' in icon) return res.status(404).json({ error: icon.error });
    sendIconFile(res, icon, 86400);
  });

  /**
   * Get application configuration
   * GET /api/config
   */
  router.get('/config', (_req, res) => {
    try {
      const untetherConfig = configService.getConfig();
      const repositoryBasePath = untetherConfig.repositoryBasePath || DEFAULT_REPOSITORY_BASE_PATH;
      const macSessions = macSessionsSettings(untetherConfig, options.macSessions);
      const macShare = macShareSettings(untetherConfig, options.macShare ?? options.macSessions);

      const config: AppConfig = {
        repositoryBasePath: repositoryBasePath,
        serverConfigured: true, // Always configured when server is running
        quickStartCommands: untetherConfig.quickStartCommands,
        notificationPreferences: configService.getNotificationPreferences(),
        autoCleanupExitedAfterDays: untetherConfig.autoCleanupExitedAfterDays ?? 0,
        autoApprove: untetherConfig.autoApprove === true,
        ...(untetherConfig.look ? { look: untetherConfig.look } : {}),
        shieldNewSessions: untetherConfig.shieldNewSessions !== false,
        restartUpdatedClaude: untetherConfig.restartUpdatedClaude === true,
        autoUpdateInstalledApp: untetherConfig.autoUpdateInstalledApp === true,
        suspendIdleClaude: untetherConfig.suspendIdleClaude === true,
        agentExplain: untetherConfig.agentExplain !== false,
        suspendIdleMinutes: clampIdleMinutes(untetherConfig.suspendIdleMinutes),
        shieldAvailable: options.isShieldAvailable?.() ?? false,
        ...(options.installedAppPath?.() ? { installedApp: options.installedAppPath() } : {}),
        macSessions: macSessions.on,
        macSessionsOpenMode: macSessions.openMode,
        macSessionsLocked: macSessions.lockedBy !== undefined,
        ...(macSessions.lockedBy ? { macSessionsLockedBy: macSessions.lockedBy } : {}),
        macSessionsSupported: macSessions.supported,
        macShare: macShare.on,
        macShareLauncher: macShare.launcher,
        macShareLocked: macShare.lockedBy !== undefined,
        ...(macShare.lockedBy ? { macShareLockedBy: macShare.lockedBy } : {}),
        macShareSupported: macShare.supported,
        ...(macShare.reason && macShare.supported ? { macShareReason: macShare.reason } : {}),
        platform: options.macSessions?.platform ?? process.platform,
        modelProviders: sanitizedProviders(untetherConfig),
        ...(untetherConfig.avatarIcons ? { avatarIcons: untetherConfig.avatarIcons } : {}),
        ...(untetherConfig.scrollPerf === true ? { scrollPerf: true as const } : {}),
        ...(untetherConfig.chatKeyboardFix === true ? { chatKeyboardFix: true as const } : {}),
        ...(untetherConfig.chatKeyboardFix2 === true ? { chatKeyboardFix2: true as const } : {}),
        ...(untetherConfig.chatKeyboardFix3 === true ? { chatKeyboardFix3: true as const } : {}),
      };

      logger.debug('[GET /api/config] Returning app config:', config);
      res.json(config);
    } catch (error) {
      logger.error('[GET /api/config] Error getting app config:', error);
      res.status(500).json({ error: 'Failed to get app config' });
    }
  });

  /**
   * Update application configuration
   * PUT /api/config
   */
  router.put('/config', (req, res) => {
    try {
      const {
        quickStartCommands,
        repositoryBasePath,
        notificationPreferences,
        autoCleanupExitedAfterDays,
        shieldNewSessions,
        restartUpdatedClaude,
        autoUpdateInstalledApp,
        suspendIdleClaude,
        agentExplain,
        suspendIdleMinutes,
        macSessions,
        macSessionsOpenMode,
        macShare,
        macShareLauncher,
        tmuxSigningIdentity,
      } = req.body;
      const updates: { [key: string]: unknown } = {};
      let validatedCommands: QuickStartCommand[] | undefined;
      let validatedPath: string | undefined;
      let validatedPrefs: Partial<NotificationPreferences> | undefined;
      let validatedCleanupDays: number | undefined;
      let validatedOpenMode: MacOpenMode | undefined;
      let validatedLauncher: MacShareLauncher | undefined;

      if (quickStartCommands !== undefined) {
        // First check if it's an array
        if (!Array.isArray(quickStartCommands)) {
          logger.error('[PUT /api/config] Invalid quick start commands: not an array');
          // Don't return immediately - let it fall through to "No valid updates"
        } else {
          // Filter and validate commands, keeping only valid ones
          validatedCommands = [];

          for (const cmd of quickStartCommands) {
            try {
              // Skip null/undefined entries
              if (cmd == null) continue;

              const validated = QuickStartCommandSchema.parse(cmd);
              // Skip empty commands
              if (validated.command.trim()) {
                validatedCommands.push(validated);
              }
            } catch {
              // Skip invalid commands
            }
          }

          updates.quickStartCommands = validatedCommands;
        }
      }

      if (repositoryBasePath !== undefined) {
        try {
          // Validate repository base path
          validatedPath = z.string().min(1).parse(repositoryBasePath);

          updates.repositoryBasePath = validatedPath;
        } catch (validationError) {
          logger.error('[PUT /api/config] Invalid repository base path:', validationError);
          // Skip invalid values instead of returning error
        }
      }

      if (notificationPreferences !== undefined) {
        try {
          // Validate notification preferences
          validatedPrefs = NotificationPreferencesSchema.parse(notificationPreferences);

          updates.notificationPreferences = validatedPrefs;
        } catch (validationError) {
          logger.error('[PUT /api/config] Invalid notification preferences:', validationError);
          // Skip invalid values instead of returning error
        }
      }

      if (autoCleanupExitedAfterDays !== undefined) {
        const parsed = AutoCleanupDaysSchema.safeParse(autoCleanupExitedAfterDays);
        if (parsed.success) {
          validatedCleanupDays = parsed.data;
          updates.autoCleanupExitedAfterDays = validatedCleanupDays;
        } else {
          logger.error('[PUT /api/config] Invalid autoCleanupExitedAfterDays:', parsed.error);
        }
      }

      if (typeof shieldNewSessions === 'boolean') {
        updates.shieldNewSessions = shieldNewSessions;
      }

      if (typeof restartUpdatedClaude === 'boolean') {
        updates.restartUpdatedClaude = restartUpdatedClaude;
      }

      if (typeof autoUpdateInstalledApp === 'boolean') {
        updates.autoUpdateInstalledApp = autoUpdateInstalledApp;
      }

      if (typeof suspendIdleClaude === 'boolean') {
        updates.suspendIdleClaude = suspendIdleClaude;
      }
      if (typeof agentExplain === 'boolean') {
        updates.agentExplain = agentExplain;
      }

      const validIdleMinutes =
        typeof suspendIdleMinutes === 'number' && Number.isFinite(suspendIdleMinutes)
          ? clampIdleMinutes(suspendIdleMinutes)
          : undefined;
      if (validIdleMinutes !== undefined) {
        updates.suspendIdleMinutes = validIdleMinutes;
      } else if (suspendIdleMinutes !== undefined) {
        logger.error('[PUT /api/config] Invalid suspendIdleMinutes');
      }

      // Saved even while the server's start forces the switch: it applies once that is gone.
      if (typeof macSessions === 'boolean') {
        updates.macSessions = macSessions;
      }

      if (macSessionsOpenMode !== undefined) {
        const parsed = MacOpenModeSchema.safeParse(macSessionsOpenMode);
        if (parsed.success) {
          validatedOpenMode = parsed.data;
          updates.macSessionsOpenMode = validatedOpenMode;
        } else {
          logger.error('[PUT /api/config] Invalid macSessionsOpenMode:', parsed.error);
        }
      }

      // Likewise saved while forced. The other macShare* keys are edited in config.json only.
      if (typeof macShare === 'boolean') {
        updates.macShare = macShare;
      }

      if (macShareLauncher !== undefined) {
        const parsed = MacShareLauncherSchema.safeParse(macShareLauncher);
        if (parsed.success) {
          validatedLauncher = parsed.data;
          updates.macShareLauncher = validatedLauncher;
        } else {
          logger.error('[PUT /api/config] Invalid macShareLauncher:', parsed.error);
        }
      }

      // null turns the stable tmux copy off (the installed tmux again).
      const signingIdentitySent =
        options.stableTmux !== undefined &&
        (tmuxSigningIdentity === null || isValidSigningIdentity(tmuxSigningIdentity));
      if (signingIdentitySent) {
        updates.tmuxSigningIdentity = tmuxSigningIdentity;
      } else if (tmuxSigningIdentity !== undefined) {
        logger.error('[PUT /api/config] Invalid or unsupported tmuxSigningIdentity');
      }

      if (Object.keys(updates).length > 0) {
        const currentConfig = configService.getConfig();
        const updatedConfig: UntetherConfig = { ...currentConfig };
        if (typeof shieldNewSessions === 'boolean') {
          updatedConfig.shieldNewSessions = shieldNewSessions;
        }
        if (typeof restartUpdatedClaude === 'boolean') {
          updatedConfig.restartUpdatedClaude = restartUpdatedClaude;
        }
        if (typeof autoUpdateInstalledApp === 'boolean') {
          updatedConfig.autoUpdateInstalledApp = autoUpdateInstalledApp;
        }
        if (typeof suspendIdleClaude === 'boolean') {
          updatedConfig.suspendIdleClaude = suspendIdleClaude;
        }
        if (typeof agentExplain === 'boolean') {
          updatedConfig.agentExplain = agentExplain;
        }
        if (validIdleMinutes !== undefined) {
          updatedConfig.suspendIdleMinutes = validIdleMinutes;
        }
        if (typeof macSessions === 'boolean') {
          updatedConfig.macSessions = macSessions;
        }
        if (validatedOpenMode) {
          updatedConfig.macSessionsOpenMode = validatedOpenMode;
        }
        if (typeof macShare === 'boolean') {
          updatedConfig.macShare = macShare;
        }
        if (validatedLauncher) {
          updatedConfig.macShareLauncher = validatedLauncher;
        }
        if (signingIdentitySent) {
          if (tmuxSigningIdentity === null) delete updatedConfig.tmuxSigningIdentity;
          else updatedConfig.tmuxSigningIdentity = tmuxSigningIdentity;
        }

        if (validatedCommands) {
          updatedConfig.quickStartCommands = validatedCommands;
        }
        if (validatedPath) {
          updatedConfig.repositoryBasePath = validatedPath;
        }
        if (validatedCleanupDays !== undefined) {
          updatedConfig.autoCleanupExitedAfterDays = validatedCleanupDays;
        }
        if (validatedPrefs) {
          updatedConfig.preferences = {
            ...currentConfig.preferences,
            notifications: {
              ...DEFAULT_NOTIFICATION_PREFERENCES,
              ...configService.getNotificationPreferences(),
              ...validatedPrefs,
            },
          };
        }

        // Saving it again is the user's way to try a failed signing once more (cleared before
        // the save, whose change notice may start the refresh).
        if (signingIdentitySent) options.stableTmux?.clearFailure();
        configService.updateConfig(updatedConfig);
        if (signingIdentitySent) void options.stableTmux?.refresh();
        logger.debug('[PUT /api/config] Updated app config:', updates);
        res.json({ success: true, ...updates });
      } else {
        res.status(400).json({ error: 'No valid updates provided' });
      }
    } catch (error) {
      logger.error('[PUT /api/config] Error updating config:', error);
      res.status(500).json({ error: 'Failed to update config' });
    }
  });

  return router;
}
