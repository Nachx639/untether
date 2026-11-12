// @vitest-environment happy-dom
/**
 * The phone's Mac Sessions calls answered by the server's own router. The client's tests and
 * the router's tests each spell out the other side's paths, bodies and error codes by hand, so
 * a change on one side passes both; here it fails.
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createMacSessionsRoutes } from '../server/routes/mac-sessions.js';
import { type ClaudeChat, parseProcessTable } from '../server/services/claude-chat.js';
import { type MacAttach, MacSessionsError } from '../server/services/mac-sessions/attach.js';
import type { MacSessionsScanner } from '../server/services/mac-sessions/scanner.js';
import type { MacSessionsSettings } from '../server/services/mac-sessions/settings.js';
import type { readSessionChat } from '../server/services/session-chat.js';
import type { MacSessionsResponse } from '../shared/mac-sessions.js';
import type { ClaudeChatView } from './components/claude-chat-view.js';
import { closeMacSessionView, openMacSessionView } from './components/mac-session-view.js';
import { changeAttachMode } from './utils/mac-attach-mode.js';
import { fetchMacSessions, MacSessionsApiError, openMacSession } from './utils/mac-sessions.js';

vi.mock('../server/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

/** The agent's process as the shared ps lists it; ids and targets carry its start from there. */
const TABLE = parseProcessTable('530 1 530 0 16/1 S 501 Fri Oct  2 09:00:00 2026 claude');
const LSTART = TABLE.starts.get(530) ?? '';
const START = Date.UTC(2026, 9, 2, 9, 0, 0) / 1000;
const TMUX_ID = `t-600-${START}-0`;
const AGENT_ID = `a-530-${START}`;

const LIST: MacSessionsResponse = {
  enabled: true,
  platform: 'darwin',
  scannedAt: '2026-10-03T19:40:12.345Z',
  openMode: 'watch',
  tmux: { available: true, version: '3.7c', canOpen: true },
  items: [
    {
      kind: 'agent',
      id: AGENT_ID,
      chatId: AGENT_ID,
      agent: 'claude',
      app: 'Terminal',
      cwd: '/srv/docs',
    },
  ],
  warnings: [{ code: 'tmux-unreachable' }],
};

const CHAT: ClaudeChat = {
  available: true,
  status: 'idle',
  messages: [{ id: 'm1', role: 'assistant', text: 'Docs pass done.' }],
};

describe('the phone and the Mac sessions API', () => {
  let settings: MacSessionsSettings;
  let scan: Mock<MacSessionsScanner['scan']>;
  let open: Mock<MacAttach['open']>;
  let setMode: Mock<MacAttach['setMode']>;
  let readChat: Mock<typeof readSessionChat>;

  beforeEach(() => {
    settings = {
      on: true,
      supported: true,
      enabled: true,
      openMode: 'watch',
      includeHeadless: false,
    };
    scan = vi.fn(async () => LIST);
    // A session already attached answers in its own mode.
    open = vi.fn(async () => ({ sessionId: 'ut-1', reused: true, mode: 'watch' as const }));
    setMode = vi.fn(async () => ({ mode: 'watch' as const, sizing: 'here' as const }));
    readChat = vi.fn(async () => CHAT);

    // Mounted as the server mounts it: JSON bodies, under /api.
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createMacSessionsRoutes({
        settings: () => settings,
        scanner: {
          scan,
          resolve: async (id) =>
            id === AGENT_ID
              ? { kind: 'agent', pid: 530, lstart: LSTART, agent: 'claude', cwd: '/srv/docs' }
              : undefined,
        },
        attach: { open, setMode },
        table: async () => TABLE,
        readChat,
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const call = init.method === 'POST' ? request(app).post(url) : request(app).get(url);
        call.set((init.headers ?? {}) as Record<string, string>);
        const answer = await (init.body === undefined ? call : call.send(String(init.body)));
        return new Response(answer.text, {
          status: answer.status,
          headers: { 'Content-Type': String(answer.headers['content-type'] ?? 'text/plain') },
        });
      })
    );
  });

  afterEach(() => {
    closeMacSessionView();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('loads the list, past the server cache when forced', async () => {
    expect(await fetchMacSessions({}, { force: true })).toEqual(LIST);
    await fetchMacSessions({});
    expect(scan.mock.calls).toEqual([[{ force: true }], [{ force: false }]]);
  });

  it('opens a tmux session as asked, else as the setting says, and reads the answer', async () => {
    expect(await openMacSession(TMUX_ID, { mode: 'control', cols: 90, rows: 40 }, {})).toEqual({
      sessionId: 'ut-1',
      reused: true,
      mode: 'watch',
    });
    expect(open).toHaveBeenCalledWith(TMUX_ID, { mode: 'control', cols: 90, rows: 40 });
    await openMacSession(TMUX_ID, {}, {});
    expect(open).toHaveBeenLastCalledWith(TMUX_ID, { mode: 'watch' });
  });

  it.each([
    ['gone', 404],
    ['tmux-too-old', 409],
    ['not-openable', 422],
    ['open-failed', 500],
  ] as const)('an open the server refuses as %s fails with that code', async (code, status) => {
    open.mockRejectedValueOnce(new MacSessionsError(code, 'why'));
    const failure = await openMacSession(TMUX_ID, {}, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MacSessionsApiError);
    expect(failure).toMatchObject({ code, status, details: 'why' });
  });

  it('an open of an id the server never made, or with the section off, fails with its code', async () => {
    expect(await openMacSession('nope', {}, {}).catch((error: unknown) => error)).toMatchObject({
      code: 'bad-id',
      status: 400,
    });
    settings = { ...settings, enabled: false, reason: 'disabled' };
    expect(await openMacSession(TMUX_ID, {}, {}).catch((error: unknown) => error)).toMatchObject({
      code: 'disabled',
      status: 503,
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('switches how an opened session behaves, and says when it lost its tmux client', async () => {
    expect(await changeAttachMode('ut-1', { sizing: 'here' }, {})).toEqual({
      mode: 'watch',
      sizing: 'here',
    });
    expect(setMode).toHaveBeenCalledWith('ut-1', { sizing: 'here' });

    setMode.mockRejectedValueOnce(new MacSessionsError('client-not-found'));
    await expect(changeAttachMode('ut-1', { mode: 'control' }, {})).rejects.toThrow(
      'This session is no longer attached to tmux. Open it again from the list.'
    );
    expect(setMode).toHaveBeenLastCalledWith('ut-1', { mode: 'control' });
  });

  it("the read-only sheet follows an agent's conversation from the server", async () => {
    openMacSessionView({ chatId: AGENT_ID, kind: 'agent', agent: 'claude', app: 'Terminal' });
    const chat = () => document.querySelector<ClaudeChatView>('mac-session-view claude-chat-view');
    await vi.waitFor(() => expect(chat()?.shadowRoot?.textContent).toContain('Docs pass done.'));
    expect(readChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: `mac:${AGENT_ID}`, pid: 530 }),
      530
    );
  });
});
