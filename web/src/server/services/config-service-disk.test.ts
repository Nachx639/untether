/**
 * ConfigService against a real config.json (config-service.test.ts mocks fs): what a save leaves
 * in the file. 2026-11-11: the server wrote only its schema's keys, so removing a key from the
 * schema removed it from every user's file, and the Mac app installed then (a build of
 * 2026-11-02 that needed them) reset the whole file to defaults.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { ConfigService } from './config-service.js';
import { configValidCheck, configWritableCheck } from './doctor-checks.js';

/**
 * A config.json as another writer left it: the Mac app of 2026-11-02 (JSONEncoder, sorted
 * keys), with sections and switches this server's schema no longer has.
 */
const OTHER_WRITERS_FILE = {
  development: {
    debugMode: false,
    devServerPath: '/Users/u/untether/web',
    logLevel: 'info',
    useDevServer: true,
  },
  preferences: {
    notifications: {
      bell: true,
      commandCompletion: true,
      commandError: true,
      enabled: true,
      sessionExit: true,
      sessionStart: false,
      showInNotificationCenter: true,
      soundEnabled: true,
      vibrationEnabled: false,
    },
    preferredTerminal: 'Ghostty',
    preventSleepWhenRunning: false,
    showInDock: true,
  },
  quickStartCommands: [
    { command: 'claude --dangerously-skip-permissions', id: 'A1', name: '✨ mine' },
    { command: 'zsh', id: 'B2' },
  ],
  remoteAccess: { ngrokEnabled: false, ngrokTokenPresent: false },
  repositoryBasePath: '~/Projects',
  server: {
    authenticationMode: 'os',
    cleanupOnStartup: true,
    dashboardAccessMode: 'network',
    port: 4020,
  },
  sessionDefaults: {
    command: 'zsh',
    spawnWindow: true,
    titleMode: 'static',
    workingDirectory: '~/Projects',
  },
  version: 2,
};

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('ConfigService on disk', () => {
  let home: string;
  let configPath: string;

  /** A file with keys the server's schema does not have, at every level it writes. */
  const FILE = {
    ...OTHER_WRITERS_FILE,
    someFutureSection: { nested: [1, { deep: null }], text: 'ñ ✨', n: 1.5 },
    shieldNewSessions: true,
  };
  /** Each part of FILE the server does not know, as its bytes in a pretty-printed file. */
  const unknownParts = (file: typeof FILE) => ({
    server: JSON.stringify(file.server),
    development: JSON.stringify(file.development),
    remoteAccess: JSON.stringify(file.remoteAccess),
    sessionDefaults: JSON.stringify(file.sessionDefaults),
    someFutureSection: JSON.stringify(file.someFutureSection),
    showInDock: JSON.stringify(file.preferences.showInDock),
    preventSleepWhenRunning: JSON.stringify(file.preferences.preventSleepWhenRunning),
    preferredTerminal: JSON.stringify(file.preferences.preferredTerminal),
    showInNotificationCenter: JSON.stringify(
      file.preferences.notifications.showInNotificationCenter
    ),
  });
  const written = () => JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof FILE;

  const saves: Array<[string, (service: ConfigService) => void]> = [
    ['updateQuickStartCommands', (s) => s.updateQuickStartCommands([{ command: 'bash' }])],
    ['updateRepositoryBasePath', (s) => s.updateRepositoryBasePath('~/Code')],
    ['updateNotificationPreferences', (s) => s.updateNotificationPreferences({ bell: false })],
    [
      'updateTaskTemplates',
      (s) => s.updateTaskTemplates([{ id: 'fix', name: 'fix', prompt: 'fix it' }]),
    ],
    ['updateConfig', (s) => s.updateConfig({ ...s.getConfig(), shieldNewSessions: false })],
  ];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-disk-'));
    vi.mocked(os.homedir).mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.untether'));
    configPath = path.join(home, '.untether', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(FILE, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600);
    fs.rmSync(home, RM_TEST_DIR);
  });

  it.each(saves)('keeps every key it does not know, byte for byte, through %s', (_name, save) => {
    const service = new ConfigService();
    save(service);
    expect(unknownParts(written())).toEqual(unknownParts(FILE));
    // The server's settings do not see them: they are someone else's.
    expect(service.getConfig()).not.toHaveProperty('server');
    expect(service.getConfig().preferences).not.toHaveProperty('showInDock');
  });

  it('keeps them through every save in a row, and its own change lands', () => {
    const service = new ConfigService();
    for (const [, save] of saves) save(service);
    const file = written();
    expect(unknownParts(file)).toEqual(unknownParts(FILE));
    expect(file.quickStartCommands).toEqual([{ command: 'bash' }]);
    expect(file.repositoryBasePath).toBe('~/Code');
    expect(file.preferences.notifications.bell).toBe(false);
    expect(file.preferences.notifications.sessionStart).toBe(false);
    expect(file.shieldNewSessions).toBe(false);
    // The file's own order of keys stays: a save is not a rewrite.
    expect(Object.keys(file).slice(0, Object.keys(FILE).length)).toEqual(Object.keys(FILE));
  });

  it('keeps a key another writer adds while the server runs', () => {
    const service = new ConfigService();
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...written(), addedLater: { by: 'the Mac app' } }, null, 2)
    );
    service.updateQuickStartCommands([{ command: 'fish' }]);
    expect(written()).toMatchObject({
      addedLater: { by: 'the Mac app' },
      quickStartCommands: [{ command: 'fish' }],
      server: FILE.server,
    });
  });

  it('still removes a setting of its own that was cleared', () => {
    const service = new ConfigService();
    const { shieldNewSessions: _cleared, ...rest } = service.getConfig();
    service.updateConfig(rest);
    expect(written()).not.toHaveProperty('shieldNewSessions');
    expect(unknownParts(written())).toEqual(unknownParts(FILE));
  });

  it('never drops preferences from the file, even with none of its own', () => {
    const service = new ConfigService();
    const { preferences: _none, ...rest } = service.getConfig();
    service.updateConfig(rest);
    expect(written().preferences).toEqual(FILE.preferences);
  });

  // 2026-11-11: config.json left read-only; every save failed with a line in the log alone.
  it('tells the doctor when config.json cannot be written, and stops once it can', () => {
    const service = new ConfigService();
    const check = configWritableCheck({
      saveProblem: () => service.getSaveProblem(),
      configPath: service.getConfigPath(),
    });
    expect(check.run()).toEqual([]);

    fs.chmodSync(configPath, 0o400);
    // Before any save fails: the file itself says so.
    expect(check.run()).toMatchObject([{ key: 'config-writable', severity: 'warning' }]);
    expect(() => service.updateQuickStartCommands([{ command: 'bash' }])).toThrow(
      /Failed to save configuration/
    );
    const [finding] = check.run() as Array<{ problem: string }>;
    expect(finding.problem).toContain(configPath);
    expect(finding.problem).toMatch(/EACCES|EPERM/);
    expect(written()).toEqual(FILE);

    fs.chmodSync(configPath, 0o600);
    service.updateQuickStartCommands([{ command: 'bash' }]);
    expect(check.run()).toEqual([]);
    expect(written().quickStartCommands).toEqual([{ command: 'bash' }]);
  });

  // 2026-11-11 (server audit, decision): one value that did not pass and loadConfig replaced the
  // whole config.json by the defaults, and config.backup.json by the same. The Mac's
  // ConfigManager had the same class of fault.
  describe('a config.json that does not pass', () => {
    const backupPath = () => path.join(home, '.untether', 'config.backup.json');
    const asidePath = () => path.join(home, '.untether', 'config.invalid.json');
    const doctor = (service: ConfigService) =>
      configValidCheck({ loadProblem: () => service.getLoadProblem() }).run() as Array<{
        key: string;
        severity: string;
        problem: string;
      }>;

    it('one bad value: the file and its backup stay, the valid settings are used, the doctor says so', () => {
      const backup = JSON.stringify({ version: 2, quickStartCommands: [{ command: 'zsh' }] });
      fs.writeFileSync(backupPath(), backup);
      const bad = JSON.stringify(
        {
          ...FILE,
          quickStartCommands: [{ command: '' }],
          repositoryBasePath: '~/Code',
          shieldNewSessions: true,
        },
        null,
        2
      );
      fs.writeFileSync(configPath, bad);

      const service = new ConfigService();
      expect(fs.readFileSync(configPath, 'utf8')).toBe(bad);
      expect(fs.readFileSync(backupPath(), 'utf8')).toBe(backup);
      // What is valid is used; only the bad key takes its default.
      expect(service.getConfig().repositoryBasePath).toBe('~/Code');
      expect(service.getConfig().shieldNewSessions).toBe(true);
      expect(service.getConfig().quickStartCommands).toEqual(
        new ConfigService().getConfig().quickStartCommands
      );
      expect(service.getConfig().quickStartCommands.length).toBeGreaterThan(0);
      const [finding] = doctor(service);
      expect(finding).toMatchObject({ key: 'config-valid', severity: 'warning' });
      expect(finding.problem).toContain(configPath);
      expect(finding.problem).toContain('quickStartCommands');
      // A later save cannot lose what the user had: a copy is beside it.
      expect(fs.readFileSync(asidePath(), 'utf8')).toBe(bad);
    });

    it('not JSON at all: untouched, the defaults in memory, and told', () => {
      const backup = JSON.stringify({ version: 2, quickStartCommands: [{ command: 'zsh' }] });
      fs.writeFileSync(backupPath(), backup);
      fs.writeFileSync(configPath, '{ "version": 2, "quickStartCommands": [');

      const service = new ConfigService();
      expect(fs.readFileSync(configPath, 'utf8')).toBe('{ "version": 2, "quickStartCommands": [');
      expect(fs.readFileSync(backupPath(), 'utf8')).toBe(backup);
      expect(service.getConfig().quickStartCommands.length).toBeGreaterThan(0);
      expect(doctor(service)[0].problem).toContain('cannot be read');
      expect(fs.readFileSync(asidePath(), 'utf8')).toBe('{ "version": 2, "quickStartCommands": [');
    });

    it('says nothing of a file that reads well', () => {
      expect(doctor(new ConfigService())).toEqual([]);
      expect(fs.existsSync(asidePath())).toBe(false);
    });
  });
});
