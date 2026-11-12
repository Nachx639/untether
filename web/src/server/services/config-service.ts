import type { FSWatcher } from 'chokidar';
import { watch } from 'chokidar';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { LOOK_IDS } from '../../shared/looks.js';
import { PROVIDER_ICON_MAX, parseProviderIcon } from '../../shared/model-providers.js';
import {
  MAX_TASK_TEMPLATES,
  TASK_NAME_MAX,
  TASK_PROMPT_MAX,
  type TaskTemplate,
} from '../../shared/tasks.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type UntetherConfig,
} from '../../types/config.js';
import { createLogger } from '../utils/logger.js';
import {
  MAC_SHARE_START_TIMEOUT_MAX_SEC,
  MAC_SHARE_START_TIMEOUT_MIN_SEC,
} from './mac-sessions/share-settings.js';
import { isValidSigningIdentity } from './stable-tmux.js';

const logger = createLogger('config-service');

export const TaskTemplateSchema = z.object({
  id: z.string().regex(/^[\w-]{1,64}$/, 'Invalid template id'),
  name: z.string().trim().min(1, 'Template name cannot be empty').max(TASK_NAME_MAX),
  prompt: z.string().trim().min(1, 'Template prompt cannot be empty').max(TASK_PROMPT_MAX),
});

export const TaskTemplatesSchema = z
  .array(TaskTemplateSchema)
  .max(MAX_TASK_TEMPLATES, `At most ${MAX_TASK_TEMPLATES} templates`)
  .refine((list) => new Set(list.map((tpl) => tpl.id)).size === list.length, {
    message: 'Template ids must be unique',
  });

/** What a tap on a tmux session in "On this Mac" opens. */
export const MacOpenModeSchema = z.enum(['control', 'watch']);

/** What "Share with phone" types to reopen an agent. */
export const MacShareLauncherSchema = z.enum(['ut', 'shell']);

// Zod schema for config validation
/**
 * The top-level keys the Mac app writes (UntetherConfig in
 * mac/Untether/Core/Services/ConfigManager.swift). It used to rewrite config.json from that
 * structure and drop every other key, so a setting only this server knows (shieldNewSessions,
 * taskTemplates, autoCleanupExitedAfterDays) was lost whenever the Mac app saved its settings
 * (upstream audit, 2026-10-03). Since 2026-11-10 the Mac app merges its change into the file; this
 * stays as the guard against any writer that drops keys: the Mac app's keys are its to change or
 * clear; the others are put back from config.backup.json, the copy of what this server last wrote.
 */
const MAC_APP_KEYS = new Set([
  'version',
  'quickStartCommands',
  'repositoryBasePath',
  'preferences',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * `ours` laid over `disk`: every key in `known` is ours (set, or removed when we have none);
 * any other key of `disk` stays exactly as it is, never validated. Keys keep the file's order.
 */
function mergeOver(
  disk: unknown,
  ours: Record<string, unknown>,
  known: readonly string[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = isPlainObject(disk) ? { ...disk } : {};
  for (const key of known) {
    if (ours[key] === undefined) delete merged[key];
    else merged[key] = ours[key];
  }
  return merged;
}

/** An agent's model per level (config taskModels). */
const TaskModelLevelsSchema = z.object({
  fast: z
    .string()
    .regex(/^[A-Za-z0-9][\w.:/[\]-]{0,99}$/)
    .optional(),
  capable: z
    .string()
    .regex(/^[A-Za-z0-9][\w.:/[\]-]{0,99}$/)
    .optional(),
});

/** Per-token USD rates (model-providers, OpenRouter-like). */
const ModelProviderRatesSchema = z.object({
  prompt: z.number().min(0).optional(),
  completion: z.number().min(0).optional(),
  input_cache_read: z.number().min(0).optional(),
});

/** One model a provider offers: an id, or `{ id, label, alias, contextTokens }`. */
const ModelProviderModelSchema = z.union([
  z.string().min(1).max(200),
  z.object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(200).optional(),
    alias: z.enum(['sonnet', 'opus', 'haiku']).optional(),
    contextTokens: z.number().int().min(1).max(100_000_000).optional(),
  }),
]);

/** Decoration: a bad value is dropped alone, it never takes down what it decorates. */
const OptionalIconSchema = z
  .string()
  .trim()
  .max(PROVIDER_ICON_MAX)
  .refine((value) => parseProviderIcon(value) !== undefined)
  .optional()
  .catch(undefined);

/**
 * An external provider compatible with the Anthropic Messages API (types/config.ts
 * ModelProvider). The key is never here: keychainService or keyEnv. baseUrl must be https so a
 * key is never sent in the clear. A bad entry drops the whole modelProviders list (opt-in: off
 * is the safe fallback), kept otherwise.
 */
const ModelProviderSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'provider id must be [a-z0-9-]'),
    label: z.string().min(1).max(100),
    icon: OptionalIconSchema,
    iconFallback: z
      .string()
      .trim()
      .max(PROVIDER_ICON_MAX)
      .refine((value) => {
        const kind = parseProviderIcon(value)?.kind;
        return kind === 'emoji' || kind === 'named';
      })
      .optional()
      .catch(undefined),
    baseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), 'provider baseUrl must be https'),
    keychainService: z.string().min(1).max(256).optional(),
    keyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'keyEnv must be an environment variable name')
      .optional(),
    models: z.array(ModelProviderModelSchema).max(100).optional(),
    defaultModel: z.string().min(1).max(200).optional(),
    pricing: z
      .union([
        z.literal('auto'),
        ModelProviderRatesSchema.extend({
          models: z.record(z.string(), ModelProviderRatesSchema).optional(),
        }),
      ])
      .optional(),
  })
  .refine(
    (provider) => !!provider.keychainService || !!provider.keyEnv,
    'a provider needs keychainService or keyEnv (the key is never stored in config.json)'
  );

const ConfigSchema = z.object({
  version: z.number(),
  quickStartCommands: z.array(
    z.object({
      name: z.string().optional(),
      command: z.string().min(1, 'Command cannot be empty'),
    })
  ),
  repositoryBasePath: z.string().optional(),
  // External Anthropic-compatible providers (model-providers.ts). A broken hand edit drops the
  // whole list and leaves providers off, rather than resetting the entire config.
  modelProviders: z
    .array(ModelProviderSchema)
    .max(50)
    .refine(
      (list) => new Set(list.map((p) => p.id)).size === list.length,
      'modelProviders ids must be unique'
    )
    .optional()
    .catch(undefined),
  avatarIcons: z
    .object({
      claude: OptionalIconSchema,
      codex: OptionalIconSchema,
      shell: OptionalIconSchema,
      preview: OptionalIconSchema,
      previewPaused: OptionalIconSchema,
    })
    .optional()
    .catch(undefined),
  autoCleanupExitedAfterDays: z.number().int().min(0).max(3650).optional(),
  shieldNewSessions: z.boolean().optional(),
  restartUpdatedClaude: z.boolean().optional().catch(undefined),
  // The installed Mac app catches up by itself (installed-app-updater.ts): a bad value is off.
  autoUpdateInstalledApp: z.boolean().optional().catch(undefined),
  appUpdate: z
    .object({
      quietSec: z.number().min(10).max(3600).optional().catch(undefined),
      everyHours: z.number().min(0.25).max(168).optional().catch(undefined),
      settleMin: z.number().min(0).max(240).optional().catch(undefined),
      waitNoticeHours: z.number().min(0.25).max(48).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  suspendIdleClaude: z.boolean().optional().catch(undefined),
  agentExplain: z.boolean().optional().catch(undefined),
  suspendIdleMinutes: z.number().int().min(15).max(10080).optional().catch(undefined),
  autoApprove: z.boolean().optional().catch(undefined),
  look: z
    .string()
    .refine((id) => LOOK_IDS.includes(id), 'not a registered interface style')
    .optional()
    .catch(undefined),
  // Untether's disposable folders (task worktrees, control dir, task logs, voice models) marked
  // excluded from Time Machine (backup-exclusion.ts, 2026-11-02). Unset = on; false turns it off.
  excludeFromBackups: z.boolean().optional().catch(undefined),
  // Minutes a ready/needs_you task waits before it reminds (0 = never; default 30).
  staleTaskRemindMinutes: z.number().int().min(0).max(10080).optional().catch(undefined),
  // A broken hand edit leaves the stable tmux copy off instead of resetting the config.
  tmuxSigningIdentity: z
    .string()
    .refine(isValidSigningIdentity, 'tmuxSigningIdentity is not a signing identity')
    .optional()
    .catch(undefined),
  // Models by level per agent (ProjectSettings.modelRouting, `ut task new --model fast`):
  // this installation's, never hard-wired. Unset: Claude's fast is sonnet, the rest the
  // agent's own default. A bad hand edit drops it.
  taskModels: z
    .object({
      claude: TaskModelLevelsSchema.optional().catch(undefined),
      codex: TaskModelLevelsSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  // Who a task goes on with when its agent hits its usage limit, in order (agentFallback):
  // another agent, account (its own command line, e.g. CLAUDE_CONFIG_DIR) or model. Unset:
  // the other agent with the user's quick start.
  taskFallbacks: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/),
        agent: z.enum(['claude', 'codex']),
        command: z.string().min(1).max(4096).optional(),
        model: z
          .string()
          .regex(/^[A-Za-z0-9][\w.:/[\]-]{0,99}$/)
          .optional(),
      })
    )
    .max(20)
    .optional()
    .catch(undefined),
  checkLoad: z
    .object({
      maxLoadPerCore: z.number().min(0).max(100).optional().catch(undefined),
      maxWaitSec: z.number().int().min(0).max(86_400).optional().catch(undefined),
      maxConcurrent: z.number().int().min(0).max(64).optional().catch(undefined),
      maxSlotWaitSec: z.number().int().min(0).max(86_400).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  taskAdmission: z
    .object({
      enabled: z.boolean().optional().catch(undefined),
      minFreeMemoryPercent: z.number().min(0).max(100).optional().catch(undefined),
      maxSwapPercentOfRam: z.number().min(0).max(1000).optional().catch(undefined),
      maxSwapGrowthMb: z.number().min(0).max(1_000_000).optional().catch(undefined),
      swapGrowthWindowMin: z.number().min(1).max(120).optional().catch(undefined),
      maxSwapPercentOfTotal: z.number().min(0).max(100).optional().catch(undefined),
      minSwapTotalPercentOfRam: z.number().min(0).max(1000).optional().catch(undefined),
      swapWarmupMin: z.number().min(0).max(120).optional().catch(undefined),
      trendUnknownMaxWaitMin: z.number().min(0).max(1440).optional().catch(undefined),
      maxLoadPerCore: z.number().min(0).max(100).optional().catch(undefined),
      cpuOnlyMaxWaitMin: z.number().min(0).max(1440).optional().catch(undefined),
      steadySwapMaxWaitMin: z.number().min(0).max(1440).optional().catch(undefined),
      settleSec: z.number().int().min(0).max(3600).optional().catch(undefined),
      roomyFreeMemoryPercent: z.number().min(0).max(100).optional().catch(undefined),
      maxSwapPagesPerSec: z.number().min(0).max(10_000_000).optional().catch(undefined),
      pagingWindowSec: z.number().min(10).max(3600).optional().catch(undefined),
      targetLoadPerCore: z.number().min(0).max(100).optional().catch(undefined),
      maxGrantLoadPerCore: z.number().min(0).max(1000).optional().catch(undefined),
      rampWindowSec: z.number().min(0).max(3600).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  // Session recordings on disk (session-recordings.ts): a bad value falls back to the default.
  recordings: z
    .object({
      rotateMB: z.number().min(1).max(100_000).optional().catch(undefined),
      finishedDays: z.number().min(0).max(3650).optional().catch(undefined),
      controlWarnGB: z.number().min(0).max(100_000).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  // No check starts while the repo's or worktree's volume has less free (task-verify.ts).
  checkDisk: z
    .object({
      minFreeGB: z.number().min(0).max(10_000).optional().catch(undefined),
      minFreePercent: z.number().min(0).max(100).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  newProjectParent: z
    .string()
    .refine((value) => path.isAbsolute(value), 'newProjectParent must be absolute')
    .optional()
    .catch(undefined),
  // A hand edit that is not a boolean just leaves it off instead of resetting the config.
  scrollPerf: z.boolean().optional().catch(undefined),
  chatKeyboardFix: z.boolean().optional().catch(undefined),
  chatKeyboardFix2: z.boolean().optional().catch(undefined),
  chatKeyboardFix3: z.boolean().optional().catch(undefined),
  // A broken hand edit drops the templates instead of resetting the whole config.
  taskTemplates: TaskTemplatesSchema.optional().catch(undefined),
  // Mac sessions: likewise, a bad value is dropped and the rest of the file kept.
  macSessions: z.boolean().optional().catch(undefined),
  macSessionsOpenMode: MacOpenModeSchema.optional().catch(undefined),
  macSessionsIncludeHeadless: z.boolean().optional().catch(undefined),
  macSessionsHideIn: z.array(z.string()).optional().catch(undefined),
  // Share with phone: likewise.
  macShare: z.boolean().optional().catch(undefined),
  macShareLauncher: MacShareLauncherSchema.optional().catch(undefined),
  macShareUtPath: z
    .string()
    .refine((value) => path.isAbsolute(value), 'macShareUtPath must be absolute')
    .optional()
    .catch(undefined),
  macShareAutoTrust: z.boolean().optional().catch(undefined),
  macShareStartTimeoutSec: z
    .number()
    .int()
    .min(MAC_SHARE_START_TIMEOUT_MIN_SEC)
    .max(MAC_SHARE_START_TIMEOUT_MAX_SEC)
    .optional()
    .catch(undefined),
  // Written by the Mac app's notification settings and by updateNotificationPreferences.
  preferences: z
    .object({
      notifications: z
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
        .optional(),
    })
    .optional(),
});

/** The keys this server owns at each level of config.json; every other key is someone else's. */
const KNOWN_KEYS = Object.keys(ConfigSchema.shape);
const KNOWN_PREFERENCES_KEYS = Object.keys(ConfigSchema.shape.preferences.unwrap().shape);
const KNOWN_NOTIFICATION_KEYS = Object.keys(
  ConfigSchema.shape.preferences.unwrap().shape.notifications.unwrap().shape
);

/**
 * The settings of a config.json, key by key: a top-level key whose value does not pass takes
 * its default (or is left out when it has none) and is named in `invalid`; the others are kept.
 */
function validPartOf(data: Record<string, unknown>): { config: UntetherConfig; invalid: string[] } {
  const candidate: Record<string, unknown> = { ...data };
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  const invalid: string[] = [];
  for (;;) {
    const result = ConfigSchema.safeParse(candidate);
    if (result.success) return { config: result.data as UntetherConfig, invalid };
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')))];
    // Nothing left to set aside (an issue with no key, or one a default did not fix).
    if (keys.some((key) => key === '' || invalid.includes(key))) {
      return { config: DEFAULT_CONFIG, invalid: ['the whole file'] };
    }
    for (const key of keys) {
      invalid.push(key);
      if (key in defaults) candidate[key] = defaults[key];
      else delete candidate[key];
    }
  }
}

/**
 * Service for managing Untether configuration with file persistence and live reloading.
 *
 * The ConfigService handles loading, saving, and watching the Untether configuration file
 * stored in the user's home directory at `~/.untether/config.json`. It provides validation
 * using Zod schemas, automatic file watching for live reloading, and event-based notifications
 * when configuration changes occur.
 *
 * Key features:
 * - Persistent storage in user's home directory
 * - Automatic validation with Zod schemas
 * - Live reloading with file watching
 * - Event-based change notifications
 * - Graceful fallback to defaults on errors
 * - Atomic updates with validation
 *
 * @example
 * ```typescript
 * // Create and start the config service
 * const configService = new ConfigService();
 * configService.startWatching();
 *
 * // Subscribe to configuration changes
 * const unsubscribe = configService.onConfigChange((newConfig) => {
 *   console.log('Config updated:', newConfig);
 * });
 *
 * // Update quick start commands
 * configService.updateQuickStartCommands([
 *   { name: '🚀 dev', command: 'npm run dev' },
 *   { command: 'bash' }
 * ]);
 *
 * // Get current configuration
 * const config = configService.getConfig();
 *
 * // Clean up when done
 * unsubscribe();
 * configService.stopWatching();
 * ```
 */
export class ConfigService {
  private configDir: string;
  private configPath: string;
  private config: UntetherConfig = DEFAULT_CONFIG;
  private watcher?: FSWatcher;
  private configChangeCallbacks: Set<(config: UntetherConfig) => void> = new Set();
  /** What this server last wrote to config.json (see MAC_APP_KEYS). */
  private readonly backupPath: string;
  /** Why the last save of config.json failed; unset once a save works (doctor config-writable). */
  private saveError?: string;
  /** See loadConfig and getLoadProblem. */
  private loadProblem?: string;

  constructor() {
    this.configDir = path.join(os.homedir(), '.untether');
    this.configPath = path.join(this.configDir, 'config.json');
    this.backupPath = path.join(this.configDir, 'config.backup.json');
    this.loadConfig();
  }

  private ensureConfigDir(): void {
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
        logger.info(`Created config directory: ${this.configDir}`);
      }
    } catch (error) {
      logger.error('Failed to create config directory:', error);
    }
  }

  private validateConfig(data: unknown): UntetherConfig {
    try {
      return ConfigSchema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error('Config validation failed:', error.issues);
        throw new Error(`Invalid config: ${error.issues.map((e) => e.message).join(', ')}`);
      }
      throw error;
    }
  }

  /**
   * Reads config.json. A file that does not pass (2026-11-11: one bad value, or a file that is
   * not JSON, and the whole config.json was replaced by the defaults, config.backup.json with
   * it) is never written from here: the server runs with what is valid in it (the defaults for
   * the keys that are not), the file stays as it is with a copy beside it
   * (config.invalid.json, so no later save can lose it), and the doctor and the log say so.
   */
  private loadConfig(): void {
    try {
      this.ensureConfigDir();

      if (!fs.existsSync(this.configPath)) {
        this.loadProblem = undefined;
        logger.info('No config file found, creating with defaults');
        this.saveConfig(); // Create config with defaults
        return;
      }
      let parsedData: unknown;
      try {
        parsedData = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch (error) {
        // The settings in memory stay: the defaults at start, the last good ones on a reload.
        this.keptAside(`cannot be read (${error instanceof Error ? error.message : error})`);
        return;
      }
      if (!isPlainObject(parsedData)) {
        this.keptAside('is not a JSON object');
        return;
      }
      const restored = this.restoreDroppedKeys(parsedData);
      const { config, invalid } = validPartOf(parsedData);
      this.config = config;
      if (invalid.length > 0) {
        this.keptAside(
          `has values that are not valid (${invalid.join(', ')}): the defaults are used for them`
        );
        return;
      }
      this.loadProblem = undefined;
      logger.info('Loaded and validated configuration from disk');
      if (restored.length > 0) {
        logger.warn(
          `put back ${restored.join(', ')}: config.json was rewritten without them (the Mac app keeps only its own keys)`
        );
        this.saveConfig();
      } else if (!fs.existsSync(this.backupPath)) {
        this.writeBackup();
      }
    } catch (error) {
      logger.error('Failed to load config:', error);
      // Keep using defaults
    }
  }

  /** A config.json that did not pass: said, and copied beside itself; never rewritten here. */
  private keptAside(what: string): void {
    const copy = path.join(this.configDir, 'config.invalid.json');
    let kept = `a copy is in ${copy}`;
    try {
      fs.copyFileSync(this.configPath, copy);
    } catch (error) {
      kept = `it could not be copied to ${copy} (${error instanceof Error ? error.message : error})`;
    }
    this.loadProblem = `${this.configPath} ${what}. The file was left as it is; ${kept}.`;
    logger.error(`config: ${this.loadProblem}`);
  }

  /** What is wrong with config.json as last read (doctor config-valid); undefined when nothing. */
  public getLoadProblem(): string | undefined {
    return this.loadProblem;
  }

  /** Keys only this server writes, dropped from `data` by another writer, put back (see MAC_APP_KEYS). */
  private restoreDroppedKeys(data: Record<string, unknown>): string[] {
    if (!data || typeof data !== 'object' || !fs.existsSync(this.backupPath)) return [];
    let backup: Record<string, unknown>;
    try {
      backup = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));
    } catch {
      return [];
    }
    const restored: string[] = [];
    for (const [key, value] of Object.entries(backup ?? {})) {
      if (MAC_APP_KEYS.has(key) || key in data || value === undefined) continue;
      data[key] = value;
      restored.push(key);
    }
    return restored;
  }

  private writeBackup(): void {
    try {
      fs.writeFileSync(this.backupPath, JSON.stringify(this.config, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      logger.warn('Failed to write the config backup:', error);
    }
  }

  /**
   * What goes to config.json: the file as it is now with this server's settings laid over it.
   * A key this server does not know (another writer's, an older or newer build's) is never
   * removed or rewritten, at the top level, inside `preferences` or inside its notifications
   * (2026-11-11: writing only the schema's keys dropped the ones the Mac app installed then
   * needed, and that app reset the whole file). What the Mac app of this same code needs of
   * the file is held by app-server-config-contract.test.ts and the Mac's ConfigContractTests.
   */
  private fileContent(): string {
    let disk: unknown;
    try {
      disk = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      // No file yet, or one nobody can read: there is nothing to keep.
    }
    const ours = this.config as unknown as Record<string, unknown>;
    // `preferences` is shared with the Mac app: laid over below, never removed from here.
    const merged = mergeOver(
      disk,
      ours,
      KNOWN_KEYS.filter((key) => key !== 'preferences')
    );
    if (isPlainObject(ours.preferences)) {
      const diskPreferences = isPlainObject(disk) ? disk.preferences : undefined;
      const preferences = mergeOver(diskPreferences, ours.preferences, KNOWN_PREFERENCES_KEYS);
      if (isPlainObject(ours.preferences.notifications)) {
        preferences.notifications = mergeOver(
          isPlainObject(diskPreferences) ? diskPreferences.notifications : undefined,
          ours.preferences.notifications,
          KNOWN_NOTIFICATION_KEYS
        );
      }
      merged.preferences = preferences;
    }
    return JSON.stringify(merged, null, 2);
  }

  private saveConfig(): void {
    try {
      this.ensureConfigDir();
      fs.writeFileSync(this.configPath, this.fileContent(), {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.saveError = undefined;
      this.writeBackup();
      logger.info('Saved configuration to disk');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.saveError = reason;
      logger.error('Failed to save config:', error);
      throw new Error(`Failed to save configuration: ${reason}`);
    }
  }

  /** Why config.json cannot be saved (the last save failed, or the file is not writable). */
  public getSaveProblem(): string | undefined {
    if (this.saveError) return this.saveError;
    try {
      if (fs.existsSync(this.configPath)) fs.accessSync(this.configPath, fs.constants.W_OK);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return undefined;
  }

  public startWatching(): void {
    if (this.watcher) {
      return; // Already watching
    }

    try {
      this.watcher = watch(this.configPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      });

      this.watcher.on('change', () => {
        logger.info('Configuration file changed, reloading...');
        const oldConfig = JSON.stringify(this.config);
        this.loadConfig();

        // Only notify if config actually changed
        if (JSON.stringify(this.config) !== oldConfig) {
          this.notifyConfigChange();
        }
      });

      this.watcher.on('error', (error) => {
        logger.error('Config watcher error:', error);
      });

      logger.info('Started watching configuration file');
    } catch (error) {
      logger.error('Failed to start config watcher:', error);
    }
  }

  public stopWatching(): void {
    if (this.watcher) {
      this.watcher.close().catch((error) => {
        logger.error('Error closing config watcher:', error);
      });
      this.watcher = undefined;
      logger.info('Stopped watching configuration file');
    }
  }

  private notifyConfigChange(): void {
    for (const callback of this.configChangeCallbacks) {
      try {
        callback(this.config);
      } catch (error) {
        logger.error('Error in config change callback:', error);
      }
    }
  }

  public onConfigChange(callback: (config: UntetherConfig) => void): () => void {
    this.configChangeCallbacks.add(callback);
    // Return unsubscribe function
    return () => {
      this.configChangeCallbacks.delete(callback);
    };
  }

  public getConfig(): UntetherConfig {
    return this.config;
  }

  public updateConfig(config: UntetherConfig): void {
    // Validate the config before updating
    this.config = this.validateConfig(config);
    this.saveConfig();
    this.notifyConfigChange();
  }

  public updateQuickStartCommands(commands: UntetherConfig['quickStartCommands']): void {
    // Validate the entire config with updated commands
    const updatedConfig = { ...this.config, quickStartCommands: commands };
    this.config = this.validateConfig(updatedConfig);
    this.saveConfig();
    this.notifyConfigChange();
  }

  public updateRepositoryBasePath(path: string): void {
    // Validate the entire config with updated repository base path
    const updatedConfig = { ...this.config, repositoryBasePath: path };
    this.config = this.validateConfig(updatedConfig);
    this.saveConfig();
    this.notifyConfigChange();
  }

  public getTaskTemplates(): TaskTemplate[] {
    return this.config.taskTemplates ?? [];
  }

  /** Replace the user's task templates (validated; throws on an invalid list). */
  public updateTaskTemplates(templates: TaskTemplate[]): void {
    const parsed = TaskTemplatesSchema.safeParse(templates);
    if (!parsed.success) {
      throw new Error(
        `Invalid task templates: ${parsed.error.issues.map((e) => e.message).join(', ')}`
      );
    }
    this.config = this.validateConfig({ ...this.config, taskTemplates: parsed.data });
    this.saveConfig();
    this.notifyConfigChange();
  }

  public getConfigPath(): string {
    return this.configPath;
  }

  public getNotificationPreferences(): NotificationPreferences {
    return this.config.preferences?.notifications || DEFAULT_NOTIFICATION_PREFERENCES;
  }

  public updateNotificationPreferences(notifications: Partial<NotificationPreferences>): void {
    // Validate the notifications object
    try {
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

      const validatedNotifications = NotificationPreferencesSchema.parse(notifications);

      // Merge with existing notifications or defaults
      const currentNotifications =
        this.config.preferences?.notifications || DEFAULT_NOTIFICATION_PREFERENCES;
      const mergedNotifications = { ...currentNotifications, ...validatedNotifications };

      this.config.preferences = { ...this.config.preferences, notifications: mergedNotifications };
      this.saveConfig();
      this.notifyConfigChange();
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error('Invalid notification preferences:', error.issues);
        throw new Error(
          `Invalid notification preferences: ${error.issues.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  }
}
