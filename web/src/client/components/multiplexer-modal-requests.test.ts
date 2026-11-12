// @vitest-environment happy-dom
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MultiplexerStatus, MultiplexerType } from '../../shared/multiplexer-types.js';
import { apiClient } from '../services/api-client.js';
import type { MultiplexerModal } from './multiplexer-modal.js';
import './multiplexer-modal.js';

vi.mock('../utils/confirm-dialog.js', () => ({ confirmDialog: vi.fn(async () => true) }));

const status = (names: string[]): MultiplexerStatus => ({
  tmux: {
    available: true,
    type: 'tmux',
    sessions: names.map((name) => ({ name, type: 'tmux' as const, windows: 1 })),
  },
  zellij: { available: false, type: 'zellij', sessions: [] },
  screen: { available: false, type: 'screen', sessions: [] },
});

type Internals = {
  killSession(type: MultiplexerType, name: string): Promise<void>;
  killWindow(session: string, index: number): Promise<void>;
  killPane(session: string, paneId: string): Promise<void>;
  attachToSession(target: { type: MultiplexerType; session: string }): Promise<void>;
};

const mockGet = (names: string[]) =>
  vi
    .spyOn(apiClient, 'get')
    .mockImplementation((async (path: string) =>
      path === '/multiplexer/status' ? status(names) : { windows: [] }) as typeof apiClient.get);

describe('multiplexer-modal requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fixtureCleanup();
  });

  // 2026-11-10: mounted already open, it loaded in connectedCallback and again in updated().
  it('loads the status once when it is mounted open', async () => {
    const get = mockGet(['main']);
    await fixture<MultiplexerModal>(html`<multiplexer-modal open></multiplexer-modal>`);
    await vi.waitFor(() =>
      expect(get.mock.calls.filter(([path]) => path === '/multiplexer/status')).toHaveLength(1)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get.mock.calls.filter(([path]) => path === '/multiplexer/status')).toHaveLength(1);
  });

  // 2026-11-10: with a name like "api#v2" the DELETE reached .../sessions/api and killed
  // ANOTHER session called "api".
  it('encodes every name in the request paths', async () => {
    mockGet(['api#v2']);
    const del = vi.spyOn(apiClient, 'delete').mockResolvedValue({ success: false });
    const modal = await fixture<MultiplexerModal>(
      html`<multiplexer-modal open></multiplexer-modal>`
    );
    await vi.waitFor(() =>
      expect(modal.querySelector('[data-testid="multiplexer-session-row"]')).not.toBeNull()
    );
    const internals = modal as unknown as Internals;
    await internals.killSession('tmux', 'api#v2');
    await internals.killWindow('api#v2', 2);
    await internals.killPane('a/b?c', '%1');
    expect(del.mock.calls.map(([path]) => path)).toEqual([
      '/multiplexer/tmux/sessions/api%23v2',
      '/multiplexer/tmux/sessions/api%23v2/windows/2',
      '/multiplexer/tmux/sessions/a%2Fb%3Fc/panes/%251',
    ]);
  });

  it('asks the windows and panes of a session by its encoded name', async () => {
    const get = mockGet(['api#v2']);
    await fixture<MultiplexerModal>(html`<multiplexer-modal open></multiplexer-modal>`);
    await vi.waitFor(() =>
      expect(get).toHaveBeenCalledWith('/multiplexer/tmux/sessions/api%23v2/windows')
    );
  });

  // 2026-11-10: a failed attach painted only the error; the list vanished until reopening.
  it('keeps the list on screen when an attach fails, and clears the error on the next try', async () => {
    mockGet(['main']);
    const post = vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('boom'));
    const modal = await fixture<MultiplexerModal>(
      html`<multiplexer-modal open></multiplexer-modal>`
    );
    await vi.waitFor(() =>
      expect(modal.querySelector('[data-testid="multiplexer-session-row"]')).not.toBeNull()
    );
    const internals = modal as unknown as Internals;
    await internals.attachToSession({ type: 'tmux', session: 'main' });
    await modal.updateComplete;
    expect(modal.querySelector('[data-testid="multiplexer-error"]')).not.toBeNull();
    expect(modal.querySelector('[data-testid="multiplexer-session-row"]')).not.toBeNull();

    post.mockResolvedValue({ success: false });
    await internals.attachToSession({ type: 'tmux', session: 'main' });
    await modal.updateComplete;
    expect(modal.querySelector('[data-testid="multiplexer-error"]')).toBeNull();
  });
});
