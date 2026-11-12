import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { type MacSessionsConfig, macSessionsSettings } from './settings.js';

// Never the real environment: a developer's UNTETHER_MAC_SESSIONS must not change the answers.
const mac = { env: {}, platform: 'darwin' as const };
const withEnv = (value: string) => ({ ...mac, env: { UNTETHER_MAC_SESSIONS: value } });

describe('Mac sessions settings', () => {
  it('lists by default, opens ready to type and hides agents without a terminal', () => {
    expect(macSessionsSettings({}, mac)).toEqual({
      on: true,
      supported: true,
      enabled: true,
      openMode: 'control',
      includeHeadless: false,
    });
  });

  it('follows config.json when nothing forces the switch', () => {
    expect(
      macSessionsSettings(
        { macSessions: false, macSessionsOpenMode: 'watch', macSessionsIncludeHeadless: true },
        mac
      )
    ).toEqual({
      on: false,
      supported: true,
      enabled: false,
      reason: 'disabled',
      openMode: 'watch',
      includeHeadless: true,
    });
  });

  it('UNTETHER_MAC_SESSIONS forces the switch either way and says so', () => {
    expect(macSessionsSettings({ macSessions: true }, withEnv('0'))).toMatchObject({
      on: false,
      enabled: false,
      reason: 'disabled',
      lockedBy: 'UNTETHER_MAC_SESSIONS=0',
    });
    const forcedOn = macSessionsSettings({ macSessions: false }, withEnv('1'));
    expect(forcedOn).toMatchObject({
      on: true,
      enabled: true,
      lockedBy: 'UNTETHER_MAC_SESSIONS=1',
    });
    expect(forcedOn.reason).toBeUndefined();
  });

  it('reads yes/no words in the env, and forces nothing with any other value', () => {
    expect(macSessionsSettings({}, withEnv(' FALSE ')).lockedBy).toBe('UNTETHER_MAC_SESSIONS=0');
    expect(macSessionsSettings({ macSessions: false }, withEnv('yes')).on).toBe(true);
    for (const value of ['', '  ', 'maybe', '2']) {
      const settings = macSessionsSettings({ macSessions: false }, withEnv(value));
      expect(settings.lockedBy, value).toBeUndefined();
      expect(settings.on, value).toBe(false);
    }
  });

  it('--no-mac-sessions beats the env and config.json', () => {
    expect(
      macSessionsSettings({ macSessions: true }, { ...withEnv('1'), cliDisabled: true })
    ).toMatchObject({ on: false, enabled: false, lockedBy: '--no-mac-sessions' });
  });

  it('lists on Linux, never on other platforms or in HQ mode', () => {
    expect(macSessionsSettings({}, { ...mac, platform: 'linux' })).toMatchObject({
      enabled: true,
      supported: true,
    });
    expect(macSessionsSettings({}, { ...mac, platform: 'win32' })).toMatchObject({
      on: true,
      supported: false,
      enabled: false,
      reason: 'unsupported',
    });
    expect(macSessionsSettings({}, { ...withEnv('1'), hqMode: true })).toMatchObject({
      supported: false,
      enabled: false,
      reason: 'hq',
    });
  });

  it('opens ready to type unless watch was chosen', () => {
    const odd = { macSessionsOpenMode: 'bogus' } as unknown as MacSessionsConfig;
    expect(macSessionsSettings(odd, mac).openMode).toBe('control');
    expect(macSessionsSettings({ macSessionsOpenMode: 'control' }, mac).openMode).toBe('control');
  });

  it('hides the folders from config.json plus UNTETHER_MAC_SESSIONS_HIDE_IN, ~ expanded', () => {
    const env = { UNTETHER_MAC_SESSIONS_HIDE_IN: ' ~/qa , /private/tmp/ut-qa-mac,,relative' };
    expect(
      macSessionsSettings({ macSessionsHideIn: ['~', '/private/tmp/ut-qa-mac'] }, { ...mac, env })
        .hideIn
    ).toEqual([os.homedir(), '/private/tmp/ut-qa-mac', path.join(os.homedir(), 'qa')]);
    expect(macSessionsSettings({ macSessionsHideIn: [] }, mac).hideIn).toBeUndefined();
  });
});
