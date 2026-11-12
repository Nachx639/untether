import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ICON_MAX } from '../../shared/model-providers.js';
import { DEFAULT_CONFIG, type QuickStartCommand, type UntetherConfig } from '../../types/config.js';
import { ConfigService } from './config-service.js';

// Mock modules
vi.mock('fs');
vi.mock('os');
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
  })),
}));

// Mock logger to avoid path issues
vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('ConfigService', () => {
  let configService: ConfigService;
  const mockHomeDir = '/home/testuser';
  const mockConfigDir = path.join(mockHomeDir, '.untether');
  const mockConfigPath = path.join(mockConfigDir, 'config.json');

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock os.homedir
    vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

    // Mock fs methods
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(DEFAULT_CONFIG));
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

    configService = new ConfigService();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and initialization', () => {
    it('should create config directory if it does not exist', () => {
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(mockConfigDir);
      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(mockConfigDir, { recursive: true });
    });

    it('should load existing config file', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockConfigDir) return true;
        if (p === mockConfigPath) return true;
        return false;
      });

      const customConfig: UntetherConfig = {
        version: 1,
        quickStartCommands: [{ command: 'custom' }],
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(customConfig));

      const service = new ConfigService();
      expect(service.getConfig()).toEqual(customConfig);
    });

    it('puts back the settings the Mac app drops when it rewrites config.json', () => {
      // The Mac app writes only its own keys: shielding and task templates set from the phone
      // vanished whenever its settings were saved (upstream audit, 2026-10-03).
      const mockBackupPath = path.join(mockConfigDir, 'config.backup.json');
      const fromMacApp = { version: 1, quickStartCommands: [{ command: 'zsh' }] };
      const backup = {
        ...fromMacApp,
        repositoryBasePath: '~/old',
        shieldNewSessions: false,
        taskTemplates: [{ id: 'tests', name: 'Tests', prompt: 'run the tests' }],
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) =>
        JSON.stringify(p === mockBackupPath ? backup : fromMacApp)
      );

      const config = new ConfigService().getConfig();
      expect(config.shieldNewSessions).toBe(false);
      expect(config.taskTemplates).toEqual(backup.taskTemplates);
      // The Mac app's own keys are its to clear.
      expect(config.repositoryBasePath).toBeUndefined();
      const written = vi
        .mocked(fs.writeFileSync)
        .mock.calls.filter(([p]) => p === mockConfigPath)
        .pop()?.[1] as string;
      expect(JSON.parse(written)).toMatchObject({ shieldNewSessions: false });
    });

    // A provider's icon is decoration: a bad one must not switch the provider off.
    it.each([
      ['a sentence', 'two words'],
      ['too long', 'x'.repeat(PROVIDER_ICON_MAX + 1)],
      ['not a string', 7],
    ])('drops only the icon of a provider when it is %s', (_case, icon) => {
      const provider = {
        id: 'acme',
        label: 'Acme',
        baseUrl: 'https://api.acme.test',
        keyEnv: 'ACME_KEY',
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 1,
          quickStartCommands: [{ command: 'zsh' }],
          modelProviders: [{ ...provider, icon }],
        })
      );
      expect(new ConfigService().getConfig().modelProviders).toEqual([provider]);
    });

    it('keeps valid avatar icons and drops only the bad ones', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 1,
          quickStartCommands: [{ command: 'zsh' }],
          avatarIcons: {
            claude: 'one.png',
            codex: ' 🦊 ',
            shell: 'terminal',
            preview: '../../secret.png',
            previewPaused: '/etc/passwd.png',
            gemini: 'unknown-key.png',
          },
        })
      );
      expect(new ConfigService().getConfig().avatarIcons).toEqual({
        claude: 'one.png',
        codex: '🦊',
        shell: 'terminal',
      });
    });

    it('survives an avatarIcons that is not an object', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 1,
          quickStartCommands: [{ command: 'zsh' }],
          shieldNewSessions: false,
          avatarIcons: 'one.png',
        })
      );
      const config = new ConfigService().getConfig();
      expect(config.avatarIcons).toBeUndefined();
      expect(config.shieldNewSessions).toBe(false);
    });

    it('keeps a valid provider icon', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 1,
          quickStartCommands: [{ command: 'zsh' }],
          modelProviders: [
            {
              id: 'acme',
              label: 'Acme',
              baseUrl: 'https://api.acme.test',
              keyEnv: 'ACME_KEY',
              icon: ' 🦊 ',
            },
          ],
        })
      );
      expect(new ConfigService().getConfig().modelProviders?.[0].icon).toBe('🦊');
    });

    it('keeps the Mac sessions settings when the Mac app rewrites config.json', () => {
      const mockBackupPath = path.join(mockConfigDir, 'config.backup.json');
      const fromMacApp = { version: 1, quickStartCommands: [{ command: 'zsh' }] };
      const backup = {
        ...fromMacApp,
        macSessions: false,
        macSessionsOpenMode: 'watch',
        macSessionsIncludeHeadless: true,
        macSessionsHideIn: ['/private/tmp/ut-qa-mac'],
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) =>
        JSON.stringify(p === mockBackupPath ? backup : fromMacApp)
      );

      expect(new ConfigService().getConfig()).toMatchObject({
        macSessions: false,
        macSessionsOpenMode: 'watch',
        macSessionsIncludeHeadless: true,
        macSessionsHideIn: ['/private/tmp/ut-qa-mac'],
      });
    });

    it('drops a bad Mac sessions value without resetting the rest of config.json', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 2,
          quickStartCommands: [{ command: 'custom' }],
          macSessions: false,
          macSessionsOpenMode: 'type',
          macSessionsIncludeHeadless: 'yes',
          macSessionsHideIn: '/private/tmp/ut-qa-mac',
        })
      );
      vi.mocked(fs.writeFileSync).mockClear(); // the beforeEach's service wrote the defaults

      const config = new ConfigService().getConfig();
      expect(config.quickStartCommands).toEqual([{ command: 'custom' }]);
      expect(config.macSessions).toBe(false);
      expect(config.macSessionsOpenMode).toBeUndefined();
      expect(config.macSessionsIncludeHeadless).toBeUndefined();
      expect(config.macSessionsHideIn).toBeUndefined();
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalledWith(
        mockConfigPath,
        JSON.stringify(DEFAULT_CONFIG, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    });

    it('keeps the share-with-phone settings, and drops a bad one alone', () => {
      const mockBackupPath = path.join(mockConfigDir, 'config.backup.json');
      const fromMacApp = { version: 1, quickStartCommands: [{ command: 'zsh' }] };
      const backup = {
        ...fromMacApp,
        macShare: true,
        macShareLauncher: 'shell',
        macShareUtPath: '/opt/ut/bin/ut',
        macShareAutoTrust: false,
        macShareStartTimeoutSec: 60,
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p) =>
        JSON.stringify(p === mockBackupPath ? backup : fromMacApp)
      );
      // The Mac app rewrote config.json without them: they come back from the backup.
      expect(new ConfigService().getConfig()).toMatchObject({
        macShare: true,
        macShareLauncher: 'shell',
        macShareUtPath: '/opt/ut/bin/ut',
        macShareAutoTrust: false,
        macShareStartTimeoutSec: 60,
      });

      vi.mocked(fs.readFileSync).mockImplementation(() =>
        JSON.stringify({
          version: 2,
          quickStartCommands: [{ command: 'custom' }],
          macShare: true,
          macShareLauncher: 'zsh',
          macShareUtPath: 'bin/ut',
          macShareStartTimeoutSec: 0,
        })
      );
      const config = new ConfigService().getConfig();
      expect(config.quickStartCommands).toEqual([{ command: 'custom' }]);
      expect(config.macShare).toBe(true);
      expect(config.macShareLauncher).toBeUndefined();
      expect(config.macShareUtPath).toBeUndefined();
      expect(config.macShareStartTimeoutSec).toBeUndefined();
    });

    it('keeps a registered interface style and drops anything else (config look)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      for (const [look, expected] of [
        ['cyber-hacker', 'cyber-hacker'],
        ['no-such-style', undefined],
        [42, undefined],
      ] as const) {
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...DEFAULT_CONFIG, look }));
        configService = new ConfigService();
        expect(configService.getConfig().look).toBe(expected);
      }
    });

    it('keeps the scrollPerf QA flag from config.json, off unless true', () => {
      expect(DEFAULT_CONFIG.scrollPerf).toBeUndefined();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ version: 2, quickStartCommands: [], scrollPerf: true })
      );
      expect(new ConfigService().getConfig().scrollPerf).toBe(true);
      // A hand edit that is not a boolean leaves it off, the rest of the config intact.
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ version: 2, quickStartCommands: [{ command: 'zsh' }], scrollPerf: 'yes' })
      );
      const config = new ConfigService().getConfig();
      expect(config.scrollPerf).toBeUndefined();
      expect(config.quickStartCommands).toEqual([{ command: 'zsh' }]);
    });

    it('keeps the chatKeyboardFix experiment from config.json, off unless true', () => {
      expect(DEFAULT_CONFIG.chatKeyboardFix).toBeUndefined();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ version: 2, quickStartCommands: [], chatKeyboardFix: true })
      );
      expect(new ConfigService().getConfig().chatKeyboardFix).toBe(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ version: 2, quickStartCommands: [{ command: 'zsh' }], chatKeyboardFix: 1 })
      );
      const config = new ConfigService().getConfig();
      expect(config.chatKeyboardFix).toBeUndefined();
      expect(config.quickStartCommands).toEqual([{ command: 'zsh' }]);
    });

    it('keeps the chatKeyboardFix2 experiment from config.json, off unless true', () => {
      expect(DEFAULT_CONFIG.chatKeyboardFix2).toBeUndefined();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ version: 2, quickStartCommands: [], chatKeyboardFix2: true })
      );
      expect(new ConfigService().getConfig().chatKeyboardFix2).toBe(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 2,
          quickStartCommands: [{ command: 'zsh' }],
          chatKeyboardFix2: 'y',
        })
      );
      const config = new ConfigService().getConfig();
      expect(config.chatKeyboardFix2).toBeUndefined();
      expect(config.quickStartCommands).toEqual([{ command: 'zsh' }]);
    });

    it('keeps the chatKeyboardFix3 experiment from config.json, off unless true', () => {
      expect(DEFAULT_CONFIG.chatKeyboardFix3).toBeUndefined();
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ version: 2, quickStartCommands: [], chatKeyboardFix3: true })
      );
      expect(new ConfigService().getConfig().chatKeyboardFix3).toBe(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 2,
          quickStartCommands: [{ command: 'zsh' }],
          chatKeyboardFix3: 'y',
        })
      );
      const config = new ConfigService().getConfig();
      expect(config.chatKeyboardFix3).toBeUndefined();
      expect(config.quickStartCommands).toEqual([{ command: 'zsh' }]);
    });

    it("keeps the checks' load threshold, and drops a bad field alone (2026-10-24)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 2,
          quickStartCommands: [{ command: 'zsh' }],
          checkLoad: { maxLoadPerCore: 1.5, maxWaitSec: 'long' },
        })
      );
      const config = new ConfigService().getConfig();
      expect(config.checkLoad).toEqual({ maxLoadPerCore: 1.5 });
      expect(config.quickStartCommands).toEqual([{ command: 'zsh' }]);
    });

    it('leaves finished-session cleanup off by default and keeps a chosen age', () => {
      expect(DEFAULT_CONFIG.autoCleanupExitedAfterDays ?? 0).toBe(0);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ version: 2, quickStartCommands: [], autoCleanupExitedAfterDays: 3 })
      );
      expect(new ConfigService().getConfig().autoCleanupExitedAfterDays).toBe(3);
    });

    // 2026-11-11: the sections server, development, remoteAccess and sessionDefaults and the
    // switches showInDock / preventSleepWhenRunning had no reader on either side: gone from
    // the schema. A config.json that still has them loads; the server's settings do not carry
    // them, and the file keeps them (same day: dropping them from the file made the Mac app
    // installed then, which needed them, reset all of config.json; config-service-disk.test.ts).
    it('loads a config.json with the removed sections, which stay in the file', () => {
      const onDisk = {
        version: 2,
        quickStartCommands: [{ command: 'zsh' }],
        server: { port: 4999, dashboardAccessMode: 'network' },
        development: { logLevel: 'debug' },
        remoteAccess: { ngrokEnabled: true },
        sessionDefaults: { command: 'zsh' },
        preferences: { showInDock: true, preventSleepWhenRunning: false },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(onDisk));

      const service = new ConfigService();
      expect(service.getConfig()).toEqual({
        version: 2,
        quickStartCommands: [{ command: 'zsh' }],
        preferences: {},
      });

      service.updateNotificationPreferences({ enabled: true });
      const written = JSON.parse(
        vi
          .mocked(fs.writeFileSync)
          .mock.calls.filter(([file]) => file === mockConfigPath)
          .at(-1)?.[1] as string
      );
      expect(written).toMatchObject(onDisk);
      expect(written.preferences.notifications.enabled).toBe(true);
    });

    it('should create default config if file does not exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockConfigDir) return true;
        if (p === mockConfigPath) return false;
        return false;
      });

      new ConfigService();
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        mockConfigPath,
        JSON.stringify(DEFAULT_CONFIG, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    });

    // 2026-11-11: an invalid config.json used to be replaced by the defaults on the spot.
    it('uses what is valid of an invalid config.json and never rewrites it', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockConfigDir) return true;
        if (p === mockConfigPath) return true;
        return false;
      });

      // Invalid config - missing version
      const invalidConfig = {
        quickStartCommands: [{ command: 'test' }],
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));
      vi.mocked(fs.writeFileSync).mockClear();

      const service = new ConfigService();

      // Its commands are kept; only the missing version takes the default.
      expect(service.getConfig()).toEqual({
        version: DEFAULT_CONFIG.version,
        quickStartCommands: [{ command: 'test' }],
      });
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
      expect(service.getLoadProblem()).toContain('version');
    });

    it('takes the default for a key that does not pass (empty commands), without a write', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockConfigDir) return true;
        if (p === mockConfigPath) return true;
        return false;
      });

      // Invalid config - empty command
      const invalidConfig: UntetherConfig = {
        version: 1,
        quickStartCommands: [{ command: '' }],
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(invalidConfig));
      vi.mocked(fs.writeFileSync).mockClear();

      const service = new ConfigService();

      expect(service.getConfig()).toEqual({
        version: 1,
        quickStartCommands: DEFAULT_CONFIG.quickStartCommands,
      });
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
      expect(service.getLoadProblem()).toContain('quickStartCommands');
    });
  });

  describe('updateQuickStartCommands', () => {
    it('should update quick start commands and save', () => {
      const newCommands: QuickStartCommand[] = [
        { command: 'python3' },
        { name: '🚀 node', command: 'node' },
      ];

      configService.updateQuickStartCommands(newCommands);

      expect(configService.getConfig().quickStartCommands).toEqual(newCommands);
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        mockConfigPath,
        JSON.stringify({ ...DEFAULT_CONFIG, quickStartCommands: newCommands }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    });

    it('should notify config change callbacks', () => {
      const callback = vi.fn();
      configService.onConfigChange(callback);

      const newCommands: QuickStartCommand[] = [{ command: 'test' }];
      configService.updateQuickStartCommands(newCommands);

      expect(callback).toHaveBeenCalledWith({
        ...DEFAULT_CONFIG,
        quickStartCommands: newCommands,
      });
    });

    it('should handle empty commands array', () => {
      configService.updateQuickStartCommands([]);

      expect(configService.getConfig().quickStartCommands).toEqual([]);
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalled();
    });

    it('should preserve other config properties', () => {
      const initialConfig = configService.getConfig();
      const newCommands: QuickStartCommand[] = [{ command: 'new' }];

      configService.updateQuickStartCommands(newCommands);

      const updatedConfig = configService.getConfig();
      expect(updatedConfig.version).toEqual(initialConfig.version);
      expect(updatedConfig.quickStartCommands).toEqual(newCommands);
    });

    it('should reject commands with empty strings', () => {
      const invalidCommands: QuickStartCommand[] = [
        { command: 'valid' },
        { command: '' }, // Invalid empty command
      ];

      expect(() => {
        configService.updateQuickStartCommands(invalidCommands);
      }).toThrow('Invalid config');

      // Config should remain unchanged
      expect(configService.getConfig()).toEqual(DEFAULT_CONFIG);
    });

    it('should accept commands with optional names', () => {
      const commandsWithNames: QuickStartCommand[] = [
        { name: '✨ Special', command: 'special-cmd' },
        { command: 'no-name-cmd' }, // No name is valid
        { name: '', command: 'empty-name-cmd' }, // Empty name is valid
      ];

      configService.updateQuickStartCommands(commandsWithNames);
      expect(configService.getConfig().quickStartCommands).toEqual(commandsWithNames);
    });
  });

  describe('config change notifications', () => {
    it('should register and notify multiple callbacks', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      configService.onConfigChange(callback1);
      configService.onConfigChange(callback2);

      configService.updateQuickStartCommands([{ command: 'test' }]);

      expect(callback1).toHaveBeenCalledOnce();
      expect(callback2).toHaveBeenCalledOnce();
    });

    it('should allow unsubscribing from changes', () => {
      const callback = vi.fn();
      const unsubscribe = configService.onConfigChange(callback);

      unsubscribe();
      configService.updateQuickStartCommands([{ command: 'test' }]);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle callback errors gracefully', () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      const normalCallback = vi.fn();

      configService.onConfigChange(errorCallback);
      configService.onConfigChange(normalCallback);

      // Should not throw
      expect(() => {
        configService.updateQuickStartCommands([{ command: 'test' }]);
      }).not.toThrow();

      expect(errorCallback).toHaveBeenCalled();
      expect(normalCallback).toHaveBeenCalled();
    });
  });

  describe('file system error handling', () => {
    it('should handle directory creation errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw during construction
      expect(() => new ConfigService()).not.toThrow();
    });

    it('should handle config save errors', () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Disk full');
      });

      // Should throw with proper error message
      expect(() => {
        configService.updateQuickStartCommands([{ command: 'test' }]);
      }).toThrow('Failed to save configuration: Disk full');

      // Config should still be updated in memory
      expect(configService.getConfig().quickStartCommands).toEqual([{ command: 'test' }]);
    });

    it('should handle corrupted config file', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockConfigDir) return true;
        if (p === mockConfigPath) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json');

      const service = new ConfigService();

      // The defaults in memory; the file is not written (2026-11-11).
      expect(service.getConfig()).toEqual(DEFAULT_CONFIG);
      expect(service.getLoadProblem()).toContain('cannot be read');
    });
  });

  describe('getConfigPath', () => {
    it('should return the correct config path', () => {
      expect(configService.getConfigPath()).toBe(mockConfigPath);
    });
  });

  describe('updateConfig', () => {
    it('should update entire config and validate', () => {
      const newConfig: UntetherConfig = {
        version: 2,
        quickStartCommands: [{ command: 'python3' }, { name: 'Node.js', command: 'node' }],
      };

      configService.updateConfig(newConfig);

      expect(configService.getConfig()).toEqual(newConfig);
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        mockConfigPath,
        JSON.stringify(newConfig, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    });

    it('should reject invalid config structure', () => {
      const invalidConfig = {
        version: 'not-a-number', // Should be number
        quickStartCommands: [{ command: 'test' }],
      } as unknown as UntetherConfig;

      expect(() => {
        configService.updateConfig(invalidConfig);
      }).toThrow('Invalid config');

      // Config should remain unchanged
      expect(configService.getConfig()).toEqual(DEFAULT_CONFIG);
    });

    it('should reject config with invalid command structure', () => {
      const invalidConfig = {
        version: 1,
        quickStartCommands: [
          { command: 'valid' },
          { notACommand: 'invalid' }, // Missing required 'command' field
        ],
      } as unknown as UntetherConfig;

      expect(() => {
        configService.updateConfig(invalidConfig);
      }).toThrow('Invalid config');
    });

    it('should reject config with non-array quickStartCommands', () => {
      const invalidConfig = {
        version: 1,
        quickStartCommands: 'not-an-array',
      } as unknown as UntetherConfig;

      expect(() => {
        configService.updateConfig(invalidConfig);
      }).toThrow('Invalid config');
    });
  });

  describe('validation edge cases', () => {
    it('should handle config with extra properties', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (p === mockConfigDir) return true;
        if (p === mockConfigPath) return true;
        return false;
      });

      // Config with extra properties (should be stripped)
      const configWithExtras = {
        version: 1,
        quickStartCommands: [{ command: 'test' }],
        extraProperty: 'should be ignored',
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configWithExtras));

      const service = new ConfigService();
      const config = service.getConfig();

      // Should only have valid properties
      expect(config).toEqual({
        version: 1,
        quickStartCommands: [{ command: 'test' }],
      });
      expect('extraProperty' in config).toBe(false);
    });

    it('should handle commands with extra properties', () => {
      const commandsWithExtras = [
        {
          command: 'valid',
          name: 'Valid Command',
          extraProp: 'ignored', // Should be stripped
        },
      ] as Array<QuickStartCommand & { extraProp: string }>;

      configService.updateQuickStartCommands(commandsWithExtras);
      const saved = configService.getConfig().quickStartCommands;

      // Extra properties should be stripped
      expect(saved).toEqual([{ command: 'valid', name: 'Valid Command' }]);
    });

    it('should handle very long command strings', () => {
      const longCommand = 'a'.repeat(1000); // 1000 character command
      const commands: QuickStartCommand[] = [{ command: longCommand }];

      // Should accept long commands (no max length)
      configService.updateQuickStartCommands(commands);
      expect(configService.getConfig().quickStartCommands[0].command).toBe(longCommand);
    });

    it('should handle unicode in commands and names', () => {
      const unicodeCommands: QuickStartCommand[] = [
        { name: '🚀 火箭', command: 'echo "Hello 世界"' },
        { name: 'émojis 😀', command: 'café' },
      ];

      configService.updateQuickStartCommands(unicodeCommands);
      expect(configService.getConfig().quickStartCommands).toEqual(unicodeCommands);
    });
  });

  describe('notification preferences', () => {
    it('should return default notification preferences when no preferences are set', () => {
      const preferences = configService.getNotificationPreferences();
      // Should return DEFAULT_NOTIFICATION_PREFERENCES instead of undefined
      expect(preferences).toEqual({
        enabled: false, // Master switch is OFF by default
        sessionStart: false,
        sessionExit: false,
        commandCompletion: false,
        commandError: true,
        bell: false,
        soundEnabled: true,
        vibrationEnabled: false,
      });
    });

    it('should update notification preferences', () => {
      const newPreferences = {
        enabled: true,
        sessionStart: false,
        sessionExit: true,
        commandCompletion: true,
        commandError: true,
        bell: true,
        soundEnabled: true,
        vibrationEnabled: false,
      };

      configService.updateNotificationPreferences(newPreferences);

      const savedPreferences = configService.getNotificationPreferences();
      expect(savedPreferences).toEqual(newPreferences);
    });

    it('should support partial notification preference updates', () => {
      // First set some initial preferences
      const initialPreferences = {
        enabled: true,
        sessionStart: true,
        sessionExit: true,
        commandCompletion: true,
        commandError: true,
        bell: true,
        soundEnabled: true,
        vibrationEnabled: true,
      };
      configService.updateNotificationPreferences(initialPreferences);

      // Now update only some fields
      const partialUpdate = {
        enabled: false,
        sessionStart: false,
      };
      configService.updateNotificationPreferences(partialUpdate);

      const savedPreferences = configService.getNotificationPreferences();
      expect(savedPreferences).toEqual({
        ...initialPreferences,
        ...partialUpdate,
      });
    });

    it('should save notification preferences to file', () => {
      const preferences = {
        enabled: false,
        sessionStart: true,
        sessionExit: false,
        commandCompletion: false,
        commandError: false,
        bell: false,
        soundEnabled: true,
        vibrationEnabled: true,
      };

      configService.updateNotificationPreferences(preferences);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        mockConfigPath,
        expect.stringContaining('"notifications"'),
        { encoding: 'utf8', mode: 0o600 }
      );

      // Verify the saved config includes preferences (get the last write call)
      const writeCalls = vi
        .mocked(fs.writeFileSync)
        .mock.calls.filter((call) => call[0] === mockConfigPath);
      const lastWriteCall = writeCalls[writeCalls.length - 1];
      const savedConfig = JSON.parse(lastWriteCall?.[1] as string);
      expect(savedConfig.preferences?.notifications).toEqual(preferences);
    });

    it('should notify listeners when preferences change', () => {
      const callback = vi.fn();
      configService.onConfigChange(callback);

      const preferences = {
        enabled: true,
        sessionStart: true,
        sessionExit: true,
        commandCompletion: true,
        commandError: true,
        bell: true,
        soundEnabled: false,
        vibrationEnabled: true,
      };

      configService.updateNotificationPreferences(preferences);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({
            notifications: preferences,
          }),
        })
      );
    });

    it('should create preferences object if it does not exist', () => {
      // Start with a config without preferences
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          version: 2,
          quickStartCommands: [],
        })
      );

      const service = new ConfigService();
      const preferences = {
        enabled: true,
        sessionStart: false,
        sessionExit: true,
        commandCompletion: true,
        commandError: true,
        bell: true,
        soundEnabled: false,
        vibrationEnabled: false,
      };

      service.updateNotificationPreferences(preferences);

      const config = service.getConfig();
      expect(config.preferences).toBeDefined();
      expect(config.preferences?.notifications).toEqual(preferences);
    });
  });
});
