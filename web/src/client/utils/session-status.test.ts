// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types.js';
import {
  deriveSessionStatus,
  lastActivityAt,
  relativeTime,
  type SessionStatus,
  statusLabel,
} from './session-status.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function session(extra: Partial<Session> = {}): Partial<Session> {
  return {
    status: 'running',
    startedAt: ago(3_600_000),
    lastModified: ago(3_600_000),
    ...extra,
  };
}

describe('deriveSessionStatus', () => {
  it.each<[string, Partial<Session>, SessionStatus]>([
    ['exited with 0', { status: 'exited', exitCode: 0 }, 'exited-ok'],
    ['exited without a code', { status: 'exited' }, 'exited-ok'],
    ['exited with 1', { status: 'exited', exitCode: 1 }, 'exited-error'],
    ['Claude waiting', { claudeStatus: { status: 'waiting' } }, 'needs-input'],
    ['Claude busy', { claudeStatus: { status: 'busy' } }, 'working'],
    [
      'Claude only waiting for background agents',
      { claudeStatus: { status: 'busy', waitingForBackground: true } },
      'idle',
    ],
    [
      'Claude idle while its terminal redraws',
      { claudeStatus: { status: 'idle' }, activityStatus: { isActive: true } },
      'idle',
    ],
    [
      'Codex busy on a turn while its terminal is quiet',
      { agentStatus: { agent: 'codex', status: 'busy' }, activityStatus: { isActive: false } },
      'working',
    ],
    [
      'Codex idle while its terminal redraws',
      {
        agentStatus: { agent: 'codex', status: 'idle' },
        activityStatus: { isActive: true, lastActivityAt: ago(1_000) },
      },
      'idle',
    ],
    ['Codex waiting', { agentStatus: { agent: 'codex', status: 'waiting' } }, 'needs-input'],
    [
      'Codex without a state of its own: its output time, as before',
      { codexActive: true, activityStatus: { isActive: true } },
      'working',
    ],
    ['PTY active', { activityStatus: { isActive: true } }, 'working'],
    [
      'output 2 s ago',
      { activityStatus: { isActive: false, lastActivityAt: ago(2_000) } },
      'working',
    ],
    [
      'output 30 s ago',
      { activityStatus: { isActive: false, lastActivityAt: ago(30_000) } },
      'idle',
    ],
    ['nothing known', {}, 'idle'],
  ])('%s', (_what, extra, expected) => {
    expect(deriveSessionStatus(session(extra), NOW)).toBe(expected);
  });

  it('needs-input wins over an active terminal', () => {
    const s = session({ claudeStatus: { status: 'waiting' }, activityStatus: { isActive: true } });
    expect(deriveSessionStatus(s, NOW)).toBe('needs-input');
  });
});

describe('lastActivityAt', () => {
  it('prefers the activity time, then lastModified, then startedAt', () => {
    expect(
      lastActivityAt(session({ activityStatus: { isActive: false, lastActivityAt: ago(5_000) } }))
    ).toBe(NOW - 5_000);
    expect(lastActivityAt({ lastModified: ago(9_000), startedAt: ago(20_000) })).toBe(NOW - 9_000);
    expect(lastActivityAt({ startedAt: ago(20_000) })).toBe(NOW - 20_000);
    expect(lastActivityAt({})).toBeUndefined();
  });

  // The same clock as the phone rows (last-activity.ts): a redraw of the terminal is not
  // activity of a Claude that ended its turn hours ago.
  it('dates a Claude at rest by its last turn, not by the terminal redrawing', () => {
    const resting = session({
      claudeStatus: { status: 'idle', since: NOW - 14 * 3_600_000 },
      activityStatus: { isActive: false, lastActivityAt: ago(4 * 60_000) },
    });
    expect(lastActivityAt(resting)).toBe(NOW - 14 * 3_600_000);
    expect(statusLabel('idle', resting, NOW)).toBe('Idle · 14h ago');
    const busy = session({
      claudeStatus: { status: 'busy', since: NOW - 14 * 3_600_000 },
      activityStatus: { isActive: true, lastActivityAt: ago(2_000) },
    });
    expect(lastActivityAt(busy)).toBe(NOW - 2_000);
  });
});

describe('relativeTime and statusLabel (English)', () => {
  it('uses the time.*Ago keys', () => {
    expect(relativeTime(4_000)).toBe('4s ago');
    expect(relativeTime(3 * 60_000)).toBe('3m ago');
    expect(relativeTime(2 * 3_600_000)).toBe('2h ago');
    expect(relativeTime(4 * 86_400_000)).toBe('4d ago');
    expect(relativeTime(-50)).toBe('0s ago');
  });

  it('labels every status', () => {
    expect(statusLabel('working')).toBe('Working');
    expect(statusLabel('idle', session({ lastModified: ago(3 * 60_000) }), NOW)).toBe(
      'Idle · 3m ago'
    );
    expect(statusLabel('idle')).toBe('Idle');
    expect(statusLabel('needs-input')).toBe('Needs you');
    expect(
      statusLabel('needs-input', session({ claudeStatus: { status: 'waiting', waitingFor: 'x' } }))
    ).toBe('Needs you · x');
    expect(statusLabel('exited-ok')).toBe('Finished');
    expect(statusLabel('exited-error', { status: 'exited', exitCode: 137 })).toBe(
      'Exited · code 137'
    );
  });
});
