/**
 * The contract between the Mac app and the server over the ~/.untether/config.json they share,
 * held with the CURRENT code of both sides (2026-11-11: an app of 2026-11-02 met a server of
 * nine days later, could not decode the file that server wrote and reset it in a loop; the
 * guard left then compared against a hand copy of that old app's structs. The installed app now
 * keeps up by itself, installed-app-updater.ts, so the contract is between the two sides of
 * one commit).
 *
 * Two files in test/fixtures/config-contract tie the sides together, each written by one side
 * and read by the other's tests:
 * - server-written.json: what this server's ConfigService writes. This test fails when that
 *   changes; the Mac's ConfigContractTests (mac/UntetherTests) loads it with ConfigManager.
 * - mac-written.json: what the Mac's ConfigManager writes. ConfigContractTests fails when that
 *   changes; this test loads it with ConfigService.
 * To change what a side writes, write its file again (UPDATE_CONFIG_CONTRACT=1 here; the Mac
 * test prints the new content) and the other side's test says whether it still reads it.
 *
 * Besides, everything the server can write is decoded here the way the Mac's JSONDecoder
 * would, with the Codable structs read from the Swift sources as they are today.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { ConfigService } from './config-service.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const CONTRACT_DIR = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'config-contract');
const SERVER_WRITTEN = path.join(CONTRACT_DIR, 'server-written.json');
const MAC_WRITTEN = path.join(CONTRACT_DIR, 'mac-written.json');
const SWIFT_SOURCES = [
  'mac/Untether/Core/Services/ConfigManager.swift',
  'mac/Untether/Core/Models/QuickStartCommand.swift',
];

interface SwiftStruct {
  required: Record<string, string>;
  optional: Record<string, string>;
}

/**
 * The Codable structs of a Swift source: each stored property with its type, `optional` when
 * declared `?` or when the struct's own `init(from:)` reads it with decodeIfPresent.
 */
function codableStructs(source: string): Record<string, SwiftStruct> {
  const structs: Record<string, SwiftStruct> = {};
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const head =
      /^(\s*)(?:private |fileprivate |public )?struct (\w+)\s*:[^{]*\bCodable\b[^{]*\{/.exec(
        lines[index]
      );
    if (!head) continue;
    const [, indent, name] = head;
    const struct: SwiftStruct = { required: {}, optional: {} };
    const ifPresent = new Set<string>();
    for (index++; index < lines.length && lines[index] !== `${indent}}`; index++) {
      const line = lines[index];
      const property = new RegExp(
        `^${indent}    (?:let|var) (\\w+): ([\\w\\[\\]]+)(\\?)?\\s*$`
      ).exec(line);
      if (property) {
        const [, key, type, optional] = property;
        (optional ? struct.optional : struct.required)[key] = type;
      }
      const read = /decodeIfPresent\([^)]*forKey: \.(\w+)\)/.exec(line);
      if (read) ifPresent.add(read[1]);
    }
    for (const key of ifPresent) {
      if (struct.required[key]) {
        struct.optional[key] = struct.required[key];
        delete struct.required[key];
      }
    }
    structs[name] = struct;
  }
  return structs;
}

const STRUCTS = Object.assign(
  {},
  ...SWIFT_SOURCES.map((file) => codableStructs(fs.readFileSync(path.join(REPO, file), 'utf8')))
) as Record<string, SwiftStruct>;

/** Why the Mac's JSONDecoder would throw on `value` as `type`; empty when it decodes. */
function decodeErrors(value: unknown, type: string, at: string): string[] {
  if (type === 'Int') return Number.isInteger(value) ? [] : [`${at}: not an Int`];
  if (type === 'Bool') return typeof value === 'boolean' ? [] : [`${at}: not a Bool`];
  if (type === 'String') return typeof value === 'string' ? [] : [`${at}: not a String`];
  const array = /^\[(\w+)\]$/.exec(type);
  if (array) {
    if (!Array.isArray(value)) return [`${at}: not an array`];
    return value.flatMap((entry, index) => decodeErrors(entry, array[1], `${at}[${index}]`));
  }
  const struct = STRUCTS[type];
  if (!struct) return [`${at}: this test does not know the Swift type ${type}`];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: not an object`];
  const object = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, fieldType] of Object.entries(struct.required)) {
    if (object[key] === undefined || object[key] === null) errors.push(`${at}.${key}: missing`);
    else errors.push(...decodeErrors(object[key], fieldType, `${at}.${key}`));
  }
  for (const [key, fieldType] of Object.entries(struct.optional)) {
    if (object[key] === undefined || object[key] === null) continue;
    errors.push(...decodeErrors(object[key], fieldType, `${at}.${key}`));
  }
  return errors;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const withoutId = ({ id: _id, ...command }: Record<string, unknown>) => command;

describe('config.json between the Mac app and the server of the same code', () => {
  let home: string;
  let configPath: string;

  const written = () => readJson(configPath);
  const expectDecodes = () =>
    expect(decodeErrors(written(), 'UntetherConfig', 'config')).toEqual([]);

  /** Every way the server saves config.json. */
  const saves: Array<[string, (service: ConfigService) => void]> = [
    ['updateQuickStartCommands', (s) => s.updateQuickStartCommands([{ command: 'bash' }])],
    ['updateRepositoryBasePath', (s) => s.updateRepositoryBasePath('~/Code')],
    ['updateNotificationPreferences', (s) => s.updateNotificationPreferences({ bell: false })],
    [
      'updateTaskTemplates',
      (s) => s.updateTaskTemplates([{ id: 'fix', name: 'fix', prompt: 'fix it' }]),
    ],
    ['updateConfig', (s) => s.updateConfig({ ...s.getConfig(), autoUpdateInstalledApp: true })],
  ];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-contract-'));
    vi.mocked(os.homedir).mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.untether'));
    configPath = path.join(home, '.untether', 'config.json');
  });

  afterEach(() => {
    fs.rmSync(home, RM_TEST_DIR);
  });

  describe('the Swift structs, as this test reads them from the sources of today', () => {
    it('finds the structs ConfigManager decodes config.json into', () => {
      expect(STRUCTS.UntetherConfig.required).toMatchObject({
        version: 'Int',
        quickStartCommands: '[QuickStartCommand]',
      });
      expect(STRUCTS.QuickStartCommand).toEqual({
        required: { command: 'String' },
        optional: { id: 'String', name: 'String' },
      });
      // Every type they name is one this test can decode.
      const known = new Set(['Int', 'Bool', 'String', ...Object.keys(STRUCTS)]);
      for (const name of ['UntetherConfig', 'PreferencesConfig', 'NotificationConfig']) {
        const struct = STRUCTS[name];
        for (const type of [...Object.values(struct.required), ...Object.values(struct.optional)]) {
          expect(known.has(type.replace(/^\[(\w+)\]$/, '$1')), `${name}: ${type}`).toBe(true);
        }
      }
    });

    it('refuses what the Mac decoder would refuse', () => {
      const [field] = Object.keys(STRUCTS.NotificationConfig.required);
      expect(field).toBeDefined();
      expect(
        decodeErrors(
          { version: 2, quickStartCommands: [{}], preferences: { notifications: {} } },
          'UntetherConfig',
          'config'
        )
      ).toEqual(
        expect.arrayContaining([
          'config.quickStartCommands[0].command: missing',
          `config.preferences.notifications.${field}: missing`,
        ])
      );
      expect(decodeErrors({ quickStartCommands: [] }, 'UntetherConfig', 'config')).toEqual([
        'config.version: missing',
      ]);
    });
  });

  describe('what the server writes, the Mac app decodes', () => {
    it('the file the server creates when there is none', () => {
      new ConfigService();
      expectDecodes();
    });

    it.each(saves)('a file the Mac app wrote, after the server saves it (%s)', (_name, save) => {
      fs.copyFileSync(MAC_WRITTEN, configPath);
      save(new ConfigService());
      expectDecodes();
    });

    it.each(saves)('a file with no preferences, after the server saves it (%s)', (_name, save) => {
      fs.writeFileSync(configPath, JSON.stringify({ version: 2, quickStartCommands: [] }));
      save(new ConfigService());
      expectDecodes();
    });

    it('a file whose preferences hold nothing yet, after the notifications are saved', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ version: 2, quickStartCommands: [], preferences: {} })
      );
      new ConfigService().updateNotificationPreferences({ enabled: true });
      expectDecodes();
    });

    it('is server-written.json, the file the Mac tests load with ConfigManager', () => {
      const service = new ConfigService();
      service.updateQuickStartCommands([
        { id: 'contract-1', name: '✨ claude', command: 'claude' },
        { command: 'zsh' },
      ]);
      service.updateRepositoryBasePath('~/Projects');
      service.updateNotificationPreferences({ enabled: true, bell: false, sessionStart: false });
      service.updateConfig({
        ...service.getConfig(),
        autoApprove: true,
        autoUpdateInstalledApp: true,
        shieldNewSessions: true,
      });
      expectDecodes();
      if (process.env.UPDATE_CONFIG_CONTRACT === '1') {
        fs.writeFileSync(SERVER_WRITTEN, `${JSON.stringify(written(), null, 2)}\n`);
      }
      expect(
        written(),
        'the server writes config.json differently now: run this test with UPDATE_CONFIG_CONTRACT=1, then the Mac tests (ConfigContractTests) say whether the app still reads it'
      ).toEqual(readJson(SERVER_WRITTEN));
    });
  });

  describe('what the Mac app writes (mac-written.json), the server reads and keeps', () => {
    it('decodes with the Mac app itself', () => {
      expect(decodeErrors(readJson(MAC_WRITTEN), 'UntetherConfig', 'config')).toEqual([]);
    });

    it('reads its quick start commands, repository path and notifications as they are', () => {
      const mac = readJson(MAC_WRITTEN);
      fs.copyFileSync(MAC_WRITTEN, configPath);
      const config = new ConfigService().getConfig();
      expect(config.version).toBe(mac.version);
      // Their ids are the Mac app's own (a list identity it makes again when missing): the
      // server has no use for them and does not carry them.
      expect(config.quickStartCommands).toEqual(mac.quickStartCommands.map(withoutId));
      expect(config.repositoryBasePath).toBe(mac.repositoryBasePath);
      expect(config.preferences?.notifications).toMatchObject(mac.preferences.notifications);
    });

    it('does not touch the file when it only loads it', () => {
      fs.copyFileSync(MAC_WRITTEN, configPath);
      new ConfigService();
      expect(written()).toEqual(readJson(MAC_WRITTEN));
    });

    it.each(saves)('keeps what its save does not change (%s)', (_name, save) => {
      const mac = readJson(MAC_WRITTEN);
      fs.copyFileSync(MAC_WRITTEN, configPath);
      const service = new ConfigService();
      const before = service.getConfig();
      save(service);
      const after = written();
      const changed = service.getConfig();
      if (
        JSON.stringify(changed.quickStartCommands) === JSON.stringify(before.quickStartCommands)
      ) {
        expect(after.quickStartCommands).toEqual(mac.quickStartCommands.map(withoutId));
      }
      if (changed.repositoryBasePath === before.repositoryBasePath) {
        expect(after.repositoryBasePath).toBe(mac.repositoryBasePath);
      }
      const notifications = { ...mac.preferences.notifications };
      if (_name === 'updateNotificationPreferences') notifications.bell = false;
      expect(after.preferences.notifications).toMatchObject(notifications);
    });
  });
});
