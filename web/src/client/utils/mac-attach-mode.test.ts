/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_SESSIONS_CHANGED_EVENT } from '../../shared/mac-sessions.js';
import type { SessionMultiplexer } from '../../shared/types.js';
import { attachedTmux, changeAttachMode, isWatching } from './mac-attach-mode.js';

const tmux = (mode: 'control' | 'watch'): SessionMultiplexer => ({
  type: 'tmux',
  socketPath: '/tmp/tmux-501/default',
  serverPid: 15674,
  serverStartedAt: 1727426400,
  sessionId: '$0',
  sessionName: '0',
  mode,
  sizing: 'others',
  source: 'mac-sessions',
});

describe('opened tmux sessions', () => {
  it('tells a session attached to a tmux session, and whether it only watches', () => {
    expect(attachedTmux({ multiplexer: tmux('control') })?.sessionId).toBe('$0');
    expect(attachedTmux({})).toBeNull();
    expect(attachedTmux(null)).toBeNull();
    expect(isWatching({ multiplexer: tmux('watch') })).toBe(true);
    expect(isWatching({ multiplexer: tmux('control') })).toBe(false);
    expect(isWatching({})).toBe(false);
  });
});

describe('changeAttachMode', () => {
  const changed = vi.fn();

  beforeEach(() => {
    changed.mockClear();
    window.addEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
  });

  afterEach(() => {
    window.removeEventListener(MAC_SESSIONS_CHANGED_EVENT, changed);
    vi.unstubAllGlobals();
  });

  it('asks the server for the change and answers what tmux reports', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ mode: 'control', sizing: 'here' })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      changeAttachMode('fwd 1', { sizing: 'here' }, { Authorization: 'Bearer t' })
    ).resolves.toEqual({ mode: 'control', sizing: 'here' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/mac-sessions/attached/fwd%201/mode');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ sizing: 'here' });
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer t',
    });
    // The list's "Watching" badge follows.
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('rejects with what to tell the user, and leaves the list alone', async () => {
    const answer = vi.fn(async () => Response.json({ error: 'client-not-found' }, { status: 409 }));
    vi.stubGlobal('fetch', answer);
    await expect(changeAttachMode('s', { mode: 'control' }, {})).rejects.toThrow(
      'This session is no longer attached to tmux. Open it again from the list.'
    );

    answer.mockImplementation(async () =>
      Response.json({ error: 'mode-failed', details: 'tmux exited 1' }, { status: 500 })
    );
    await expect(changeAttachMode('s', { mode: 'watch' }, {})).rejects.toThrow(
      'Couldn’t switch: tmux exited 1'
    );

    // An older server has no such route.
    answer.mockImplementation(async () => new Response('Not found', { status: 404 }));
    await expect(changeAttachMode('s', { mode: 'watch' }, {})).rejects.toThrow(
      'Couldn’t switch: HTTP 404'
    );

    answer.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(changeAttachMode('s', { mode: 'watch' }, {})).rejects.toThrow(
      'Couldn’t switch: Failed to fetch'
    );
    expect(changed).not.toHaveBeenCalled();
  });
});
