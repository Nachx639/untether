// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';

const terminateSession = vi.fn();
const clearSession = vi.fn();
vi.mock('../../services/session-action-service.js', () => ({
  sessionActionService: {
    terminateSession: (...args: unknown[]) => terminateSession(...args),
    clearSession: (...args: unknown[]) => clearSession(...args),
  },
}));

const confirmDialog = vi.fn(async (_options: unknown) => true);
vi.mock('../../utils/confirm-dialog.js', () => ({
  confirmDialog: (options: unknown) => confirmDialog(options),
}));

import { rememberMacSessionsPlatform } from '../../utils/mac-sessions.js';
import { type SessionActionsCallbacks, SessionActionsHandler } from './session-actions-handler.js';

describe('SessionActionsHandler', () => {
  const session = {
    id: 's1',
    name: 'tmux: work',
    command: ['tmux'],
    status: 'running',
  } as unknown as Session;

  const handlerWith = (
    dispatchEvent: SessionActionsCallbacks['dispatchEvent'],
    current = session
  ) => {
    const handler = new SessionActionsHandler();
    handler.setCallbacks({
      getSession: () => current,
      setSession: () => {},
      getViewMode: () => 'terminal',
      setViewMode: () => {},
      dispatchEvent,
      requestUpdate: () => {},
      handleBack: () => {},
      ensureTerminalInitialized: () => {},
    });
    return handler;
  };

  it('returns a rename failure, toasting it only when the caller does not show it itself', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const events: Event[] = [];
      const handler = handlerWith((event) => events.push(event) > 0);
      expect(await handler.handleSetUserTitle('s1', 'Mi tarea')).toEqual({
        success: false,
        error: 'server error (500)',
      });
      expect(events.map((event) => event.type)).toEqual(['error']);

      events.length = 0;
      expect(
        (await handler.handleSetUserTitle('s1', 'Mi tarea', { showError: false })).success
      ).toBe(false);
      expect(events).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('tells the app when a session it ended here is gone, and not when that failed', async () => {
    const events: Event[] = [];
    const handler = handlerWith((event) => events.push(event) > 0);

    // A disconnected tmux session leaves the list at once: the app must know it ended here.
    terminateSession.mockImplementationOnce(async (_session, options) => {
      options.callbacks.onSuccess();
      return { success: true };
    });
    await handler.handleTerminateSession();
    const killed = events.find((event) => event.type === 'session-killed') as CustomEvent;
    expect(killed?.detail).toEqual({ sessionId: 's1', session });
    expect(killed.bubbles && killed.composed).toBe(true);

    events.length = 0;
    terminateSession.mockImplementationOnce(async (_session, options) => {
      options.callbacks.onError('nope');
      return { success: false, error: 'nope' };
    });
    await handler.handleTerminateSession();
    expect(events.map((event) => event.type)).toEqual(['error']);
  });

  it('asks before ending a session opened with ut: it ends in its Mac window too', async () => {
    rememberMacSessionsPlatform('darwin');
    const inWindow = {
      id: 'fwd_1759500000_20085',
      name: 'claude (~/Projects)',
      command: ['claude'],
      status: 'running',
    } as unknown as Session;
    confirmDialog.mockClear();
    confirmDialog.mockResolvedValueOnce(false);
    terminateSession.mockClear();
    await handlerWith(() => true, inWindow).handleTerminateSession();
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith({
      title: 'Terminate session?',
      body: 'Kill “claude (~/Projects)”? It also closes in the Mac window.',
      confirmLabel: 'Terminate Session',
      tone: 'danger',
    });
    expect(terminateSession).not.toHaveBeenCalled();

    confirmDialog.mockResolvedValueOnce(true);
    await handlerWith(() => true, inWindow).handleTerminateSession();
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });

  it('always confirms in the app dialog (never window.confirm), except a tmux disconnect', async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    try {
      const plain = {
        id: 'p1',
        name: 'zsh',
        command: ['zsh'],
        status: 'running',
      } as unknown as Session;
      confirmDialog.mockClear();
      terminateSession.mockClear();
      confirmDialog.mockResolvedValueOnce(true);
      await handlerWith(() => true, plain).handleTerminateSession();
      expect(confirmDialog).toHaveBeenCalledTimes(1);
      expect((confirmDialog.mock.calls[0][0] as { body: string }).body).toBe(
        'The process will be stopped.'
      );
      expect(terminateSession).toHaveBeenCalledTimes(1);
      expect(nativeConfirm).not.toHaveBeenCalled();

      // Disconnecting Untether's tmux client ends nothing: no question.
      confirmDialog.mockClear();
      await handlerWith(() => true).handleTerminateSession();
      expect(confirmDialog).not.toHaveBeenCalled();
      expect(terminateSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('tells the app a session cleared from ⋯ is gone, then goes back', async () => {
    const events: Event[] = [];
    const exited = { ...session, status: 'exited' } as Session;
    const handler = handlerWith((event) => events.push(event) > 0, exited);
    clearSession.mockImplementationOnce(async (_session, options) => {
      options.callbacks.onSuccess();
      return { success: true };
    });
    await handler.handleClearSession();
    const killed = events.find((event) => event.type === 'session-killed') as CustomEvent;
    expect(killed?.detail).toEqual({ sessionId: 's1', session: exited });
    expect(killed.bubbles && killed.composed).toBe(true);
  });

  it('Reopen runs once while a first tap is on its way', async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const events: Event[] = [];
      const exited = { ...session, status: 'exited', workingDir: '/tmp' } as Session;
      const handler = handlerWith((event) => events.push(event) > 0, exited);
      const first = handler.handleRestartSession();
      await handler.handleRestartSession();
      answer(new Response(JSON.stringify({ sessionId: 'new' }), { status: 200 }));
      await first;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.type)).toEqual(['session-created']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
