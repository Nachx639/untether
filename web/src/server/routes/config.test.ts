import type { Express } from 'express';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type {
  NotificationPreferences,
  QuickStartCommand,
  UntetherConfig,
} from '../../types/config.js';
import type { ConfigService } from '../services/config-service.js';
import type { MacSessionsStartOptions } from '../services/mac-sessions/settings.js';
import type { MacShareStartOptions } from '../services/mac-sessions/share-settings.js';
import { createConfigRoutes } from './config.js';

// Never the real environment: a developer's UNTETHER_MAC_SESSIONS must not change the answers.
const macOnly = { env: {}, platform: 'darwin' as const };
const macSessionsDefaults = {
  macSessions: true,
  macSessionsOpenMode: 'control',
  macSessionsLocked: false,
  macSessionsSupported: true,
  platform: 'darwin',
  // "Share with phone" is off unless turned on, and types `ut <agent> …`.
  macShare: false,
  macShareLauncher: 'ut',
  macShareLocked: false,
  macShareSupported: true,
  macShareReason: 'disabled',
  // No external model providers unless config.json sets them (model-providers.ts).
  modelProviders: [],
};

describe('Config Routes', () => {
  let app: Express;
  let mockConfigService: ConfigService;

  const defaultConfig: UntetherConfig = {
    version: 1,
    repositoryBasePath: '/home/user/repos',
    quickStartCommands: [
      { name: '✨ claude', command: 'claude' },
      { command: 'zsh' },
      { name: '▶️ pnpm run dev', command: 'pnpm run dev' },
    ],
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock config service
    mockConfigService = {
      getConfig: vi.fn(() => defaultConfig),
      updateQuickStartCommands: vi.fn(),
      updateRepositoryBasePath: vi.fn(),
      updateConfig: vi.fn(),
      startWatching: vi.fn(),
      stopWatching: vi.fn(),
      onConfigChange: vi.fn(),
      getConfigPath: vi.fn(() => '/home/user/.untether/config.json'),
      getNotificationPreferences: vi.fn(),
      updateNotificationPreferences: vi.fn(),
    } as unknown as ConfigService;

    // Create routes
    const configRoutes = createConfigRoutes({
      configService: mockConfigService,
      macSessions: macOnly,
    });

    app.use('/api', configRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/config', () => {
    it('sends avatarIcons only when configured', async () => {
      const plain = await request(app).get('/api/config');
      expect(plain.body).not.toHaveProperty('avatarIcons');
      const avatarIcons = { claude: 'one.png', previewPaused: '🦊' };
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, avatarIcons }));
      expect((await request(app).get('/api/config')).body.avatarIcons).toEqual(avatarIcons);
    });

    it('should return application configuration', async () => {
      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        repositoryBasePath: '/home/user/repos',
        serverConfigured: true,
        quickStartCommands: defaultConfig.quickStartCommands,
        autoApprove: false,
        autoCleanupExitedAfterDays: 0,
        shieldNewSessions: true,
        restartUpdatedClaude: false,
        autoUpdateInstalledApp: false,
        suspendIdleClaude: false,
        agentExplain: true,
        suspendIdleMinutes: 120,
        shieldAvailable: false,
        ...macSessionsDefaults,
      });

      expect(mockConfigService.getConfig).toHaveBeenCalledOnce();
    });

    it('tells clients to log their touch scrolls only when config.json says so', async () => {
      // The installed PWA has no address bar for ?scrollperf: QA turns it on from the server.
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('scrollPerf');
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, scrollPerf: true }));
      expect((await request(app).get('/api/config')).body.scrollPerf).toBe(true);
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, scrollPerf: false }));
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('scrollPerf');
    });

    it('turns the chat keyboard fix on for clients only when config.json says so', async () => {
      // An experiment for one iPhone: on and off by hand in config.json, without a deploy.
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('chatKeyboardFix');
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, chatKeyboardFix: true }));
      expect((await request(app).get('/api/config')).body.chatKeyboardFix).toBe(true);
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, chatKeyboardFix: false }));
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('chatKeyboardFix');
    });

    it('turns iteration 3 of the chat keyboard fix on only when config.json says so', async () => {
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('chatKeyboardFix2');
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, chatKeyboardFix2: true }));
      expect((await request(app).get('/api/config')).body.chatKeyboardFix2).toBe(true);
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, chatKeyboardFix2: false }));
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('chatKeyboardFix2');
    });

    it('turns iteration 4 of the chat keyboard fix on only when config.json says so', async () => {
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('chatKeyboardFix3');
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, chatKeyboardFix3: true }));
      expect((await request(app).get('/api/config')).body.chatKeyboardFix3).toBe(true);
      mockConfigService.getConfig = vi.fn(() => ({ ...defaultConfig, chatKeyboardFix3: false }));
      expect((await request(app).get('/api/config')).body).not.toHaveProperty('chatKeyboardFix3');
    });

    it('should use default repository path when not configured', async () => {
      mockConfigService.getConfig = vi.fn(() => ({
        ...defaultConfig,
        repositoryBasePath: undefined,
      }));

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        repositoryBasePath: '~/Documents',
        serverConfigured: true,
        quickStartCommands: defaultConfig.quickStartCommands,
        autoApprove: false,
        autoCleanupExitedAfterDays: 0,
        shieldNewSessions: true,
        restartUpdatedClaude: false,
        autoUpdateInstalledApp: false,
        suspendIdleClaude: false,
        agentExplain: true,
        suspendIdleMinutes: 120,
        shieldAvailable: false,
        ...macSessionsDefaults,
      });
    });

    it('should handle config service errors', async () => {
      mockConfigService.getConfig = vi.fn(() => {
        throw new Error('Config read error');
      });

      const response = await request(app).get('/api/config');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to get app config',
      });
    });
  });

  describe('PUT /api/config', () => {
    it('should update quick start commands', async () => {
      const newCommands: QuickStartCommand[] = [
        { command: 'python3' },
        { name: '🚀 node', command: 'node' },
      ];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: newCommands });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: newCommands,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: newCommands,
      });
    });

    it('should filter out empty commands', async () => {
      const commandsWithEmpty: QuickStartCommand[] = [
        { command: 'python3' },
        { command: '' }, // Empty command
        { name: 'Empty', command: '   ' }, // Whitespace only
        { name: '🚀 node', command: 'node' },
      ];

      const expectedFiltered: QuickStartCommand[] = [
        { command: 'python3' },
        { name: '🚀 node', command: 'node' },
      ];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: commandsWithEmpty });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: expectedFiltered,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: expectedFiltered,
      });
    });

    it('should validate command structure', async () => {
      const invalidCommands = [
        { command: 'valid' },
        { notCommand: 'invalid' }, // Missing command field
        null, // Null entry
        { command: 123 }, // Invalid type
      ];

      const expectedValid = [{ command: 'valid' }];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: invalidCommands });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: expectedValid,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: expectedValid,
      });
    });

    it('should return 400 for missing quickStartCommands', async () => {
      const response = await request(app).put('/api/config').send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'No valid updates provided',
      });

      expect(mockConfigService.updateQuickStartCommands).not.toHaveBeenCalled();
    });

    it('should return 400 for non-array quickStartCommands', async () => {
      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: 'not-an-array' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'No valid updates provided',
      });

      expect(mockConfigService.updateQuickStartCommands).not.toHaveBeenCalled();
    });

    it('should handle config service update errors', async () => {
      mockConfigService.updateConfig = vi.fn(() => {
        throw new Error('Write error');
      });

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: [{ command: 'test' }] });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to update config',
      });
    });

    it('should allow empty array of commands', async () => {
      const response = await request(app).put('/api/config').send({ quickStartCommands: [] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        quickStartCommands: [],
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: [],
      });
    });

    it('should preserve optional name field', async () => {
      const commandsWithNames: QuickStartCommand[] = [
        { name: 'Python REPL', command: 'python3' },
        { command: 'node' }, // No name
        { name: undefined, command: 'bash' }, // Explicitly undefined
      ];

      const response = await request(app)
        .put('/api/config')
        .send({ quickStartCommands: commandsWithNames });

      expect(response.status).toBe(200);
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        quickStartCommands: commandsWithNames,
      });
    });

    it('should update repository base path', async () => {
      const newPath = '/new/repo/path';

      const response = await request(app).put('/api/config').send({ repositoryBasePath: newPath });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        repositoryBasePath: newPath,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        repositoryBasePath: newPath,
      });
    });

    it('should update both repository base path and quick start commands', async () => {
      const newPath = '/new/repo/path';
      const newCommands = [{ command: 'test' }];

      const response = await request(app).put('/api/config').send({
        repositoryBasePath: newPath,
        quickStartCommands: newCommands,
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        repositoryBasePath: newPath,
        quickStartCommands: newCommands,
      });

      expect(mockConfigService.updateConfig).toHaveBeenCalledOnce();
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        repositoryBasePath: newPath,
        quickStartCommands: newCommands,
      });
    });

    it('reports finished-session cleanup as off when never chosen', async () => {
      const response = await request(app).get('/api/config');
      expect(response.body.autoCleanupExitedAfterDays).toBe(0);
    });

    it('saves the finished-session cleanup age, including turning it off', async () => {
      for (const days of [7, 0]) {
        const response = await request(app).put('/api/config').send({
          autoCleanupExitedAfterDays: days,
        });
        expect(response.status).toBe(200);
        expect(mockConfigService.updateConfig).toHaveBeenLastCalledWith({
          ...defaultConfig,
          autoCleanupExitedAfterDays: days,
        });
      }
    });

    it('rejects a negative or fractional cleanup age', async () => {
      for (const days of [-1, 1.5, '7']) {
        const response = await request(app).put('/api/config').send({
          autoCleanupExitedAfterDays: days,
        });
        expect(response.status).toBe(400);
      }
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });

    it('should reject invalid repository base path', async () => {
      const response = await request(app).put('/api/config').send({ repositoryBasePath: 123 }); // Not a string

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'No valid updates provided',
      });

      expect(mockConfigService.updateRepositoryBasePath).not.toHaveBeenCalled();
    });
  });

  describe('shield new sessions', () => {
    it('is on unless turned off, and says whether tmux is there', async () => {
      const shieldApp = express();
      shieldApp.use(express.json());
      shieldApp.use(
        '/api',
        createConfigRoutes({
          configService: mockConfigService as unknown as ConfigService,
          isShieldAvailable: () => true,
        })
      );
      const response = await request(shieldApp).get('/api/config');
      expect(response.body.shieldNewSessions).toBe(true);
      expect(response.body.shieldAvailable).toBe(true);
    });

    it('PUT saves the switch', async () => {
      const response = await request(app).put('/api/config').send({ shieldNewSessions: false });
      expect(response.status).toBe(200);
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ shieldNewSessions: false })
      );
    });

    it('PUT ignores a value that is not true/false', async () => {
      await request(app).put('/api/config').send({ shieldNewSessions: 'yes' });
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });

  // 2026-10-31: idle Claude sessions restarted on the installed version; off unless turned on.
  describe('restart Claude after updates', () => {
    it('is off by default and PUT saves it', async () => {
      expect((await request(app).get('/api/config')).body.restartUpdatedClaude).toBe(false);
      const response = await request(app).put('/api/config').send({ restartUpdatedClaude: true });
      expect(response.status).toBe(200);
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ restartUpdatedClaude: true })
      );
    });

    it('PUT ignores a value that is not true/false', async () => {
      await request(app).put('/api/config').send({ restartUpdatedClaude: 'yes' });
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });

  // 2026-11-11: the installed Mac app kept up to date by itself; off unless turned on, and
  // offered only where an installed app runs this server as a development server.
  describe('keep the installed app up to date', () => {
    it('is off by default and PUT saves it', async () => {
      const before = (await request(app).get('/api/config')).body;
      expect(before.autoUpdateInstalledApp).toBe(false);
      expect(before).not.toHaveProperty('installedApp');
      const response = await request(app).put('/api/config').send({ autoUpdateInstalledApp: true });
      expect(response.status).toBe(200);
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ autoUpdateInstalledApp: true })
      );
    });

    it('PUT ignores a value that is not true/false', async () => {
      await request(app).put('/api/config').send({ autoUpdateInstalledApp: 'yes' });
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });

  // 2026-10-31: idle Claude sessions suspended to free memory; off unless turned on.
  describe('suspend idle Claude sessions', () => {
    it('is off by default with 120 minutes, and PUT saves both', async () => {
      const body = (await request(app).get('/api/config')).body;
      expect(body.suspendIdleClaude).toBe(false);
      expect(body.suspendIdleMinutes).toBe(120);
      const response = await request(app)
        .put('/api/config')
        .send({ suspendIdleClaude: true, suspendIdleMinutes: 60 });
      expect(response.status).toBe(200);
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ suspendIdleClaude: true, suspendIdleMinutes: 60 })
      );
    });

    it('keeps at least 15 minutes and ignores what is not a number or a boolean', async () => {
      await request(app).put('/api/config').send({ suspendIdleMinutes: 2 });
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ suspendIdleMinutes: 15 })
      );
      mockConfigService.updateConfig.mockClear();
      await request(app)
        .put('/api/config')
        .send({ suspendIdleClaude: 'yes', suspendIdleMinutes: 'x' });
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });

  // 2026-11-08: the home cards' one line about each agent, on unless turned off.
  it('agentExplain is on by default and PUT saves it off', async () => {
    expect((await request(app).get('/api/config')).body.agentExplain).toBe(true);
    const response = await request(app).put('/api/config').send({ agentExplain: false });
    expect(response.status).toBe(200);
    expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agentExplain: false })
    );
  });

  describe('stable tmux signature', () => {
    const IDENTITY = 'C'.repeat(40);
    function signingApp(withStableTmux: boolean) {
      const order: string[] = [];
      const stableTmux = {
        refresh: vi.fn(async () => {
          order.push('refresh');
          return { state: 'current' as const, bin: '/x/tmux', version: '3.7c' };
        }),
        clearFailure: vi.fn(() => order.push('clearFailure')),
        lastStatus: { state: 'current' as const, bin: '/x/tmux', version: '3.7c' },
      };
      (mockConfigService.updateConfig as ReturnType<typeof vi.fn>).mockImplementation(() =>
        order.push('save')
      );
      const signing = express();
      signing.use(express.json());
      signing.use(
        '/api',
        createConfigRoutes({
          configService: mockConfigService,
          ...(withStableTmux ? { stableTmux } : {}),
          signingIdentities: async () => [{ hash: IDENTITY, name: 'Local signing' }],
        })
      );
      return { signing, stableTmux, order };
    }

    it('GET lists the keychain identities and the copy, or says unsupported', async () => {
      const { signing } = signingApp(true);
      const response = await request(signing).get('/api/tmux-signing');
      expect(response.body).toEqual({
        supported: true,
        identifier: 'dev.untether.tmux',
        identity: null,
        identities: [{ hash: IDENTITY, name: 'Local signing' }],
        status: { state: 'current', bin: '/x/tmux', version: '3.7c' },
      });
      const off = signingApp(false);
      expect((await request(off.signing).get('/api/tmux-signing')).body).toEqual({
        supported: false,
      });
    });

    it('PUT saves the identity, clears a failed signing first, then renews', async () => {
      const { signing, order } = signingApp(true);
      const response = await request(signing)
        .put('/api/config')
        .send({ tmuxSigningIdentity: IDENTITY });
      expect(response.status).toBe(200);
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ tmuxSigningIdentity: IDENTITY })
      );
      expect(order).toEqual(['clearFailure', 'save', 'refresh']);
    });

    it('PUT null turns it off; an option-like value or no stable copy is refused', async () => {
      const { signing } = signingApp(true);
      await request(signing).put('/api/config').send({ tmuxSigningIdentity: null });
      const saved = (mockConfigService.updateConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect('tmuxSigningIdentity' in saved).toBe(false);
      vi.clearAllMocks();
      await request(signing).put('/api/config').send({ tmuxSigningIdentity: '--force' });
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
      const off = signingApp(false);
      await request(off.signing).put('/api/config').send({ tmuxSigningIdentity: IDENTITY });
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });

  describe('Mac sessions', () => {
    function macApp(config: Partial<UntetherConfig>, macSessions: MacSessionsStartOptions) {
      const macApp = express();
      macApp.use(express.json());
      macApp.use(
        '/api',
        createConfigRoutes({
          configService: {
            ...mockConfigService,
            getConfig: () => ({ ...defaultConfig, ...config }),
          } as unknown as ConfigService,
          macSessions,
        })
      );
      return macApp;
    }

    it('are listed and open ready to type unless chosen otherwise', async () => {
      let response = await request(app).get('/api/config');
      expect(response.body).toMatchObject(macSessionsDefaults);
      expect(response.body.macSessionsLockedBy).toBeUndefined();

      response = await request(
        macApp({ macSessions: false, macSessionsOpenMode: 'watch' }, macOnly)
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macSessions: false,
        macSessionsOpenMode: 'watch',
        macSessionsLocked: false,
      });
    });

    it('a switch forced at start wins over config.json and is reported locked', async () => {
      const env = { UNTETHER_MAC_SESSIONS: '0' };
      let response = await request(macApp({ macSessions: true }, { ...macOnly, env })).get(
        '/api/config'
      );
      expect(response.body).toMatchObject({
        macSessions: false,
        macSessionsLocked: true,
        macSessionsLockedBy: 'UNTETHER_MAC_SESSIONS=0',
      });

      response = await request(macApp({}, { ...macOnly, cliDisabled: true })).get('/api/config');
      expect(response.body).toMatchObject({
        macSessions: false,
        macSessionsLockedBy: '--no-mac-sessions',
      });
    });

    it('are not offered where nothing can be listed', async () => {
      for (const options of [
        { ...macOnly, platform: 'win32' as const },
        { ...macOnly, hqMode: true },
      ]) {
        const response = await request(macApp({}, options)).get('/api/config');
        expect(response.body.macSessionsSupported).toBe(false);
      }
    });

    it("say which platform the server runs on, for Settings' words", async () => {
      const linux = await request(macApp({}, { ...macOnly, platform: 'linux' })).get('/api/config');
      expect(linux.body.platform).toBe('linux');
      const mac = await request(macApp({}, macOnly)).get('/api/config');
      expect(mac.body.platform).toBe('darwin');
    });

    it('PUT saves the switch and the open mode', async () => {
      const response = await request(app)
        .put('/api/config')
        .send({ macSessions: false, macSessionsOpenMode: 'watch' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        macSessions: false,
        macSessionsOpenMode: 'watch',
      });
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        macSessions: false,
        macSessionsOpenMode: 'watch',
      });
    });

    it('PUT refuses an open mode other than control or watch, and a switch that is not a boolean', async () => {
      for (const body of [
        { macSessionsOpenMode: 'type' },
        { macSessionsOpenMode: '' },
        { macSessionsOpenMode: null },
        { macSessionsOpenMode: ['watch'] },
        { macSessions: 'yes' },
        { macSessions: 1 },
      ]) {
        const response = await request(app).put('/api/config').send(body);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });

  describe('Share with phone', () => {
    function shareApp(config: Partial<UntetherConfig>, macShare: MacShareStartOptions) {
      const shareApp = express();
      shareApp.use(express.json());
      shareApp.use(
        '/api',
        createConfigRoutes({
          configService: {
            ...mockConfigService,
            getConfig: () => ({ ...defaultConfig, ...config }),
          } as unknown as ConfigService,
          macSessions: macOnly,
          macShare,
        })
      );
      return shareApp;
    }

    it('is off until turned on, and then offered with the launcher chosen', async () => {
      const response = await request(
        shareApp({ macShare: true, macShareLauncher: 'shell' }, macOnly)
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macShare: true,
        macShareLauncher: 'shell',
        macShareLocked: false,
        macShareSupported: true,
      });
      expect(response.body).not.toHaveProperty('macShareReason');
      expect(response.body).not.toHaveProperty('macShareLockedBy');
    });

    it('a switch forced at start wins over config.json and is reported locked', async () => {
      let response = await request(
        shareApp({ macShare: false }, { ...macOnly, env: { UNTETHER_MAC_SHARE: '1' } })
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macShare: true,
        macShareLocked: true,
        macShareLockedBy: 'UNTETHER_MAC_SHARE=1',
      });

      response = await request(
        shareApp(
          { macShare: true },
          { ...macOnly, env: { UNTETHER_MAC_SHARE: '1' }, shareCliDisabled: true }
        )
      ).get('/api/config');
      expect(response.body).toMatchObject({
        macShare: false,
        macShareLocked: true,
        macShareLockedBy: '--no-mac-share',
        macShareReason: 'disabled',
      });
    });

    it('says why it is not offered while on: no login, or "On this Mac" off', async () => {
      let response = await request(shareApp({ macShare: true }, { ...macOnly, noAuth: true })).get(
        '/api/config'
      );
      expect(response.body).toMatchObject({ macShare: true, macShareReason: 'no-auth' });

      response = await request(shareApp({ macShare: true, macSessions: false }, macOnly)).get(
        '/api/config'
      );
      expect(response.body.macShareReason).toBe('mac-sessions-off');
    });

    it('is not offered off macOS or in HQ mode, without a reason to show', async () => {
      for (const options of [
        { ...macOnly, platform: 'linux' as const },
        { ...macOnly, hqMode: true },
      ]) {
        const response = await request(shareApp({ macShare: true }, options)).get('/api/config');
        expect(response.body.macShareSupported).toBe(false);
        expect(response.body).not.toHaveProperty('macShareReason');
      }
    });

    it('PUT saves the switch and the launcher', async () => {
      const response = await request(app)
        .put('/api/config')
        .send({ macShare: true, macShareLauncher: 'shell' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, macShare: true, macShareLauncher: 'shell' });
      expect(mockConfigService.updateConfig).toHaveBeenCalledWith({
        ...defaultConfig,
        macShare: true,
        macShareLauncher: 'shell',
      });
    });

    it('PUT refuses another launcher, a switch that is not a boolean, and config.json-only keys', async () => {
      for (const body of [
        { macShareLauncher: 'zsh' },
        { macShareLauncher: '' },
        { macShareLauncher: null },
        { macShare: 'yes' },
        { macShare: 1 },
        { macShareUtPath: '/tmp/ut' },
        { macShareAutoTrust: false },
        { macShareStartTimeoutSec: 60 },
      ]) {
        const response = await request(app).put('/api/config').send(body);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(mockConfigService.updateConfig).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/quick-start/availability', () => {
    function availabilityApp(check: (programs: string[]) => Promise<Record<string, boolean>>) {
      const availabilityApp = express();
      availabilityApp.use(
        '/api',
        createConfigRoutes({
          configService: {
            getConfig: () => ({
              ...defaultConfig,
              quickStartCommands: [
                { name: '✨ claude', command: 'claude --dangerously-skip-permissions' },
                { command: 'gemini' },
                { command: 'opencode 4' },
              ],
            }),
          } as unknown as ConfigService,
          quickStartAvailability: { check },
        })
      );
      return availabilityApp;
    }

    it('answers for the program of each quick start', async () => {
      const check = vi.fn(async (programs: string[]) =>
        Object.fromEntries(programs.map((program) => [program, program !== 'gemini']))
      );

      const response = await request(availabilityApp(check)).get('/api/quick-start/availability');

      expect(check).toHaveBeenCalledWith(['claude', 'gemini', 'opencode']);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ claude: true, gemini: false, opencode: true });
    });

    it('answers {} (every quick start offered) when the check fails', async () => {
      const response = await request(
        availabilityApp(async () => {
          throw new Error('boom');
        })
      ).get('/api/quick-start/availability');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });
  });

  describe('notification preferences', () => {
    describe('GET /api/config with notification preferences', () => {
      it('should include notification preferences in response', async () => {
        const notificationPreferences: NotificationPreferences = {
          enabled: true,
          sessionStart: false,
          sessionExit: true,
          commandCompletion: true,
          commandError: true,
          bell: true,
          soundEnabled: true,
          vibrationEnabled: true,
        };

        mockConfigService.getNotificationPreferences = vi.fn(() => notificationPreferences);

        const response = await request(app).get('/api/config');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          repositoryBasePath: '/home/user/repos',
          serverConfigured: true,
          quickStartCommands: defaultConfig.quickStartCommands,
          notificationPreferences,
          autoApprove: false,
          autoCleanupExitedAfterDays: 0,
          shieldNewSessions: true,
          restartUpdatedClaude: false,
          autoUpdateInstalledApp: false,
          suspendIdleClaude: false,
          agentExplain: true,
          suspendIdleMinutes: 120,
          shieldAvailable: false,
          ...macSessionsDefaults,
        });
      });

      it('should handle missing notification preferences', async () => {
        // A fake without an implementation answers undefined.
        mockConfigService.getNotificationPreferences = vi.fn<() => NotificationPreferences>();

        const response = await request(app).get('/api/config');

        expect(response.status).toBe(200);
        expect(response.body.notificationPreferences).toBeUndefined();
      });
    });

    describe('PUT /api/config with notification preferences', () => {
      it('should update notification preferences', async () => {
        const newPreferences = {
          enabled: false,
          sessionStart: true,
          sessionExit: false,
          commandCompletion: false,
          commandError: false,
          bell: false,
        };

        const response = await request(app)
          .put('/api/config')
          .send({ notificationPreferences: newPreferences });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          success: true,
          notificationPreferences: newPreferences,
        });

        expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            preferences: expect.objectContaining({
              notifications: expect.objectContaining(newPreferences),
            }),
          })
        );
      });

      it('should update notification preferences along with other settings', async () => {
        const newPath = '/new/repository/path';
        const newPreferences = {
          enabled: true,
          sessionStart: true,
          sessionExit: true,
          commandCompletion: true,
          commandError: true,
          bell: true,
        };

        const response = await request(app).put('/api/config').send({
          repositoryBasePath: newPath,
          notificationPreferences: newPreferences,
        });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          success: true,
          repositoryBasePath: newPath,
          notificationPreferences: newPreferences,
        });

        expect(mockConfigService.updateConfig).toHaveBeenCalledOnce();
        expect(mockConfigService.updateConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            repositoryBasePath: newPath,
            preferences: expect.objectContaining({
              notifications: expect.objectContaining(newPreferences),
            }),
          })
        );
      });

      it('should reject invalid notification preferences', async () => {
        const response = await request(app)
          .put('/api/config')
          .send({ notificationPreferences: 'invalid' }); // Not an object

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          error: 'No valid updates provided',
        });

        expect(mockConfigService.updateNotificationPreferences).not.toHaveBeenCalled();
      });
    });
  });

  describe('GET /model-providers/icon/:file', () => {
    let control: string;

    beforeEach(() => {
      control = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-config-icons-'));
      fs.mkdirSync(path.join(control, 'icons'));
      fs.writeFileSync(path.join(control, 'icons', 'acme.png'), 'png-bytes');
      fs.writeFileSync(path.join(control, 'secret.png'), 'secret');
      vi.stubEnv('UNTETHER_CONTROL_DIR', control);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      fs.rmSync(control, RM_TEST_DIR);
    });

    it('serves the image, unable to run anything and cached', async () => {
      const response = await request(app).get('/api/model-providers/icon/acme.png');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain('sandbox');
      expect(response.headers['cache-control']).toBe('private, max-age=86400');
    });

    it.each([
      ['a missing file', 'nope.png'],
      ['an encoded parent path', '..%2Fsecret.png'],
      ['an encoded absolute path', '%2Fetc%2Fpasswd.png'],
    ])('answers 404 for %s', async (_label, name) => {
      const response = await request(app).get(`/api/model-providers/icon/${name}`);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('secret');
    });
  });
});
