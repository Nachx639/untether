/**
 * Server Configuration Service
 *
 * Centralized service for managing server configuration including:
 * - Quick start commands
 * - Repository base path
 * - Server configuration status
 */
import { DEFAULT_REPOSITORY_BASE_PATH } from '../../shared/constants.js';
import type { MacOpenMode } from '../../shared/mac-sessions.js';
import type { MacShareLauncher, MacShareOffReason } from '../../shared/mac-share.js';
import type { AvatarIcons, PublicModelProvider } from '../../shared/model-providers.js';
import { HttpMethod } from '../../shared/types.js';
import type { NotificationPreferences, QuickStartCommand } from '../../types/config.js';
import { createLogger } from '../utils/logger.js';
import { type AuthClient, authClient } from './auth-client.js';

const logger = createLogger('server-config-service');

export interface ServerConfig {
  repositoryBasePath: string;
  serverConfigured?: boolean;
  quickStartCommands?: QuickStartCommand[];
  notificationPreferences?: NotificationPreferences;
  /** Days after which finished sessions are removed automatically; 0 = off. */
  autoCleanupExitedAfterDays?: number;
  /** Nothing waits for the user's OK on the phone (2026-10-24); default off. */
  autoApprove?: boolean;
  /** The server's default interface style (config.json `look`); none = each device's own. */
  look?: string;
  /** New web/phone sessions are shielded (survive server restarts); default on. */
  shieldNewSessions?: boolean;
  /** Idle Claude sessions are restarted on the installed version (2026-10-31); default off. */
  restartUpdatedClaude?: boolean;
  /** The installed Mac app is rebuilt and replaced by itself (2026-11-11); default off. */
  autoUpdateInstalledApp?: boolean;
  /** The installed Mac app this development server runs under; none: no such switch. */
  installedApp?: string;
  /** The home's cards say in one line what each agent does (2026-11-08); default on. */
  agentExplain?: boolean;
  /** Idle Claude sessions are suspended to free memory (2026-10-31); default off. */
  suspendIdleClaude?: boolean;
  /** Minutes of inactivity before a session is suspended (default 120, at least 15). */
  suspendIdleMinutes?: number;
  /** tmux is installed on the Mac, so sessions can be shielded at all. */
  shieldAvailable?: boolean;
  /** "On this Mac" in the session list; default on. */
  macSessions?: boolean;
  /** What a tap on a tmux session there opens; default control (ready to type). */
  macSessionsOpenMode?: MacOpenMode;
  /** The switch was forced when the server started; macSessionsLockedBy names how. */
  macSessionsLocked?: boolean;
  macSessionsLockedBy?: string;
  /** False where the server can't list anything (not macOS or Linux, HQ mode). */
  macSessionsSupported?: boolean;
  /** "Share with phone"; default off. */
  macShare?: boolean;
  /** What is typed to reopen an agent; default ut. */
  macShareLauncher?: MacShareLauncher;
  /** The switch was forced when the server started; macShareLockedBy names how. */
  macShareLocked?: boolean;
  macShareLockedBy?: string;
  /** False off macOS and in HQ mode. */
  macShareSupported?: boolean;
  /** Why it isn't offered although supported. */
  macShareReason?: MacShareOffReason;
  /** The server's platform ("darwin", "linux"…). */
  platform?: string;
  /** External model providers the New Session dialog can open a session against (no key). */
  modelProviders?: PublicModelProvider[];
  /** Marks that replace the app's in the avatars; absent when none are configured. */
  avatarIcons?: AvatarIcons;
  /** QA: log every touch scroll of the terminal (utils/scroll-perf.ts); absent when off. */
  scrollPerf?: boolean;
  /** Experiment: the home-screen app's chat keyboard band fix (chat-keyboard-fix.ts); absent when off. */
  chatKeyboardFix?: boolean;
  /** Experiment: iteration 3 of that fix (chat-keyboard-fix2.ts); absent when off. */
  chatKeyboardFix2?: boolean;
  /** Experiment: iteration 4 (chat-keyboard-fix3.ts); absent when off. */
  chatKeyboardFix3?: boolean;
  /** Only sent in PUT: the stable tmux copy's signing identity (null: off). */
  tmuxSigningIdentity?: string | null;
}

/** GET /api/tmux-signing: the stable tmux copy (macOS, the user's own server). */
export interface TmuxSigningInfo {
  supported: boolean;
  identity?: string | null;
  identities?: Array<{ hash: string; name: string }>;
  status?: { state: string; version?: string; error?: string } | null;
}

export class ServerConfigService {
  private authClient?: AuthClient;
  private configCache?: ServerConfig;
  private cacheTimestamp?: number;
  /** The GET /api/config being made, shared by everyone who asks meanwhile. */
  private inFlight?: Promise<ServerConfig>;
  /** Bumped by clearCache(): a reply that was asked for before it must not fill the cache. */
  private cacheGeneration = 0;
  private readonly CACHE_TTL = 60000; // 1 minute cache

  constructor(authClient?: AuthClient) {
    this.authClient = authClient;
  }

  /**
   * Set or update the auth client
   */
  setAuthClient(authClient: AuthClient): void {
    this.authClient = authClient;
    // Clear cache when auth changes
    this.clearCache();
  }

  /**
   * Clear the config cache
   */
  private clearCache(): void {
    this.configCache = undefined;
    this.cacheTimestamp = undefined;
    this.inFlight = undefined;
    this.cacheGeneration++;
  }

  /**
   * Check if cache is still valid
   */
  private isCacheValid(): boolean {
    if (!this.configCache || !this.cacheTimestamp) {
      return false;
    }
    return Date.now() - this.cacheTimestamp < this.CACHE_TTL;
  }

  /**
   * Load server configuration
   * @param forceRefresh - Force refresh even if cache is valid
   */
  async loadConfig(forceRefresh = false): Promise<ServerConfig> {
    // Return cached config if valid and not forcing refresh
    if (!forceRefresh && this.isCacheValid() && this.configCache) {
      logger.debug('Returning cached server config');
      return this.configCache;
    }

    // 2026-11-10: startup asked for the config from 3-5 places at once, one identical GET each.
    // A forced refresh starts its own request; failures are never cached or kept in flight.
    if (!forceRefresh && this.inFlight) return this.inFlight;
    const request = this.fetchConfig();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  private async fetchConfig(): Promise<ServerConfig> {
    const generation = this.cacheGeneration;
    try {
      const response = await fetch('/api/config', {
        headers: this.authClient ? this.authClient.getAuthHeader() : {},
      });

      if (!response.ok) {
        throw new Error(`Failed to load config: ${response.statusText}`);
      }

      const config: ServerConfig = await response.json();

      // Update cache, unless the cache was cleared (auth or config changed) since the request
      if (generation === this.cacheGeneration) {
        this.configCache = config;
        this.cacheTimestamp = Date.now();
      }

      logger.debug('Loaded server config:', config);
      return config;
    } catch (error) {
      logger.error('Failed to load server config:', error);
      // Return default config on error
      return {
        repositoryBasePath: DEFAULT_REPOSITORY_BASE_PATH,
        serverConfigured: false,
        quickStartCommands: [],
      };
    }
  }

  /**
   * Update quick start commands
   */
  async updateQuickStartCommands(commands: QuickStartCommand[]): Promise<void> {
    if (!commands || !Array.isArray(commands)) {
      throw new Error('Invalid quick start commands');
    }

    // Validate commands
    const validCommands = commands.filter(
      (cmd) => cmd && typeof cmd.command === 'string' && cmd.command.trim()
    );

    try {
      const response = await fetch('/api/config', {
        method: HttpMethod.PUT,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authClient ? this.authClient.getAuthHeader() : {}),
        },
        body: JSON.stringify({ quickStartCommands: validCommands }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update config: ${response.statusText}`);
      }

      // Clear cache to force reload on next access
      this.clearCache();

      logger.debug('Updated quick start commands:', validCommands);
    } catch (error) {
      logger.error('Failed to update quick start commands:', error);
      throw error;
    }
  }

  /**
   * Get repository base path from config
   */
  async getRepositoryBasePath(): Promise<string> {
    const config = await this.loadConfig();
    return config.repositoryBasePath || DEFAULT_REPOSITORY_BASE_PATH;
  }

  /**
   * Check if server is configured (Mac app connected)
   */
  async isServerConfigured(): Promise<boolean> {
    const config = await this.loadConfig();
    return config.serverConfigured ?? false;
  }

  /**
   * Get quick start commands
   */
  async getQuickStartCommands(): Promise<QuickStartCommand[]> {
    const config = await this.loadConfig();
    return config.quickStartCommands || [];
  }

  /** The configured external model providers (model-providers.ts); empty when none. */
  async getModelProviders(): Promise<PublicModelProvider[]> {
    const config = await this.loadConfig();
    return config.modelProviders ?? [];
  }

  /**
   * Update configuration (supports partial updates)
   */
  async updateConfig(updates: Partial<ServerConfig>): Promise<void> {
    if (!updates || typeof updates !== 'object') {
      throw new Error('Invalid configuration updates');
    }

    try {
      const response = await fetch('/api/config', {
        method: HttpMethod.PUT,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authClient ? this.authClient.getAuthHeader() : {}),
        },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        throw new Error(`Failed to update config: ${response.statusText}`);
      }

      // Clear cache to force reload on next access
      this.clearCache();

      logger.debug('Updated server config:', updates);
    } catch (error) {
      logger.error('Failed to update server config:', error);
      throw error;
    }
  }

  /** The stable tmux copy's identity, the keychain's identities and its state. */
  async getTmuxSigning(): Promise<TmuxSigningInfo> {
    const response = await fetch('/api/tmux-signing', {
      headers: { ...(this.authClient ? this.authClient.getAuthHeader() : {}) },
    });
    if (!response.ok) return { supported: false };
    return (await response.json()) as TmuxSigningInfo;
  }

  /** The user's autoApprove (PUT /api/confirmations/auto-approve: from the app, no OK asked). */
  async setAutoApprove(on: boolean): Promise<void> {
    const response = await fetch('/api/confirmations/auto-approve', {
      method: HttpMethod.PUT,
      headers: {
        'Content-Type': 'application/json',
        ...(this.authClient ? this.authClient.getAuthHeader() : {}),
      },
      body: JSON.stringify({ on }),
    });
    // 202: the server took it for an agent's request and asks the OK; not on yet.
    if (response.status !== 200) {
      throw new Error(`Failed to update autoApprove: ${response.status} ${response.statusText}`);
    }
    this.clearCache();
  }

  /**
   * Get notification preferences
   */
  async getNotificationPreferences(): Promise<ServerConfig['notificationPreferences']> {
    const config = await this.loadConfig();
    return config.notificationPreferences;
  }

  /**
   * Update notification preferences
   */
  async updateNotificationPreferences(preferences: NotificationPreferences): Promise<void> {
    await this.updateConfig({ notificationPreferences: preferences });
  }
}

// Export singleton instance for easy access
// The shared instance uses the app's auth: without it /api/config answered 401 and callers
// silently got defaults (no quick start commands) unless a settings screen had set it first.
export const serverConfigService = new ServerConfigService(authClient);
