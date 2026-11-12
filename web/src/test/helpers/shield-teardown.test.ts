import { describe, expect, it } from 'vitest';
import { shieldLaunchdLabel } from '../../server/services/shielded-tmux.js';
import { stopTestShieldServer } from './shield-teardown.js';

describe('stopTestShieldServer (2026-10-20: launchd jobs left loaded by tests)', () => {
  it("kills the test's tmux server and boots out only its own launchd job", () => {
    const calls: string[][] = [];
    stopTestShieldServer(
      '/usr/bin/tmux',
      '/tmp/ut-sh-abc',
      (file, args) => {
        calls.push([file, ...args]);
      },
      'darwin',
      501
    );
    expect(calls[0][0]).toBe('/usr/bin/tmux');
    expect(calls[0].at(-1)).toBe('kill-server');
    expect(calls[1]).toEqual([
      'launchctl',
      'bootout',
      `gui/501/${shieldLaunchdLabel('/tmp/ut-sh-abc')}`,
    ]);
    expect(calls).toHaveLength(2);
    // The label is this control dir's alone, never a production one.
    expect(shieldLaunchdLabel('/tmp/ut-sh-abc')).not.toBe(
      shieldLaunchdLabel(`${process.env.HOME}/.untether/control`)
    );
  });

  it('keeps going when nothing runs, and skips launchd off macOS', () => {
    const calls: string[] = [];
    const failing = (file: string) => {
      calls.push(file);
      throw new Error('not loaded');
    };
    expect(() => stopTestShieldServer('/t', '/tmp/x', failing, 'darwin', 501)).not.toThrow();
    expect(calls).toEqual(['/t', 'launchctl']);
    calls.length = 0;
    stopTestShieldServer('/t', '/tmp/x', failing, 'linux', 1000);
    expect(calls).toEqual(['/t']);
  });
});
