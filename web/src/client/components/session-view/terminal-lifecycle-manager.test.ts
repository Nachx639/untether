/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import type { Terminal } from '../terminal.js';
import { pendingSizeGiveBacks, resetSizeGiveBackForTests } from './size-give-back.js';
import {
  ENTRY_SETTLE_MS,
  KEYBOARD_RESIZE_DEBOUNCE_MS,
  setPageUsedForTests,
  TerminalLifecycleManager,
  takesBackPtySize,
} from './terminal-lifecycle-manager.js';

const resizeEvent = (cols: number, rows: number, isHeightOnlyChange: boolean) =>
  new CustomEvent('terminal-resize', {
    detail: { cols, rows, isMobile: true, isHeightOnlyChange, source: 'test' },
  });

describe('TerminalLifecycleManager resize forwarding on mobile', () => {
  let manager: TerminalLifecycleManager;
  let resize: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
    manager = new TerminalLifecycleManager();
    manager.setSession({ id: 's1', status: 'running' } as Session);
  });

  afterEach(() => {
    resize.mockRestore();
    vi.useRealTimers();
  });

  it('forwards keyboard-driven height changes so the PTY matches the visible rows', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    await manager.handleTerminalResize(resizeEvent(48, 16, true));
    await vi.runAllTimersAsync();

    expect(resize.mock.calls).toEqual([
      ['s1', 48, 46, false],
      ['s1', 48, 16, false],
    ]);
  });

  it('forces a repaint when the terminal shrinks and returns to the size the PTY already has', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    resize.mockClear();

    // Keyboard shown and hidden within one debounce window.
    await manager.handleTerminalResize(resizeEvent(48, 16, true));
    await manager.handleTerminalResize(resizeEvent(48, 46, true));
    await vi.runAllTimersAsync();

    expect(resize.mock.calls).toEqual([
      ['s1', 48, 45, false],
      ['s1', 48, 46, false],
    ]);
  });

  it('sends a keyboard resize once, 150 ms after the last of its changes', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 16, false));
    await vi.runAllTimersAsync();
    resize.mockClear();

    // The keyboard going down in steps: each new size restarts the wait.
    await manager.handleTerminalResize(resizeEvent(48, 30, true));
    await vi.advanceTimersByTimeAsync(KEYBOARD_RESIZE_DEBOUNCE_MS - 10);
    await manager.handleTerminalResize(resizeEvent(48, 46, true));
    await vi.advanceTimersByTimeAsync(KEYBOARD_RESIZE_DEBOUNCE_MS - 1);
    expect(resize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(KEYBOARD_RESIZE_DEBOUNCE_MS).toBe(150);
    expect(resize.mock.calls).toEqual([['s1', 48, 46, false]]);
  });

  it('waits for the visual viewport to stop moving before the app redraws', async () => {
    const viewport = new EventTarget();
    vi.stubGlobal('visualViewport', viewport);
    try {
      await manager.handleTerminalResize(resizeEvent(48, 16, false));
      await vi.runAllTimersAsync();
      resize.mockClear();

      // The rows changed with the keyboard's first viewport resize; it is still animating.
      await manager.handleTerminalResize(resizeEvent(48, 46, true));
      await vi.advanceTimersByTimeAsync(100);
      viewport.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(100);
      viewport.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(KEYBOARD_RESIZE_DEBOUNCE_MS - 1);
      expect(resize).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resize.mock.calls).toEqual([['s1', 48, 46, false]]);

      // Once sent, a later viewport change sends nothing more.
      viewport.dispatchEvent(new Event('resize'));
      await vi.runAllTimersAsync();
      expect(resize).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The phone's grid follows another client's PTY (terminal.ts followPtySize) and reports its
  // own size when its screen changes: it goes out (not as a claim) even though it is the one
  // this page last sent, and the server applies it only if this page owns the size.
  it('sends its last size again once another client has the PTY at another one', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    resize.mockClear();
    manager.handlePtySize({ cols: 120, rows: 52 });

    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();

    expect(resize.mock.calls).toEqual([['s1', 48, 46, false]]);
  });

  it('does not resend an unchanged size', async () => {
    await manager.handleTerminalResize(resizeEvent(48, 46, false));
    await vi.runAllTimersAsync();
    resize.mockClear();

    await manager.handleTerminalResize(resizeEvent(48, 46, true));
    await vi.runAllTimersAsync();

    expect(resize).not.toHaveBeenCalled();
  });
});

describe('TerminalLifecycleManager claiming the size (user report 2026-10-14)', () => {
  let manager: TerminalLifecycleManager;
  let resize: ReturnType<typeof vi.spyOn>;
  const own = { cols: 45, rows: 33 };

  beforeEach(async () => {
    vi.useFakeTimers();
    resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
    manager = new TerminalLifecycleManager();
    manager.setSession({ id: 's1', status: 'running' } as Session);
    manager.setTerminal({ getOwnSize: () => own } as unknown as Terminal);
    await manager.handleTerminalResize(resizeEvent(45, 33, false));
    await vi.runAllTimersAsync();
    manager.handlePtySize({ cols: 45, rows: 33 });
    resize.mockClear();
  });

  afterEach(() => {
    resize.mockRestore();
    vi.useRealTimers();
  });

  it('sends nothing when another client takes the PTY and this page is only shown', async () => {
    // Another client (or the Mac window) set 53x56 under the phone's 45 columns.
    manager.handlePtySize({ cols: 53, rows: 56 });
    await vi.runAllTimersAsync();
    // Shown again, focused, turned: none of it is use (session-view no longer reports them).
    expect(resize).not.toHaveBeenCalled();
  });

  it('claims once on a tap or a key, then not again while it has the size', async () => {
    manager.handlePtySize({ cols: 53, rows: 56 });
    manager.noteUserActivity();
    manager.noteUserActivity();
    await vi.runAllTimersAsync();
    expect(resize.mock.calls).toEqual([['s1', 45, 33, true]]);

    // Its echo settles it; taps afterwards send nothing.
    manager.handlePtySize({ cols: 45, rows: 33 });
    manager.noteUserActivity();
    await vi.runAllTimersAsync();
    expect(resize).toHaveBeenCalledTimes(1);

    // Another client took it again: the next tap claims again.
    manager.handlePtySize({ cols: 53, rows: 56 });
    manager.noteUserActivity();
    await vi.runAllTimersAsync();
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it('claims even at the size the PTY has, to become its owner', async () => {
    manager.noteUserActivity();
    await vi.runAllTimersAsync();
    expect(resize.mock.calls).toEqual([['s1', 45, 33, true]]);
  });

  it('sends a change of its own screen as a plain resize, the server decides', async () => {
    manager.handlePtySize({ cols: 53, rows: 56 });
    await manager.handleTerminalResize(resizeEvent(45, 20, true));
    await vi.runAllTimersAsync();
    expect(resize.mock.calls).toEqual([['s1', 45, 20, false]]);
  });

  it('back from a lock that gave the size to the Mac window: shows it, claims only on a tap', async () => {
    const state = { visibility: 'hidden' as DocumentVisibilityState };
    const vis = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => state.visibility);
    try {
      // While locked, the server gave the size back to the window (pty-manager sweepSizeOwners).
      manager.handlePtySize({ cols: 120, rows: 67 });
      state.visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('focus'));
      await vi.runAllTimersAsync();
      expect(resize).not.toHaveBeenCalled();
      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      expect(resize.mock.calls).toEqual([['s1', 45, 33, true]]);
    } finally {
      vis.mockRestore();
    }
  });

  it('does not claim while the page is hidden', async () => {
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      manager.handlePtySize({ cols: 53, rows: 56 });
      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      expect(resize).not.toHaveBeenCalled();
    } finally {
      hidden.mockRestore();
    }
  });

  it('claims nothing while its terminal is hidden (chat view)', async () => {
    manager.setTerminal({ getOwnSize: () => null } as unknown as Terminal);
    manager.handlePtySize({ cols: 53, rows: 56 });
    manager.noteUserActivity();
    await vi.runAllTimersAsync();
    expect(resize).not.toHaveBeenCalled();
  });
});

describe('where another terminal owns the PTY size', () => {
  const tmux = (sizing: 'here' | 'others', mode: 'control' | 'watch' = 'control') => ({
    id: 's1',
    multiplexer: {
      type: 'tmux' as const,
      socketPath: '/tmp/tmux-501/default',
      serverPid: 1,
      serverStartedAt: 1,
      sessionId: '$1',
      sessionName: 'main',
      mode,
      sizing,
      source: 'mac-sessions' as const,
    },
  });

  it('leaves the size to tmux unless it fits here; a Mac window gets it back by itself', () => {
    expect(takesBackPtySize({ id: 'ff005102-6d2f-43b2-99e2-925ee7e3c611' })).toBe(true);
    expect(takesBackPtySize({ id: 'fwd_1791029966_4242' })).toBe(true);
    expect(takesBackPtySize(tmux('others'))).toBe(false);
    expect(takesBackPtySize(tmux('here'))).toBe(true);
    expect(takesBackPtySize(tmux('here', 'watch'))).toBe(false);
  });

  for (const [name, session] of [
    ['a tmux client sized by the other terminals', { ...tmux('others'), status: 'running' }],
    ['a tmux client that only watches', { ...tmux('here', 'watch'), status: 'running' }],
  ] as const) {
    it(`never claims ${name}, however much it is used`, async () => {
      vi.useFakeTimers();
      const resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
      try {
        const manager = new TerminalLifecycleManager();
        manager.setSession(session as unknown as Session);
        await manager.handleTerminalResize(resizeEvent(45, 33, false));
        await vi.runAllTimersAsync();
        resize.mockClear();
        manager.handlePtySize({ cols: 53, rows: 56 });
        manager.noteUserActivity();
        await vi.runAllTimersAsync();
        expect(resize).not.toHaveBeenCalled();
      } finally {
        resize.mockRestore();
        vi.useRealTimers();
      }
    });
  }

  it('claims for a tmux client set to fit this screen', async () => {
    vi.useFakeTimers();
    const resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
    try {
      const manager = new TerminalLifecycleManager();
      manager.setSession({ ...tmux('here'), status: 'running' } as unknown as Session);
      await manager.handleTerminalResize(resizeEvent(45, 33, false));
      await vi.runAllTimersAsync();
      resize.mockClear();
      manager.handlePtySize({ cols: 53, rows: 56 });
      manager.noteUserActivity();
      await vi.runAllTimersAsync();
      expect(resize.mock.calls).toEqual([['s1', 45, 33, true]]);
    } finally {
      resize.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('a Mac-window session opened in the browser', () => {
  let resize: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const session = { id: 'fwd_1791029966_4242', status: 'running' } as Session;

  const opened = async (own: { cols: number; rows: number }) => {
    const manager = new TerminalLifecycleManager();
    const element = document.createElement('div');
    element.appendChild(
      Object.assign(document.createElement('ut-terminal'), { getOwnSize: () => own })
    );
    manager.setDomElement(element);
    manager.setSession(session);
    await manager.initializeTerminal();
    return manager;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetSizeGiveBackForTests();
    resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ reset: true })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resize.mockRestore();
    vi.unstubAllGlobals();
    setPageUsedForTests(false);
    vi.useRealTimers();
  });

  it('claims its size when opened from inside the app', async () => {
    setPageUsedForTests(true);
    const desktop = await opened({ cols: 184, rows: 39 });
    desktop.handlePtySize({ cols: 120, rows: 40 }); // the stream's header
    await vi.advanceTimersByTimeAsync(ENTRY_SETTLE_MS + 200);
    expect(resize.mock.calls).toEqual([['fwd_1791029966_4242', 184, 39, true]]);
  });

  it('does not claim when a reload shows the session again by itself', async () => {
    setPageUsedForTests(false);
    const desktop = await opened({ cols: 184, rows: 39 });
    desktop.handlePtySize({ cols: 120, rows: 40 });
    await vi.advanceTimersByTimeAsync(ENTRY_SETTLE_MS + 200);
    expect(resize).not.toHaveBeenCalled();
  });

  it('gives the size back a minute after it is left, unless it is opened again', async () => {
    const phone = await opened({ cols: 47, rows: 33 });
    phone.resetTerminalSize();
    await vi.advanceTimersByTimeAsync(30_000);
    // Opened again within the minute: nothing goes back.
    phone.setSession({ ...session });
    expect(pendingSizeGiveBacks()).toEqual([]);
    phone.resetTerminalSize();
    const giveBacks = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/reset-size'));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(giveBacks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(giveBacks()).toHaveLength(1);
    const body = JSON.parse(String(giveBacks()[0][1].body));
    expect(typeof body.clientId).toBe('string');
  });

  it('never gives back the size of a session that has no Mac window', async () => {
    const manager = new TerminalLifecycleManager();
    manager.setSession({
      id: 'ff005102-6d2f-43b2-99e2-925ee7e3c611',
      status: 'running',
    } as Session);
    manager.resetTerminalSize();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/reset-size'))).toEqual(
      []
    );
  });
});
