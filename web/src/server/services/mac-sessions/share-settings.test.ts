import { describe, expect, it } from 'vitest';
import { type MacShareStartOptions, macShareSettings } from './share-settings.js';

// Never the real environment: a developer's UNTETHER_MAC_SHARE must not change the answers.
const mac: MacShareStartOptions = { env: {}, platform: 'darwin' };
const withEnv = (value: string): MacShareStartOptions => ({
  ...mac,
  env: { UNTETHER_MAC_SHARE: value },
});

describe('Share with phone settings', () => {
  it('is off by default, types ut, and answers the same-folder trust dialog', () => {
    expect(macShareSettings({}, mac)).toEqual({
      on: false,
      supported: true,
      enabled: false,
      reason: 'disabled',
      launcher: 'ut',
      autoTrust: true,
      startTimeoutSec: 30,
    });
  });

  it('follows config.json when nothing forces the switch', () => {
    expect(
      macShareSettings(
        {
          macShare: true,
          macShareLauncher: 'shell',
          macShareUtPath: '/opt/ut/bin/ut',
          macShareAutoTrust: false,
          macShareStartTimeoutSec: 45,
        },
        mac
      )
    ).toEqual({
      on: true,
      supported: true,
      enabled: true,
      launcher: 'shell',
      utPath: '/opt/ut/bin/ut',
      autoTrust: false,
      startTimeoutSec: 45,
    });
  });

  it('UNTETHER_MAC_SHARE forces the switch either way and says so', () => {
    expect(macShareSettings({}, withEnv('1'))).toMatchObject({
      on: true,
      enabled: true,
      lockedBy: 'UNTETHER_MAC_SHARE=1',
    });
    expect(macShareSettings({ macShare: true }, withEnv(' off '))).toMatchObject({
      on: false,
      enabled: false,
      reason: 'disabled',
      lockedBy: 'UNTETHER_MAC_SHARE=0',
    });
    for (const value of ['', 'maybe', '2']) {
      expect(macShareSettings({ macShare: true }, withEnv(value)).lockedBy, value).toBeUndefined();
    }
  });

  it('--no-mac-share beats the env and config.json', () => {
    expect(
      macShareSettings({ macShare: true }, { ...withEnv('1'), shareCliDisabled: true })
    ).toMatchObject({ on: false, enabled: false, lockedBy: '--no-mac-share' });
  });

  it('only works on macOS, never in HQ mode', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(macShareSettings({ macShare: true }, { ...mac, platform })).toMatchObject({
        on: true,
        supported: false,
        enabled: false,
        reason: 'unsupported',
      });
    }
    expect(macShareSettings({ macShare: true }, { ...mac, hqMode: true })).toMatchObject({
      supported: false,
      enabled: false,
      reason: 'hq',
    });
  });

  it('needs "On this Mac" listing and a login, even when on', () => {
    expect(macShareSettings({ macShare: true, macSessions: false }, mac)).toMatchObject({
      on: true,
      supported: true,
      enabled: false,
      reason: 'mac-sessions-off',
    });
    expect(
      macShareSettings({ macShare: true }, { ...mac, env: { UNTETHER_MAC_SESSIONS: '0' } })
    ).toMatchObject({ enabled: false, reason: 'mac-sessions-off' });
    expect(macShareSettings({ macShare: true }, { ...mac, noAuth: true })).toMatchObject({
      on: true,
      enabled: false,
      reason: 'no-auth',
    });
  });

  it('ignores a relative ut path and keeps the start timeout within bounds', () => {
    const settings = macShareSettings(
      // Values a hand edit could leave if the schema were bypassed.
      { macShareUtPath: 'bin/ut', macShareStartTimeoutSec: 1 },
      mac
    );
    expect(settings).not.toHaveProperty('utPath');
    expect(settings.startTimeoutSec).toBe(5);
    expect(macShareSettings({ macShareStartTimeoutSec: 10_000 }, mac).startTimeoutSec).toBe(300);
    expect(macShareSettings({ macShareStartTimeoutSec: 2.5 }, mac).startTimeoutSec).toBe(30);
  });
});
