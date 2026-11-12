// @vitest-environment happy-dom

import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UtTerminalBuffer } from './ut-terminal-buffer';

type Handlers = {
  onSnapshot: (snapshot: unknown) => void;
  onError: (message: string) => void;
};

const socket = vi.hoisted(() => ({
  subscribe: vi.fn(),
}));
vi.mock('../services/terminal-socket-client.js', () => ({ terminalSocketClient: socket }));

const snapshot = (text: string) => ({
  cols: 80,
  rows: 24,
  viewportY: 0,
  cursorX: 0,
  cursorY: 0,
  cells: [[...text].map((char) => ({ char, width: 1 }))],
});

describe('ut-terminal-buffer', () => {
  let handlers: Handlers[];
  let unsubscribes: Array<ReturnType<typeof vi.fn>>;

  beforeAll(async () => {
    await import('./ut-terminal-buffer');
  });

  beforeEach(() => {
    handlers = [];
    unsubscribes = [];
    socket.subscribe.mockReset();
    socket.subscribe.mockImplementation((_id: string, opts: Handlers) => {
      handlers.push(opts);
      const off = vi.fn();
      unsubscribes.push(off);
      return off;
    });
    // happy-dom has no layout: give the content div a height so rows fit.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const make = () =>
    fixture<UtTerminalBuffer>(html`<ut-terminal-buffer .sessionId=${'s1'}></ut-terminal-buffer>`);

  const shown = async (element: UtTerminalBuffer) => {
    await vi.waitFor(() =>
      expect(element.querySelector('#buffer-container')?.textContent).not.toBe('')
    );
    return element.querySelector('#buffer-container')?.textContent;
  };

  it('shows the snapshot it is sent', async () => {
    const element = await make();
    expect(socket.subscribe).toHaveBeenCalledTimes(1);
    handlers[0].onSnapshot(snapshot('hello'));
    expect(await shown(element)).toBe('hello');
  });

  it('writes into the content div Lit renders after an error, not the detached old one (2026-11-10)', async () => {
    const element = await make();
    handlers[0].onSnapshot(snapshot('first'));
    await shown(element);
    const before = element.querySelector('#buffer-container');

    handlers[0].onError('lost');
    await element.updateComplete;
    expect(element.querySelector('#buffer-container')).toBeNull();

    handlers[0].onSnapshot(snapshot('again'));
    await vi.waitFor(() =>
      expect(element.querySelector('#buffer-container')?.textContent).toBe('again')
    );
    expect(element.querySelector('#buffer-container')).not.toBe(before);
  });

  it('subscribes again when moved in the DOM, and lets go once removed (2026-11-10)', async () => {
    const element = await make();
    expect(socket.subscribe).toHaveBeenCalledTimes(1);

    // A move: the card goes to another list.
    const other = document.createElement('div');
    document.body.appendChild(other);
    other.appendChild(element);
    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(socket.subscribe).toHaveBeenCalledTimes(2);

    handlers[1].onSnapshot(snapshot('moved'));
    expect(await shown(element)).toBe('moved');

    element.remove();
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
    expect(socket.subscribe).toHaveBeenCalledTimes(2);
    other.remove();
  });
});
