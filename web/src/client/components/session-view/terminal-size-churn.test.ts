/**
 * @vitest-environment happy-dom
 */
// User report (2026-10-14): swiping between sessions on a phone resized the PTYs every
// second (each session left was reset to its Mac window's size, then taken back on return),
// and Claude Code's redraws tore its footer rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import {
  FORWARDED_SIZE_GIVE_BACK_DELAY_MS,
  pendingSizeGiveBacks,
  resetSizeGiveBackForTests,
} from './size-give-back.js';
import { ENTRY_SETTLE_MS, TerminalLifecycleManager } from './terminal-lifecycle-manager.js';

const resizeEvent = (cols: number, rows: number) =>
  new CustomEvent('terminal-resize', {
    detail: { cols, rows, isMobile: true, isHeightOnlyChange: false, source: 'test' },
  });

describe('swiping between sessions', () => {
  let resize: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const resets = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/reset-size'))
      .map(([url, init]) => ({
        id: String(url).split('/')[3],
        body: JSON.parse((init as RequestInit).body as string),
      }));

  beforeEach(() => {
    vi.useFakeTimers();
    resetSizeGiveBackForTests();
    resize = vi.spyOn(terminalSocketClient, 'resize').mockReturnValue(true);
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, reset: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resize.mockRestore();
    resetSizeGiveBackForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** Opens a session's view as the phone does on a swipe: a new view, its terminal fitting. */
  async function open(id: string, size = { cols: 48, rows: 46 }) {
    const manager = new TerminalLifecycleManager();
    const host = document.createElement('div');
    host.appendChild(document.createElement('ut-terminal'));
    document.body.appendChild(host);
    manager.setDomElement(host);
    manager.setEventHandlers({
      handleSessionExit: () => {},
      handleTerminalResize: (e) => void manager.handleTerminalResize(e),
      handleTerminalPaste: () => {},
    });
    manager.setSession({ id, status: 'running' } as Session);
    await manager.initializeTerminal();
    // The terminal goes through its default size, then its fit, as it mounts.
    await manager.handleTerminalResize(resizeEvent(80, 24));
    await manager.handleTerminalResize(resizeEvent(size.cols, size.rows));
    return {
      manager,
      leave: () => {
        manager.resetTerminalSize();
        manager.cleanup();
        host.remove();
      },
    };
  }

  it('resizes a session passed through on a swipe not at all, and one stayed on once', async () => {
    const a = await open('a');
    await vi.advanceTimersByTimeAsync(ENTRY_SETTLE_MS - 1);
    expect(resize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resize.mock.calls).toEqual([['a', 48, 46, false]]);
    a.leave();

    // Rapid swipes: b, a, b, a, each for 300 ms.
    for (const id of ['b', 'a', 'b', 'a']) {
      const view = await open(id);
      await vi.advanceTimersByTimeAsync(300);
      view.leave();
    }
    await vi.advanceTimersByTimeAsync(FORWARDED_SIZE_GIVE_BACK_DELAY_MS + 1000);

    // One resize while on a; the swipes made none. No Mac window: nothing to give back.
    expect(resize.mock.calls).toEqual([['a', 48, 46, false]]);
    expect(resets()).toEqual([]);
  });

  // User report 2026-10-14: a Mac-window session left for a few seconds got its window's width
  // back and the phone took it again; each width change left a copy of Claude Code's screen
  // in the history (its answer three times, lines broken at the other width).
  it("keeps a Mac-window session's size through a visit to another session", async () => {
    const id = 'fwd_1_2';
    const a = await open(id);
    await vi.advanceTimersByTimeAsync(ENTRY_SETTLE_MS);
    a.leave();
    expect(pendingSizeGiveBacks()).toEqual([id]);
    const other = await open('b');
    await vi.advanceTimersByTimeAsync(30_000);
    other.leave();
    const again = await open(id);
    expect(pendingSizeGiveBacks()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    const windowResets = () => resets().filter((reset) => reset.id === id);
    expect(windowResets()).toEqual([]);
    const sizes = resize.mock.calls.filter((c) => c[0] === id).map((c) => c.join('x'));
    expect(new Set(sizes)).toEqual(new Set([`${id}x48x46xfalse`]));
    // Left for good: a minute later the server is asked to give the window its size back
    // (it does only if this page still owns it and nobody else views the session).
    again.leave();
    await vi.advanceTimersByTimeAsync(FORWARDED_SIZE_GIVE_BACK_DELAY_MS - 1);
    expect(windowResets()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(windowResets()).toEqual([{ id, body: { clientId: expect.any(String) } }]);
  });

  it('never claims for a page that is only open: the page used claims once', async () => {
    const phone = await open('fwd_3_4');
    const desktop = await open('fwd_3_4', { cols: 120, rows: 40 });
    await vi.advanceTimersByTimeAsync(30_000);
    // Both report their size; neither claims (the server applies only its owner's).
    expect(resize.mock.calls.every((c) => c[3] === false)).toBe(true);
    phone.manager.setTerminal({ getOwnSize: () => ({ cols: 48, rows: 46 }) } as never);
    desktop.manager.setTerminal({ getOwnSize: () => ({ cols: 120, rows: 40 }) } as never);
    resize.mockClear();
    phone.manager.noteUserActivity();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resize.mock.calls).toEqual([['fwd_3_4', 48, 46, true]]);
  });
});
