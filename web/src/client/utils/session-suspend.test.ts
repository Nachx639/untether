// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionSuspension } from '../../shared/types.js';
import { deriveSessionStatus, statusLabel } from './session-status.js';
import {
  blockerLines,
  canKeepAwake,
  canSuspend,
  isFinishedSession,
  isSuspended,
  splitSuspended,
  suspendedGroups,
  suspendSession,
  wakeSession,
} from './session-suspend.js';

const record: SessionSuspension = {
  at: '2026-10-31T10:00:00Z',
  claudeSessionId: 'conv-1',
  command: ['claude'],
  workingDir: '/tmp',
  shielded: true,
  idleMinutes: 130,
};
const suspended = { status: 'exited' as const, suspended: record };

describe('suspended sessions on the client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a suspended session is paused, not finished: it stays among the live ones', () => {
    expect(isSuspended(suspended)).toBe(true);
    expect(isFinishedSession(suspended)).toBe(false);
    expect(isFinishedSession({ status: 'exited' })).toBe(true);
    expect(isFinishedSession({ status: 'running' })).toBe(false);
  });

  it('shows as paused (or why it could not wake) wherever the status is shown', () => {
    const paused = deriveSessionStatus(suspended as Partial<Session>);
    expect(paused).toBe('paused');
    expect(statusLabel(paused, suspended as Partial<Session>)).not.toBe('');
    const failed = { ...suspended, suspended: { ...record, resumeError: 'boom' } };
    expect(statusLabel('paused', failed as Partial<Session>)).not.toBe(
      statusLabel('paused', suspended as Partial<Session>)
    );
  });

  it('"keep awake" is offered for shielded Claude sessions that are not finished', () => {
    expect(canKeepAwake({ shielded: true, command: ['claude'], status: 'running' })).toBe(true);
    expect(canKeepAwake({ shielded: true, command: ['claude'], ...suspended })).toBe(true);
    expect(canKeepAwake({ shielded: false, command: ['claude'], status: 'running' })).toBe(false);
    expect(canKeepAwake({ shielded: true, command: ['zsh'], status: 'running' })).toBe(false);
    expect(canKeepAwake({ shielded: true, command: ['claude'], status: 'exited' })).toBe(false);
  });

  it('two taps share one wake, and a failure carries the server reason', async () => {
    let resolve: (value: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = wakeSession('s1');
    const second = wakeSession('s1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toBeDefined();
    resolve(new Response(JSON.stringify({ sessionId: 's1', woke: true }), { status: 200 }));
    expect(await first).toEqual({ sessionId: 's1' });
    expect(await second).toEqual({ sessionId: 's1' });

    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'its folder is gone' }), { status: 503 })
    );
    await expect(wakeSession('s1')).rejects.toThrow('its folder is gone');
  });
});

// 2026-10-31: the "Suspended" section and "Suspend" by hand.
describe('the Suspended section and Suspend by hand', () => {
  afterEach(() => vi.unstubAllGlobals());
  const at = (minutesAgo: number) => ({
    ...record,
    at: new Date(Date.parse('2026-10-31T12:00:00Z') - minutesAgo * 60_000).toISOString(),
  });

  it('splits the lists: live ones (running, starting) and suspended ones, finished in neither', () => {
    const sessions = [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'starting' },
      { id: 'c', status: 'exited', suspended: record },
      { id: 'd', status: 'exited' },
    ];
    const { live, suspended: paused } = splitSuspended(sessions);
    expect(live.map((s) => s.id)).toEqual(['a', 'b']);
    expect(paused.map((s) => s.id)).toEqual(['c']);
  });

  it('groups them by project, latest pause first, no project last', () => {
    const groups = new Map<string | null, Array<{ id: string; suspended: SessionSuspension }>>([
      [null, [{ id: 'n', suspended: at(1) }]],
      ['/p/old', [{ id: 'o', suspended: at(300) }]],
      [
        '/p/new',
        [
          { id: 'n1', suspended: at(60) },
          { id: 'n2', suspended: at(5) },
        ],
      ],
    ]);
    const ordered = suspendedGroups(groups);
    expect(ordered.map((g) => g.key)).toEqual(['/p/new', '/p/old', null]);
    expect(ordered[0].sessions.map((s) => s.id)).toEqual(['n2', 'n1']);
  });

  it('since when it is paused, in the status label', () => {
    const label = statusLabel(
      'paused',
      { status: 'exited', suspended: at(120) } as Partial<Session>,
      Date.parse('2026-10-31T12:00:00Z')
    );
    expect(label).toBe('Paused 2h ago');
  });

  it('"Suspend" only for a running shielded Claude session', () => {
    expect(canSuspend({ shielded: true, command: ['claude'], status: 'running' })).toBe(true);
    expect(canSuspend({ shielded: true, command: ['claude'], ...suspended })).toBe(false);
    expect(canSuspend({ shielded: false, command: ['claude'], status: 'running' })).toBe(false);
    expect(canSuspend({ shielded: true, command: ['zsh'], status: 'running' })).toBe(false);
  });

  it('posts to /suspend; a 409 brings each reason, told once per kind in the user language', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: 'The session cannot be suspended now',
          blockers: [
            { kind: 'draft', reason: 'text in its input box (or no input box seen)' },
            { kind: 'background', reason: 'vite runs under Claude (pid 9)' },
            { kind: 'background', reason: 'openclaw agent runs (pid 10)' },
            { kind: 'strange', reason: 'x' },
          ],
        },
        { status: 409 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await suspendSession('s 1', { Authorization: 'Bearer t' });
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/sessions/s%201/suspend',
      expect.objectContaining({ method: 'POST' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok || !('blockers' in result)) throw new Error('expected blockers');
    expect(result.blockers.map((b) => b.kind)).toEqual([
      'draft',
      'background',
      'background',
      'unknown',
    ]);
    expect(blockerLines(result.blockers)).toEqual([
      'there is text in its input box (send or clear it first)',
      'something runs in the background',
      "Untether couldn't check that it is safe",
    ]);

    fetchMock.mockImplementationOnce(async () =>
      Response.json({ sessionId: 's1', suspended: true })
    );
    expect(await suspendSession('s1')).toEqual({ ok: true });
    fetchMock.mockImplementationOnce(async () => Response.json({ error: 'nope' }, { status: 501 }));
    expect(await suspendSession('s1')).toEqual({ ok: false, error: 'nope' });
  });
});
